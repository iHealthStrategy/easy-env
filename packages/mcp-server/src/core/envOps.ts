// High-level env operations used by the env.* MCP tools. Bridges the
// EnvRegistry (state) and core/containers (lifecycle).
import crypto from 'node:crypto';
import { MongoClient } from 'mongodb';
import Redis from 'ioredis';
import type { EnvRegistry } from '../store/envRegistry.js';
import type { ManagedEnv } from '../schemas/env.js';
import { spawnMongo, spawnRedis, stopAllForEnv, mongoUrlFor, redisUrlFor } from './containers.js';
import {
  DEFAULT_MONGO_IMAGE,
  DEFAULT_REDIS_IMAGE,
  FALLBACK_MONGO_URL,
  FALLBACK_REDIS_URL,
  type BackendsSpec,
} from './backends.js';

const newEnvId = () => `env_${crypto.randomBytes(6).toString('hex')}`;

function configHash(spec: BackendsSpec): string {
  const stable = JSON.stringify({
    mongoImage: spec.mongo?.image,
    redisImage: spec.redis?.image,
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
  /** Skip starting Mongo (when project doesn't use it). */
  withoutMongo?: boolean;
  /** Skip starting Redis (when project doesn't use it). */
  withoutRedis?: boolean;
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

    const mongo = opts.withoutMongo
      ? undefined
      : await spawnMongo({ envId, image: mongoImage, labels, hostPort: spec.mongo?.port });
    const redis = opts.withoutRedis
      ? undefined
      : await spawnRedis({ envId, image: redisImage, labels, hostPort: spec.redis?.port });

    const ready: ManagedEnv = {
      ...initial,
      status: 'ready',
      mongo,
      redis,
      resolved: {
        ...(dbName ? { dbName } : {}),
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
  override?: { mongoUrl?: string; redisUrl?: string; dbName?: string },
): Promise<{ mongoUrl: string; redisUrl: string; dbName?: string; envId?: string }> {
  if (override?.mongoUrl && override?.redisUrl) {
    return {
      mongoUrl: override.mongoUrl,
      redisUrl: override.redisUrl,
      dbName: override.dbName,
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
    mongoUrl: override?.mongoUrl ?? FALLBACK_MONGO_URL,
    redisUrl: override?.redisUrl ?? FALLBACK_REDIS_URL,
    dbName: override?.dbName,
  };
}
