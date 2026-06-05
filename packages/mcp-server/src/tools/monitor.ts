// monitor.set — persist a project's traffic-monitoring SELECTION (which
// Mongo databases to watch) into the daemon manifest. This is durable
// project intent, shared across the project's concurrent envs. It does NOT
// start or stop the profiler — that is a per-env runtime action (traffic.*).
//
// Read-modify-write on the manifest, mirroring env.init / vars.set.
import { z } from 'zod';
import type { ToolContext } from '../core/context.js';
import { ProjectName } from '../schemas/manifest.js';

export const MonitorSetInput = z.object({
  projectName: ProjectName,
  projectRoot: z.string().min(1),
  // The Mongo database names to watch. Empty array = watch nothing.
  databases: z.array(z.string().min(1)),
});

export async function runMonitorSet(input: z.infer<typeof MonitorSetInput>, ctx: ToolContext) {
  const manifest = await ctx.manifests.loadOrInit(input.projectName, input.projectRoot);
  const databases = [...new Set(input.databases.filter(Boolean))];
  const next = {
    ...manifest,
    monitor: { ...manifest.monitor, mongo: { ...manifest.monitor.mongo, databases } },
  };
  await ctx.manifests.write(next);
  return {
    projectName: next.name,
    projectRoot: next.projectRoot,
    databases,
  };
}

export const monitorSetToolDescription = {
  name: 'monitor.set',
  description:
    "Persist which Mongo databases this project's traffic monitor should watch. Pass { projectName, projectRoot, databases: string[] }. This stores durable project intent (shared across the project's envs); it does NOT turn the profiler on — call traffic.enable on a specific envId to start capturing. Pass an empty array to clear the selection. Only databases inside the env's own easy-env-managed mongo instance can be monitored.",
  inputSchema: MonitorSetInput,
};
