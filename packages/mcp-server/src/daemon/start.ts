// Daemon entry point. Boots the HTTP server, writes a PID file, wires up
// graceful shutdown. Invoked via `bin/easy-env-daemon.mjs` or
// `npm run daemon --workspace easy-env-mcp`.
import '../core/requireNode.js'; // must be first: hard-exits on Node < 18
import { serve } from '@hono/node-server';
import { FsStore } from '../store/fsStore.js';
import { buildContext } from '../core/context.js';
import { buildApp } from './server.js';
import { daemonHost, daemonPort } from './config.js';
import { writePidFile, deletePidFile, deletePidFileSync, readPidFile, isProcessAlive } from './pidfile.js';
import { dockerRemoveByEnvId, dockerStateForEnv } from '../core/containers.js';
import type { EnvRegistry } from '../store/envRegistry.js';

/**
 * Reconcile registry state with reality at daemon startup. Every env in
 * the registry belongs to a previous daemon process that has now died
 * (we know this because PID-file check enforces single-daemon — see main).
 * Their containers are orphans regardless of docker state: if Exited or
 * Created, obvious zombies; if still Up, they've outlived their owning
 * easy-env session and serve no live env reference any more.
 *
 * Sweep them all, both at the docker level and the registry level, so
 * the daemon always starts from a clean slate.
 */
async function reconcileRegistry(registry: EnvRegistry): Promise<{ swept: number; containersRemoved: number }> {
  const envs = await registry.list();
  let swept = 0;
  let containersRemoved = 0;
  for (const env of envs) {
    const states = await dockerStateForEnv(env.envId).catch(() => []);
    const removed = await dockerRemoveByEnvId(env.envId).catch(() => []);
    containersRemoved += removed.length;
    await registry.delete(env.envId).catch(() => undefined);
    if (states.length > 0 || removed.length > 0 || env.status !== 'destroyed') swept += 1;
  }
  return { swept, containersRemoved };
}

/**
 * Drain: stop and remove all containers for envs in the registry. Called
 * during graceful shutdown so SIGTERM doesn't leave running containers
 * behind without a matching live easy-env process.
 */
async function drainRegistry(registry: EnvRegistry): Promise<void> {
  const envs = await registry.list();
  await Promise.allSettled(envs.map((e) => dockerRemoveByEnvId(e.envId)));
}

async function main(): Promise<void> {
  const existing = await readPidFile();
  if (existing && isProcessAlive(existing.pid)) {
    console.error(`[easy-env-daemon] already running (pid=${existing.pid}, port=${existing.port})`);
    process.exit(1);
  }
  if (existing) {
    // Stale PID file — previous daemon crashed. Clean up.
    await deletePidFile();
  }

  const ctx = buildContext(FsStore.default());
  const startedAt = Date.now();

  // Sweep zombies from any previous daemon run before we start serving.
  const { swept, containersRemoved } = await reconcileRegistry(ctx.registry);
  if (swept > 0 || containersRemoved > 0) {
    console.log(`[easy-env-daemon] reconciled ${swept} stale env(s), removed ${containersRemoved} container(s)`);
  }

  const app = buildApp(ctx, startedAt);

  const host = daemonHost();
  const port = daemonPort();

  const server = serve({ fetch: app.fetch, hostname: host, port }, (info) => {
    console.log(`[easy-env-daemon] listening on http://${info.address}:${info.port}`);
  });

  await writePidFile({ pid: process.pid, startedAt: new Date(startedAt).toISOString(), port });

  const shutdown = async (signal: string) => {
    console.log(`[easy-env-daemon] received ${signal}, shutting down`);
    server.close();
    await drainRegistry(ctx.registry).catch((e) => {
      console.error('[easy-env-daemon] drain failed (non-fatal):', e instanceof Error ? e.message : e);
    });
    await deletePidFile();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('exit', () => deletePidFileSync());
}

main().catch((e) => {
  console.error('[easy-env-daemon] fatal:', e);
  process.exit(1);
});
