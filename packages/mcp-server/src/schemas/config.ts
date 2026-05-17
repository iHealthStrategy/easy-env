import { z } from 'zod';

// easy-env.json — the consumer-project-level config file. Place it at the
// root of the project you want easy-env to inspect.
//
// Discovery: starting from EASY_ENV_CONFIG (if set) or process.cwd(),
// look for easy-env.json, walking up directories until found or root.

export const MongoBackendConfig = z.object({
  // The expected image tag, e.g. "mongo:3.2", "mongo:4.4", "mongo:6.0.5".
  // Used by env.config to warn if the live server's major.minor differs.
  image: z.string().min(1).optional(),
  // The connection URL the agent will use. Defaults to mongodb://localhost:27018
  // when omitted so the legacy PoC paths still work out of the box.
  url: z.string().url().optional(),
  dbName: z.string().min(1).optional(),
});

export const RedisBackendConfig = z.object({
  image: z.string().min(1).optional(),
  url: z.string().url().optional(),
});

export const BackendsConfig = z.object({
  mongo: MongoBackendConfig.optional(),
  redis: RedisBackendConfig.optional(),
});

export const AppConfig = z.object({
  baseUrl: z.string().url().optional(),
  // Reserved for Level 2 (not used in v0.1.0-alpha): how to start the app.
  startCommand: z.string().optional(),
  cwd: z.string().optional(),
});

export const DefaultsConfig = z.object({
  capture: z.object({
    mongo: z.object({ collections: z.array(z.string()) }).optional(),
    redis: z.object({ keyPatterns: z.array(z.string()) }).optional(),
  }).optional(),
  noisePolicy: z.object({
    ignoreTimestampFields: z.array(z.string()).default([]),
    ignoreRedisTtlDrift: z.boolean().default(true),
  }).optional(),
});

export const EasyEnvConfig = z.object({
  version: z.literal(1).default(1),
  backends: BackendsConfig.default({}),
  app: AppConfig.default({}),
  defaults: DefaultsConfig.default({}),
});

export type EasyEnvConfig = z.infer<typeof EasyEnvConfig>;
export type MongoBackendConfig = z.infer<typeof MongoBackendConfig>;
export type RedisBackendConfig = z.infer<typeof RedisBackendConfig>;
