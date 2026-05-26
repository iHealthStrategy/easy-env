// project.delete — remove all daemon-side state for a project IDENTITY:
// ~/.easy-env/projects/<slug>/ (manifest.json + vars.json). Running envs
// are NOT torn down; the caller is expected to env.down separately if
// they want the containers gone too.
//
// Identity resolution: when projectRoot is provided we delete the exact
// (name, root) slug. Without it, the daemon falls back to single-match
// resolution by name — fine for the common single-worktree case, errors
// when the name is ambiguous so the caller can disambiguate.
import { z } from 'zod';
import type { ToolContext } from '../core/context.js';
import { ProjectName } from '../schemas/manifest.js';
import { projectsRoot, slugFor, resolveSlugFromName } from '../store/projectKey.js';
import fs from 'node:fs/promises';
import path from 'node:path';

export const ProjectDeleteInput = z.object({
  projectName: ProjectName,
  projectRoot: z.string().min(1).optional(),
});

export async function runProjectDelete(
  input: z.infer<typeof ProjectDeleteInput>,
  _ctx: ToolContext,
) {
  const slug = input.projectRoot
    ? slugFor(input.projectName, input.projectRoot)
    : await resolveSlugFromName(input.projectName);
  const dir = path.join(projectsRoot(), slug);
  let existed = false;
  try {
    await fs.access(dir);
    existed = true;
  } catch {
    // not there
  }
  await fs.rm(dir, { recursive: true, force: true });
  return { projectName: input.projectName, deleted: existed };
}

export const projectDeleteToolDescription = {
  name: 'project.delete',
  description:
    "Delete a project's daemon-side state: removes ~/.easy-env/projects/<slug>/ in its entirety (manifest + variable values). Running envs are NOT torn down — call env.down separately if their containers should also be cleaned up. The project's easy-env.json in the user's source tree is not touched. Pass projectRoot when multiple worktrees of the same project are registered, so the daemon picks the right one.",
  inputSchema: ProjectDeleteInput,
};
