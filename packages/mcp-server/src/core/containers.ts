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
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import type { ContainerHandle } from '../schemas/env.js';

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

export async function spawnMongo(opts: {
  envId: string;
  image: string;
  labels: Record<string, string>;
}): Promise<ContainerHandle> {
  const container = await new GenericContainer(opts.image)
    .withLabels(opts.labels)
    .withExposedPorts(MONGO_PORT)
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
}

export async function spawnRedis(opts: {
  envId: string;
  image: string;
  labels: Record<string, string>;
}): Promise<ContainerHandle> {
  const container = await new GenericContainer(opts.image)
    .withLabels(opts.labels)
    .withExposedPorts(REDIS_PORT)
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
}

export function mongoUrlFor(handle: ContainerHandle): string {
  return `mongodb://localhost:${handle.hostPort}`;
}
export function redisUrlFor(handle: ContainerHandle): string {
  return `redis://localhost:${handle.hostPort}`;
}
