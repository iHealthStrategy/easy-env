import { z } from 'zod';

export const MongoCollectionDiff = z.object({
  added: z.array(z.record(z.string(), z.unknown())),
  removed: z.array(z.record(z.string(), z.unknown())),
  modified: z.array(
    z.object({
      _id: z.unknown(),
      changes: z.record(
        z.string(),
        z.object({ from: z.unknown(), to: z.unknown() }),
      ),
    }),
  ),
});

export const RedisDiff = z.object({
  added: z.record(z.string(), z.unknown()),
  removed: z.record(z.string(), z.unknown()),
  modified: z.record(
    z.string(),
    z.object({ from: z.unknown(), to: z.unknown() }),
  ),
});

export const DiffArtifact = z.object({
  diffId: z.string(),
  beforeSnapshotId: z.string(),
  afterSnapshotId: z.string(),
  beforeTakenAt: z.string(),
  afterTakenAt: z.string(),
  // Provenance — inherited from the underlying snapshots. Optional because
  // legacy diffs and snapshots without an envId pass through unchanged.
  envId: z.string().optional(),
  projectName: z.string().optional(),
  noisePolicy: z.object({
    ignoreTimestampFields: z.array(z.string()).default([]),
    ignoreRedisTtlDrift: z.boolean().default(true),
  }).default(() => ({ ignoreTimestampFields: [], ignoreRedisTtlDrift: true })),
  mongo: z.record(z.string(), MongoCollectionDiff),
  redis: RedisDiff,
});

export const NoisePolicy = z.object({
  ignoreTimestampFields: z.array(z.string()).default([]),
  ignoreRedisTtlDrift: z.boolean().default(true),
});

export type DiffArtifact = z.infer<typeof DiffArtifact>;
export type NoisePolicy = z.infer<typeof NoisePolicy>;
