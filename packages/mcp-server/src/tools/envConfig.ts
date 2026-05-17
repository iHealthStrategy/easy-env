import { z } from 'zod';
import { loadConfig, resolvedMongoUrl, resolvedRedisUrl, resolvedDbName } from '../core/config.js';
import { checkMongo, checkRedis, type BackendVersionInfo } from '../core/versionCheck.js';

export const EnvConfigInput = z.object({
  startDir: z.string().optional(),
  probeVersions: z.boolean().default(true),
});

export type EnvConfigInput = z.infer<typeof EnvConfigInput>;

export interface EnvConfigOutput {
  configPath: string | null;
  source: 'env' | 'walk' | 'defaults';
  resolved: {
    mongoUrl: string;
    redisUrl: string;
    dbName: string;
    baseUrl?: string;
  };
  defaults: unknown;
  version: number;
  backendChecks?: BackendVersionInfo[];
  warnings: string[];
}

function summarizeWarning(info: BackendVersionInfo): string | null {
  if (!info.reachable) {
    return `${info.backend} at the configured URL is not reachable: ${info.reachError}`;
  }
  if (info.mismatch && info.expected && info.actual) {
    return `${info.backend} version mismatch: easy-env.json declares image "${info.imageTag}" (${info.expected}) but the live server reports ${info.rawActual} (${info.actual}). Behavior may differ from production.`;
  }
  return null;
}

export async function runEnvConfig(input: EnvConfigInput): Promise<EnvConfigOutput> {
  const loaded = loadConfig(input.startDir);
  const cfg = loaded.config;
  const mongoUrl = resolvedMongoUrl(cfg);
  const redisUrl = resolvedRedisUrl(cfg);
  const dbName = resolvedDbName(cfg);

  const warnings: string[] = [];
  if (loaded.source === 'defaults') {
    warnings.push(
      `No easy-env.json found above ${input.startDir ?? process.cwd()}. Using built-in defaults (mongo:6 on :27018, redis:7 on :6380, db "mini").`,
    );
  }

  let backendChecks: BackendVersionInfo[] | undefined;
  if (input.probeVersions) {
    backendChecks = await Promise.all([
      checkMongo(mongoUrl, cfg.backends.mongo?.image),
      checkRedis(redisUrl, cfg.backends.redis?.image),
    ]);
    for (const info of backendChecks) {
      const w = summarizeWarning(info);
      if (w) warnings.push(w);
    }
  }

  return {
    configPath: loaded.configPath,
    source: loaded.source,
    resolved: {
      mongoUrl,
      redisUrl,
      dbName,
      baseUrl: cfg.app.baseUrl,
    },
    defaults: cfg.defaults,
    version: cfg.version,
    backendChecks,
    warnings,
  };
}

export const envConfigToolDescription = {
  name: 'env.config',
  description:
    'Resolve and report the current easy-env.json (declares which DB/Redis versions THIS project needs). Returns the discovered config path, resolved URLs/dbName/baseUrl, the actual live versions of mongo and redis, and warnings when image-declared versions differ from the live servers. Call this FIRST in a session to understand which environment the other tools will operate against.',
  inputSchema: EnvConfigInput,
};
