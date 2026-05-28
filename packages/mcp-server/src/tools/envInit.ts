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

const ClickhouseClusterPatch = z.object({
  // Becomes the XML tag inside <remote_servers> in the config snippet —
  // must be a strict identifier. Defaults to "default".
  name: z.string().min(1).regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'cluster name must be a valid XML identifier').optional(),
  shard: z.string().min(1).optional(),
  replica: z.string().min(1).optional(),
});

const ClickhouseBackendPatch = z.object({
  image: z.string().min(1).optional(),
  // Host port mapped to container HTTP port 8123. Native protocol (9000)
  // is not exposed — easy-env's seed/diff helpers all use HTTP.
  port: z.number().int().min(1).max(65535).optional(),
  // Primary database name (env.up creates it on first boot; env.reset
  // drops + recreates it). Defaults to "default".
  dbName: z.string().min(1).optional(),
  // Enable embedded Keeper + synthetic single-node cluster. Presence (even
  // empty {}) turns it ON; omit to keep the lighter single-node-no-Keeper
  // boot (default). Needed only when the project uses ReplicatedMergeTree /
  // Distributed / ON CLUSTER / cluster() — plain MergeTree + SELECT … FINAL
  // work without this.
  cluster: ClickhouseClusterPatch.optional(),
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
  clickhouse: ClickhouseBackendPatch.optional(),
  /** Explicitly stop running a backend: removes it from the manifest so
   *  env.up no longer spawns it. Use this to turn a service OFF — omitting
   *  a backend key only leaves its current declaration untouched, it does
   *  NOT disable it. `disable` wins if the same backend is also patched. */
  disable: z.array(z.enum(['mongo', 'redis', 'rabbit', 'clickhouse'])).optional(),
  /** Seed file paths to register. When omitted the manifest's existing
   *  seed config is preserved; when provided, it REPLACES the existing
   *  config (so the manifest stays in sync with easy-env.json). Pass
   *  empty arrays to clear. */
  seed: SeedPatch.optional(),
});

export async function runEnvInit(input: z.infer<typeof EnvInitInput>, ctx: ToolContext) {
  const manifest = await ctx.manifests.loadOrInit(input.projectName, input.projectRoot);

  // A backend's PRESENCE in the manifest is what makes env.up spawn it
  // (mongo/redis/rabbit are all opt-in, symmetrically). So we only touch
  // backends the caller actually mentioned:
  //   - patch passed (even {})  → declare/enable + merge config
  //   - listed in `disable`     → remove (stop spawning it)
  //   - omitted                 → leave the existing declaration untouched
  const disable = new Set(input.disable ?? []);
  const patches = { mongo: input.mongo, redis: input.redis, rabbit: input.rabbit, clickhouse: input.clickhouse };
  const backends: Record<string, Record<string, unknown>> = { ...manifest.backends };
  for (const b of ['mongo', 'redis', 'rabbit', 'clickhouse'] as const) {
    if (disable.has(b)) {
      delete backends[b];
      continue;
    }
    const patch = patches[b];
    if (patch !== undefined) {
      backends[b] = { ...(manifest.backends[b] ?? {}), ...patch };
    }
  }

  const next = {
    ...manifest,
    backends,
    // Seed REPLACES (not merges) on each call — the AI's easy-env.json is
    // the source of truth; partial-update semantics would silently retain
    // stale paths the user already deleted from the project's config.
    seed: input.seed ?? manifest.seed,
  };

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
    "Register or update this project's backend container configuration in the daemon manifest. Pass { projectName, projectRoot, mongo?: { image?, port?, dbName?, replicaSet? }, redis?: { image?, port? }, rabbit?: { image?, port?, managementPort?, user?, password? }, clickhouse?: { image?, port?, dbName? }, disable?: ('mongo'|'redis'|'rabbit'|'clickhouse')[], seed?: { json?: string[], scripts?: string[] } }. The AI is the source of truth — it reads the project's easy-env.json and source, then submits the resolved values here. The daemon never opens any file inside projectRoot, except for the explicit seed paths declared here (which state.seed later reads). DECLARE ONLY THE SERVICES THE PROJECT USES: each backend is opt-in — env.up spawns mongo/redis/rabbit/clickhouse only when they're declared here. Pass an empty object (e.g. mongo: {}) to enable a service with default image/port; omit a backend to leave its current declaration untouched; pass it in `disable` to stop running it. seed paths are relative to projectRoot; submitting seed REPLACES the existing config (don't omit to silently retain stale paths). Setting mongo.replicaSet (e.g. \"rs0\") boots mongod with --replSet + rs.initiate (required for change streams / transactions); resolved mongoUrl gains ?replicaSet=…&directConnection=true. ClickHouse is exposed via HTTP only (container port 8123); clickhouse.dbName defaults to \"default\" and env.up auto-creates it. For projects that use ReplicatedMergeTree / Distributed / ON CLUSTER / cluster() syntax, pass clickhouse.cluster: {} (or { name, shard, replica }) to enable embedded Keeper + a synthetic single-node cluster (cluster name defaults to \"default\"). Without clickhouse.cluster, those features will fail (plain MergeTree + SELECT … FINAL still work).",
  inputSchema: EnvInitInput,
};
