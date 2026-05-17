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

// --- env.up ----------------------------------------------------------------

export const EnvUpInput = z.object({
  setActive: z.boolean().default(true),
  withoutMongo: z.boolean().default(false),
  withoutRedis: z.boolean().default(false),
});

export async function runEnvUp(input: z.infer<typeof EnvUpInput>, ctx: ToolContext) {
  const env = await envUp(ctx.config, ctx.registry, {
    setActive: input.setActive,
    withoutMongo: input.withoutMongo,
    withoutRedis: input.withoutRedis,
  });
  return {
    envId: env.envId,
    status: env.status,
    resolved: env.resolved,
    containers: {
      mongo: env.mongo
        ? { containerId: env.mongo.containerId, image: env.mongo.image, hostPort: env.mongo.hostPort }
        : null,
      redis: env.redis
        ? { containerId: env.redis.containerId, image: env.redis.image, hostPort: env.redis.hostPort }
        : null,
    },
    labels: env.labels,
  };
}

export const envUpToolDescription = {
  name: 'env.up',
  description:
    "Provision a fresh isolated environment for this project using Testcontainers. Reads images from easy-env.json (backends.mongo.image / backends.redis.image) and spawns containers with dynamic ports. Returns envId + resolved URLs that other tools accept via envId. Sets this env as 'active' so subsequent tool calls default to it.",
  inputSchema: EnvUpInput,
};

// --- env.list --------------------------------------------------------------

export const EnvListInput = z.object({});

export async function runEnvList(_input: unknown, ctx: ToolContext) {
  const { envs, activeEnvId } = await envList(ctx.registry);
  return {
    activeEnvId,
    envs: envs.map((e) => ({
      envId: e.envId,
      createdAt: e.createdAt,
      status: e.status,
      resolved: e.resolved,
      images: {
        mongo: e.mongo?.image ?? null,
        redis: e.redis?.image ?? null,
      },
    })),
  };
}

export const envListToolDescription = {
  name: 'env.list',
  description:
    'List all environments easy-env currently manages on this host, plus which one is active (the default target for other tools). Use this to discover other agents/sessions sharing the host.',
  inputSchema: EnvListInput,
};

// --- env.status ------------------------------------------------------------

export const EnvStatusInput = z.object({ envId: z.string() });

export async function runEnvStatus(input: z.infer<typeof EnvStatusInput>, ctx: ToolContext) {
  const { env, mongoReachable, redisReachable } = await envStatus(input.envId, ctx.registry);
  return {
    envId: env.envId,
    createdAt: env.createdAt,
    status: env.status,
    resolved: env.resolved,
    health: { mongoReachable, redisReachable },
    containers: {
      mongo: env.mongo ?? null,
      redis: env.redis ?? null,
    },
    labels: env.labels,
    error: env.error,
  };
}

export const envStatusToolDescription = {
  name: 'env.status',
  description:
    'Inspect one specific environment: lifecycle status, resolved URLs, live health probe results for Mongo and Redis.',
  inputSchema: EnvStatusInput,
};

// --- env.reset -------------------------------------------------------------

export const EnvResetInput = z.object({
  envId: z.string(),
  recreate: z.boolean().default(false),
});

export async function runEnvReset(input: z.infer<typeof EnvResetInput>, ctx: ToolContext) {
  const env = await envReset(input.envId, ctx.registry, input.recreate, ctx.config);
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
    'Reset an environment to a clean state. Default (recreate:false) is FAST: dropDatabase + flushdb against the existing containers, milliseconds. With recreate:true, containers are destroyed and freshly spawned (new envId, several seconds, the only way to recover from corrupted volumes).',
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
    'Destroy an environment: stop its containers and remove it from the registry. Use this when the test session is done. Containers are automatically reaped if easy-env crashes (ryuk), but env.down is the cooperative shutdown path.',
  inputSchema: EnvDownInput,
};
