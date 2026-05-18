// state.seed runners. Two flavours, both gated on the AI explicitly
// registering paths via env.init:
//
//   JSON   — declarative fixtures the daemon applies directly via the
//            mongo / ioredis / rabbit Management HTTP clients.
//   Script — imperative node processes the daemon spawns with backend
//            URLs and the project's vars injected via process.env.
//
// The daemon reads project files ONLY for these explicit paths. Every
// other "read project source" path is the AI's job, by design.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { MongoClient } from 'mongodb';
import Redis from 'ioredis';
import type { ToolContext } from './context.js';
import type { ManagedEnv } from '../schemas/env.js';
import { JsonSeedSpec, type RabbitTopology } from '../schemas/seed.js';
import { resolveVars } from './vars.js';

/** Guard: seed paths must resolve INSIDE projectRoot. Absolute paths and
 *  `..` escapes are rejected — the AI is supposed to ship paths from
 *  easy-env.json, and those are relative to the project. */
export function resolveSeedPath(projectRoot: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) {
    throw new Error(`seed path must be relative to projectRoot, got absolute: ${relativePath}`);
  }
  const abs = path.resolve(projectRoot, relativePath);
  const rootAbs = path.resolve(projectRoot);
  if (!abs.startsWith(rootAbs + path.sep) && abs !== rootAbs) {
    throw new Error(`seed path escapes projectRoot: ${relativePath}`);
  }
  return abs;
}

// ── JSON seed application ──────────────────────────────────────────────────

export interface JsonSeedRunResult {
  mongo: Array<{ db: string; collection: string; mode: string; inserted: number }>;
  redis: Array<{ key: string; type: string }>;
  rabbit?: { exchanges: number; queues: number; bindings: number };
}

export async function applyJsonSeed(
  spec: unknown,
  env: ManagedEnv,
  rabbit?: { user: string; password: string; managementUrl: string },
): Promise<JsonSeedRunResult> {
  const parsed = JsonSeedSpec.parse(spec);
  const result: JsonSeedRunResult = { mongo: [], redis: [] };

  if (parsed.mongo) {
    if (!env.resolved.mongoUrl) throw new Error('seed.mongo present but env has no mongoUrl');
    const client = await MongoClient.connect(env.resolved.mongoUrl);
    try {
      for (const [dbName, collections] of Object.entries(parsed.mongo)) {
        const db = client.db(dbName);
        for (const [collName, entry] of Object.entries(collections)) {
          const { mode, docs } = Array.isArray(entry)
            ? { mode: 'replace' as const, docs: entry }
            : entry;
          if (docs.length === 0 && mode !== 'replace') continue;
          const coll = db.collection(collName);
          if (mode === 'replace') {
            // drop is idempotent; ignore "ns not found"
            await coll.drop().catch(() => undefined);
            if (docs.length > 0) await coll.insertMany(docs as Array<Record<string, unknown>>);
            result.mongo.push({ db: dbName, collection: collName, mode, inserted: docs.length });
          } else if (mode === 'insert') {
            await coll.insertMany(docs as Array<Record<string, unknown>>);
            result.mongo.push({ db: dbName, collection: collName, mode, inserted: docs.length });
          } else {
            // upsert by _id (skip docs without _id — they'd insert anyway)
            let n = 0;
            for (const d of docs as Array<Record<string, unknown>>) {
              if (d._id === undefined) {
                await coll.insertOne(d);
              } else {
                // d._id is `unknown` in the spec; the driver accepts any
                // BSON-serialisable id at runtime, so widen via `as any`.
                await coll.replaceOne({ _id: d._id as any }, d, { upsert: true });
              }
              n += 1;
            }
            result.mongo.push({ db: dbName, collection: collName, mode, inserted: n });
          }
        }
      }
    } finally {
      await client.close();
    }
  }

  if (parsed.redis) {
    if (!env.resolved.redisUrl) throw new Error('seed.redis present but env has no redisUrl');
    const r = new Redis(env.resolved.redisUrl, { maxRetriesPerRequest: 2 });
    try {
      for (const [key, raw] of Object.entries(parsed.redis)) {
        const entry: { type: 'string' | 'hash' | 'list' | 'set' | 'zset'; value: unknown; ttlSeconds?: number } =
          typeof raw === 'string'
            ? { type: 'string', value: raw }
            : { type: raw.type, value: raw.value, ttlSeconds: raw.ttlSeconds };
        await writeRedisKey(r, key, entry);
        result.redis.push({ key, type: entry.type });
      }
    } finally {
      r.disconnect();
    }
  }

  if (parsed.rabbit) {
    if (!rabbit) throw new Error('seed.rabbit present but env has no rabbit backend configured');
    const counts = await applyRabbitTopology(parsed.rabbit, rabbit);
    result.rabbit = counts;
  }

  return result;
}

