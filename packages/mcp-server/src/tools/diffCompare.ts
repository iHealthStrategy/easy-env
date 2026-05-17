import { z } from 'zod';
import { diffSnapshots } from '../core/diff.js';
import { NoisePolicy } from '../schemas/diff.js';
import type { ToolContext } from '../core/context.js';

export const DiffCompareInput = z.object({
  beforeSnapshotId: z.string(),
  afterSnapshotId: z.string(),
  noisePolicy: NoisePolicy.optional(),
  scenarioId: z.string().optional(),
});

export type DiffCompareInput = z.infer<typeof DiffCompareInput>;

export async function runDiffCompare(input: DiffCompareInput, ctx: ToolContext) {
  const before = await ctx.store.getSnapshot(input.beforeSnapshotId);
  const after = await ctx.store.getSnapshot(input.afterSnapshotId);
  if (!before) throw new Error(`snapshot not found: ${input.beforeSnapshotId}`);
  if (!after) throw new Error(`snapshot not found: ${input.afterSnapshotId}`);
  const diff = diffSnapshots(before, after, input.noisePolicy);
  await ctx.store.saveDiff(input.scenarioId ?? '_adhoc', diff);
  return diff;
}

export const diffCompareToolDescription = {
  name: 'diff.compare',
  description:
    "Diff two snapshots (by id) and return a structured multi-backend diff. Filters incidental noise (timestamp fields, Redis TTL drift) per the optional noisePolicy. The diff is persisted for later retrieval by diffId.",
  inputSchema: DiffCompareInput,
};
