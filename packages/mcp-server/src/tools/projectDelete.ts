// project.delete — remove all daemon-side state for a project:
// ~/.easy-env/projects/<name>/ (manifest.json + vars.json). Running envs
// are NOT torn down; the caller is expected to env.down separately if
// they want the containers gone too.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import type { ToolContext } from '../core/context.js';
import { ProjectName } from '../schemas/manifest.js';

function homeRoot(): string {
  return (
    process.env.EASY_ENV_HOME
    ?? process.env.STATE_DIFF_HOME
    ?? path.join(os.homedir(), '.easy-env')
  );
}

export const ProjectDeleteInput = z.object({
  projectName: ProjectName,
});

export async function runProjectDelete(
  input: z.infer<typeof ProjectDeleteInput>,
  _ctx: ToolContext,
) {
  const dir = path.join(homeRoot(), 'projects', input.projectName);
  // Existed-before flag so callers can distinguish 'deleted' from 'no-op'.
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
    "Delete a project's daemon-side state: removes ~/.easy-env/projects/<name>/ in its entirety (manifest + variable values). Running envs are NOT torn down — call env.down separately if their containers should also be cleaned up. The project's easy-env.json in the user's source tree is not touched.",
  inputSchema: ProjectDeleteInput,
};