async function writeRedisKey(
  r: Redis,
  key: string,
  entry: { type: 'string' | 'hash' | 'list' | 'set' | 'zset'; value: unknown; ttlSeconds?: number },
): Promise<void> {
  // Replace any existing key/type at this key — matches the "init"
  // semantic. DEL is a no-op if the key doesn't exist.
  await r.del(key);
  switch (entry.type) {
    case 'string': {
      const v = entry.value;
      if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
        throw new Error(`redis seed key '${key}' string type requires scalar value`);
      }
      await r.set(key, String(v));
      break;
    }
    case 'hash': {
      const v = entry.value;
      if (!v || typeof v !== 'object' || Array.isArray(v)) {
        throw new Error(`redis seed key '${key}' hash type requires object value`);
      }
      const flat: string[] = [];
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        flat.push(k, typeof x === 'string' ? x : JSON.stringify(x));
      }
      if (flat.length > 0) await r.hset(key, ...flat);
      break;
    }
    case 'list': {
      const v = entry.value;
      if (!Array.isArray(v)) throw new Error(`redis seed key '${key}' list type requires array value`);
      const items = v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x)));
      if (items.length > 0) await r.rpush(key, ...items);
      break;
    }
    case 'set': {
      const v = entry.value;
      if (!Array.isArray(v)) throw new Error(`redis seed key '${key}' set type requires array value`);
      const items = v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x)));
      if (items.length > 0) await r.sadd(key, ...items);
      break;
    }
    case 'zset': {
      const v = entry.value;
      // Accept [{member, score}, ...] OR {member: score, ...}
      const tuples: Array<[number, string]> = [];
      if (Array.isArray(v)) {
        for (const item of v as Array<{ member: string; score: number }>) {
          tuples.push([Number(item.score), String(item.member)]);
        }
      } else if (v && typeof v === 'object') {
        for (const [m, s] of Object.entries(v as Record<string, unknown>)) {
          tuples.push([Number(s), m]);
        }
      } else {
        throw new Error(`redis seed key '${key}' zset type requires array or object`);
      }
      if (tuples.length > 0) {
        const flat = tuples.flatMap(([s, m]) => [s, m]) as (string | number)[];
        await (r as any).zadd(key, ...flat);
      }
      break;
    }
  }
  if (entry.ttlSeconds && entry.ttlSeconds > 0) {
    await r.expire(key, entry.ttlSeconds);
  }
}

// ── Rabbit topology via Management HTTP API ─────────────────────────────────
// Default vhost '/' → URL-encoded '%2F'.

