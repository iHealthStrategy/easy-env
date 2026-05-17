import { z } from 'zod';

export const MongoCaptureSpec = z.object({
  collections: z.array(z.string().min(1)).min(1),
});

export const RedisCaptureSpec = z.object({
  keyPatterns: z.array(z.string().min(1)).min(1),
});

export const CaptureSpec = z.object({
  mongo: MongoCaptureSpec.optional(),
  redis: RedisCaptureSpec.optional(),
}).refine(
  (s) => s.mongo !== undefined || s.redis !== undefined,
  'CaptureSpec must include at least one of mongo or redis',
);

export const BackendUrls = z.object({
  mongoUrl: z.string().url().optional(),
  dbName: z.string().min(1).optional(),
  redisUrl: z.string().url().optional(),
});

export const MongoDoc = z.record(z.string(), z.unknown());
export const RedisValue = z.object({
  type: z.string(),
  value: z.unknown(),
  ttl: z.number(),
});

export const SnapshotArtifact = z.object({
  snapshotId: z.string(),
  takenAt: z.string(),
  mongo: z.record(z.string(), z.array(MongoDoc)).default({}),
  redis: z.record(z.string(), RedisValue).default({}),
});

export type CaptureSpec = z.infer<typeof CaptureSpec>;
export type BackendUrls = z.infer<typeof BackendUrls>;
export type SnapshotArtifact = z.infer<typeof SnapshotArtifact>;
