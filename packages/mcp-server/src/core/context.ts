import type { Store } from '../store/fsStore.js';
import type { EasyEnvConfig } from '../schemas/config.js';
import { loadConfig, resolvedMongoUrl, resolvedRedisUrl, resolvedDbName } from './config.js';
import { EnvRegistry } from '../store/envRegistry.js';

export interface ToolContext {
  store: Store;
  registry: EnvRegistry;
  config: EasyEnvConfig;
  configPath: string | null;
  /** Fallback resolution when no envId is passed and no managed env active. */
  resolved: {
    mongoUrl: string;
    redisUrl: string;
    dbName: string;
    baseUrl?: string;
  };
}

export function buildContext(store: Store): ToolContext {
  const loaded = loadConfig();
  const cfg = loaded.config;
  return {
    store,
    registry: new EnvRegistry(),
    config: cfg,
    configPath: loaded.configPath,
    resolved: {
      mongoUrl: resolvedMongoUrl(cfg),
      redisUrl: resolvedRedisUrl(cfg),
      dbName: resolvedDbName(cfg),
      baseUrl: cfg.app.baseUrl,
    },
  };
}
