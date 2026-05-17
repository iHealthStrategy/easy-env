// MCP tools for project variables. Web UI and AI both go through these.
import { z } from 'zod';
import type { ToolContext } from '../core/context.js';
import { ProjectVarsStore, type VarValue } from '../store/projectVarsStore.js';
import { resolveVars, isContainerManagedName } from '../core/vars.js';
import { loadConfig } from '../core/config.js';

// easy-env.json can change at runtime (vars.init rewrites it, user hand-edits
// it). Reload the in-memory ctx.config from disk before any vars op so we
// always see the current declaration list.
function refreshConfig(ctx: ToolContext): void {
  try {
    const loaded = loadConfig();
    ctx.config = loaded.config;
    ctx.configPath = loaded.configPath;
  } catch {
    // keep stale config rather than crash
  }
}

const VarValueSchema: z.ZodType<VarValue> = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

function projectNameOrThrow(ctx: ToolContext): string {
  const name = ctx.config.name;
  if (!name) {
    throw new Error(
      "easy-env.json has no 'name' field — variables features require it. Add { \"name\": \"my-project\" } to your config.",
    );
  }
  return name;
}

// ── vars.list ───────────────────────────────────────────────────────────────

export const VarsListInput = z.object({});

export async function runVarsList(_input: unknown, ctx: ToolContext) {
  refreshConfig(ctx);
  const view = await resolveVars({ ctx });
  return {
    projectName: ctx.config.name ?? null,
    variables: view,
  };
}

export const varsListToolDescription = {
  name: 'vars.list',
  description:
    "Return every environment variable easy-env knows about for the current project, with source attribution. Each entry has { value, source: 'user' | 'container' | 'unset' }. Container vars (MONGO_URL, REDIS_URL, MONGO_DB_NAME) come from the active managed env when one is up; user vars come from ~/.easy-env/projects/{name}/vars.json. Spread the resolved values into a child process's env to run the project.",
  inputSchema: VarsListInput,
};

// ── vars.set ───────────────────────────────────────────────────────────────

export const VarsSetInput = z.object({
  name: z.string().min(1),
  value: VarValueSchema,
});

export async function runVarsSet(input: z.infer<typeof VarsSetInput>, ctx: ToolContext) {
  refreshConfig(ctx);
  const projectName = projectNameOrThrow(ctx);
  if (isContainerManagedName(input.name)) {
    throw new Error(`${input.name} is managed by easy-env's containers and cannot be set manually.`);
  }
  const declared = ctx.config.variables ?? [];
  if (!declared.includes(input.name)) {
    throw new Error(
      `${input.name} is not declared in easy-env.json#variables. Add it there first (or run vars.init to bootstrap).`,
    );
  }
  const store = new ProjectVarsStore();
  await store.set(projectName, input.name, input.value);
  return { name: input.name, value: input.value, source: 'user' as const };
}

export const varsSetToolDescription = {
  name: 'vars.set',
  description:
    "Set a user-managed variable's value. Refuses container-managed names (MONGO_URL, REDIS_URL, MONGO_DB_NAME) and names not declared in easy-env.json#variables. Writes to ~/.easy-env/projects/{name}/vars.json. The Web UI is the primary writer; use this tool for programmatic bootstrap when explicitly asked.",
  inputSchema: VarsSetInput,
};

// ── vars.unset ─────────────────────────────────────────────────────────────

export const VarsUnsetInput = z.object({ name: z.string().min(1) });

export async function runVarsUnset(input: z.infer<typeof VarsUnsetInput>, ctx: ToolContext) {
  refreshConfig(ctx);
  const projectName = projectNameOrThrow(ctx);
  if (isContainerManagedName(input.name)) {
    throw new Error(`${input.name} is managed by easy-env's containers and cannot be unset manually.`);
  }
  const store = new ProjectVarsStore();
  await store.unset(projectName, input.name);
  return { name: input.name, cleared: true };
}

export const varsUnsetToolDescription = {
  name: 'vars.unset',
  description:
    "Clear a user-managed variable's value. The variable's declaration in easy-env.json#variables is unchanged — the next vars.list call will show it as { source: 'unset' }.",
  inputSchema: VarsUnsetInput,
};
