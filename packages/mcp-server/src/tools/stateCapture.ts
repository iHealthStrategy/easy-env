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
  // Resolution order: explicit backends > envId (or active env) > built-in fallback.
  const resolved = await resolveBackends(ctx.registry, input.envId, input.backends);
  const raw = await captureState(input.spec, resolved);
  // Provenance — tag the snapshot with the env it came from (so the UI can
  // group snapshots by env/project later). Best-effort: if the env was torn
  // down between resolveBackends and now we just skip the project lookup.
  const envId = resolved.envId;
  let projectName: string | undefined;
  if (envId) {
    const env = await ctx.registry.get(envId).catch(() => null);
    projectName = env?.labels?.['easy-env.project'];
  }
  const snap = { ...raw, envId, projectName };
  if (input.scenarioId) await ctx.store.saveSnapshot(input.scenarioId, snap);
  else await ctx.store.saveSnapshot('_adhoc', snap);
  const mongoCollections: Record<string, number> = {};
  for (const [name, docs] of Object.entries(snap.mongo)) {
    mongoCollections[name] = docs.length;
  }
  const clickhouseTables: Record<string, number> = {};
  for (const [name, table] of Object.entries(snap.clickhouse ?? {})) {
    clickhouseTables[name] = table.rows.length;
  }
  return {
    snapshotId: snap.snapshotId,
    takenAt: snap.takenAt,
    summary: {
      mongoCollections,
      redisKeys: Object.keys(snap.redis).length,
      clickhouseTables,
    },
    resolvedBackends: resolved,
  };
}

export const stateCaptureToolDescription = {
  name: 'state.capture',
  description:
    "Snapshot the current state across configured backends (Mongo collections, Redis keys, ClickHouse tables). For ClickHouse, pass spec.clickhouse.tables as [{ name, database?, orderBy? }]; orderBy enables per-row diffing (added/removed/modified) — omit it for append-only logs (added/removed only, no modified). Returns a stable snapshotId you can later pass to diff.compare. Backends are resolved in this order: explicit `backends` arg > `envId` (or the active managed env) > built-in fallbacks.",
  inputSchema: StateCaptureInput,
};
