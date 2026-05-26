// Testcontainers-backed container lifecycle. Three backend kinds: mongo,
// redis, and rabbit. Each spawn returns a strongly-typed handle the
// registry persists.
//
// Ryuk reaper is left on (testcontainers' default) so a crashed easy-env
// process doesn't leave orphan containers — they get reaped when this
// process exits.
//
// Persistence: NONE. All test data lives in tmpfs (RAM). The directories
// each image declares as VOLUME (mongo: /data/db + /data/configdb;
// redis: /data; rabbit: /var/lib/rabbitmq) are mounted as tmpfs so Docker
// never creates anonymous volumes and there is no possibility of orphaned
// state on disk. Caps are sized for typical PoC-scale fixtures; bump them
// here if a project genuinely needs more than a few hundred MB of test
// data per env.
import { spawn } from 'node:child_process';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import type { ContainerHandle } from '../schemas/env.js';
import { DEFAULT_RABBIT_USER, DEFAULT_RABBIT_PASSWORD } from './backends.js';

export type BackendKind = 'mongo' | 'redis' | 'rabbit';

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
const RABBIT_AMQP_PORT = 5672;
const RABBIT_MGMT_PORT = 15672;

const MONGO_TMPFS = {
  '/data/db': 'rw,size=512m',
  '/data/configdb': 'rw,size=64m',
};
const REDIS_TMPFS = {
  '/data': 'rw,size=256m',
};
// Rabbit needs writeable storage for the Mnesia DB even when we don't care
// about persistence. tmpfs is plenty for PoC-scale queues.
const RABBIT_TMPFS = {
  '/var/lib/rabbitmq': 'rw,size=256m',
};

// In-process index from envId+backend to the live StartedTestContainer
// instance. We need this because Testcontainers' stop() requires the
// instance, not just the docker container id.
const liveContainers = new Map<string, StartedTestContainer>();

function key(envId: string, backend: BackendKind) {
  return `${envId}:${backend}`;
}

// Identify the class of error that means "the fixed host port we asked
// for is taken" — Docker phrases it a few different ways depending on
// the platform / engine version. Used by the port-collision fallback
// path (see spawnWithPortFallback) to decide whether to retry with a
// dynamic port instead of bailing.
function isPortBindError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /address already in use|bind for .* failed|port is already allocated/i.test(msg);
}

// Convert non-port spawn errors into a clearer message that names the
// backend, and clean up the half-created container that testcontainers
// left behind (port-bind failures otherwise leave a "Created" zombie
// piling up on every retry).
async function wrapSpawnError(
  envId: string,
  backend: BackendKind,
  hostPort: number | undefined,
  e: unknown,
): Promise<never> {
  await dockerRemoveByEnvId(envId).catch(() => undefined);
  const msg = e instanceof Error ? e.message : String(e);
  if (hostPort && isPortBindError(e)) {
    throw new Error(
      `${backend} container failed to bind host port ${hostPort}: port is already in use. ` +
      `Either stop the conflicting process, or change backends.${backend}.port in easy-env.json.`,
    );
  }
  throw e instanceof Error ? e : new Error(msg);
}

/**
 * Run `attempt(hostPort)`. If it fails with a port-bind error AND a
 * fixed hostPort was requested, clean up the half-created container and
 * retry once with `undefined` so testcontainers picks a free port. This
 * is what makes two worktrees of the same project able to env.up in
 * parallel even when the manifest hard-codes a port — the first one
 * grabs the fixed port, subsequent ones quietly fall back to dynamic.
 */
async function spawnWithPortFallback<T>(
  envId: string,
  backend: BackendKind,
  hostPort: number | undefined,
  attempt: (port: number | undefined) => Promise<T>,
): Promise<T> {
  try {
    return await attempt(hostPort);
  } catch (e) {
    if (hostPort && isPortBindError(e)) {
      await dockerRemoveByEnvId(envId).catch(() => undefined);
      console.error(
        `[easy-env] ${backend}: host port ${hostPort} is taken; falling back to a dynamic port.`,
      );
      try {
        return await attempt(undefined);
      } catch (e2) {
        return wrapSpawnError(envId, backend, undefined, e2);
      }
    }
    return wrapSpawnError(envId, backend, hostPort, e);
  }
}

