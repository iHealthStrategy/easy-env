import { MongoClient } from 'mongodb';
import Redis from 'ioredis';
import type {
  CaptureSpec,
  ClickhouseCaptureSpec,
  ClickhouseTableSnapshot,
  SnapshotArtifact,
} from '../schemas/capture.js';
import { newId, nowIso } from './ids.js';
import { clickhouseQueryRows, escapeClickhouseIdent } from './clickhouse.js';

export interface CaptureContext {
  mongoUrl: string;
  // Optional: omit when the caller doesn't know which db to capture from.
  // captureState will refuse to capture mongo collections without one.
  dbName?: string;
  redisUrl: string;
  clickhouseUrl?: string;
  clickhouseDbName?: string;
}

const DEFAULT_CTX: CaptureContext = {
  mongoUrl: 'mongodb://localhost:27018',
  redisUrl: 'redis://localhost:6380',
};

async function captureMongo(
  collections: string[],
  ctx: CaptureContext,
): Promise<Record<string, Array<Record<string, unknown>>>> {
  if (collections.length === 0) return {};
  if (!ctx.dbName) {
    throw new Error(
      'captureState: mongo collections requested but no dbName supplied. Pass `backends.dbName` explicitly, or include backends.mongo.dbName in your easy-env.json.',
    );
  }
  const client = await MongoClient.connect(ctx.mongoUrl);
  try {
    const db = client.db(ctx.dbName);
    const out: Record<string, Array<Record<string, unknown>>> = {};
    for (const name of collections) {
      out[name] = (await db.collection(name).find({}).toArray()) as Array<Record<string, unknown>>;
    }
    return out;
  } finally {
    await client.close();
  }
}

async function captureRedis(
  patterns: string[],
  ctx: CaptureContext,
): Promise<Record<string, { type: string; value: unknown; ttl: number }>> {
  if (patterns.length === 0) return {};
  const redis = new Redis(ctx.redisUrl, { maxRetriesPerRequest: 1 });
  try {
    const seen = new Set<string>();
    for (const pattern of patterns) {
      let cursor = '0';
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = next;
        for (const k of keys) seen.add(k);
      } while (cursor !== '0');
    }
    const out: Record<string, { type: string; value: unknown; ttl: number }> = {};
    for (const key of [...seen].sort()) {
      const [type, value, ttl] = await Promise.all([
        redis.type(key),
        redis.get(key).catch(() => null),
        redis.ttl(key),
      ]);
      out[key] = { type, value, ttl };
    }
    return out;
  } finally {
    redis.disconnect();
  }
}

async function captureClickhouse(
  spec: ClickhouseCaptureSpec,
  ctx: CaptureContext,
): Promise<Record<string, ClickhouseTableSnapshot>> {
  if (spec.tables.length === 0) return {};
  if (!ctx.clickhouseUrl) {
    throw new Error(
      'captureState: clickhouse tables requested but no clickhouseUrl supplied. Pass `backends.clickhouseUrl` explicitly, or run env.up with backends.clickhouse declared.',
    );
  }
  const out: Record<string, ClickhouseTableSnapshot> = {};
  for (const t of spec.tables) {
    const database = t.database ?? ctx.clickhouseDbName ?? 'default';
    const orderBy = t.orderBy ?? null;
    // Use FORMAT JSONEachRow so each line is a complete JSON object — same
    // shape we use for seed insertion, which makes the round-trip cheap to
    // verify in tests. `ORDER BY tuple()` is ClickHouse for "no ordering";
    // when an orderBy column was given, sort by it so snapshots are stable.
    const sortClause = orderBy ? `ORDER BY ${escapeClickhouseIdent(orderBy)}` : '';
    const sql = `SELECT * FROM ${escapeClickhouseIdent(database)}.${escapeClickhouseIdent(t.name)} ${sortClause} FORMAT JSONEachRow`;
    const rows = await clickhouseQueryRows(ctx.clickhouseUrl, sql);
    out[`${database}.${t.name}`] = { orderBy, rows };
  }
  return out;
}

export async function captureState(
  spec: CaptureSpec,
  ctxOverride: Partial<CaptureContext> = {},
): Promise<SnapshotArtifact> {
  const ctx: CaptureContext = { ...DEFAULT_CTX, ...ctxOverride };
  const mongo = spec.mongo
    ? await captureMongo(spec.mongo.collections, ctx)
    : {};
  const redis = spec.redis ? await captureRedis(spec.redis.keyPatterns, ctx) : {};
  const clickhouse = spec.clickhouse ? await captureClickhouse(spec.clickhouse, ctx) : {};
  return {
    snapshotId: newId('snap'),
    takenAt: nowIso(),
    mongo,
    redis,
    clickhouse,
  };
}
