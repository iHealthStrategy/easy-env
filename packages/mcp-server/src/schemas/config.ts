import { z } from 'zod';
import { SeedConfig } from './seed.js';

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
  // Fixed host port for env.up. When set, the spawned container binds to
  // this host port so MONGO_URL stays stable across env.up cycles; user
  // variables can safely hardcode it. Omitted → dynamic port (legacy).
  port: z.number().int().min(1).max(65535).optional(),
  // Run as a single-node replica set with this name (e.g. "rs0"). Required
  // for change streams / transactions. easy-env will start mongod with
  // --replSet, exec rs.initiate() once it's listening, and append
  // ?replicaSet=<name>&directConnection=true to the resolved mongoUrl so
  // drivers can connect without doing topology discovery. Omitted → run as
  // a standalone (legacy behaviour).
  replicaSet: z.string().min(1).optional(),
});

export const RedisBackendConfig = z.object({
  image: z.string().min(1).optional(),
  url: z.string().url().optional(),
  port: z.number().int().min(1).max(65535).optional(),
});

export const RabbitBackendConfig = z.object({
  image: z.string().min(1).optional(),
  url: z.string().url().optional(),
  // AMQP host port (default container port 5672).
  port: z.number().int().min(1).max(65535).optional(),
  // Optional management UI host port (container 15672). Only allocated when
  // the image is the *-management variant; omitted → no management UI exposed.
  managementPort: z.number().int().min(1).max(65535).optional(),
  user: z.string().min(1).optional(),
  password: z.string().min(1).optional(),
});

export const ClickhouseBackendConfig = z.object({
  image: z.string().min(1).optional(),
  url: z.string().url().optional(),
  // Host port mapped to container HTTP port 8123.
  port: z.number().int().min(1).max(65535).optional(),
  // Primary database name. Auto-created on env.up; defaults to "default".
  dbName: z.string().min(1).optional(),
  // Enable embedded Keeper + synthetic single-node cluster (so Distributed
  // / ON CLUSTER / ReplicatedMergeTree work against one container).
  cluster: z.object({
    name: z.string().min(1).regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
    shard: z.string().min(1).optional(),
    replica: z.string().min(1).optional(),
  }).optional(),
});

export const BackendsConfig = z.object({
  mongo: MongoBackendConfig.optional(),
  redis: RedisBackendConfig.optional(),
  rabbit: RabbitBackendConfig.optional(),
  clickhouse: ClickhouseBackendConfig.optional(),
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

// Project name doubles as the primary key for the per-project values
// store (`~/.easy-env/projects/{name}/vars.json`). Optional for backward
// compatibility — vars features are disabled when missing.
export const ProjectName = z
  .string()
  .min(1)
  .regex(/^[a-zA-Z0-9._-]+$/, 'name must match [a-zA-Z0-9._-]+');

export const EasyEnvConfig = z.object({
  version: z.literal(1).default(1),
  name: ProjectName.optional(),
  backends: BackendsConfig.default({}),
  app: AppConfig.default({}),
  defaults: DefaultsConfig.default({}),
  // Declared variable names this project needs. Values are not stored
  // here — they live in ~/.easy-env/projects/{name}/vars.json and are
  // managed through the Web UI.
  variables: z.array(z.string().min(1)).default([]),
  // Optional declarative seed config. JSON fixtures (declarative) +
  // scripts (imperative) — both arrays of paths relative to projectRoot,
  // executed by state.seed in order.
  seed: SeedConfig.default({ json: [], scripts: [] }),
});

export type EasyEnvConfig = z.infer<typeof EasyEnvConfig>;
export type MongoBackendConfig = z.infer<typeof MongoBackendConfig>;
export type RedisBackendConfig = z.infer<typeof RedisBackendConfig>;
export type RabbitBackendConfig = z.infer<typeof RabbitBackendConfig>;
export type ClickhouseBackendConfig = z.infer<typeof ClickhouseBackendConfig>;
