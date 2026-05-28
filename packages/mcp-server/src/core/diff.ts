import type { ClickhouseTableSnapshot, SnapshotArtifact } from '../schemas/capture.js';
import type { DiffArtifact, NoisePolicy } from '../schemas/diff.js';
import { newId } from './ids.js';

const DEFAULT_NOISE_POLICY: NoisePolicy = {
  ignoreTimestampFields: [],
  ignoreRedisTtlDrift: true,
};

function isTimestampField(name: string, policy: NoisePolicy): boolean {
  return policy.ignoreTimestampFields.includes(name);
}

function fieldDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  policy: NoisePolicy,
): Record<string, { from: unknown; to: unknown }> {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    if (isTimestampField(k, policy)) continue;
    const a = before[k];
    const b = after[k];
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      changes[k] = { from: a === undefined ? null : a, to: b === undefined ? null : b };
    }
  }
  return changes;
}

function collectionDiff(
  beforeDocs: Array<Record<string, unknown>> = [],
  afterDocs: Array<Record<string, unknown>> = [],
  policy: NoisePolicy,
) {
  const beforeById = new Map(beforeDocs.map((d) => [String(d._id), d]));
  const afterById = new Map(afterDocs.map((d) => [String(d._id), d]));
  const added: Array<Record<string, unknown>> = [];
  const removed: Array<Record<string, unknown>> = [];
  const modified: Array<{ _id: unknown; changes: Record<string, { from: unknown; to: unknown }> }> = [];
  for (const [id, doc] of afterById) {
    if (!beforeById.has(id)) added.push(doc);
    else {
      const changes = fieldDiff(beforeById.get(id)!, doc, policy);
      if (Object.keys(changes).length > 0) modified.push({ _id: doc._id, changes });
    }
  }
  for (const [id, doc] of beforeById) if (!afterById.has(id)) removed.push(doc);
  return { added, removed, modified };
}

type RedisEntry = { type: string; value?: unknown; ttl: number };
function redisDiff(
  before: Record<string, RedisEntry>,
  after: Record<string, RedisEntry>,
  policy: NoisePolicy,
) {
  const added: Record<string, unknown> = {};
  const removed: Record<string, unknown> = {};
  const modified: Record<string, { from: unknown; to: unknown }> = {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    const b = before[k];
    const a = after[k];
    if (!b && a) {
      added[k] = a;
    } else if (b && !a) {
      removed[k] = b;
    } else if (b && a) {
      const sameValue =
        JSON.stringify(b.value) === JSON.stringify(a.value) && b.type === a.type;
      if (!sameValue) {
        modified[k] = { from: b, to: a };
      } else if (!policy.ignoreRedisTtlDrift && b.ttl !== a.ttl) {
        modified[k] = { from: b, to: a };
      }
    }
  }
  return { added, removed, modified };
}

function clickhouseTableDiff(
  before: ClickhouseTableSnapshot | undefined,
  after: ClickhouseTableSnapshot | undefined,
  policy: NoisePolicy,
) {
  const beforeRows = before?.rows ?? [];
  const afterRows = after?.rows ?? [];
  // Prefer after's orderBy (we're diffing toward the new state); if absent,
  // fall back to before's. When neither side declares a key, identity is
  // the full row JSON.
  const orderBy = after?.orderBy ?? before?.orderBy ?? null;
  if (!orderBy) {
    // Full-row equality. No "modified" possible — a changed row looks like
    // one removed + one added.
    const seenAfter = new Set(afterRows.map((r) => JSON.stringify(r)));
    const seenBefore = new Set(beforeRows.map((r) => JSON.stringify(r)));
    const added = afterRows.filter((r) => !seenBefore.has(JSON.stringify(r)));
    const removed = beforeRows.filter((r) => !seenAfter.has(JSON.stringify(r)));
    return { added, removed, modified: [] as Array<{ key: unknown; changes: Record<string, { from: unknown; to: unknown }> }> };
  }
  const beforeByKey = new Map(beforeRows.map((r) => [JSON.stringify(r[orderBy]), r]));
  const afterByKey = new Map(afterRows.map((r) => [JSON.stringify(r[orderBy]), r]));
  const added: Array<Record<string, unknown>> = [];
  const removed: Array<Record<string, unknown>> = [];
  const modified: Array<{ key: unknown; changes: Record<string, { from: unknown; to: unknown }> }> = [];
  for (const [k, row] of afterByKey) {
    if (!beforeByKey.has(k)) added.push(row);
    else {
      const changes = fieldDiff(beforeByKey.get(k)!, row, policy);
      if (Object.keys(changes).length > 0) modified.push({ key: row[orderBy], changes });
    }
  }
  for (const [k, row] of beforeByKey) if (!afterByKey.has(k)) removed.push(row);
  return { added, removed, modified };
}

export function diffSnapshots(
  before: SnapshotArtifact,
  after: SnapshotArtifact,
  noisePolicy: NoisePolicy = DEFAULT_NOISE_POLICY,
): DiffArtifact {
  const mongoNames = new Set([
    ...Object.keys(before.mongo || {}),
    ...Object.keys(after.mongo || {}),
  ]);
  const mongo: Record<string, ReturnType<typeof collectionDiff>> = {};
  for (const name of mongoNames) {
    mongo[name] = collectionDiff(before.mongo[name], after.mongo[name], noisePolicy);
  }
  const redis = redisDiff(before.redis ?? {}, after.redis ?? {}, noisePolicy);
  const clickhouseNames = new Set([
    ...Object.keys(before.clickhouse || {}),
    ...Object.keys(after.clickhouse || {}),
  ]);
  const clickhouse: Record<string, ReturnType<typeof clickhouseTableDiff>> = {};
  for (const name of clickhouseNames) {
    clickhouse[name] = clickhouseTableDiff(before.clickhouse?.[name], after.clickhouse?.[name], noisePolicy);
  }
  return {
    diffId: newId('diff'),
    beforeSnapshotId: before.snapshotId,
    afterSnapshotId: after.snapshotId,
    beforeTakenAt: before.takenAt,
    afterTakenAt: after.takenAt,
    // Provenance — inherit from after (current state); fall back to before
    // in the rare case the snapshots came from differently-tagged sources.
    envId: after.envId ?? before.envId,
    projectName: after.projectName ?? before.projectName,
    noisePolicy,
    mongo,
    redis,
    clickhouse,
  };
}
