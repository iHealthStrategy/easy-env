// High-level env operations used by the env.* MCP tools. Bridges the
// EnvRegistry (state) and core/containers (lifecycle).
import crypto from 'node:crypto';
import { MongoClient } from 'mongodb';
import Redis from 'ioredis';
import type { EnvRegistry } from '../store/envRegistry.js';
import type { ManagedEnv } from '../schemas/env.js';
import net from 'node:net';
import {
  spawnMongo,
  spawnRedis,
  spawnRabbit,
  stopAllForEnv,
  imageExists,
  mongoUrlFor,
  redisUrlFor,
  rabbitUrlFor,
  rabbitManagementUrlFor,
} from './containers.js';
import {
  DEFAULT_MONGO_IMAGE,
  DEFAULT_REDIS_IMAGE,
  DEFAULT_RABBIT_IMAGE,
  FALLBACK_MONGO_URL,
  FALLBACK_REDIS_URL,
  FALLBACK_RABBIT_URL,
  type BackendsSpec,
} from './backends.js';

const newEnvId = () => `env_${crypto.randomBytes(6).toString('hex')}`;

function configHash(spec: BackendsSpec): string {
  const stable = JSON.stringify({
    mongoImage: spec.mongo?.image,
    redisImage: spec.redis?.image,
    rabbitImage: spec.rabbit?.image,
    dbName: spec.mongo?.dbName,
  });
  return crypto.createHash('sha256').update(stable).digest('hex').slice(0, 16);
}

function commonLabels(envId: string, projectName?: string): Record<string, string> {
  const labels: Record<string, string> = {
    'easy-env.env-id': envId,
    'easy-env.session': String(process.pid),
    'easy-env.created-at': new Date().toISOString(),
  };
  if (projectName) labels['easy-env.project'] = projectName;
  return labels;
}

export interface UpOptions {
  /** One-off override: skip Mongo even if the manifest declares it. */
  withoutMongo?: boolean;
  /** One-off override: skip Redis even if the manifest declares it. */
  withoutRedis?: boolean;
  /** One-off override: skip Rabbit even if the manifest declares it. */
  withoutRabbit?: boolean;
  /** If true, set this new env as the active one. Default true. */
  setActive?: boolean;
  /** Project name to tag on the container labels (for sweeping per-project). */
  projectName?: string;
}

export async function envUp(
  spec: BackendsSpec,
  registry: EnvRegistry,
  opts: UpOptions = {},
): Promise<ManagedEnv> {
  const envId = newEnvId();
  const labels = commonLabels(envId, opts.projectName);
  const dbName = spec.mongo?.dbName;

  const initial: ManagedEnv = {
    envId,
    createdAt: new Date().toISOString(),
    status: 'starting',
    configHash: configHash(spec),
    resolved: dbName ? { dbName } : {},
    labels,
  };
  await registry.save(initial);

  try {
    const mongoImage = spec.mongo?.image ?? DEFAULT_MONGO_IMAGE;
    const redisImage = spec.redis?.image ?? DEFAULT_REDIS_IMAGE;
    const rabbitImage = spec.rabbit?.image ?? DEFAULT_RABBIT_IMAGE;

    // Surface a pull on the env record so the UI can show "downloading
    // <image>" while testcontainers fetches it (first run on a fresh machine
    // can take minutes). Only flag images not already cached locally; clear
    // again before the next backend so the field reflects what's downloading
    // right now.
    const markPulling = async (image: string) => {
      if (!(await imageExists(image))) {
        await registry.save({ ...initial, pullingImage: image });
      }
    };

    // Every backend is opt-in and symmetric: spawned only when the project
    // declared it in the manifest (spec.<x> present), unless the caller
    // passed a one-off withoutX override. A project that uses none of these
    // data services declares none and gets a bare env.
    let mongo;
    if (spec.mongo !== undefined && !opts.withoutMongo) {
      await markPulling(mongoImage);
      mongo = await spawnMongo({
        envId,
        image: mongoImage,
        labels,
        hostPort: spec.mongo?.port,
        replicaSet: spec.mongo?.replicaSet,
      });
    }
    let redis;
    if (spec.redis !== undefined && !opts.withoutRedis) {
      await markPulling(redisImage);
      redis = await spawnRedis({ envId, image: redisImage, labels, hostPort: spec.redis?.port });
    }
    let rabbitSpawn;
    if (spec.rabbit !== undefined && !opts.withoutRabbit) {
      await markPulling(rabbitImage);
      rabbitSpawn = await spawnRabbit({
        envId,
        image: rabbitImage,
        labels,
        hostPort: spec.rabbit.port,
        managementHostPort: spec.rabbit.managementPort,
        user: spec.rabbit.user,
        password: spec.rabbit.password,
      });
    }
    const rabbit = rabbitSpawn?.handle;

    const ready: ManagedEnv = {
      ...initial,
      status: 'ready',
      mongo,
      redis,
      rabbit,
      resolved: {
        ...(dbName ? { dbName } : {}),
        mongoUrl: mongo ? mongoUrlFor(mongo, spec.mongo?.replicaSet) : undefined,
        redisUrl: redis ? redisUrlFor(redis) : undefined,
        rabbitUrl: rabbitSpawn ? rabbitUrlFor(rabbit!, rabbitSpawn.user, rabbitSpawn.password) : undefined,
        rabbitManagementUrl: rabbitSpawn?.managementHostPort
          ? rabbitManagementUrlFor(rabbitSpawn.managementHostPort)
          : undefined,
      },
    };
    await registry.save(ready);
    if (opts.setActive !== false) await registry.setActive(envId);
    return ready;
  } catch (e) {
    const failed: ManagedEnv = {
      ...initial,
      status: 'error',
      error: (e as Error).message,
    };
    await registry.save(failed);
    await stopAllForEnv(envId).catch(() => undefined);
    throw e;
  }
}

