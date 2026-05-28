// Pure-logic tests for ClickHouse capture-diff. Exercises:
//   - diffSnapshots clickhouse path: added / removed / modified by orderBy
//   - the no-orderBy fallback (added/removed only, full-row equality)
//   - the seed schema round-trip (shorthand array vs. { mode, rows } long form)
// Does NOT spin up a container — that's covered by smoke when Docker is around.
import { diffSnapshots } from '../src/core/diff.js';
import { JsonSeedSpec } from '../src/schemas/seed.js';
import { SnapshotArtifact } from '../src/schemas/capture.js';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`CLICKHOUSE DIFF FAIL: ${msg}`);
}

function snap(name: string, takenAt: string, clickhouse: Record<string, { orderBy: string | null; rows: Array<Record<string, unknown>> }>) {
  return SnapshotArtifact.parse({
    snapshotId: name,
    takenAt,
    mongo: {},
    redis: {},
    clickhouse,
  });
}

function main() {
  // ── 1. orderBy diff: added / removed / modified ────────────────────────
  const before = snap('snap_before', '2026-01-01T00:00:00Z', {
    'analytics.events': {
      orderBy: 'id',
      rows: [
        { id: 1, kind: 'click', userId: 'a' },
        { id: 2, kind: 'view', userId: 'b' },
        { id: 3, kind: 'click', userId: 'c' },
      ],
    },
  });
  const after = snap('snap_after', '2026-01-01T00:01:00Z', {
    'analytics.events': {
      orderBy: 'id',
      rows: [
        { id: 2, kind: 'view', userId: 'b' },       // unchanged
        { id: 3, kind: 'purchase', userId: 'c' },   // modified (kind changed)
        { id: 4, kind: 'click', userId: 'd' },      // added
      ],
    },
  });
  const d = diffSnapshots(before, after);
  const t = d.clickhouse['analytics.events'];
  assert(t.added.length === 1 && (t.added[0] as { id: number }).id === 4, 'one row added');
  assert(t.removed.length === 1 && (t.removed[0] as { id: number }).id === 1, 'one row removed');
  assert(t.modified.length === 1 && t.modified[0].key === 3, 'one row modified, keyed by id');
  assert(
    t.modified[0].changes.kind?.from === 'click' && t.modified[0].changes.kind?.to === 'purchase',
    'modified diff captures kind: click → purchase',
  );
  console.log('  ✓ clickhouse diff with orderBy: added / removed / modified');

  // ── 2. No orderBy → full-row equality, no `modified` ───────────────────
  const beforeNoKey = snap('snap_b2', '2026-01-01T00:00:00Z', {
    'default.log': {
      orderBy: null,
      rows: [
        { ts: 100, msg: 'a' },
        { ts: 200, msg: 'b' },
      ],
    },
  });
  const afterNoKey = snap('snap_a2', '2026-01-01T00:01:00Z', {
    'default.log': {
      orderBy: null,
      rows: [
        { ts: 200, msg: 'b' },
        { ts: 300, msg: 'c' },
      ],
    },
  });
  const d2 = diffSnapshots(beforeNoKey, afterNoKey);
  const t2 = d2.clickhouse['default.log'];
  assert(t2.added.length === 1 && (t2.added[0] as { ts: number }).ts === 300, 'one row added (no key)');
  assert(t2.removed.length === 1 && (t2.removed[0] as { ts: number }).ts === 100, 'one row removed (no key)');
  assert(t2.modified.length === 0, 'no modified entries without orderBy');
  console.log('  ✓ clickhouse diff without orderBy: added/removed only');

  // ── 3. Old snapshots without `clickhouse` field default to {} ──────────
  const legacyBefore = SnapshotArtifact.parse({
    snapshotId: 's_legacy_b',
    takenAt: '2026-01-01T00:00:00Z',
    mongo: {},
    redis: {},
    // clickhouse omitted — schema default {} kicks in
  });
  const legacyAfter = SnapshotArtifact.parse({
    snapshotId: 's_legacy_a',
    takenAt: '2026-01-01T00:01:00Z',
    mongo: {},
    redis: {},
  });
  const dLegacy = diffSnapshots(legacyBefore, legacyAfter);
  assert(Object.keys(dLegacy.clickhouse).length === 0, 'legacy snapshots produce empty clickhouse diff');
  console.log('  ✓ legacy snapshots (no clickhouse field) parse + diff cleanly');

  // ── 4. Seed schema: shorthand (array) and long form both parse ────────
  const seed = JsonSeedSpec.parse({
    clickhouse: {
      events: [{ id: 1, kind: 'click' }],
      sessions: { mode: 'insert', rows: [{ id: 'sess-1', userId: 'u' }] },
      profiles: { mode: 'replace', database: 'analytics', rows: [{ id: 'u', name: 'a' }] },
    },
  });
  const ch = seed.clickhouse!;
  assert(Array.isArray(ch.events), 'shorthand array preserved');
  const sessions = ch.sessions as { mode: string; rows: unknown[] };
  assert(!Array.isArray(ch.sessions) && sessions.mode === 'insert', 'insert mode parsed');
  const profiles = ch.profiles as { mode: string; database: string };
  assert(!Array.isArray(ch.profiles) && profiles.database === 'analytics', 'database override parsed');
  console.log('  ✓ JsonSeedSpec clickhouse: array shorthand + long-form modes parse');

  console.log('clickhouse-diff: ALL PASS');
}

main();
