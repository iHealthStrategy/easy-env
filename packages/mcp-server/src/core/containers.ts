// Testcontainers-backed container lifecycle. Two backend kinds: mongo and
// redis. Each spawn returns a strongly-typed handle the registry persists.
//
// Ryuk reaper is left on (testcontainers' default) so a crashed easy-env
// process doesn't leave orphan containers — they get reaped when this
// process exits.
//
// Persistence: NONE. All test data lives in tmpfs (RAM). The directories
// each image declares as VOLUME (mongo: /data/db + /data/configdb;
// redis: /data) are mounted as tmpfs so Docker never creates anonymous
// volumes and there is no possibility of orphaned state on disk. Caps
// are sized for typical PoC-scale fixtures; bump them here if a project
// genuinely needs more than a few hundred MB of test data per env.
import { spawn } from 'node:child_process';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import type { ContainerHandle } from '../schemas/env.js';

// Shell-out to `docker` CLI for cleanup operations. Cheap, no extra deps,
// and matches what users would type by hand.
function dockerExec(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const proc = spawn('docker', args);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (b) => { stdout += b.toString(); });
    proc.stderr.on('data', (b) => { stderr += b.toString(); });
    proc.on('close', (code) => resolve({ stdout, stderr, code: code ?? 1 }));
    proc.on('error', () => resolve({ stdout, stderr, code: 1 }));
  });
}

/**
 * Force-remove all Docker containers labelled with the given envId. Used:
 *   - in the spawn error path to clean up half-created containers
 *     (port-bind failures leave a "Created" container behind that
 *     testcontainers never reaps)
 *   - by env.down as a fallback when the in-process StartedTestContainer
 *     reference is gone (e.g. after a daemon restart)
 *   - at daemon shutdown for every env in the registry
 * Returns the list of removed container IDs.
 */
export async function dockerRemoveByEnvId(envId: string): Promise<string[]> {
  const list = await dockerExec(['ps', '-aq', '--filter', `label=easy-env.env-id=${envId}`]);
  const ids = list.stdout.trim().split('\n').filter(Boolean);
  if (ids.length === 0) return [];
  await dockerExec(['rm', '-f', ...ids]);
  return ids;
}

/**
 * Returns the docker state ("running" | "exited" | "created" | …) of every
 * container labelled with the given envId. Empty array = no such containers.
 */
export async function dockerStateForEnv(envId: string): Promise<Array<{ id: string; state: string }>> {
  const list = await dockerExec([
    'ps', '-a',
    '--filter', `label=easy-env.env-id=${envId}`,
    '--format', '{{.ID}} {{.State}}',
  ]);
  return list.stdout.trim().split('\n').filter(Boolean).map((line) => {
    const [id, state] = line.split(/\s+/);
    return { id, state: state ?? 'unknown' };
  });
}

const MONGO_PORT = 27017;
const REDIS_PORT = 6379;

const MONGO_TMPFS = {
  '/data/db': 'rw,size=512m',
  '/data/configdb': 'rw,size=64m',
};
const REDIS_TMPFS = {
  '/data': 'rw,size=256m',
};

// In-process index from envId+backend to the live StartedTestContainer
// instance. We need this because Testcontainers' stop() requires the
// instance, not just the docker container id.
const liveContainers = new Map<string, StartedTestContainer>();

function key(envId: string, backend: 'mongo' | 'redis') {
  return `${envId}:${backend}`;
}

// Convert "EADDRINUSE" / docker port-allocation errors into a clear message
// that names the port and the backend, and clean up the half-created
// container that testcontainers left behind. Otherwise users see opaque
// stack traces AND "Created" zombies pile up on every retry.
async function wrapSpawnError(
  envId: string,
  backend: 'mongo' | 'redis',
  hostPort: number | undefined,
  e: unknown,
): Promise<never> {
  await dockerRemoveByEnvId(envId).catch(() => undefined);
  const msg = e instanceof Error ? e.message : String(e);
  if (hostPort && /address already in use|bind for .* failed|port is already allocated/i.test(msg)) {
    throw new Error(
      `${backend} container failed to bind host port ${hostPort}: port is already in use. ` +
      `Either stop the conflicting process, or change backends.${backend}.port in easy-env.json.`,
    );
  }
  throw e instanceof Error ? e : new Error(msg);
}

export async function spawnMongo(opts: {
  envId: string;
  image: string;
  labels: Record<string, string>;
  hostPort?: number;
}): Promise<ContainerHandle> {
  const portBinding = opts.hostPort
    ? { container: MONGO_PORT, host: opts.hostPort }
    : MONGO_PORT;
  try {
    const container = await new GenericContainer(opts.image)
      .withLabels(opts.labels)
      .withExposedPorts(portBinding)
      .withTmpFs(MONGO_TMPFS)
      .withStartupTimeout(60_000)
      .start();
    const handle: ContainerHandle = {
      containerId: container.getId(),
      image: opts.image,
      internalPort: MONGO_PORT,
      hostPort: container.getMappedPort(MONGO_PORT),
    };
    liveContainers.set(key(opts.envId, 'mongo'), container);
    return handle;
  } catch (e) {
    return wrapSpawnError(opts.envId, 'mongo', opts.hostPort, e);
  }
}

export async function spawnRedis(opts: {
  envId: string;
  image: string;
  labels: Record<string, string>;
  hostPort?: number;
}): Promise<ContainerHandle> {
  const portBinding = opts.hostPort
    ? { container: REDIS_PORT, host: opts.hostPort }
    : REDIS_PORT;
  try {
    const container = await new GenericContainer(opts.image)
      .withLabels(opts.labels)
      .withExposedPorts(portBinding)
      .withTmpFs(REDIS_TMPFS)
      .withStartupTimeout(60_000)
      .start();
    const handle: ContainerHandle = {
      containerId: container.getId(),
      image: opts.image,
      internalPort: REDIS_PORT,
      hostPort: container.getMappedPort(REDIS_PORT),
    };
    liveContainers.set(key(opts.envId, 'redis'), container);
    return handle;
  } catch (e) {
    return wrapSpawnError(opts.envId, 'redis', opts.hostPort, e);
  }
}

export async function stopContainer(envId: string, backend: 'mongo' | 'redis'): Promise<void> {
  const c = liveContainers.get(key(envId, backend));
  if (!c) return;
  await c.stop({ timeout: 5_000 });
  liveContainers.delete(key(envId, backend));
}

export async function stopAllForEnv(envId: string): Promise<void> {
  await Promise.allSettled([
    stopContainer(envId, 'mongo'),
    stopContainer(envId, 'redis'),
  ]);
  // Fallback: if liveContainers had no reference (e.g. daemon restart since
  // env.up), the in-process stop() above did nothing. Sweep docker by label
  // to make sure no zombie remains for this envId.
  await dockerRemoveByEnvId(envId).catch(() => undefined);
}

export function mongoUrlFor(handle: ContainerHandle): string {
  return `mongodb://localhost:${handle.hostPort}`;
}
export function redisUrlFor(handle: ContainerHandle): string {
  return `redis://localhost:${handle.hostPort}`;
}
