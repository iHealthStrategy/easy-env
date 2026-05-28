import { z } from 'zod';

// A container that easy-env created and currently owns.
export const ContainerHandle = z.object({
  containerId: z.string(),
  image: z.string(),
  internalPort: z.number().int().positive(),
  hostPort: z.number().int().positive(),
});

export const ManagedEnvStatus = z.enum(['starting', 'ready', 'destroyed', 'error']);

export const ManagedEnv = z.object({
  envId: z.string(),
  createdAt: z.string(),
  status: ManagedEnvStatus,
  configHash: z.string(),
  mongo: ContainerHandle.optional(),
  redis: ContainerHandle.optional(),
  rabbit: ContainerHandle.optional(),
  clickhouse: ContainerHandle.optional(),
  resolved: z.object({
    mongoUrl: z.string().optional(),
    redisUrl: z.string().optional(),
    rabbitUrl: z.string().optional(),
    // Optional management UI URL (RabbitMQ *-management image only).
    rabbitManagementUrl: z.string().optional(),
    // ClickHouse HTTP URL (e.g. http://localhost:8124). Always the HTTP
    // interface — native protocol (9000) is not exposed.
    clickhouseUrl: z.string().optional(),
    // ClickHouse primary database name (mirrors what env.init recorded).
    clickhouseDbName: z.string().optional(),
    // Synthetic cluster name when cluster mode is on; absent in single-node
    // mode. Useful for templating `ON CLUSTER ${clickhouse.cluster}` in vars.
    clickhouseCluster: z.string().optional(),
    // Optional — only set when the project explicitly declares
    // backends.mongo.dbName in its easy-env.json. easy-env no longer
    // injects a fallback dbName; if the project wants /<dbname> in
    // MONGO_URL, it should template it (e.g. value: "${mongo.url}/blog")
    // in its vars.declare submission.
    dbName: z.string().optional(),
  }),
  labels: z.record(z.string(), z.string()),
  error: z.string().optional(),
  // Transient: while status === 'starting', the Docker image currently being
  // pulled (set only when it wasn't already present locally). Lets the UI show
  // "downloading <image>…" instead of an indefinite "starting" on first run.
  // Cleared once the env is ready.
  pullingImage: z.string().optional(),
});

export type ContainerHandle = z.infer<typeof ContainerHandle>;
export type ManagedEnv = z.infer<typeof ManagedEnv>;
export type ManagedEnvStatus = z.infer<typeof ManagedEnvStatus>;
