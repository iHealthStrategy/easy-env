// TrafficMonitor — per-env, opt-in MongoDB traffic capture via the database
// profiler. The mechanism is entirely native MongoDB: for each SELECTED
// database we set profiling level 2 (profile every operation) and poll that
// database's capped `system.profile` collection, feeding the operations into
// a bounded in-memory ring buffer keyed by envId. Nothing is persisted; a
// daemon restart starts clean.
//
// WHY per-database, not one global stream: MongoDB profiling is scoped per
// database — `setProfilingLevel(2)` affects only that db, and each db has its
// own `system.profile`. So "watch db X and Y" means: enable profiling on each
// and run one poller per db, all writing into the shared per-env ring.
//
// WHY polling, not a tailable cursor: a tailable cursor on `system.profile`
// dies on capped-collection wrap and has fragile empty-collection semantics.
// A 400ms poll feels instant for a debug view. We seed the poll floor at the
// epoch (`new Date(0)`) rather than a host wall-clock: startDb drops+recreates
// system.profile EMPTY, so "everything in the collection" is exactly the
// post-enable traffic — and we avoid comparing the daemon's clock against the
// mongod server clock (they drift under Docker-on-macOS). Caveat: two ops in
// the same millisecond at a poll boundary can be missed — acceptable for a
// debugging aid (this is not an audit log).
//
// CONCURRENCY: one TrafficMonitor instance is shared across every daemon
// request (it lives on the daemon-scoped ToolContext). enable/disable/stopEnv
// for a given env are therefore serialized through a per-env async lock so
// their multi-await reconciliation can't interleave (which would orphan
// pollers or leak clients). A torn-down envId is remembered so a request that
// raced env.down can't resurrect a monitor for a dead container.
//
// Ownership: this module never accepts a connection URL from a tool input.
// Callers pass the URL pulled from `env.resolved.mongoUrl` via the
// ensureManagedEnv guard, so we only ever connect to easy-env-owned mongods.
import { MongoClient } from 'mongodb';

// Ring buffer cap per env. Bounded so a chatty app can't grow memory without
// limit; oldest entries are dropped and counted.
const RING_CAP = 500;
// system.profile is a capped collection. The default (~1MB) churns fast under
// level-2 profiling; 8MB gives a useful window while staying well within the
// mongo container's 512MB tmpfs /data/db budget even with several dbs watched.
const PROFILE_COLL_SIZE = 8 * 1024 * 1024;
// Cap the serialized command blob so a huge insert/aggregate payload can't
// bloat the ring.
const COMMAND_BLOB_CAP = 4096;
const POLL_MS = 400;
const CONNECT_TIMEOUT_MS = 5000;
// Hard ceiling on concurrently profiled dbs per env — a backstop against a
// project with a pathological number of databases. Surfaced (not silent).
const MAX_DBS = 20;

// System databases never offered as monitor targets.
const SYSTEM_DBS = new Set(['admin', 'local', 'config']);

// Driver/handshake commands we never surface as "app traffic" — pure protocol
// or session bookkeeping, keyed by the first field of the profiled command
// document. Deliberately NARROW: app-issued DDL (create/drop/createCollection)
// and cursor continuation (getMore) ARE real application traffic a debugger
// wants to see, so they are NOT here. easy-env's own system.profile DDL runs
// while profiling is OFF (see startDb), so it is never recorded regardless.
const ADMIN_CMD_DENYLIST = new Set([
  'profile', 'listCollections', 'listDatabases', 'listIndexes',
  'dbStats', 'collStats', 'ping', 'hello', 'ismaster', 'isMaster',
  'buildInfo', 'getnonce', 'saslStart', 'saslContinue', 'endSessions',
]);

export interface TrafficEntry {
  id: number;
  ts: string; // ISO timestamp from the profiler
  db: string;
  ns: string; // db.collection (or db.$cmd)
  collection: string;
  op: string; // query | insert | update | remove | command | getmore | ...
  durationMs: number;
  nreturned?: number;
  planSummary?: string;
  command: string; // truncated JSON of the profiled command/filter
  appName?: string;
  client?: string;
}

export interface TrafficStatus {
  enabled: boolean;
  databases: string[];
  buffered: number;
  dropped: number;
}

interface DbWatch {
  active: boolean;
}

