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
  // Optional: passed by the MCP server (auto-injected from easy-env.json).
  // When present, the daemon resolves to the slug deterministically; when
  // absent (UI / older callers), it falls back to single-match lookup by
  // projectName under ~/.easy-env/projects/.
  projectRoot: z.string().min(1).optional(),
});

export async function runVarsList(input: z.infer<typeof VarsListInput>, ctx: ToolContext) {
  const { variables, containers } = await resolveVars({
    ctx,
    projectName: input.projectName,
    projectRoot: input.projectRoot,
  });
  return {
    projectName: input.projectName,
    variables,
    containers,
  };
}

export const varsListToolDescription = {
  name: 'vars.list',
  description:
    "Return every environment variable easy-env knows about for the given project, plus a separate `containers` handle when an active env is up. variables: { [name]: { value, source: 'user' | 'unset' } } — values come from ~/.easy-env/projects/{projectName}/vars.json. Template placeholders inside stored values are interpolated at read time against the active env: ${mongo.url} (base only, NO query, e.g. mongodb://host:port), ${mongo.params} (query suffix like \"?replicaSet=rs0&directConnection=true\" or empty), ${mongo.host}, ${mongo.port}, ${mongo.dbName}, ${redis.url}, ${redis.host}, ${redis.port}, ${rabbit.url}, ${rabbit.host}, ${rabbit.port}. Idiomatic mongo URL with db: `${mongo.url}/<dbname>${mongo.params}`. Unknown placeholders are left as-is. containers: { envId, mongoUrl?, redisUrl?, rabbitUrl?, rabbitManagementUrl?, dbName?, mongoHostPort?, redisHostPort?, rabbitHostPort? } | null — mongoUrl in containers is the FULL working URL (with query), in case you'd rather plumb it yourself with vars.set.",
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
  await ctx.vars.set(input.projectName, input.name, input.value, input.projectRoot);
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
    "Set a user-managed variable's value for a given project. Auto-declares the name in the manifest if not already declared. Writes the value to ~/.easy-env/projects/{projectName}/vars.json. Values may contain template placeholders that are interpolated against the active env on every vars.list read: ${mongo.url} (mongodb://host:port, NO /db, NO query), ${mongo.params} (e.g. \"?replicaSet=rs0&directConnection=true\" or empty), ${mongo.host}, ${mongo.port}, ${mongo.dbName}, ${redis.url}, ${redis.host}, ${redis.port}, ${rabbit.url} (amqp://user:pass@host:port), ${rabbit.host}, ${rabbit.port}. Example: value=\"${mongo.url}/blog${mongo.params}\" works across replica-set / standalone configs and survives port shifts on daemon restart.",
  inputSchema: VarsSetInput,
};

// ── vars.unset ─────────────────────────────────────────────────────────────

export const VarsUnsetInput = z.object({
  projectName: ProjectName,
  projectRoot: z.string().min(1).optional(),
  name: z.string().min(1),
});

export async function runVarsUnset(input: z.infer<typeof VarsUnsetInput>, ctx: ToolContext) {
  await ctx.vars.unset(input.projectName, input.name, input.projectRoot);
  return { projectName: input.projectName, name: input.name, cleared: true };
}

export const varsUnsetToolDescription = {
  name: 'vars.unset',
  description:
    "Clear a user-managed variable's value. The declaration in the manifest is unchanged — the next vars.list call will show it as { source: 'unset' }.",
  inputSchema: VarsUnsetInput,
};
