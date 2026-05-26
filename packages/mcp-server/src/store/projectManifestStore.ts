// Per-project manifest. One JSON blob per project IDENTITY (projectName
// scoped by projectRoot — see ./projectKey.ts). The daemon's authoritative
// source for backends config + declared variable names.
//
// IMPORTANT: the daemon never reads anything inside the project's own
// directory. All structural data lives here. The AI is responsible for
// reading the project (easy-env.json, source, compose, …) and pushing
// the relevant fields here via env.init / vars.declare.
//
// On disk: ~/.easy-env/projects/<slug>/manifest.json where
// slug = `<projectName>__<8hexHashOfProjectRoot>`. Two worktrees of the
// same project resolve to two slugs and never share state.
import fs from 'node:fs/promises';
import path from 'node:path';
import { ProjectManifest } from '../schemas/manifest.js';
import {
  projectsRoot,
  slugFor,
  isSlug,
  resolveSlugFromName,
} from './projectKey.js';

export class ProjectManifestStore {
  constructor(private root: string = projectsRoot()) {}

  private fileForSlug(slug: string): string {
    return path.join(this.root, slug, 'manifest.json');
  }

  /** Read manifest by key. Key can be the slug (preferred) or a bare
   *  projectName — the latter is resolved against the projects dir for
   *  back-compat with callers that don't yet thread projectRoot. */
  async read(key: string): Promise<ProjectManifest | null> {
    const slug = await resolveSlugFromName(key, this.root);
    return this.readBySlug(slug);
  }

  private async readBySlug(slug: string): Promise<ProjectManifest | null> {
    try {
      const raw = await fs.readFile(this.fileForSlug(slug), 'utf8');
      return ProjectManifest.parse(JSON.parse(raw));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  // Atomic full-write. Caller is expected to have read-modified-written.
  async write(manifest: ProjectManifest): Promise<void> {
    const parsed = ProjectManifest.parse(manifest);
    const slug = slugFor(parsed.name, parsed.projectRoot);
    const f = this.fileForSlug(slug);
    await fs.mkdir(path.dirname(f), { recursive: true });
    const tmp = `${f}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(parsed, null, 2));
    await fs.rename(tmp, f);
  }

  /**
   * Load existing manifest or initialise a new one. Identity is keyed by
   * (projectName, projectRoot) so two worktrees never collide — each gets
   * its own slug dir.
   *
   * Migrates a legacy `<projectName>/` dir to its slug-suffixed form on
   * first read, if the manifest inside it has a projectRoot we can use
   * to compute the slug.
   */
  async loadOrInit(name: string, projectRoot: string): Promise<ProjectManifest> {
    const slug = slugFor(name, projectRoot);
    const slugDir = path.join(this.root, slug);

    // Fast path: slug dir already exists.
    const fromSlug = await this.readBySlug(slug);
    if (fromSlug) return fromSlug;

    // Migration: legacy ~/.easy-env/projects/<name>/ from before slugging.
    // Move it under its slug — if the legacy manifest's projectRoot
    // happens to match this caller's, we adopt it; otherwise it belongs
    // to whichever projectRoot is recorded inside the file.
    const legacyDir = path.join(this.root, name);
    if (!isSlug(name)) {
      try {
        const legacyManifestPath = path.join(legacyDir, 'manifest.json');
        const raw = await fs.readFile(legacyManifestPath, 'utf8');
        const legacy = ProjectManifest.parse(JSON.parse(raw));
        const targetSlug = slugFor(legacy.name, legacy.projectRoot);
        const targetDir = path.join(this.root, targetSlug);
        // Rename rather than copy — vars.json (if any) lives in the same
        // legacy dir and must move with it.
        await fs.mkdir(this.root, { recursive: true });
        await fs.rename(legacyDir, targetDir).catch(async (err) => {
          // Cross-device or already-exists at target: fall back to a
          // best-effort manual move so we still escape the legacy layout.
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
          await fs.rm(legacyDir, { recursive: true, force: true });
        });
        // After migration, retry the fast path.
        if (legacy.projectRoot === projectRoot) {
          const after = await this.readBySlug(targetSlug);
          if (after) return after;
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    }

    // Fresh manifest for this (name, projectRoot).
    await fs.mkdir(slugDir, { recursive: true });
    return ProjectManifest.parse({ name, projectRoot, backends: {}, variables: [] });
  }

  async delete(key: string): Promise<void> {
    const slug = await resolveSlugFromName(key, this.root);
    const dir = path.join(this.root, slug);
    await fs.rm(dir, { recursive: true, force: true });
  }

  /**
   * Returns the list of slug keys currently on disk (one per registered
   * project identity). Callers reconstruct the human-readable name +
   * projectRoot via `read(slug)`.
   */
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
