// Project identity on disk = "<projectName>__<8hexHash(projectRoot)>".
// The hash is taken from the normalized absolute projectRoot so two
// worktrees of the same project (same projectName, different paths)
// resolve to distinct slugs and get their own manifest, vars and
// containers. Public API surface still exposes the original projectName
// — the slug is purely an on-disk key.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ProjectManifest } from '../schemas/manifest.js';

export function homeRoot(): string {
  return (
    process.env.EASY_ENV_HOME
    ?? process.env.STATE_DIFF_HOME
    ?? path.join(os.homedir(), '.easy-env')
  );
}

export function projectsRoot(): string {
  return path.join(homeRoot(), 'projects');
}

function rootHash(projectRoot: string): string {
  const normalized = path.resolve(projectRoot);
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 8);
}

export function slugFor(projectName: string, projectRoot: string): string {
  return `${projectName}__${rootHash(projectRoot)}`;
}

/** True when `s` looks like a slug emitted by slugFor (has the `__<8hex>`
 *  suffix). Used to short-circuit the legacy-name lookup. */
export function isSlug(s: string): boolean {
  return /__[0-9a-f]{8}$/.test(s);
}

/**
 * Resolve a possibly-legacy project key (a bare projectName, or a slug)
 * into the slug we should use on disk. Used by call sites that only have
 * a projectName (the daemon HTTP routes, vars.list, vars.unset,
 * project.delete) — they can fall back to single-match resolution.
 *
 *   - If `input` already looks like a slug → return it (no resolution).
 *   - Else look for `<input>__*` dirs under projectsRoot:
 *       - exactly one match → return that slug
 *       - multiple matches  → throw with the candidate roots so the
 *         caller can disambiguate by also passing projectRoot
 *       - zero matches      → fall through
 *   - Else if a legacy `<input>` dir exists → return `<input>` so the
 *     caller can rename-on-read in loadOrInit.
 *   - Else return `<input>` unchanged. Reads return null; writes create
 *     a fresh entry under `<input>__*`.
 */
export async function resolveSlugFromName(
  input: string,
  root: string = projectsRoot(),
): Promise<string> {
  if (isSlug(input)) return input;
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const matches = entries
      .filter((e) => e.isDirectory() && e.name.startsWith(`${input}__`))
      .map((e) => e.name);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      const roots = await Promise.all(
        matches.map(async (slug) => {
          try {
            const raw = await fs.readFile(path.join(root, slug, 'manifest.json'), 'utf8');
            const m = ProjectManifest.parse(JSON.parse(raw));
            return `${slug} (projectRoot=${m.projectRoot})`;
          } catch {
            return slug;
          }
        }),
      );
      throw new Error(
        `project name "${input}" matches multiple registered worktrees:\n  - ${roots.join('\n  - ')}\n` +
        `Pass projectRoot to disambiguate.`,
      );
    }
    // No slug match — fall through to legacy <input> dir check.
    const legacy = entries.find((e) => e.isDirectory() && e.name === input);
    if (legacy) return input;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  return input;
}
