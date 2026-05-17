import { MongoClient } from 'mongodb';
import Redis from 'ioredis';
import type { CaptureSpec, SnapshotArtifact } from '../schemas/capture.js';
import { newId, nowIso } from './ids.js';

export interface CaptureContext {
  mongoUrl: string;
  dbName: string;
  redisUrl: string;
}

const DEFAULT_CTX: CaptureContext = {
  mongoUrl: 'mongodb://localhost:27018',
  dbName: 'mini',
  redisUrl: 'redis://localhost:6380',
};

async function captureMongo(
  collections: string[],
  ctx: CaptureContext,
): Promise<Record<string, Array<Record<string, unknown>>>> {
  if (collections.length === 0) return {};
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

export async function captureState(
  spec: CaptureSpec,
  ctxOverride: Partial<CaptureContext> = {},
): Promise<SnapshotArtifact> {
  const ctx: CaptureContext = { ...DEFAULT_CTX, ...ctxOverride };
  const mongo = spec.mongo
    ? await captureMongo(spec.mongo.collections, ctx)
    : {};
  const redis = spec.redis ? await captureRedis(spec.redis.keyPatterns, ctx) : {};
  return {
    snapshotId: newId('snap'),
    takenAt: nowIso(),
    mongo,
    redis,
  };
}
