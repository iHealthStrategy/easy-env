// Daemon entry point. Boots the HTTP server, writes a PID file, wires up
// graceful shutdown. Invoked via `bin/easy-env-daemon.mjs` or
// `npm run daemon --workspace easy-env-mcp`.
import { serve } from '@hono/node-server';
import { FsStore } from '../store/fsStore.js';
import { buildContext } from '../core/context.js';
import { buildApp, webDistAvailable } from './server.js';
import { daemonHost, daemonPort } from './config.js';
import { writePidFile, deletePidFile, deletePidFileSync, readPidFile, isProcessAlive } from './pidfile.js';

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
  const app = buildApp(ctx, startedAt);

  const host = daemonHost();
  const port = daemonPort();

  const server = serve({ fetch: app.fetch, hostname: host, port }, (info) => {
    console.log(`[easy-env-daemon] listening on http://${info.address}:${info.port}`);
    if (webDistAvailable()) {
      console.log(`[easy-env-daemon] Web UI:    http://${info.address}:${info.port}/`);
    } else {
      console.log('[easy-env-daemon] Web UI:    (not built — run `npm run build --workspace easy-env-web`)');
    }
  });

  await writePidFile({ pid: process.pid, startedAt: new Date(startedAt).toISOString(), port });

  const shutdown = async (signal: string) => {
    console.log(`[easy-env-daemon] received ${signal}, shutting down`);
    server.close();
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
