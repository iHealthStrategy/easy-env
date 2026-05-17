// Per-project manifest. One JSON blob per project name. The daemon's
// authoritative source for backends config + declared variable names.
//
// IMPORTANT: the daemon never reads anything inside the project's own
// directory. All structural data lives here. The AI is responsible for
// reading the project (easy-env.json, source, compose, …) and pushing
// the relevant fields here via env.init / vars.declare.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ProjectManifest } from '../schemas/manifest.js';

function homeRoot(): string {
  return (
    process.env.EASY_ENV_HOME
    ?? process.env.STATE_DIFF_HOME
    ?? path.join(os.homedir(), '.easy-env')
  );
}

export class ProjectNameConflictError extends Error {
  constructor(
    public readonly name: string,
    public readonly existingRoot: string,
    public readonly incomingRoot: string,
  ) {
    super(
      `project name "${name}" already registered with projectRoot=${existingRoot}, ` +
      `but this request came from projectRoot=${incomingRoot}. ` +
      `Rename one project (set a different "name" in its easy-env.json) and retry.`,
    );
    this.name = name;
  }
}

export class ProjectManifestStore {
  constructor(private root: string = path.join(homeRoot(), 'projects')) {}

  private fileFor(name: string): string {
    return path.join(this.root, name, 'manifest.json');
  }

  async read(name: string): Promise<ProjectManifest | null> {
    const f = this.fileFor(name);
    try {
      const raw = await fs.readFile(f, 'utf8');
      return ProjectManifest.parse(JSON.parse(raw));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  // Atomic full-write. Caller is expected to have read-modified-written.
  async write(manifest: ProjectManifest): Promise<void> {
    const parsed = ProjectManifest.parse(manifest);
    const f = this.fileFor(parsed.name);
    await fs.mkdir(path.dirname(f), { recursive: true });
    const tmp = `${f}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(parsed, null, 2));
    await fs.rename(tmp, f);
  }

  /**
   * Load existing manifest or initialise a new one. Enforces the
   * "projectName is unique per projectRoot" invariant — if a manifest
   * already exists under this name but with a different projectRoot,
   * throws ProjectNameConflictError so the caller can surface a clear
   * message to the AI/user.
   */
  async loadOrInit(name: string, projectRoot: string): Promise<ProjectManifest> {
    const existing = await this.read(name);
    if (existing) {
      if (existing.projectRoot !== projectRoot) {
        throw new ProjectNameConflictError(name, existing.projectRoot, projectRoot);
      }
      return existing;
    }
    return ProjectManifest.parse({ name, projectRoot, backends: {}, variables: [] });
  }

  async delete(name: string): Promise<void> {
    const f = this.fileFor(name);
    await fs.rm(f, { force: true });
  }

  async list(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.root, { withFileTypes: true });
      const out: string[] = [];
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        try {
          await fs.access(path.join(this.root, e.name, 'manifest.json'));
          out.push(e.name);
        } catch {
          // No manifest in this dir — ignore (might be a vars-only legacy dir).
        }
      }
      return out;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
  }
}
