import { z } from 'zod';
import { CaptureSpec, BackendUrls } from '../schemas/capture.js';
import { captureState } from '../core/capture.js';
import type { ToolContext } from '../core/context.js';
import { resolveBackends } from '../core/envOps.js';

export const StateCaptureInput = z.object({
  spec: CaptureSpec,
  envId: z.string().optional(),
  backends: BackendUrls.optional(),
  scenarioId: z.string().optional(),
});

export type StateCaptureInput = z.infer<typeof StateCaptureInput>;

export async function runStateCapture(input: StateCaptureInput, ctx: ToolContext) {
  // Resolution order: explicit backends > envId (or active env) > config > fallback.
  const resolved = await resolveBackends(ctx.registry, ctx.config, input.envId, input.backends);
  const snap = await captureState(input.spec, resolved);
  if (input.scenarioId) await ctx.store.saveSnapshot(input.scenarioId, snap);
  else await ctx.store.saveSnapshot('_adhoc', snap);
  const mongoCollections: Record<string, number> = {};
  for (const [name, docs] of Object.entries(snap.mongo)) {
    mongoCollections[name] = docs.length;
  }
  return {
    snapshotId: snap.snapshotId,
    takenAt: snap.takenAt,
    summary: {
      mongoCollections,
      redisKeys: Object.keys(snap.redis).length,
    },
    resolvedBackends: resolved,
  };
}

export const stateCaptureToolDescription = {
  name: 'state.capture',
  description:
    "Snapshot the current state across configured backends (Mongo collections, Redis keys). Returns a stable snapshotId you can later pass to diff.compare. Backends are resolved in this order: explicit `backends` arg > `envId` (or the active managed env) > easy-env.json defaults > built-in fallbacks.",
  inputSchema: StateCaptureInput,
};
