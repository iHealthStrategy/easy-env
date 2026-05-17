// In-memory ring buffer of recent tool calls. Lets the Web UI surface
// "what has the MCP been doing?" without adding a persistent store.
// Cleared when the daemon restarts.

export interface ActivityEntry {
  id: number;
  tool: string;
  startedAt: string;
  durationMs: number;
  status: 'ok' | 'error';
  errorMessage?: string;
}

const MAX_ENTRIES = 200;

export class ActivityLog {
  private entries: ActivityEntry[] = [];
  private nextId = 1;
  private totals = { ok: 0, error: 0 };

  record(entry: Omit<ActivityEntry, 'id'>): ActivityEntry {
    const full: ActivityEntry = { id: this.nextId++, ...entry };
    this.entries.push(full);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    }
    this.totals[entry.status] += 1;
    return full;
  }

  /** Most-recent-first slice. */
  recent(limit = 50): ActivityEntry[] {
    const start = Math.max(0, this.entries.length - limit);
    return this.entries.slice(start).reverse();
  }

  stats() {
    return {
      total: this.totals.ok + this.totals.error,
      ok: this.totals.ok,
      error: this.totals.error,
    };
  }
}
