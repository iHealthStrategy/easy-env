import fs from 'node:fs';
import path from 'node:path';
import { EasyEnvConfig } from '../schemas/config.js';

const CONFIG_FILENAME = 'easy-env.json';

export interface LoadedConfig {
  config: EasyEnvConfig;
  configPath: string | null;   // null if no file found; defaults applied
  source: 'env' | 'walk' | 'defaults';
}

function existsSync(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function walkUpFor(startDir: string, filename: string): string | null {
  let dir = path.resolve(startDir);
  // Stop at filesystem root.
  while (true) {
    const candidate = path.join(dir, filename);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Resolve the easy-env.json path according to the discovery rules:
 *   1. EASY_ENV_CONFIG env var (explicit override)
 *   2. Walk up from process.cwd() looking for easy-env.json
 *   3. Walk up from startDir if provided
 */
export function findConfigPath(startDir: string = process.cwd()): string | null {
  const override = process.env.EASY_ENV_CONFIG;
  if (override) {
    const resolved = path.resolve(override);
    if (existsSync(resolved)) return resolved;
    // Loudly fail if the user pointed us at a non-existent file.
    throw new Error(
      `EASY_ENV_CONFIG points to ${resolved} but the file does not exist or is unreadable.`,
    );
  }
  return walkUpFor(startDir, CONFIG_FILENAME);
}

export function loadConfig(startDir: string = process.cwd()): LoadedConfig {
  const configPath = findConfigPath(startDir);
  if (!configPath) {
    return {
      config: EasyEnvConfig.parse({}),
      configPath: null,
      source: 'defaults',
    };
  }
  const raw = fs.readFileSync(configPath, 'utf8');
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `Failed to parse ${configPath} as JSON: ${(e as Error).message}`,
    );
  }
  const config = EasyEnvConfig.parse(parsedJson);
  return {
    config,
    configPath,
    source: process.env.EASY_ENV_CONFIG ? 'env' : 'walk',
  };
}

// Hard-coded fallbacks if config has no backends. Match the docker-compose
// shipped with the easy-env repo so the smoke test works without any config.
export const FALLBACK_MONGO_URL = 'mongodb://localhost:27018';
export const FALLBACK_REDIS_URL = 'redis://localhost:6380';
export const FALLBACK_DB_NAME = 'mini';

export function resolvedMongoUrl(cfg: EasyEnvConfig): string {
  return cfg.backends.mongo?.url ?? FALLBACK_MONGO_URL;
}
export function resolvedRedisUrl(cfg: EasyEnvConfig): string {
  return cfg.backends.redis?.url ?? FALLBACK_REDIS_URL;
}
export function resolvedDbName(cfg: EasyEnvConfig): string {
  return cfg.backends.mongo?.dbName ?? FALLBACK_DB_NAME;
}

/**
 * Persist a config patch back to the discovered easy-env.json. Used by
 * vars.init when applying its proposal. Throws if no config file exists
 * (we don't want to silently create one — that's a user decision).
 */
export function saveConfig(patch: Partial<EasyEnvConfig>, startDir: string = process.cwd()): string {
  const configPath = findConfigPath(startDir);
  if (!configPath) {
    throw new Error(
      'no easy-env.json found in this project. Create one before calling save-mutating tools.',
    );
  }
  const raw = fs.readFileSync(configPath, 'utf8');
  const current: Record<string, unknown> = raw ? JSON.parse(raw) : {};
  const merged = { ...current, ...patch };
  fs.writeFileSync(configPath, JSON.stringify(merged, null, 2) + '\n');
  return configPath;
}
