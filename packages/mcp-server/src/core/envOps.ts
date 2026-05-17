// High-level env operations used by the env.* MCP tools. Bridges the
// EnvRegistry (state) and core/containers (lifecycle).
import crypto from 'node:crypto';
import { MongoClient } from 'mongodb';
import Redis from 'ioredis';
import type { EnvRegistry } from '../store/envRegistry.js';
import type { ManagedEnv } from '../schemas/env.js';
import type { EasyEnvConfig } from '../schemas/config.js';
import { spawnMongo, spawnRedis, stopAllForEnv, mongoUrlFor, redisUrlFor } from './containers.js';
import {
  FALLBACK_MONGO_URL,
  FALLBACK_REDIS_URL,
  FALLBACK_DB_NAME,
} from './config.js';

const newEnvId = () => `env_${crypto.randomBytes(6).toString('hex')}`;

function configHash(cfg: EasyEnvConfig): string {
  const stable = JSON.stringify({
    mongoImage: cfg.backends.mongo?.image,
    redisImage: cfg.backends.redis?.image,
    dbName: cfg.backends.mongo?.dbName,
  });
  return crypto.createHash('sha256').update(stable).digest('hex').slice(0, 16);
}

function commonLabels(envId: string): Record<string, string> {
  return {
    'easy-env.env-id': envId,
    'easy-env.session': String(process.pid),
    'easy-env.created-at': new Date().toISOString(),
  };
}

export interface UpOptions {
  /** Skip starting Mongo (when project doesn't use it). */
  withoutMongo?: boolean;
  /** Skip starting Redis (when project doesn't use it). */
  withoutRedis?: boolean;
  /** If true, set this new env as the active one. Default true. */
  setActive?: boolean;
}

export async function envUp(
  cfg: EasyEnvConfig,
  registry: EnvRegistry,
  opts: UpOptions = {},
): Promise<ManagedEnv> {
  const envId = newEnvId();
  const labels = commonLabels(envId);
  const dbName = cfg.backends.mongo?.dbName ?? FALLBACK_DB_NAME;

  // Initial record: status=starting so partial failure leaves a trail.
  const initial: ManagedEnv = {
    envId,
    createdAt: new Date().toISOString(),
    status: 'starting',
    configHash: configHash(cfg),
    resolved: { dbName },
    labels,
  };
  await registry.save(initial);

  try {
    // Default to mongo:4.2 — the most common version still in use across
    // the user's real projects (e.g. blog-backend pins to 3.2, kithPay 4.x,
    // newer services 6.0). 4.2 is the "median compatible" default.
    const mongoImage = cfg.backends.mongo?.image ?? 'mongo:4.2';
    const redisImage = cfg.backends.redis?.image ?? 'redis:7-alpine';

    const mongo = opts.withoutMongo
      ? undefined
      : await spawnMongo({ envId, image: mongoImage, labels, hostPort: cfg.backends.mongo?.port });
    const redis = opts.withoutRedis
      ? undefined
      : await spawnRedis({ envId, image: redisImage, labels, hostPort: cfg.backends.redis?.port });

    const ready: ManagedEnv = {
      ...initial,
      status: 'ready',
      mongo,
      redis,
      resolved: {
        dbName,
        mongoUrl: mongo ? mongoUrlFor(mongo) : undefined,
        redisUrl: redis ? redisUrlFor(redis) : undefined,
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
    // Try to clean up anything that did start.
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

export async function envStatus(envId: string, registry: EnvRegistry): Promise<{
  env: ManagedEnv;
  mongoReachable?: boolean;
  redisReachable?: boolean;
}> {
  const env = await registry.get(envId);
  if (!env) throw new Error(`env not found: ${envId}`);
  let mongoReachable: boolean | undefined;
  let redisReachable: boolean | undefined;
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
  return { env, mongoReachable, redisReachable };
}

export async function envReset(
  envId: string,
  registry: EnvRegistry,
  recreate: boolean,
  cfg: EasyEnvConfig | null,
): Promise<ManagedEnv> {
  const env = await registry.get(envId);
  if (!env) throw new Error(`env not found: ${envId}`);

  if (recreate) {
    if (!cfg) {
      throw new Error('env.reset with recreate:true requires the active easy-env.json');
    }
    await envDown(envId, registry);
    return envUp(cfg, registry, { setActive: true });
  }

  // Fast path: drop database + flush redis. Containers stay up.
  if (env.resolved.mongoUrl) {
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
 * Fallback resolver: produces { mongoUrl, redisUrl, dbName } from an env if
 * available, otherwise from config defaults, otherwise from built-in fallbacks.
 * This is the single point where envId addressing wins over per-call backends.
 */
export async function resolveBackends(
  registry: EnvRegistry,
  cfg: EasyEnvConfig,
  envId?: string,
  override?: { mongoUrl?: string; redisUrl?: string; dbName?: string },
): Promise<{ mongoUrl: string; redisUrl: string; dbName: string; envId?: string }> {
  // Explicit override wins (for ad-hoc connections).
  if (override?.mongoUrl && override?.redisUrl) {
    return {
      mongoUrl: override.mongoUrl,
      redisUrl: override.redisUrl,
      dbName: override.dbName ?? cfg.backends.mongo?.dbName ?? FALLBACK_DB_NAME,
    };
  }
  const env = await resolveEnv(envId, registry);
  if (env && env.resolved.mongoUrl && env.resolved.redisUrl) {
    return {
      mongoUrl: override?.mongoUrl ?? env.resolved.mongoUrl,
      redisUrl: override?.redisUrl ?? env.resolved.redisUrl,
      dbName: override?.dbName ?? env.resolved.dbName,
      envId: env.envId,
    };
  }
  return {
    mongoUrl: override?.mongoUrl ?? cfg.backends.mongo?.url ?? FALLBACK_MONGO_URL,
    redisUrl: override?.redisUrl ?? cfg.backends.redis?.url ?? FALLBACK_REDIS_URL,
    dbName: override?.dbName ?? cfg.backends.mongo?.dbName ?? FALLBACK_DB_NAME,
  };
}
