// Per-project variable values. One JSON blob per project identity,
// keyed by the same slug as ProjectManifestStore (see ./projectKey.ts).
// The file at ~/.easy-env/projects/<slug>/vars.json is owned exclusively
// by the daemon. Web UI mutates it through `vars.set`; it's not meant
// to be hand-edited.
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  projectsRoot,
  slugFor,
  resolveSlugFromName,
} from './projectKey.js';

export type VarValue = string | number | boolean | null;
export type VarsMap = Record<string, VarValue>;

export class ProjectVarsStore {
  constructor(private root: string = projectsRoot()) {}

  /** Slug helper for callers that already know both name + root (e.g.
   *  varsDeclare). Avoids a redundant dir scan via resolveSlugFromName. */
  private fileForSlug(slug: string): string {
    return path.join(this.root, slug, 'vars.json');
  }

  /** Resolve `key` (either a slug or bare projectName) to its slug. When
   *  projectRoot is provided we can derive the slug deterministically;
   *  otherwise we scan for a single match. */
  private async resolveSlug(key: string, projectRoot?: string): Promise<string> {
    if (projectRoot) return slugFor(key, projectRoot);
    return resolveSlugFromName(key, this.root);
  }

  async readAll(key: string, projectRoot?: string): Promise<VarsMap> {
    const slug = await this.resolveSlug(key, projectRoot);
    const f = this.fileForSlug(slug);
    try {
      const raw = await fs.readFile(f, 'utf8');
      const parsed = raw ? JSON.parse(raw) : {};
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return {};
      }
      return parsed as VarsMap;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw e;
    }
  }

  async writeAll(key: string, vars: VarsMap, projectRoot?: string): Promise<void> {
    const slug = await this.resolveSlug(key, projectRoot);
    const f = this.fileForSlug(slug);
    await fs.mkdir(path.dirname(f), { recursive: true });
    // Atomic write: write to temp then rename.
    const tmp = `${f}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(vars, null, 2));
    await fs.rename(tmp, f);
  }

  async set(key: string, name: string, value: VarValue, projectRoot?: string): Promise<VarsMap> {
    const current = await this.readAll(key, projectRoot);
    current[name] = value;
    await this.writeAll(key, current, projectRoot);
    return current;
  }

  async unset(key: string, name: string, projectRoot?: string): Promise<VarsMap> {
    const current = await this.readAll(key, projectRoot);
    delete current[name];
    await this.writeAll(key, current, projectRoot);
    return current;
  }
}