interface EnvState {
  client: MongoClient | null;
  dbs: Map<string, DbWatch>;
  ring: TrafficEntry[];
  dropped: number;
  nextId: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function safeJson(value: unknown): string {
  try {
    // bson types (ObjectId, etc.) define toJSON, so they render readably.
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…(+${s.length - max})` : s;
}

export class TrafficMonitor {
  private envs = new Map<string, EnvState>();
  // Per-env serialization: each mutating op chains onto the previous so
  // enable/disable/stopEnv for the same env never interleave at an await.
  private locks = new Map<string, Promise<unknown>>();
  // envIds whose monitor was fully torn down (env.down/env.reset). Never
  // resurrect one — envIds are unique per env.up, so a torn-down id is dead
  // forever. Grows by one per env teardown this daemon session; cleared on
  // daemon restart (the Map starts empty).
  private destroyed = new Set<string>();

  /** Serialize `fn` after any in-flight op for this env. The stored tail
   *  swallows errors so one failed op doesn't wedge the chain. */
  private withLock<T>(envId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(envId) ?? Promise.resolve();
    const run = prev.then(() => fn(), () => fn());
    this.locks.set(envId, run.then(() => undefined, () => undefined));
    return run;
  }

  /**
   * List candidate monitor targets on an owned mongo instance: user databases
   * (system dbs filtered out). Uses a short-lived connection so discovery
   * never entangles with an active monitor's client lifecycle. `mongoUrl`
   * MUST be the verbatim env.resolved.mongoUrl (preserves replicaSet params).
   */
  async listDatabases(mongoUrl: string): Promise<string[]> {
    const client = await MongoClient.connect(mongoUrl, { serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS });
    try {
      const { databases } = await client.db().admin().listDatabases({ nameOnly: true });
      return databases
        .map((d) => d.name)
        .filter((name) => !SYSTEM_DBS.has(name))
        .sort();
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  /**
   * Reconcile the set of profiled databases for an env to exactly
   * `databases`. Starts profiling + a poller for newly-selected dbs, stops
   * them for deselected ones. An empty list (or after deselecting everything)
   * closes the client but KEEPS the ring buffer so recent traffic stays
   * readable after a pause. `mongoUrl` is the verbatim resolved URL.
   */
  async enable(envId: string, mongoUrl: string, databases: string[]): Promise<TrafficStatus> {
    return this.withLock(envId, async () => {
      // Never resurrect a torn-down env (a request that raced env.down).
      if (this.destroyed.has(envId)) {
        return { enabled: false, databases: [], buffered: 0, dropped: 0 };
      }
      // Never profile system dbs — meaningless and noisy.
      const wanted = [...new Set(databases.filter((d) => d && !SYSTEM_DBS.has(d)))];
      if (wanted.length > MAX_DBS) {
        throw new Error(
          `cannot monitor ${wanted.length} databases at once (max ${MAX_DBS}). Narrow your selection.`,
        );
      }
      const target = new Set(wanted);
      let state = this.envs.get(envId);
      if (!state) {
        state = { client: null, dbs: new Map(), ring: [], dropped: 0, nextId: 1 };
        this.envs.set(envId, state);
      }
      if (target.size > 0 && !state.client) {
        state.client = await MongoClient.connect(mongoUrl, { serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS });
      }
      // Stop dbs no longer wanted.
      for (const db of [...state.dbs.keys()]) {
        if (!target.has(db)) await this.stopDb(state, db);
      }
      // Start newly-wanted dbs. Per-db isolation: one db failing to start
      // (e.g. a transient profile:2 error) rolls itself back and does not
      // abort the others or leave a half-registered db.
      const failed: string[] = [];
      for (const db of target) {
        if (!state.dbs.has(db)) {
          try {
            await this.startDb(envId, state, db);
          } catch (e) {
            failed.push(db);
            console.error(`[easy-env] traffic: failed to start monitoring ${db}: ${e instanceof Error ? e.message : e}`);
          }
        }
      }
      // Nothing active → drop the client but keep the buffer.
      if (state.dbs.size === 0 && state.client) {
        await state.client.close().catch(() => undefined);
        state.client = null;
      }
      return this.status(envId);
    });
  }

  /** Stop profiling + pollers for this env, close the client, but keep the
   *  ring buffer so `recent()` still returns the captured history. */
  async disable(envId: string): Promise<TrafficStatus> {
    return this.withLock(envId, async () => {
      const state = this.envs.get(envId);
      if (!state) return { enabled: false, databases: [], buffered: 0, dropped: 0 };
      for (const db of [...state.dbs.keys()]) await this.stopDb(state, db);
      if (state.client) {
        await state.client.close().catch(() => undefined);
        state.client = null;
      }
      return this.status(envId);
    });
  }

  /** Full teardown: stop everything AND drop the buffer. Called when the env
   *  itself goes away (env.down / env.reset) so nothing leaks or orphans. The
   *  envId is remembered so a racing enable can't resurrect it. */
  async stopEnv(envId: string): Promise<void> {
    await this.withLock(envId, async () => {
      this.destroyed.add(envId);
      const state = this.envs.get(envId);
      if (!state) return;
      for (const db of [...state.dbs.keys()]) await this.stopDb(state, db);
      if (state.client) await state.client.close().catch(() => undefined);
      this.envs.delete(envId);
    });
  }

  /** Stop everything for every env. Called at daemon shutdown. */
  async stopAll(): Promise<void> {
    await Promise.allSettled([...this.envs.keys()].map((id) => this.stopEnv(id)));
  }

  /** Most-recent-first slice of captured traffic, optionally filtered. */
  recent(envId: string, opts: { limit?: number; db?: string; op?: string } = {}): TrafficEntry[] {
    const state = this.envs.get(envId);
    if (!state) return [];
    let rows = state.ring;
    if (opts.db) rows = rows.filter((r) => r.db === opts.db);
    if (opts.op) rows = rows.filter((r) => r.op === opts.op);
    const limit = Math.min(RING_CAP, Math.max(1, opts.limit ?? 100));
    return rows.slice(-limit).reverse();
  }

  status(envId: string): TrafficStatus {
    const state = this.envs.get(envId);
    if (!state) return { enabled: false, databases: [], buffered: 0, dropped: 0 };
    const dbs = [...state.dbs.keys()].sort();
    return { enabled: dbs.length > 0, databases: dbs, buffered: state.ring.length, dropped: state.dropped };
  }

  // ── internals (all callers hold the per-env lock) ────────────────────────

  private async startDb(envId: string, state: EnvState, db: string): Promise<void> {
    const dbh = state.client!.db(db);
    // Profiling must be OFF to resize system.profile. Drop + recreate it
    // capped at our larger size, then turn level-2 profiling on. The
    // profile:0 / drop / create commands run while profiling is off, so they
    // are not themselves recorded.
    await dbh.command({ profile: 0 }).catch(() => undefined);
    await dbh.collection('system.profile').drop().catch(() => undefined);
    await dbh.createCollection('system.profile', { capped: true, size: PROFILE_COLL_SIZE }).catch(() => undefined);
    try {
      await dbh.command({ profile: 2 });
    } catch (e) {
      // Roll back so a failed start doesn't leave the mongod at level 2.
      await dbh.command({ profile: 0 }).catch(() => undefined);
      throw e;
    }
    // Register only AFTER profiling is confirmed on, then launch the detached
    // poller bound to this watch. Capture everything in the freshly-recreated
    // (empty) collection — see the file header on why we don't use a clock.
    const watch: DbWatch = { active: true };
    state.dbs.set(db, watch);
    void this.runPoller(envId, db, watch);
  }

  private async stopDb(state: EnvState, db: string): Promise<void> {
    const watch = state.dbs.get(db);
    if (!watch) return;
    watch.active = false; // stop the poller on its next tick
    // Reset profiling BEFORE forgetting the db. If this fails we surface it
    // (the mongod may still be at level 2) rather than swallowing silently.
    try {
      if (state.client) await state.client.db(db).command({ profile: 0 });
    } catch (e) {
      console.error(
        `[easy-env] traffic: failed to reset profiling for ${db} — it may still be ON: ${e instanceof Error ? e.message : e}`,
      );
    }
    state.dbs.delete(db);
  }

  private async runPoller(envId: string, db: string, watch: DbWatch): Promise<void> {
    // Seed at the epoch: the collection was just recreated empty, so this
    // captures all post-enable ops without comparing host vs server clocks.
    let lastTs = new Date(0);
    while (watch.active) {
      const state = this.envs.get(envId);
      if (!state || !state.client) break;
      try {
        const docs = await state.client
          .db(db)
          .collection('system.profile')
          .find({ ts: { $gt: lastTs } })
          .sort({ ts: 1 })
          .limit(RING_CAP)
          .toArray();
        for (const doc of docs) {
          const ts = doc.ts instanceof Date ? doc.ts : undefined;
          if (ts && ts > lastTs) lastTs = ts;
          this.ingest(state, db, doc);
        }
      } catch {
        // Connection dropped (env torn down) or transient error. If still
        // active, the next loop re-checks state.client and retries.
      }
      if (!watch.active) break;
      await sleep(POLL_MS);
    }
  }

  private ingest(state: EnvState, db: string, doc: Record<string, unknown>): void {
    const ns = typeof doc.ns === 'string' ? doc.ns : `${db}.?`;
    const collection = ns.startsWith(`${db}.`) ? ns.slice(db.length + 1) : ns;
    // Drop the profiler's own collection traffic (our poller's find/getMore).
    if (collection === 'system.profile') return;
    const op = typeof doc.op === 'string' ? doc.op : 'command';
    const command = (doc.command ?? {}) as Record<string, unknown>;
    // Filter driver/handshake bookkeeping (keyed by the command name) so the
    // view shows app traffic only. App DDL + getMore are intentionally kept.
    const firstKey = Object.keys(command)[0];
    if (firstKey && ADMIN_CMD_DENYLIST.has(firstKey)) return;

    const entry: TrafficEntry = {
      id: state.nextId++,
      ts: (doc.ts instanceof Date ? doc.ts : new Date()).toISOString(),
      db,
      ns,
      collection,
      op,
      durationMs: typeof doc.millis === 'number' ? doc.millis : 0,
      nreturned: typeof doc.nreturned === 'number' ? doc.nreturned : undefined,
      planSummary: typeof doc.planSummary === 'string' ? doc.planSummary : undefined,
      command: truncate(safeJson(command), COMMAND_BLOB_CAP),
      appName: typeof doc.appName === 'string' ? doc.appName : undefined,
      client: typeof doc.client === 'string' ? doc.client : undefined,
    };
    state.ring.push(entry);
    if (state.ring.length > RING_CAP) {
      const overflow = state.ring.length - RING_CAP;
      state.ring.splice(0, overflow);
      state.dropped += overflow;
    }
  }
}
