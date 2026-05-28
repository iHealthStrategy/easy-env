import { z } from 'zod';
import { SeedConfig } from './seed.js';

// daemon-side manifest for a project. Lives at
// ~/.easy-env/projects/<name>/manifest.json and is the daemon's
// authoritative view of the project's backends + declared variables.
//
// The daemon never opens any file inside the project's own directory.
// The AI (via MCP) reads the project's easy-env.json and source, then
// pushes the relevant pieces here through env.init / vars.declare.
//
// `projectRoot` is recorded so the daemon can reject same-name collisions
// from different projects (two `blog-backend` folders on disk → second
// env.init fails until the user renames one).

export const ProjectName = z
  .string()
  .min(1)
  .regex(/^[a-zA-Z0-9._-]+$/, 'projectName must match [a-zA-Z0-9._-]+');

export const MongoBackendManifest = z.object({
  image: z.string().min(1).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  // Single-node replica set name; presence triggers --replSet + rs.initiate
  // during env.up.
  replicaSet: z.string().min(1).optional(),
  // Primary database name. Required for db.* tools (find/insert/update/delete);
  // also used by env.reset to scope its dropDatabase. Without this set,
  // db.* refuse to operate because they don't have a default db to target.
  dbName: z.string().min(1).optional(),
});

export const RedisBackendManifest = z.object({
  image: z.string().min(1).optional(),
  port: z.number().int().min(1).max(65535).optional(),
});

export const RabbitBackendManifest = z.object({
  image: z.string().min(1).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  managementPort: z.number().int().min(1).max(65535).optional(),
  user: z.string().min(1).optional(),
  password: z.string().min(1).optional(),
});

// Cluster names become XML element names in the <remote_servers> config
// block, so they must be a strict identifier. Same shape we'd accept in
// ClickHouse's own config — letters/digits/underscore, not starting with a digit.
const XmlIdent = z
  .string()
  .min(1)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be a valid XML identifier (letters, digits, underscore; not starting with a digit)');

export const ClickhouseClusterManifest = z.object({
  name: XmlIdent.optional(),
  shard: z.string().min(1).optional(),
  replica: z.string().min(1).optional(),
});

export const ClickhouseBackendManifest = z.object({
  image: z.string().min(1).optional(),
  // Host port mapped to container HTTP port 8123. Native protocol (9000)
  // is not exposed by easy-env — the project must use the HTTP interface.
  port: z.number().int().min(1).max(65535).optional(),
  // Primary database name. easy-env auto-creates it on env.up so the
  // first query against it doesn't 404. Defaults to "default".
  dbName: z.string().min(1).optional(),
  // Enable embedded Keeper + synthetic single-node cluster. Presence (even
  // empty {}) turns the cluster mode ON; absence keeps single-node, no Keeper.
  cluster: ClickhouseClusterManifest.optional(),
});

export const BackendsManifest = z.object({
  mongo: MongoBackendManifest.optional(),
  redis: RedisBackendManifest.optional(),
  rabbit: RabbitBackendManifest.optional(),
  clickhouse: ClickhouseBackendManifest.optional(),
});

export const ProjectManifest = z.object({
  name: ProjectName,
  projectRoot: z.string().min(1),
  backends: BackendsManifest.default({}),
  variables: z.array(z.string().min(1).regex(/^[A-Z_][A-Z0-9_]*$/)).default([]),
  // Project-level seed paths (resolved against projectRoot at run time).
  // The daemon reads these files during state.seed; it never scans
  // projectRoot for other content.
  seed: SeedConfig.default({ json: [], scripts: [] }),
});

export type ProjectManifest = z.infer<typeof ProjectManifest>;
export type MongoBackendManifest = z.infer<typeof MongoBackendManifest>;
export type RedisBackendManifest = z.infer<typeof RedisBackendManifest>;
export type RabbitBackendManifest = z.infer<typeof RabbitBackendManifest>;
export type ClickhouseBackendManifest = z.infer<typeof ClickhouseBackendManifest>;
export type ClickhouseClusterManifest = z.infer<typeof ClickhouseClusterManifest>;
export type BackendsManifest = z.infer<typeof BackendsManifest>;