export async function envDown(envId: string, registry: EnvRegistry): Promise<void> {
  const env = await registry.get(envId);
  if (!env) throw new Error(`env not found: ${envId}`);
  await stopAllForEnv(envId);
  await registry.delete(envId);
}

export async function envList(registry: EnvRegistry): Promise<{
  envs: ManagedEnv[];
  activeEnvId: string | null;
}> {
  const envs = await registry.list();
  const activeEnvId = await registry.getActive();
  return { envs, activeEnvId };
}

/**
 * Cheap "is something listening?" probe — TCP connect with a short timeout.
 * Used for Rabbit so we don't need to pull in amqplib just to ping the
 * broker. Returns true if a connect() succeeded, false on refused/timeout.
 */
function tcpProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
    sock.connect(port, host);
  });
}

export async function envStatus(envId: string, registry: EnvRegistry): Promise<{
  env: ManagedEnv;
  mongoReachable?: boolean;
  redisReachable?: boolean;
  rabbitReachable?: boolean;
}> {
  const env = await registry.get(envId);
  if (!env) throw new Error(`env not found: ${envId}`);
  let mongoReachable: boolean | undefined;
  let redisReachable: boolean | undefined;
  let rabbitReachable: boolean | undefined;
  if (env.resolved.mongoUrl) {
    try {
      const c = await MongoClient.connect(env.resolved.mongoUrl, { serverSelectionTimeoutMS: 1500 });
      await c.db().admin().ping();
      await c.close();
      mongoReachable = true;
    } catch {
      mongoReachable = false;
    }
  }
  if (env.resolved.redisUrl) {
    const r = new Redis(env.resolved.redisUrl, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: true,
    });
    try {
      await r.connect();
      await r.ping();
      redisReachable = true;
    } catch {
      redisReachable = false;
    } finally {
      r.disconnect();
    }
  }
  if (env.rabbit) {
    rabbitReachable = await tcpProbe('localhost', env.rabbit.hostPort, 1500);
  }
  return { env, mongoReachable, redisReachable, rabbitReachable };
}

export async function envReset(
  envId: string,
  registry: EnvRegistry,
  recreate: boolean,
  recreateSpec: BackendsSpec | null,
  projectName?: string,
): Promise<ManagedEnv> {
  const env = await registry.get(envId);
  if (!env) throw new Error(`env not found: ${envId}`);

  if (recreate) {
    if (!recreateSpec) {
      throw new Error('env.reset with recreate:true requires backends spec (pass projectName so we can read the manifest).');
    }
    await envDown(envId, registry);
    return envUp(recreateSpec, registry, { setActive: true, projectName });
  }

  if (env.resolved.mongoUrl && env.resolved.dbName) {
    // Only drop a database when the project told us which one. Otherwise
    // the project is likely using multiple dbs in this Mongo instance —
    // it must clean up its own data with project-specific tooling.
    const client = await MongoClient.connect(env.resolved.mongoUrl);
    try {
      await client.db(env.resolved.dbName).dropDatabase();
    } finally {
      await client.close();
    }
  }
  if (env.resolved.redisUrl) {
    const r = new Redis(env.resolved.redisUrl, { maxRetriesPerRequest: 1 });
    try {
      await r.flushdb();
    } finally {
      r.disconnect();
    }
  }
  return env;
}

export async function resolveEnv(
  envId: string | undefined,
  registry: EnvRegistry,
): Promise<ManagedEnv | null> {
  let id = envId;
  if (!id) id = (await registry.getActive()) ?? undefined;
  if (!id) return null;
  return registry.get(id);
}

/**
 * Fallback resolver: produces { mongoUrl, redisUrl, dbName? } from an env
 * if available, otherwise from built-in URL fallbacks. Explicit overrides
 * win. dbName is optional: if neither caller nor env supplies one, it's
 * omitted — downstream callers (state.capture, scenario.replay) must
 * decide what to do without it (typically: require the caller to supply
 * one for db-scoped operations).
 */
export async function resolveBackends(
  registry: EnvRegistry,
  envId?: string,
  override?: { mongoUrl?: string; redisUrl?: string; rabbitUrl?: string; dbName?: string },
): Promise<{ mongoUrl: string; redisUrl: string; rabbitUrl?: string; dbName?: string; envId?: string }> {
  // Per-field precedence: explicit override > active/selected env's resolved
  // URL > built-in compose fallback. Resolving per-field (rather than
  // all-or-nothing) matters now that envs are selective: a redis-only env
  // must keep its real redisUrl instead of being swapped wholesale for the
  // fallback ports just because it has no mongo. The fallback only fills a
  // service the env didn't spawn — callers that actually need that service
  // already error clearly (see db.* / core/seed.ts).
  const env =
    override?.mongoUrl && override?.redisUrl ? null : await resolveEnv(envId, registry);
  return {
    mongoUrl: override?.mongoUrl ?? env?.resolved.mongoUrl ?? FALLBACK_MONGO_URL,
    redisUrl: override?.redisUrl ?? env?.resolved.redisUrl ?? FALLBACK_REDIS_URL,
    rabbitUrl: override?.rabbitUrl ?? env?.resolved.rabbitUrl ?? FALLBACK_RABBIT_URL,
    dbName: override?.dbName ?? env?.resolved.dbName,
    envId: env?.envId,
  };
}
