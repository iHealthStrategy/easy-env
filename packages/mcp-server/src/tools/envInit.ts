// env.init — scan the project for likely backend ports and (optionally)
// write them into easy-env.json#backends.{mongo,redis}.port so MONGO_URL
// and REDIS_URL stay stable across env.up cycles.
import path from 'node:path';
import { z } from 'zod';
import type { ToolContext } from '../core/context.js';
import { findConfigPath, loadConfig, saveConfig } from '../core/config.js';
import { suggestPorts } from '../core/envScanner.js';

export const EnvInitInput = z.object({
  dryRun: z.boolean().default(true),
});

export async function runEnvInit(input: z.infer<typeof EnvInitInput>, ctx: ToolContext) {
  const configPath = ctx.configPath ?? findConfigPath();
  if (!configPath) {
    throw new Error(
      'no easy-env.json found in this project. Create one before running env.init.',
    );
  }
  const projectRoot = path.dirname(configPath);
  const suggestion = await suggestPorts(projectRoot);

  const existingMongo = ctx.config.backends?.mongo?.port;
  const existingRedis = ctx.config.backends?.redis?.port;

  const proposal = {
    configPath,
    projectName: ctx.config.name ?? null,
    mongo: { ...suggestion.mongo, existing: existingMongo ?? null },
    redis: { ...suggestion.redis, existing: existingRedis ?? null },
  };

  if (input.dryRun) return { applied: false, ...proposal };

  // Apply: write only the ports we'd actually change.
  const patch: Record<string, unknown> = {};
  const currentBackends = (ctx.config.backends ?? {}) as Record<string, Record<string, unknown>>;
  const nextBackends = {
    ...currentBackends,
    mongo: { ...(currentBackends.mongo ?? {}), port: existingMongo ?? suggestion.mongo.port },
    redis: { ...(currentBackends.redis ?? {}), port: existingRedis ?? suggestion.redis.port },
  };
  patch.backends = nextBackends;

  saveConfig(patch, projectRoot);
  // Refresh ctx so subsequent env.up sees the new port.
  try {
    const reloaded = loadConfig();
    ctx.config = reloaded.config;
    ctx.configPath = reloaded.configPath;
  } catch {
    // non-fatal
  }

  return {
    applied: true,
    ...proposal,
    appliedPorts: {
      mongo: nextBackends.mongo.port,
      redis: nextBackends.redis.port,
    },
  };
}

export const envInitToolDescription = {
  name: 'env.init',
  description:
    "Suggest fixed host ports for the project's mongo and redis containers and (optionally) write them to easy-env.json#backends.{mongo,redis}.port. Scans docker-compose.* files first to reuse the project's historical ports; falls back to defaults that rarely collide with system services. With these in place, MONGO_URL / REDIS_URL stay stable across env.up cycles. dryRun:true (default) returns the proposal; dryRun:false applies. Preserves any port already set in the config.",
  inputSchema: EnvInitInput,
};
