// traffic.* — env-scoped MongoDB traffic monitoring tools. All of them
// resolve their connection target through ensureManagedEnv, so they only ever
// touch easy-env-owned mongods (no tool accepts a connection URL). v1 is
// Mongo-only.
//
//   traffic.targets  — discover which dbs can be watched + current selection
//   traffic.enable   — start the profiler + pollers for an env (uses the
//                      project's persisted selection, or an explicit list)
//   traffic.disable  — stop capturing for an env (keeps the buffer)
//   traffic.tail     — read recent captured operations from the ring buffer
import { z } from 'zod';
import type { ToolContext } from '../core/context.js';
import type { ManagedEnv } from '../schemas/env.js';
import { ensureManagedEnv, requireMongoUrl, projectIdentityFromEnv } from '../core/managedEnv.js';

/** Read the project's persisted monitor selection for an env, via the
 *  project identity recorded on the env's labels. Empty when the env predates
 *  the project-root label or has no project. */
async function selectedDatabasesFor(env: ManagedEnv, ctx: ToolContext): Promise<string[]> {
  const id = projectIdentityFromEnv(env);
  if (!id) return [];
  const manifest = await ctx.manifests.loadOrInit(id.projectName, id.projectRoot);
  return manifest.monitor.mongo.databases;
}

// --- traffic.targets -------------------------------------------------------

export const TrafficTargetsInput = z.object({ envId: z.string() });

export async function runTrafficTargets(input: z.infer<typeof TrafficTargetsInput>, ctx: ToolContext) {
  const env = await ensureManagedEnv(input.envId, ctx.registry);
  const mongoUrl = requireMongoUrl(env);
  const available = await ctx.traffic.listDatabases(mongoUrl);
  const selected = await selectedDatabasesFor(env, ctx);
  const status = ctx.traffic.status(input.envId);
  return {
    envId: input.envId,
    available,
    selected,
    enabled: status.enabled,
    monitoring: status.databases,
    buffered: status.buffered,
    dropped: status.dropped,
  };
}

export const trafficTargetsToolDescription = {
  name: 'traffic.targets',
  description:
    "Discover traffic-monitoring targets for a managed env's Mongo: lists the user databases that can be watched (system dbs excluded), the project's persisted selection, and whether the profiler is currently running. Use this to populate a 'which databases to monitor' picker, then monitor.set to persist a selection and traffic.enable to start capturing.",
  inputSchema: TrafficTargetsInput,
};

// --- traffic.enable --------------------------------------------------------

export const TrafficEnableInput = z.object({
  envId: z.string(),
  // Explicit db list for a one-off; when omitted, uses the project's persisted
  // selection (monitor.set). System dbs are always excluded.
  databases: z.array(z.string().min(1)).optional(),
});

export async function runTrafficEnable(input: z.infer<typeof TrafficEnableInput>, ctx: ToolContext) {
  const env = await ensureManagedEnv(input.envId, ctx.registry);
  const mongoUrl = requireMongoUrl(env);
  const databases = input.databases ?? (await selectedDatabasesFor(env, ctx));
  const status = await ctx.traffic.enable(input.envId, mongoUrl, databases);
  return {
    envId: input.envId,
    requested: databases,
    status,
    note:
      status.databases.length === 0
        ? 'No databases selected to monitor — nothing started. Select databases (monitor.set) or pass `databases`.'
        : `Profiler level 2 is ON for: ${status.databases.join(', ')}. This profiles every operation and adds load — disable when done.`,
  };
}

export const trafficEnableToolDescription = {
  name: 'traffic.enable',
  description:
    "Start MongoDB traffic capture for a managed env. Enables the database profiler (level 2 — every operation) and polls system.profile for the selected databases, buffering operations in memory. With no `databases`, uses the project's persisted selection (monitor.set); pass `databases` for a one-off. OFF by default and adds real load (profiles every op) — intended for short, bounded debugging sessions; call traffic.disable when done. Only databases inside this env's own managed mongo can be watched.",
  inputSchema: TrafficEnableInput,
};

// --- traffic.disable -------------------------------------------------------

export const TrafficDisableInput = z.object({ envId: z.string() });

export async function runTrafficDisable(input: z.infer<typeof TrafficDisableInput>, ctx: ToolContext) {
  await ensureManagedEnv(input.envId, ctx.registry);
  const status = await ctx.traffic.disable(input.envId);
  return { envId: input.envId, status };
}

export const trafficDisableToolDescription = {
  name: 'traffic.disable',
  description:
    'Stop MongoDB traffic capture for a managed env: sets profiling level back to 0 and stops the pollers. The captured ring buffer is kept so traffic.tail still returns recent operations until the env is torn down.',
  inputSchema: TrafficDisableInput,
};

// --- traffic.tail ----------------------------------------------------------

export const TrafficTailInput = z.object({
  envId: z.string(),
  limit: z.number().int().positive().max(500).default(100),
  // Optional filters for the captured operations.
  db: z.string().optional(),
  op: z.string().optional(),
});

export async function runTrafficTail(input: z.infer<typeof TrafficTailInput>, ctx: ToolContext) {
  await ensureManagedEnv(input.envId, ctx.registry);
  const entries = ctx.traffic.recent(input.envId, { limit: input.limit, db: input.db, op: input.op });
  const status = ctx.traffic.status(input.envId);
  return { envId: input.envId, status, entries };
}

export const trafficTailToolDescription = {
  name: 'traffic.tail',
  description:
    'Read recently captured MongoDB operations for a managed env (most-recent-first). Each entry has op, ns/collection, duration (ms), nreturned, planSummary and the command/filter. Optionally filter by db or op. Returns the current monitor status too (enabled, watched dbs, buffered count, dropped count). Requires traffic.enable to have been called.',
  inputSchema: TrafficTailInput,
};