export async function spawnMongo(opts: {
  envId: string;
  image: string;
  labels: Record<string, string>;
  hostPort?: number;
  /** Single-node replica set name; if set, mongod boots with --replSet
   *  <name> and we exec rs.initiate() against it once it's listening. */
  replicaSet?: string;
}): Promise<ContainerHandle> {
  return spawnWithPortFallback(opts.envId, 'mongo', opts.hostPort, async (port) => {
    const portBinding = port
      ? { container: MONGO_PORT, host: port }
      : MONGO_PORT;
    let builder = new GenericContainer(opts.image)
      .withLabels(opts.labels)
      .withExposedPorts(portBinding)
      .withTmpFs(MONGO_TMPFS)
      // Replica set bootstrap can add 10-15s; keep some headroom.
      .withStartupTimeout(opts.replicaSet ? 90_000 : 60_000);
    if (opts.replicaSet) {
      // --bind_ip_all so the in-container rs.initiate member host
      // (127.0.0.1:27017) is reachable; --replSet flips on the oplog.
      builder = builder.withCommand([
        'mongod',
        '--replSet', opts.replicaSet,
        '--bind_ip_all',
      ]);
    }
    const container = await builder.start();
    const handle: ContainerHandle = {
      containerId: container.getId(),
      image: opts.image,
      internalPort: MONGO_PORT,
      hostPort: container.getMappedPort(MONGO_PORT),
    };
    liveContainers.set(key(opts.envId, 'mongo'), container);
    if (opts.replicaSet) {
      await initiateReplicaSet(container, opts.replicaSet);
    }
    return handle;
  });
}

/**
 * Bootstrap a single-node replica set inside an already-started mongod
 * container, then wait until myState === 1 (PRIMARY) so subsequent driver
 * connections see a writable primary.
 *
 * Uses the in-container shell — `mongosh` on 5.0+, `mongo` on 3.6/4.x.
 * Initiates with host="127.0.0.1:27017" so the driver, when given
 * `?replicaSet=<name>&directConnection=true`, can connect via the host
 * port mapping without needing topology discovery against the advertised
 * member host (which is meaningless outside the container).
 */
async function initiateReplicaSet(
  container: StartedTestContainer,
  replicaSetName: string,
): Promise<void> {
  const shell = await detectMongoShell(container);
  const initScript =
    `try { rs.initiate({_id:"${replicaSetName}",members:[{_id:0,host:"127.0.0.1:27017"}]}) } ` +
    `catch (e) { if (!String(e).includes("already initialized")) throw e }`;
  const initRes = await container.exec([shell, '--quiet', '--eval', initScript]);
  if (initRes.exitCode !== 0) {
    throw new Error(
      `mongo replica set ${replicaSetName} init failed (exit ${initRes.exitCode}): ${initRes.output}`,
    );
  }
  // Poll for PRIMARY. rs.status().myState === 1 means PRIMARY.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const r = await container.exec([
      shell, '--quiet', '--eval',
      'print("STATE=" + rs.status().myState)',
    ]);
    if (r.exitCode === 0 && /STATE=1\b/.test(r.output)) return;
    await new Promise((res) => setTimeout(res, 500));
  }
  throw new Error(`mongo replica set ${replicaSetName} never reached PRIMARY within 30s`);
}

async function detectMongoShell(container: StartedTestContainer): Promise<'mongosh' | 'mongo'> {
  // mongosh ships in mongo:5.0+; older 3.x/4.x only have `mongo`. The
  // legacy shell exits 0 on `--version`, so we use that as the probe.
  const mongosh = await container.exec(['which', 'mongosh']).catch(() => null);
  if (mongosh && mongosh.exitCode === 0 && mongosh.output.trim()) return 'mongosh';
  return 'mongo';
}

export async function spawnRedis(opts: {
  envId: string;
  image: string;
  labels: Record<string, string>;
  hostPort?: number;
}): Promise<ContainerHandle> {
  return spawnWithPortFallback(opts.envId, 'redis', opts.hostPort, async (port) => {
    const portBinding = port
      ? { container: REDIS_PORT, host: port }
      : REDIS_PORT;
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
  });
}

export interface RabbitSpawn {
  handle: ContainerHandle;
  user: string;
  password: string;
  /** Management UI host port, only set when the image exposes 15672 and we
   *  successfully bound it. Mainline rabbit images without the management
   *  plugin won't have it. */
  managementHostPort?: number;
}

