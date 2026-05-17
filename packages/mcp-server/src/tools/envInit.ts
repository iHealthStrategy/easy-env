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
});

const RedisBackendPatch = z.object({
  image: z.string().min(1).optional(),
  port: z.number().int().min(1).max(65535).optional(),
});

export const EnvInitInput = z.object({
  projectName: ProjectName,
  // Used solely to namespace same-named projects. The daemon stores it
  // in the manifest and uses it to detect name collisions on subsequent
  // calls; it never opens any file inside this path.
  projectRoot: z.string().min(1),
  mongo: MongoBackendPatch.optional(),
  redis: RedisBackendPatch.optional(),
});

export async function runEnvInit(input: z.infer<typeof EnvInitInput>, ctx: ToolContext) {
  const manifest = await ctx.manifests.loadOrInit(input.projectName, input.projectRoot);

  // Merge per-backend so callers can update just one of mongo/redis.
  const next = {
    ...manifest,
    backends: {
      mongo: { ...(manifest.backends.mongo ?? {}), ...(input.mongo ?? {}) },
      redis: { ...(manifest.backends.redis ?? {}), ...(input.redis ?? {}) },
    },
  };
  // Drop empty backend entries to keep the manifest tidy.
  if (Object.keys(next.backends.mongo).length === 0) delete (next.backends as { mongo?: unknown }).mongo;
  if (Object.keys(next.backends.redis).length === 0) delete (next.backends as { redis?: unknown }).redis;

  await ctx.manifests.write(next);

  return {
    projectName: next.name,
    projectRoot: next.projectRoot,
    backends: next.backends,
    variables: next.variables,
  };
}

export const envInitToolDescription = {
  name: 'env.init',
  description:
    "Register or update this project's backend container configuration in the daemon manifest. Pass { projectName, projectRoot, mongo?: { image?, port?, dbName? }, redis?: { image?, port? } }. The AI is the source of truth — it reads the project's easy-env.json and source, then submits the resolved values here. The daemon never opens any file inside projectRoot; that path is recorded only to detect same-name collisions (two different folders both calling themselves 'foo' will be rejected). Subsequent env.up reads images and host ports from this manifest so the resolved Mongo/Redis host:port stays stable across cycles. mongo.dbName is optional — projects usually template the db name into their connection strings via `vars.declare` (e.g. value: \"${mongo.url}/blog\"); only set dbName here if you want env.reset to scope its drop to that db.",
  inputSchema: EnvInitInput,
};
