// MCP tools for the env lifecycle: env.up / env.list / env.status /
// env.reset / env.down. Container lifecycle is delegated to core/envOps.
import { z } from 'zod';
import type { ToolContext } from '../core/context.js';
import {
  envUp,
  envDown,
  envList,
  envStatus,
  envReset,
} from '../core/envOps.js';
import type { BackendsSpec } from '../core/backends.js';
import { ProjectName } from '../schemas/manifest.js';
import { applyManifestSeed } from './stateSeed.js';

// --- env.up ----------------------------------------------------------------

export const EnvUpInput = z.object({
  projectName: ProjectName,
  projectRoot: z.string().min(1),
  setActive: z.boolean().default(true),
  withoutMongo: z.boolean().default(false),
  withoutRedis: z.boolean().default(false),
  // Rabbit is opt-in via the manifest; this flag lets callers skip it
  // explicitly (rare). Default false (= follow the manifest).
  withoutRabbit: z.boolean().default(false),
  // Same opt-out story for ClickHouse.
  withoutClickhouse: z.boolean().default(false),
  /** Auto-apply manifest.seed (json + scripts) once the env is ready.
   *  'auto'  (default) — runs seed if the manifest has any seed paths declared
   *  'skip'            — skip; caller can run state.seed manually later. */
  seed: z.enum(['auto', 'skip']).default('auto'),
});

async function loadBackendsSpec(ctx: ToolContext, projectName: string, projectRoot: string): Promise<BackendsSpec> {
  const manifest = await ctx.manifests.loadOrInit(projectName, projectRoot);
  return {
    mongo: manifest.backends.mongo,
    redis: manifest.backends.redis,
    rabbit: manifest.backends.rabbit,
    clickhouse: manifest.backends.clickhouse,
  };
}

export async function runEnvUp(input: z.infer<typeof EnvUpInput>, ctx: ToolContext) {
  // Load the manifest once: env.up needs backend spec, auto-seed needs the seed paths.
  const manifest = await ctx.manifests.loadOrInit(input.projectName, input.projectRoot);
  const spec: BackendsSpec = {
    mongo: manifest.backends.mongo,
    redis: manifest.backends.redis,
    rabbit: manifest.backends.rabbit,
    clickhouse: manifest.backends.clickhouse,
  };
  const env = await envUp(spec, ctx.registry, {
    setActive: input.setActive,
    withoutMongo: input.withoutMongo,
    withoutRedis: input.withoutRedis,
    withoutRabbit: input.withoutRabbit,
    withoutClickhouse: input.withoutClickhouse,
    projectName: input.projectName,
  });

  // Per-service summary so the AI/user can see what ran and why — especially
  // the "skipped because not declared" case, which is the new default for a
  // project that doesn't use a given data service.
  const serviceStatus = (
    declared: boolean,
    without: boolean,
    spawned: boolean,
  ): string => {
    if (spawned) return 'spawned';
    if (!declared) return 'skipped: not declared in manifest';
    if (without) return 'skipped: caller passed without flag';
    return 'skipped';
  };
  const services = {
    mongo: serviceStatus(spec.mongo !== undefined, input.withoutMongo, !!env.mongo),
    redis: serviceStatus(spec.redis !== undefined, input.withoutRedis, !!env.redis),
    rabbit: serviceStatus(spec.rabbit !== undefined, input.withoutRabbit, !!env.rabbit),
    clickhouse: serviceStatus(spec.clickhouse !== undefined, input.withoutClickhouse, !!env.clickhouse),
  };

  // Auto-seed — runs only when (a) caller didn't opt out and (b) manifest
  // declares at least one seed path. The whole point: "the AI already told
  // us about these files via env.init; don't make it call state.seed again."
  let seedResult: Awaited<ReturnType<typeof applyManifestSeed>> | null = null;
  let seedSkippedReason: string | null = null;
  const hasSeed = manifest.seed.json.length > 0 || manifest.seed.scripts.length > 0;
  if (input.seed === 'skip') {
    seedSkippedReason = 'caller passed seed:skip';
  } else if (!hasSeed) {
    seedSkippedReason = 'manifest has no seed paths declared';
  } else {
    try {
      seedResult = await applyManifestSeed({ manifest, env, ctx });
    } catch (err) {
      // Don't fail the whole env.up on seed errors — the env itself is up
      // and the caller can investigate / retry via state.seed. Surface the
      // error in the response so the AI sees what went wrong.
      seedSkippedReason = `seed failed: ${(err as Error).message}`;
    }
  }

  return {
    envId: env.envId,
    projectName: input.projectName,
    status: env.status,
    resolved: env.resolved,
    services,
    containers: {
      mongo: env.mongo
        ? { containerId: env.mongo.containerId, image: env.mongo.image, hostPort: env.mongo.hostPort }
        : null,
      redis: env.redis
        ? { containerId: env.redis.containerId, image: env.redis.image, hostPort: env.redis.hostPort }
        : null,
      rabbit: env.rabbit
        ? { containerId: env.rabbit.containerId, image: env.rabbit.image, hostPort: env.rabbit.hostPort }
        : null,
      clickhouse: env.clickhouse
        ? { containerId: env.clickhouse.containerId, image: env.clickhouse.image, hostPort: env.clickhouse.hostPort }
        : null,
    },
    labels: env.labels,
    seed: seedResult
      ? { applied: true, json: seedResult.json, scripts: seedResult.scripts }
      : { applied: false, reason: seedSkippedReason },
  };
}