export async function spawnRabbit(opts: {
  envId: string;
  image: string;
  labels: Record<string, string>;
  hostPort?: number;
  managementHostPort?: number;
  user?: string;
  password?: string;
}): Promise<RabbitSpawn> {
  const user = opts.user ?? DEFAULT_RABBIT_USER;
  const password = opts.password ?? DEFAULT_RABBIT_PASSWORD;
  // Only expose the management port for *-management images (the others
  // don't run the plugin, and exposing it would fail the readiness check
  // because nothing listens on 15672).
  const isManagement = /-management(?:-|$)/.test(opts.image) || /:management$/.test(opts.image);
  return spawnWithPortFallback(opts.envId, 'rabbit', opts.hostPort, async (amqpPort) => {
    const amqpBinding = amqpPort
      ? { container: RABBIT_AMQP_PORT, host: amqpPort }
      : RABBIT_AMQP_PORT;
    // When the AMQP port fell back to dynamic, also drop the fixed
    // mgmt port — odds are it would clash for the same reason and a
    // single-port retry can't recover from a two-port collision.
    const mgmtHostPort = amqpPort ? opts.managementHostPort : undefined;
    const mgmtBinding = isManagement
      ? (mgmtHostPort
          ? { container: RABBIT_MGMT_PORT, host: mgmtHostPort }
          : RABBIT_MGMT_PORT)
      : undefined;
    let container = new GenericContainer(opts.image)
      .withLabels(opts.labels)
      .withEnvironment({
        RABBITMQ_DEFAULT_USER: user,
        RABBITMQ_DEFAULT_PASS: password,
      })
      .withTmpFs(RABBIT_TMPFS)
      // Rabbit's beam VM + management plugin can take 20-30s on a cold boot.
      .withStartupTimeout(90_000);
    container = mgmtBinding
      ? container.withExposedPorts(amqpBinding, mgmtBinding)
      : container.withExposedPorts(amqpBinding);
    const started = await container.start();
    const handle: ContainerHandle = {
      containerId: started.getId(),
      image: opts.image,
      internalPort: RABBIT_AMQP_PORT,
      hostPort: started.getMappedPort(RABBIT_AMQP_PORT),
    };
    liveContainers.set(key(opts.envId, 'rabbit'), started);
    return {
      handle,
      user,
      password,
      managementHostPort: mgmtBinding ? started.getMappedPort(RABBIT_MGMT_PORT) : undefined,
    };
  });
}

export async function stopContainer(envId: string, backend: BackendKind): Promise<void> {
  const c = liveContainers.get(key(envId, backend));
  if (!c) return;
  await c.stop({ timeout: 5_000 });
  liveContainers.delete(key(envId, backend));
}

export async function stopAllForEnv(envId: string): Promise<void> {
  await Promise.allSettled([
    stopContainer(envId, 'mongo'),
    stopContainer(envId, 'redis'),
    stopContainer(envId, 'rabbit'),
  ]);
  // Fallback: if liveContainers had no reference (e.g. daemon restart since
  // env.up), the in-process stop() above did nothing. Sweep docker by label
  // to make sure no zombie remains for this envId.
  await dockerRemoveByEnvId(envId).catch(() => undefined);
}

export function mongoUrlFor(handle: ContainerHandle, replicaSet?: string): string {
  const base = `mongodb://localhost:${handle.hostPort}`;
  // directConnection=true keeps the driver pinned to the host:port we
  // know about — without it, the driver would read the replica set
  // config, discover member host "127.0.0.1:27017" (the in-container
  // address), and try to dial that from the host.
  return replicaSet
    ? `${base}/?replicaSet=${encodeURIComponent(replicaSet)}&directConnection=true`
    : base;
}
export function redisUrlFor(handle: ContainerHandle): string {
  return `redis://localhost:${handle.hostPort}`;
}
export function rabbitUrlFor(handle: ContainerHandle, user: string, password: string): string {
  return `amqp://${encodeURIComponent(user)}:${encodeURIComponent(password)}@localhost:${handle.hostPort}`;
}
export function rabbitManagementUrlFor(hostPort: number): string {
  return `http://localhost:${hostPort}`;
}
