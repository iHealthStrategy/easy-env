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

export const BackendsManifest = z.object({
  mongo: MongoBackendManifest.optional(),
  redis: RedisBackendManifest.optional(),
  rabbit: RabbitBackendManifest.optional(),
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
export type BackendsManifest = z.infer<typeof BackendsManifest>;