export const envUpToolDescription = {
  name: 'env.up',
  description:
    "Provision a fresh isolated environment for a project using Testcontainers. Pass { projectName, projectRoot, seed?: 'auto'|'skip' }; the daemon looks up the manifest written by env.init to learn which services to run and which images / host ports to use. ONLY THE DECLARED SERVICES ARE STARTED: mongo, redis, rabbit and clickhouse are each spawned only when env.init declared them, so a project that uses just one — or none — of these data services gets exactly that. The response includes a `services` field reporting, per backend, whether it was spawned or skipped (e.g. 'not declared in manifest'). Use withoutMongo/withoutRedis/withoutRabbit/withoutClickhouse for a one-off skip of a declared service. When the manifest declares seed paths (seed.json / seed.scripts) and seed='auto' (default), env.up applies them automatically after the containers are ready. Pass seed='skip' to opt out. Returns envId + resolved URLs (including clickhouseUrl when declared) + `services` + a `seed` field. Sets this env as 'active' so subsequent tool calls default to it.",
  inputSchema: EnvUpInput,
};

// --- env.list --------------------------------------------------------------

export const EnvListInput = z.object({
  projectName: ProjectName.optional(),
});

export async function runEnvList(input: z.infer<typeof EnvListInput>, ctx: ToolContext) {
  const { envs, activeEnvId } = await envList(ctx.registry);
  const filtered = input.projectName
    ? envs.filter((e) => e.labels?.['easy-env.project'] === input.projectName)
    : envs;
  return {
    activeEnvId,
    envs: filtered.map((e) => ({
      envId: e.envId,
      projectName: e.labels?.['easy-env.project'] ?? null,
      createdAt: e.createdAt,
      status: e.status,
      pullingImage: e.pullingImage ?? null,
      resolved: e.resolved,
      images: {
        mongo: e.mongo?.image ?? null,
        redis: e.redis?.image ?? null,
        rabbit: e.rabbit?.image ?? null,
        clickhouse: e.clickhouse?.image ?? null,
      },
    })),
  };
}

export const envListToolDescription = {
  name: 'env.list',
  description:
    "List all environments easy-env currently manages on this host, plus which one is active. Optionally filter by projectName.",
  inputSchema: EnvListInput,
};

// --- env.status ------------------------------------------------------------

export const EnvStatusInput = z.object({ envId: z.string() });

export async function runEnvStatus(input: z.infer<typeof EnvStatusInput>, ctx: ToolContext) {
  const { env, mongoReachable, redisReachable, rabbitReachable, clickhouseReachable } = await envStatus(input.envId, ctx.registry);
  return {
    envId: env.envId,
    projectName: env.labels?.['easy-env.project'] ?? null,
    createdAt: env.createdAt,
    status: env.status,
    pullingImage: env.pullingImage ?? null,
    resolved: env.resolved,
    health: { mongoReachable, redisReachable, rabbitReachable, clickhouseReachable },
    containers: {
      mongo: env.mongo ?? null,
      redis: env.redis ?? null,
      rabbit: env.rabbit ?? null,
      clickhouse: env.clickhouse ?? null,
    },
    labels: env.labels,
    error: env.error,
  };
}

export const envStatusToolDescription = {
  name: 'env.status',
  description:
    'Inspect one specific environment: lifecycle status, resolved URLs, live health probe results for Mongo, Redis, Rabbit and ClickHouse (rabbit uses a TCP probe — true means something is listening on 5672, not a full AMQP handshake; clickhouse hits HTTP /ping).',
  inputSchema: EnvStatusInput,
};

// --- env.reset -------------------------------------------------------------

export const EnvResetInput = z.object({
  envId: z.string(),
  recreate: z.boolean().default(false),
  // Required when recreate:true so the daemon can read the manifest and
  // spin up replacement containers with the same backends spec.
  projectName: ProjectName.optional(),
  projectRoot: z.string().min(1).optional(),
});

export async function runEnvReset(input: z.infer<typeof EnvResetInput>, ctx: ToolContext) {
  let spec: BackendsSpec | null = null;
  if (input.recreate) {
    if (!input.projectName || !input.projectRoot) {
      throw new Error(
        'env.reset with recreate:true requires { projectName, projectRoot } so the daemon can read the manifest.',
      );
    }
    spec = await loadBackendsSpec(ctx, input.projectName, input.projectRoot);
  }
  const env = await envReset(input.envId, ctx.registry, input.recreate, spec, input.projectName);
  return {
    envId: env.envId,
    status: env.status,
    resolved: env.resolved,
    mode: input.recreate ? 'recreate' : 'fast',
    note: input.recreate
      ? 'Containers destroyed and re-created. New envId because the underlying containers are different.'
      : 'Data dropped (dropDatabase + flushdb). Containers preserved; same envId.',
  };
}

export const envResetToolDescription = {
  name: 'env.reset',
  description:
    'Reset an environment to a clean state. Default (recreate:false) is FAST: dropDatabase + flushdb against the existing containers. With recreate:true, containers are destroyed and freshly spawned (requires projectName + projectRoot so the daemon can read the manifest).',
  inputSchema: EnvResetInput,
};

// --- env.down --------------------------------------------------------------

export const EnvDownInput = z.object({ envId: z.string() });

export async function runEnvDown(input: z.infer<typeof EnvDownInput>, ctx: ToolContext) {
  await envDown(input.envId, ctx.registry);
  return { envId: input.envId, destroyed: true };
}

export const envDownToolDescription = {
  name: 'env.down',
  description:
    'Destroy an environment: stop its containers and remove it from the registry. Containers are automatically reaped if easy-env crashes (ryuk), but env.down is the cooperative shutdown path.',
  inputSchema: EnvDownInput,
};
