import { z } from 'zod';

// Project-level seed configuration. JSON files run first (declarative
// fixtures applied directly by the daemon), then scripts (imperative
// node processes spawned by the daemon with backend URLs injected).
// Paths are relative to projectRoot.
export const SeedConfig = z.object({
  json: z.array(z.string().min(1)).default([]),
  scripts: z.array(z.string().min(1)).default([]),
});
export type SeedConfig = z.infer<typeof SeedConfig>;

// ── JSON fixture file shape ──────────────────────────────────────────────────
// Two-tier schema: either pass an array of docs (defaults to mode='replace'),
// or pass an explicit { mode, docs } object.

const MongoCollectionShorthand = z.array(z.record(z.string(), z.unknown()));
const MongoCollectionLong = z.object({
  /** replace = drop collection then insertMany (default — most "init"-ish).
   *  upsert  = replaceOne by _id for each doc (preserves untouched docs).
   *  insert  = insertMany, errors on duplicate _id. */
  mode: z.enum(['replace', 'upsert', 'insert']).default('replace'),
  docs: z.array(z.record(z.string(), z.unknown())),
});
const MongoCollection = z.union([MongoCollectionShorthand, MongoCollectionLong]);

const RedisValueShorthand = z.string();
const RedisValueLong = z.object({
  type: z.enum(['string', 'hash', 'list', 'set', 'zset']).default('string'),
  value: z.unknown(),
  ttlSeconds: z.number().int().positive().optional(),
});
const RedisValue = z.union([RedisValueShorthand, RedisValueLong]);

const RabbitExchange = z.object({
  name: z.string().min(1),
  type: z.enum(['direct', 'fanout', 'topic', 'headers']).default('topic'),
  durable: z.boolean().default(true),
  autoDelete: z.boolean().default(false),
  arguments: z.record(z.unknown()).default({}),
});

const RabbitQueue = z.object({
  name: z.string().min(1),
  durable: z.boolean().default(true),
  autoDelete: z.boolean().default(false),
  exclusive: z.boolean().default(false),
  arguments: z.record(z.unknown()).default({}),
});

const RabbitBinding = z.object({
  /** Source exchange name. */
  source: z.string().min(1),
  /** Destination queue name (exchange→exchange bindings not supported in v1). */
  destination: z.string().min(1),
  routingKey: z.string().default(''),
  arguments: z.record(z.unknown()).default({}),
});

const RabbitTopology = z.object({
  exchanges: z.array(RabbitExchange).default([]),
  queues: z.array(RabbitQueue).default([]),
  bindings: z.array(RabbitBinding).default([]),
});

// ── ClickHouse table seed ─────────────────────────────────────────────────
// Tables must already exist (we don't run DDL — schemas are too engine-specific).
// Use a seed script to CREATE TABLE if you need that. JSON seeds only insert rows.
const ClickhouseTableShorthand = z.array(z.record(z.string(), z.unknown()));
const ClickhouseTableLong = z.object({
  /** replace = TRUNCATE then INSERT (default — most "init"-ish).
   *  insert  = append rows; errors are surfaced.
   *  ClickHouse has no upsert semantics for vanilla MergeTree, so we don't
   *  expose one — use ReplacingMergeTree + insert if you need that. */
  mode: z.enum(['replace', 'insert']).default('replace'),
  /** Override the database (defaults to env's clickhouseDbName). */
  database: z.string().min(1).optional(),
  rows: z.array(z.record(z.string(), z.unknown())),
});
const ClickhouseTable = z.union([ClickhouseTableShorthand, ClickhouseTableLong]);

export const JsonSeedSpec = z.object({
  // { dbName: { collectionName: [docs] | { mode, docs } } }
  mongo: z.record(z.string(), z.record(z.string(), MongoCollection)).optional(),
  // { key: stringValue | { type, value, ttlSeconds? } }
  redis: z.record(z.string(), RedisValue).optional(),
  // exchanges / queues / bindings — all declared idempotently against the
  // RabbitMQ Management HTTP API (default vhost '/').
  rabbit: RabbitTopology.optional(),
  // { tableName: [rows] | { mode, database?, rows } }
  clickhouse: z.record(z.string(), ClickhouseTable).optional(),
});
export type JsonSeedSpec = z.infer<typeof JsonSeedSpec>;
export type RabbitTopology = z.infer<typeof RabbitTopology>;

// ── Tool I/O ────────────────────────────────────────────────────────────────

export const StateSeedInput = z.object({
  projectName: z.string().min(1),
  projectRoot: z.string().min(1),
  /** Run env.reset (fast: dropDatabase + flushdb against the active env)
   *  before applying seeds. Rabbit topology is always idempotent so reset
   *  is a no-op there. */
  reset: z.boolean().default(false),
  /** Restrict which files to run. Indices into manifest.seed.json /
   *  manifest.seed.scripts; absent → run all. */
  only: z.object({
    json: z.array(z.number().int().nonnegative()).optional(),
    scripts: z.array(z.number().int().nonnegative()).optional(),
  }).optional(),
});
export type StateSeedInput = z.infer<typeof StateSeedInput>;

export const SeedJsonResult = z.object({
  file: z.string(),
  mongo: z.array(z.object({
    db: z.string(),
    collection: z.string(),
    mode: z.string(),
    inserted: z.number(),
  })).default([]),
  redis: z.array(z.object({
    key: z.string(),
    type: z.string(),
  })).default([]),
  rabbit: z.object({
    exchanges: z.number(),
    queues: z.number(),
    bindings: z.number(),
  }).optional(),
  clickhouse: z.array(z.object({
    database: z.string(),
    table: z.string(),
    mode: z.string(),
    inserted: z.number(),
  })).default([]),
  durationMs: z.number(),
});

export const SeedScriptResult = z.object({
  file: z.string(),
  exitCode: z.number().nullable(),
  durationMs: z.number(),
  stdoutTail: z.string().optional(),
  stderrTail: z.string().optional(),
});

export const StateSeedResult = z.object({
  projectName: z.string(),
  envId: z.string().nullable(),
  reset: z.boolean(),
  json: z.array(SeedJsonResult),
  scripts: z.array(SeedScriptResult),
});
export type StateSeedResult = z.infer<typeof StateSeedResult>;
