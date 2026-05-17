// MCP tools for project variables. Web UI and AI both go through these.
// Every call carries projectName (+ projectRoot for the daemon to detect
// same-name collisions) — the daemon never reads anything inside the
// project's own directory.
import { z } from 'zod';
import type { ToolContext } from '../core/context.js';
import { type VarValue } from '../store/projectVarsStore.js';
import { resolveVars } from '../core/vars.js';
import { ProjectName } from '../schemas/manifest.js';

const VarValueSchema: z.ZodType<VarValue> = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

// ── vars.list ───────────────────────────────────────────────────────────────

export const VarsListInput = z.object({
  projectName: ProjectName,
});

export async function runVarsList(input: z.infer<typeof VarsListInput>, ctx: ToolContext) {
  const { variables, containers } = await resolveVars({ ctx, projectName: input.projectName });
  return {
    projectName: input.projectName,
    variables,
    containers,
  };
}

export const varsListToolDescription = {
  name: 'vars.list',
  description:
    "Return every environment variable easy-env knows about for the given project, plus a separate `containers` handle when an active env is up. variables: { [name]: { value, source: 'user' | 'unset' } } — values come from ~/.easy-env/projects/{projectName}/vars.json. Template placeholders inside stored values are interpolated at read time against the active env: ${mongo.url}, ${mongo.host}, ${mongo.port}, ${mongo.dbName}, ${redis.url}, ${redis.host}, ${redis.port}. Unknown placeholders are left as-is. containers: { envId, mongoUrl?, redisUrl?, dbName?, mongoHostPort?, redisHostPort? } | null — the raw connection details, also exposed in case you'd rather plumb them yourself with vars.set.",
  inputSchema: VarsListInput,
};

// ── vars.set ───────────────────────────────────────────────────────────────

export const VarsSetInput = z.object({
  projectName: ProjectName,
  projectRoot: z.string().min(1),
  name: z.string().min(1).regex(/^[A-Z_][A-Z0-9_]*$/),
  value: VarValueSchema,
});

export async function runVarsSet(input: z.infer<typeof VarsSetInput>, ctx: ToolContext) {
  // Implicit-declare: if the name isn't in the manifest yet, add it.
  const manifest = await ctx.manifests.loadOrInit(input.projectName, input.projectRoot);
  let autoDeclared = false;
  if (!manifest.variables.includes(input.name)) {
    await ctx.manifests.write({
      ...manifest,
      variables: [...manifest.variables, input.name],
    });
    autoDeclared = true;
  }
  await ctx.vars.set(input.projectName, input.name, input.value);
  return {
    projectName: input.projectName,
    name: input.name,
    value: input.value,
    source: 'user' as const,
    autoDeclared,
  };
}

export const varsSetToolDescription = {
  name: 'vars.set',
  description:
    "Set a user-managed variable's value for a given project. Auto-declares the name in the manifest if not already declared. Writes the value to ~/.easy-env/projects/{projectName}/vars.json. Values may contain template placeholders that are interpolated against the active env on every vars.list read: ${mongo.url} (mongodb://host:port, no /db), ${mongo.host}, ${mongo.port}, ${mongo.dbName}, ${redis.url}, ${redis.host}, ${redis.port}. Example: value=\"${mongo.url}/blog\" keeps working across daemon restarts where ports may shift.",
  inputSchema: VarsSetInput,
};

// ── vars.unset ─────────────────────────────────────────────────────────────

export const VarsUnsetInput = z.object({
  projectName: ProjectName,
  name: z.string().min(1),
});

export async function runVarsUnset(input: z.infer<typeof VarsUnsetInput>, ctx: ToolContext) {
  await ctx.vars.unset(input.projectName, input.name);
  return { projectName: input.projectName, name: input.name, cleared: true };
}

export const varsUnsetToolDescription = {
  name: 'vars.unset',
  description:
    "Clear a user-managed variable's value. The declaration in the manifest is unchanged — the next vars.list call will show it as { source: 'unset' }.",
  inputSchema: VarsUnsetInput,
};
