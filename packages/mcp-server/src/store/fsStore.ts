import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { SnapshotArtifact } from '../schemas/capture.js';
import type { DiffArtifact } from '../schemas/diff.js';
import type { RunArtifact, ScenarioConfig } from '../schemas/scenario.js';

export interface ArtifactSummary {
  id: string;
  takenAt: string;
  sizeBytes: number;
}

export interface Store {
  saveScenario(scenario: ScenarioConfig): Promise<void>;
  getScenario(id: string): Promise<ScenarioConfig | null>;
  saveSnapshot(scenarioId: string, snapshot: SnapshotArtifact): Promise<void>;
  getSnapshot(snapshotId: string): Promise<SnapshotArtifact | null>;
  listSnapshots(): Promise<ArtifactSummary[]>;
  saveDiff(scenarioId: string, diff: DiffArtifact): Promise<void>;
  getDiff(diffId: string): Promise<DiffArtifact | null>;
  listDiffs(): Promise<ArtifactSummary[]>;
  saveRun(scenarioId: string, run: RunArtifact): Promise<void>;
  listRuns(scenarioId: string): Promise<string[]>;
}

export class FsStore implements Store {
  constructor(private root: string) {}

  static default(): FsStore {
    const root = process.env.EASY_ENV_HOME
      ?? process.env.STATE_DIFF_HOME  // legacy
      ?? path.join(os.homedir(), '.easy-env');
    return new FsStore(root);
  }

  private async ensureDir(p: string): Promise<void> {
    await fs.mkdir(p, { recursive: true });
  }

  private async writeJson(p: string, obj: unknown): Promise<void> {
    await this.ensureDir(path.dirname(p));
    await fs.writeFile(p, JSON.stringify(obj, null, 2));
  }

  private async readJson<T>(p: string): Promise<T | null> {
    try {
      const raw = await fs.readFile(p, 'utf8');
      return JSON.parse(raw) as T;
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
      throw e;
    }
  }

  private scenarioDir(id: string) { return path.join(this.root, 'scenarios', id); }
  private snapshotPath(id: string) { return path.join(this.root, 'snapshots', `${id}.json`); }
  private diffPath(id: string) { return path.join(this.root, 'diffs', `${id}.json`); }

  async saveScenario(scenario: ScenarioConfig): Promise<void> {
    await this.writeJson(path.join(this.scenarioDir(scenario.id), 'scenario.json'), scenario);
  }

  async getScenario(id: string): Promise<ScenarioConfig | null> {
    return this.readJson(path.join(this.scenarioDir(id), 'scenario.json'));
  }

  async saveSnapshot(scenarioId: string, snapshot: SnapshotArtifact): Promise<void> {
    await this.writeJson(this.snapshotPath(snapshot.snapshotId), snapshot);
    // also leave a per-scenario pointer
    await this.ensureDir(path.join(this.scenarioDir(scenarioId), 'snapshots'));
    await fs.writeFile(
      path.join(this.scenarioDir(scenarioId), 'snapshots', `${snapshot.snapshotId}.txt`),
      this.snapshotPath(snapshot.snapshotId),
    );
  }

  async getSnapshot(snapshotId: string): Promise<SnapshotArtifact | null> {
    return this.readJson(this.snapshotPath(snapshotId));
  }

  async listSnapshots(): Promise<ArtifactSummary[]> {
    return this.listArtifacts(path.join(this.root, 'snapshots'), 'takenAt');
  }

  async saveDiff(scenarioId: string, diff: DiffArtifact): Promise<void> {
    await this.writeJson(this.diffPath(diff.diffId), diff);
    await this.ensureDir(path.join(this.scenarioDir(scenarioId), 'diffs'));
    await fs.writeFile(
      path.join(this.scenarioDir(scenarioId), 'diffs', `${diff.diffId}.txt`),
      this.diffPath(diff.diffId),
    );
  }

  async getDiff(diffId: string): Promise<DiffArtifact | null> {
    return this.readJson(this.diffPath(diffId));
  }

  async listDiffs(): Promise<ArtifactSummary[]> {
    return this.listArtifacts(path.join(this.root, 'diffs'), 'afterTakenAt');
  }

  private async listArtifacts(dir: string, takenAtField: string): Promise<ArtifactSummary[]> {
    if (!fsSync.existsSync(dir)) return [];
    const files = await fs.readdir(dir);
    const out: ArtifactSummary[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const full = path.join(dir, f);
      try {
        const stat = await fs.stat(full);
        const parsed = await this.readJson<Record<string, unknown>>(full);
        if (!parsed) continue;
        const takenAt = typeof parsed[takenAtField] === 'string' ? (parsed[takenAtField] as string) : stat.mtime.toISOString();
        out.push({ id: f.replace(/\.json$/, ''), takenAt, sizeBytes: stat.size });
      } catch {
        // skip corrupt artifacts
      }
    }
    return out.sort((a, b) => b.takenAt.localeCompare(a.takenAt));
  }

  async saveRun(scenarioId: string, run: RunArtifact): Promise<void> {
    await this.writeJson(
      path.join(this.scenarioDir(scenarioId), 'runs', `${run.runId}.json`),
      run,
    );
  }

  async listRuns(scenarioId: string): Promise<string[]> {
    const dir = path.join(this.scenarioDir(scenarioId), 'runs');
    if (!fsSync.existsSync(dir)) return [];
    const files = await fs.readdir(dir);
    return files.filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
  }
}
