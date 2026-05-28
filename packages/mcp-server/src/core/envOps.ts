// High-level env operations used by the env.* MCP tools. Bridges the
// EnvRegistry (state) and core/containers (lifecycle).
import crypto from 'node:crypto';
import { MongoClient } from 'mongodb';
import Redis from 'ioredis';
import type { EnvRegistry } from '../store/envRegistry.js';
import type { ManagedEnv } from '../schemas/env.js';
import net from 'node:net';
import {
  clickhouseClearDatabase,
  clickhouseExec,
  escapeClickhouseIdent,
} from './clickhouse.js';
import {
  spawnMongo,
  spawnRedis,
  spawnRabbit,
  spawnClickhouse,
  stopAllForEnv,
  imageExists,
  mongoUrlFor,
  redisUrlFor,
  rabbitUrlFor,
  rabbitManagementUrlFor,
  clickhouseUrlFor,
} from './containers.js';
import {
  DEFAULT_MONGO_IMAGE,
  DEFAULT_REDIS_IMAGE,
  DEFAULT_RABBIT_IMAGE,
  DEFAULT_CLICKHOUSE_IMAGE,
  DEFAULT_CLICKHOUSE_DB,
  DEFAULT_CLICKHOUSE_CLUSTER_NAME,
  DEFAULT_CLICKHOUSE_SHARD,
  DEFAULT_CLICKHOUSE_REPLICA,
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
    clickhouseImage: spec.clickhouse?.image,
    dbName: spec.mongo?.dbName,
    clickhouseDbName: spec.clickhouse?.dbName,
    clickhouseCluster: spec.clickhouse?.cluster,
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
  /** One-off override: skip ClickHouse even if the manifest declares it. */
  withoutClickhouse?: boolean;
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
    const clickhouseImage = spec.clickhouse?.image ?? DEFAULT_CLICKHOUSE_IMAGE;
    const clickhouseDbName = spec.clickhouse?.dbName ?? DEFAULT_CLICKHOUSE_DB;

    // Every backend is opt-in and symmetric: spawned only when the project
    // declared it in the manifest (spec.<x> present), unless the caller
    // passed a one-off withoutX override. A project that uses none of these
    // data services declares none and gets a bare env.
    const wantMongo = spec.mongo !== undefined && !opts.withoutMongo;
    const wantRedis = spec.redis !== undefined && !opts.withoutRedis;
    const wantRabbit = spec.rabbit !== undefined && !opts.withoutRabbit;
    const wantClickhouse = spec.clickhouse !== undefined && !opts.withoutClickhouse;

    // Surface pending image downloads on the env record so the UI can show
    // "downloading <image>…" while testcontainers fetches them (first run
    // on a fresh machine can take minutes). Check all needed images in
    // parallel before launching anything, so the UI sees the full list at
    // once instead of flicker as each backend overwrites the previous one.
    const neededImages = [
      wantMongo ? mongoImage : null,
      wantRedis ? redisImage : null,
      wantRabbit ? rabbitImage : null,
      wantClickhouse ? clickhouseImage : null,
    ].filter((x): x is string => x !== null);
    const presence = await Promise.all(neededImages.map((img) => imageExists(img)));
    const pulling = neededImages.filter((_, i) => !presence[i]);
    if (pulling.length > 0) {
      // pullingImage is a single string for back-compat; surface the first
      // (alphabetical) so the UI shows a stable name. The actual download
      // happens concurrently across all of them inside testcontainers.
      await registry.save({ ...initial, pullingImage: pulling.sort()[0] });
    }

    // Cluster mode for ClickHouse is opt-in per project — passing
    // `cluster: {}` in env.init turns it on with sensible defaults;
    // absence keeps the lighter single-node-no-Keeper boot.
    const clusterSpec = spec.clickhouse?.cluster
      ? {
          name: spec.clickhouse.cluster.name ?? DEFAULT_CLICKHOUSE_CLUSTER_NAME,
          shard: spec.clickhouse.cluster.shard ?? DEFAULT_CLICKHOUSE_SHARD,
          replica: spec.clickhouse.cluster.replica ?? DEFAULT_CLICKHOUSE_REPLICA,
        }
      : undefined;

    // Spawn declared backends in parallel — they have no inter-dependencies,
    // and the slow ones (rabbit ~30s cold, clickhouse-with-cluster ~30s cold)
    // dominate. Serial would sum to ~90s for a project using all four;
    // parallel caps at the slowest single boot (~30s).
    const [mongo, redis, rabbitSpawn, clickhouse] = await Promise.all([
      wantMongo
        ? spawnMongo({
            envId,
            image: mongoImage,
            labels,
            hostPort: spec.mongo?.port,
            replicaSet: spec.mongo?.replicaSet,
          })
        : Promise.resolve(undefined),
      wantRedis
        ? spawnRedis({ envId, image: redisImage, labels, hostPort: spec.redis?.port })
        : Promise.resolve(undefined),
      wantRabbit
        ? spawnRabbit({
            envId,
            image: rabbitImage,
            labels,
            hostPort: spec.rabbit!.port,
            managementHostPort: spec.rabbit!.managementPort,
            user: spec.rabbit!.user,
            password: spec.rabbit!.password,
          })
        : Promise.resolve(undefined),
      wantClickhouse
        ? spawnClickhouse({
            envId,
            image: clickhouseImage,
            labels,
            hostPort: spec.clickhouse!.port,
            dbName: clickhouseDbName,
            cluster: clusterSpec,
          })
        : Promise.resolve(undefined),
    ]);
    const rabbit = rabbitSpawn?.handle;

    const ready: ManagedEnv = {
      ...initial,
      status: 'ready',
      mongo,
      redis,
      rabbit,
      clickhouse,
      resolved: {
        ...(dbName ? { dbName } : {}),
        mongoUrl: mongo ? mongoUrlFor(mongo, spec.mongo?.replicaSet) : undefined,
        redisUrl: redis ? redisUrlFor(redis) : undefined,
        rabbitUrl: rabbitSpawn ? rabbitUrlFor(rabbit!, rabbitSpawn.user, rabbitSpawn.password) : undefined,
        rabbitManagementUrl: rabbitSpawn?.managementHostPort
          ? rabbitManagementUrlFor(rabbitSpawn.managementHostPort)
          : undefined,
        clickhouseUrl: clickhouse ? clickhouseUrlFor(clickhouse) : undefined,
        clickhouseDbName: clickhouse ? clickhouseDbName : undefined,
        clickhouseCluster: clickhouse && spec.clickhouse?.cluster
          ? spec.clickhouse.cluster.name ?? DEFAULT_CLICKHOUSE_CLUSTER_NAME
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
  clickhouseReachable?: boolean;
}> {
  const env = await registry.get(envId);
  if (!env) throw new Error(`env not found: ${envId}`);
  let mongoReachable: boolean | undefined;
  let redisReachable: boolean | undefined;
  let rabbitReachable: boolean | undefined;
  let clickhouseReachable: boolean | undefined;
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
  if (env.resolved.clickhouseUrl) {
    // Mongo/Redis/Rabbit probes use 1.5s, but ClickHouse — especially in
    // cluster mode (embedded Keeper, raft election, background merges) —
    // routinely takes >1.5s to answer /ping under any real load. 5s
    // matches the practical worst case while still feeling snappy in the
    // UI for healthy envs.
    const timeoutMs = env.resolved.clickhouseCluster ? 5000 : 3000;
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeoutMs);
      const res = await fetch(`${env.resolved.clickhouseUrl}/ping`, { signal: ctl.signal });
      clearTimeout(t);
      clickhouseReachable = res.ok;
    } catch {
      clickhouseReachable = false;
    }
  }
  return { env, mongoReachable, redisReachable, rabbitReachable, clickhouseReachable };
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
  if (env.resolved.clickhouseUrl && env.resolved.clickhouseDbName) {
    const dbName = env.resolved.clickhouseDbName;
    if (dbName === 'default') {
      // ClickHouse refuses `DROP DATABASE default` with Code 219 — the
      // system 'default' DB cannot be dropped or renamed. Enumerate user
      // tables and drop them individually instead. Same observable result
      // (the DB is empty after reset) without the fatal error path.
      await clickhouseClearDatabase(env.resolved.clickhouseUrl, dbName);
    } else {
      // For project-owned databases, drop + recreate is the simplest fully
      // clean reset (mirrors mongo's dropDatabase semantic).
      const ident = escapeClickhouseIdent(dbName);
      await clickhouseExec(env.resolved.clickhouseUrl, `DROP DATABASE IF EXISTS ${ident}`);
      await clickhouseExec(env.resolved.clickhouseUrl, `CREATE DATABASE ${ident}`);
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
  override?: {
    mongoUrl?: string;
    redisUrl?: string;
    rabbitUrl?: string;
    clickhouseUrl?: string;
    clickhouseDbName?: string;
    dbName?: string;
  },
): Promise<{
  mongoUrl: string;
  redisUrl: string;
  rabbitUrl?: string;
  /** Undefined when neither caller-override nor active env declared ClickHouse.
   *  Mongo/Redis still fall back to the compose ports so the smoke test works
   *  without env.up; ClickHouse has no analogous always-on default in this
   *  project, so we leave it absent and let callers detect "no CH" cleanly
   *  (instead of silently dialling localhost:8124 — that produced phantom
   *  URLs in scenario configs for non-CH projects). */
  clickhouseUrl?: string;
  clickhouseDbName?: string;
  dbName?: string;
  envId?: string;
}> {
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
    clickhouseUrl: override?.clickhouseUrl ?? env?.resolved.clickhouseUrl,
    clickhouseDbName: override?.clickhouseDbName ?? env?.resolved.clickhouseDbName,
    dbName: override?.dbName ?? env?.resolved.dbName,
    envId: env?.envId,
  };
}
