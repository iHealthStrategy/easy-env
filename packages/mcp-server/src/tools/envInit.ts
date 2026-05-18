// env.init — persist this project's backends configuration into the
// daemon-side manifest. AI is responsible for reading the project's
// easy-env.json (or whatever source) and passing the resolved values
// in via this call. The daemon never opens any file inside the project.
import { z } from 'zod';
import type { ToolContext } from '../core/context.js';
import { ProjectName } from '../schemas/manifest.js';

const MongoBackendPatch = z.object({
  image: z.string().min(1).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  // The mongo database the project considers its "primary". Optional —
  // most projects template the db name into MONGO_URL themselves
  // (`value: "${mongo.url}/blog"`) and never need to set this. Setting
  // it here only matters for env.reset (so easy-env knows which db to
  // drop) and as a hint surfaced via vars.list.containers.dbName.
  dbName: z.string().min(1).optional(),
  // Single-node replica set name (e.g. "rs0"). Required when the project
  // uses change streams or transactions. easy-env boots mongod with
  // --replSet, runs rs.initiate, waits for PRIMARY, and appends
  // ?replicaSet=<name>&directConnection=true to the resolved URL.
  replicaSet: z.string().min(1).optional(),
});

const RedisBackendPatch = z.object({
  image: z.string().min(1).optional(),
  port: z.number().int().min(1).max(65535).optional(),
});

const RabbitBackendPatch = z.object({
  image: z.string().min(1).optional(),
  // AMQP port the project will connect to (container 5672).
  port: z.number().int().min(1).max(65535).optional(),
  // Management UI port (container 15672) — only honored when the image is
  // a *-management variant.
  managementPort: z.number().int().min(1).max(65535).optional(),
  user: z.string().min(1).optional(),
  password: z.string().min(1).optional(),
});

// Seed paths submitted via env.init. Each path is relative to projectRoot.
// The daemon reads these files when state.seed is called — this is the
// one narrow exception to "daemon never reads projectRoot". JSON files are
// parsed against JsonSeedSpec; scripts are spawned with node.
const SeedPatch = z.object({
  json: z.array(z.string().min(1)).default([]),
  scripts: z.array(z.string().min(1)).default([]),
});

export const EnvInitInput = z.object({
  projectName: ProjectName,
  // Used solely to namespace same-named projects. The daemon stores it
  // in the manifest and uses it to detect name collisions on subsequent
  // calls; it never opens any file inside this path.
  projectRoot: z.string().min(1),
  mongo: MongoBackendPatch.optional(),
  redis: RedisBackendPatch.optional(),
  rabbit: RabbitBackendPatch.optional(),
  /** Seed file paths to register. When omitted the manifest's existing
   *  seed config is preserved; when provided, it REPLACES the existing
   *  config (so the manifest stays in sync with easy-env.json). Pass
   *  empty arrays to clear. */
  seed: SeedPatch.optional(),
});

export async function runEnvInit(input: z.infer<typeof EnvInitInput>, ctx: ToolContext) {
  const manifest = await ctx.manifests.loadOrInit(input.projectName, input.projectRoot);

  // Merge per-backend so callers can update just one of mongo/redis/rabbit.
  const next = {
    ...manifest,
    backends: {
      mongo: { ...(manifest.backends.mongo ?? {}), ...(input.mongo ?? {}) },
      redis: { ...(manifest.backends.redis ?? {}), ...(input.redis ?? {}) },
      rabbit: { ...(manifest.backends.rabbit ?? {}), ...(input.rabbit ?? {}) },
    },
    // Seed REPLACES (not merges) on each call — the AI's easy-env.json is
    // the source of truth; partial-update semantics would silently retain
    // stale paths the user already deleted from the project's config.
    seed: input.seed ?? manifest.seed,
  };
  // Drop empty backend entries to keep the manifest tidy.
  if (Object.keys(next.backends.mongo).length === 0) delete (next.backends as { mongo?: unknown }).mongo;
  if (Object.keys(next.backends.redis).length === 0) delete (next.backends as { redis?: unknown }).redis;
  if (Object.keys(next.backends.rabbit).length === 0) delete (next.backends as { rabbit?: unknown }).rabbit;

  await ctx.manifests.write(next);

  return {
    projectName: next.name,
    projectRoot: next.projectRoot,
    backends: next.backends,
    variables: next.variables,
    seed: next.seed,
  };
}

export const envInitToolDescription = {
  name: 'env.init',
  description:
    "Register or update this project's backend container configuration in the daemon manifest. Pass { projectName, projectRoot, mongo?: { image?, port?, dbName?, replicaSet? }, redis?: { image?, port? }, rabbit?: { image?, port?, managementPort?, user?, password? }, seed?: { json?: string[], scripts?: string[] } }. The AI is the source of truth — it reads the project's easy-env.json and source, then submits the resolved values here. The daemon never opens any file inside projectRoot, except for the explicit seed paths declared here (which state.seed later reads). seed paths are relative to projectRoot; submitting seed REPLACES the existing config (don't omit to silently retain stale paths). Rabbit is opt-in (only spawns when declared). Setting mongo.replicaSet (e.g. \"rs0\") boots mongod with --replSet + rs.initiate (required for change streams / transactions); resolved mongoUrl gains ?replicaSet=…&directConnection=true.",
  inputSchema: EnvInitInput,
};
