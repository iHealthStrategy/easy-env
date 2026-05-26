// vars.declare — the AI's bulk submission of the project's env-var
// surface. AI reads the project (any layout) and posts the resolved
// {name, value?, evidence?} list here. easy-env's role is pure
// persistence — names land in the daemon manifest, values land in
// ~/.easy-env/projects/<name>/vars.json. The daemon never opens any
// file inside the project's own directory.
//
// No name is "reserved" by the daemon — the project is free to call its
// variables whatever it wants (MONGO_URL, MONGO_BG, MONGO_PARROT, …).
// Container connection details are returned by vars.list under a
// separate `containers` field; the AI maps them onto whatever variable
// names the project actually uses.
import { z } from 'zod';
import type { ToolContext } from '../core/context.js';
import { type VarValue } from '../store/projectVarsStore.js';
import { ProjectName } from '../schemas/manifest.js';

const VarValueSchema: z.ZodType<VarValue> = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

export const VarsDeclareInput = z.object({
  projectName: ProjectName,
  projectRoot: z.string().min(1),
  items: z
    .array(
      z.object({
        name: z
          .string()
          .min(1)
          .regex(/^[A-Z_][A-Z0-9_]*$/, 'name must match /^[A-Z_][A-Z0-9_]*$/'),
        value: VarValueSchema.optional(),
        evidence: z.string().optional(),
      }),
    )
    .default([]),
  removeUndeclared: z.boolean().default(false),
});

export interface DeclaredItem {
  name: string;
  declared: 'added' | 'unchanged';
  valueWritten?: boolean;
  valueSkippedReason?: 'already-set' | 'no-value';
  evidence?: string;
}

export interface DeclareResponse {
  projectName: string;
  projectRoot: string;
  results: DeclaredItem[];
  removed: string[];
  declaredVariables: string[];
}

export async function runVarsDeclare(
  input: z.infer<typeof VarsDeclareInput>,
  ctx: ToolContext,
): Promise<DeclareResponse> {
  const manifest = await ctx.manifests.loadOrInit(input.projectName, input.projectRoot);
  const declared = new Set(manifest.variables);
  const results: DeclaredItem[] = [];
  const removed: string[] = [];

  // Deduplicate by name, keep the last occurrence's value/evidence.
  const byName = new Map<string, (typeof input.items)[number]>();
  for (const item of input.items) byName.set(item.name, item);

  // 1. Merge names into the declared set.
  for (const item of byName.values()) {
    const wasDeclared = declared.has(item.name);
    declared.add(item.name);
    results.push({
      name: item.name,
      declared: wasDeclared ? 'unchanged' : 'added',
      evidence: item.evidence,
    });
  }

  // 2. Optional: remove anything previously declared but not resubmitted.
  if (input.removeUndeclared) {
    const incoming = new Set(byName.keys());
    for (const name of [...declared]) {
      if (!incoming.has(name)) {
        declared.delete(name);
        removed.push(name);
      }
    }
  }

  // 3. Persist names to the manifest. Preserve original order then append.
  const finalList: string[] = [];
  for (const name of manifest.variables) if (declared.has(name)) finalList.push(name);
  for (const item of byName.values()) if (!finalList.includes(item.name)) finalList.push(item.name);

  await ctx.manifests.write({ ...manifest, variables: finalList });

  // 4. Write values for items that carry one and aren't already user-set.
  const userValues = await ctx.vars.readAll(input.projectName, input.projectRoot);
  for (const item of byName.values()) {
    const r = results.find((x) => x.name === item.name);
    if (!r) continue;
    if (item.value === undefined) {
      r.valueSkippedReason = 'no-value';
      continue;
    }
    if (item.name in userValues) {
      r.valueSkippedReason = 'already-set';
      continue;
    }
    await ctx.vars.set(input.projectName, item.name, item.value, input.projectRoot);
    r.valueWritten = true;
  }

  return {
    projectName: input.projectName,
    projectRoot: input.projectRoot,
    results,
    removed,
    declaredVariables: finalList,
  };
}

export const varsDeclareToolDescription = {
  name: 'vars.declare',
  description:
    "Declare which environment variables this project needs, in one bulk submit. The AI is the source of truth: it reads the project (easy-env.json, docker-compose, .env, source, Dockerfile, k8s manifests, README — whatever applies) and posts the resulting {name, value?, evidence?} list here together with { projectName, projectRoot }. easy-env persists names into the daemon-side manifest and values into ~/.easy-env/projects/<name>/vars.json. Existing user-set values are never overwritten. Pass removeUndeclared:true when re-surveying the whole project. The daemon reserves NO variable names — call them whatever the project calls them. For values that depend on the easy-env-managed Mongo/Redis, use template placeholders that vars.list interpolates at read time: ${mongo.url} (e.g. `value: \"${mongo.url}/blog\"` for MONGO_URL), ${mongo.host}, ${mongo.port}, ${mongo.dbName}, ${redis.url}, ${redis.host}, ${redis.port}. Templates survive daemon restarts where host ports may change.",
  inputSchema: VarsDeclareInput,
};