async function applyRabbitTopology(
  topo: RabbitTopology,
  rabbit: { user: string; password: string; managementUrl: string },
): Promise<{ exchanges: number; queues: number; bindings: number }> {
  const base = rabbit.managementUrl.replace(/\/+$/, '');
  const auth = 'Basic ' + Buffer.from(`${rabbit.user}:${rabbit.password}`).toString('base64');
  const vhost = '%2F';

  for (const ex of topo.exchanges) {
    const url = `${base}/api/exchanges/${vhost}/${encodeURIComponent(ex.name)}`;
    await mgmtRequest('PUT', url, auth, {
      type: ex.type,
      durable: ex.durable,
      auto_delete: ex.autoDelete,
      arguments: ex.arguments,
    });
  }
  for (const q of topo.queues) {
    const url = `${base}/api/queues/${vhost}/${encodeURIComponent(q.name)}`;
    await mgmtRequest('PUT', url, auth, {
      durable: q.durable,
      auto_delete: q.autoDelete,
      exclusive: q.exclusive,
      arguments: q.arguments,
    });
  }
  for (const b of topo.bindings) {
    const url = `${base}/api/bindings/${vhost}/e/${encodeURIComponent(b.source)}/q/${encodeURIComponent(b.destination)}`;
    await mgmtRequest('POST', url, auth, {
      routing_key: b.routingKey,
      arguments: b.arguments,
    });
  }
  return {
    exchanges: topo.exchanges.length,
    queues: topo.queues.length,
    bindings: topo.bindings.length,
  };
}

async function mgmtRequest(method: 'PUT' | 'POST', url: string, auth: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', authorization: auth },
    body: JSON.stringify(body),
  });
  // Management API returns 201 Created / 204 No Content on success, 200 on
  // idempotent re-declare. 4xx on conflicting redeclare (different args).
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`rabbit management ${method} ${url} failed: ${res.status} ${text.slice(0, 200)}`);
  }
}

// ── Script invocation ───────────────────────────────────────────────────────

export interface ScriptRunResult {
  exitCode: number | null;
  stdoutTail?: string;
  stderrTail?: string;
}

export async function runSeedScript(opts: {
  scriptAbsPath: string;
  projectRoot: string;
  ctx: ToolContext;
  projectName: string;
}): Promise<ScriptRunResult> {
  if (!/\.(m?js)$/i.test(opts.scriptAbsPath)) {
    throw new Error(`seed script must be .js or .mjs (got ${path.basename(opts.scriptAbsPath)})`);
  }
  // Inject the project's resolved vars (with template interpolation
  // against the active env) into the child env, so the script can read
  // process.env.MONGODB_URI etc. exactly like the project at runtime.
  const { variables, containers } = await resolveVars({ ctx: opts.ctx, projectName: opts.projectName });
  const env: Record<string, string> = { ...process.env as Record<string, string> };
  for (const [name, entry] of Object.entries(variables)) {
    if (entry.source === 'user' && entry.value !== null && entry.value !== undefined) {
      env[name] = String(entry.value);
    }
  }
  // Also expose the raw container URLs under EASY_ENV_* so scripts that
  // don't want to depend on the project's variable naming have a stable
  // contract.
  if (containers?.mongoUrl) env.EASY_ENV_MONGO_URL = containers.mongoUrl;
  if (containers?.redisUrl) env.EASY_ENV_REDIS_URL = containers.redisUrl;
  if (containers?.rabbitUrl) env.EASY_ENV_RABBIT_URL = containers.rabbitUrl;
  if (containers?.rabbitManagementUrl) env.EASY_ENV_RABBIT_MGMT_URL = containers.rabbitManagementUrl;
  if (containers?.dbName) env.EASY_ENV_MONGO_DB = containers.dbName;

  return new Promise((resolve, reject) => {
    const child = spawn('node', [opts.scriptAbsPath], {
      cwd: opts.projectRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const TAIL_CAP = 2_048;
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({
      exitCode: code,
      stdoutTail: stdout ? stdout.slice(-TAIL_CAP) : undefined,
      stderrTail: stderr ? stderr.slice(-TAIL_CAP) : undefined,
    }));
  });
}

// ── Public helper: read JSON seed from disk ─────────────────────────────────

export async function readJsonSeedFile(absPath: string): Promise<unknown> {
  const raw = await readFile(absPath, 'utf8');
  return JSON.parse(raw);
}
