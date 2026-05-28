import { z } from 'zod';

export const MongoCaptureSpec = z.object({
  collections: z.array(z.string().min(1)).min(1),
});

export const RedisCaptureSpec = z.object({
  keyPatterns: z.array(z.string().min(1)).min(1),
});

// ClickHouse tables to snapshot. Each entry names a table (optionally in a
// non-default database) and the column used to key rows for diffing. When
// `orderBy` is omitted, diff falls back to full-row JSON equality and
// reports only added/removed (no modified) — fine for append-only logs.
//
// name / database / orderBy all splice into SQL via escapeClickhouseIdent;
// we still restrict to identifier characters so malformed input gives a
// schema error at the tool boundary rather than reaching the wire.
const SqlIdent = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be a valid SQL identifier');
export const ClickhouseTableSpec = z.object({
  name: SqlIdent,
  /** Defaults to the env's clickhouseDbName (usually "default"). */
  database: SqlIdent.optional(),
  /** Column used as a row key for diff matching (e.g. "id"). Optional. */
  orderBy: SqlIdent.optional(),
});

export const ClickhouseCaptureSpec = z.object({
  tables: z.array(ClickhouseTableSpec).min(1),
});

export const CaptureSpec = z.object({
  mongo: MongoCaptureSpec.optional(),
  redis: RedisCaptureSpec.optional(),
  clickhouse: ClickhouseCaptureSpec.optional(),
}).refine(
  (s) => s.mongo !== undefined || s.redis !== undefined || s.clickhouse !== undefined,
  'CaptureSpec must include at least one of mongo, redis or clickhouse',
);

export const BackendUrls = z.object({
  mongoUrl: z.string().url().optional(),
  dbName: z.string().min(1).optional(),
  redisUrl: z.string().url().optional(),
  // Surfaced so future capture/replay primitives can reach Rabbit; the
  // current capture/diff tools only read mongo + redis + clickhouse.
  rabbitUrl: z.string().url().optional(),
  clickhouseUrl: z.string().url().optional(),
  clickhouseDbName: z.string().min(1).optional(),
});

export const MongoDoc = z.record(z.string(), z.unknown());
export const RedisValue = z.object({
  type: z.string(),
  value: z.unknown(),
  ttl: z.number(),
});

export const ClickhouseTableSnapshot = z.object({
  /** Column used to key rows for diff matching; null when not supplied
   *  (diff falls back to full-row equality). */
  orderBy: z.string().nullable(),
  /** Rows as JSONEachRow returned them, sorted by orderBy when present so
   *  snapshots are stable across captures. */
  rows: z.array(z.record(z.string(), z.unknown())),
});

export const SnapshotArtifact = z.object({
  snapshotId: z.string(),
  takenAt: z.string(),
  // Provenance — captured from the env/project used to take the snapshot.
  // Optional so artifacts written by older daemon versions still parse.
  envId: z.string().optional(),
  projectName: z.string().optional(),
  mongo: z.record(z.string(), z.array(MongoDoc)).default({}),
  redis: z.record(z.string(), RedisValue).default({}),
  // Keyed by "<database>.<table>" so the same table name in different DBs
  // doesn't collide. Default {} keeps old snapshots parseable.
  clickhouse: z.record(z.string(), ClickhouseTableSnapshot).default({}),
});

export type CaptureSpec = z.infer<typeof CaptureSpec>;
export type ClickhouseCaptureSpec = z.infer<typeof ClickhouseCaptureSpec>;
export type ClickhouseTableSpec = z.infer<typeof ClickhouseTableSpec>;
export type ClickhouseTableSnapshot = z.infer<typeof ClickhouseTableSnapshot>;
export type BackendUrls = z.infer<typeof BackendUrls>;
export type SnapshotArtifact = z.infer<typeof SnapshotArtifact>;
