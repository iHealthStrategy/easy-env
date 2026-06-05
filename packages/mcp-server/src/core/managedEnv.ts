// The ownership guard. Every data-touching operation (db.*, traffic.*)
// resolves its target through here so the daemon ONLY ever connects to
// containers easy-env itself spawned and recorded in the registry. No tool
// accepts a caller-supplied connection URL — the connection string comes
// exclusively from `env.resolved`, keyed by an envId the registry knows.
//
// This is the v1 mitigation for "AI has direct db access on prod": there is
// no code path from an agent-crafted URL to a live connection.
import type { EnvRegistry } from '../store/envRegistry.js';
import type { ManagedEnv } from '../schemas/env.js';

/**
 * Resolve an envId to a ready, easy-env-owned environment, or throw a
 * message that tells the caller exactly how to recover.
 */
export async function ensureManagedEnv(envId: string, registry: EnvRegistry): Promise<ManagedEnv> {
  const env = await registry.get(envId);
  if (!env) {
    throw new Error(
      `operations can only target environments owned by this easy-env server. envId "${envId}" is not in the registry. Call env.up first, or env.list to see available ones.`,
    );
  }
  if (env.status !== 'ready') {
    throw new Error(`env ${envId} is not ready (status=${env.status})`);
  }
  return env;
}

/**
 * Pull the Mongo connection URL off a managed env, throwing if it has no
 * Mongo backend. Returns the verbatim resolved URL (which may carry
 * ?replicaSet=…&directConnection=true) — callers MUST connect with it
 * unchanged so replica-set query params survive.
 */
export function requireMongoUrl(env: ManagedEnv): string {
  if (!env.resolved.mongoUrl) {
    throw new Error(`env ${env.envId} has no Mongo backend`);
  }
  return env.resolved.mongoUrl;
}

/**
 * Recover the project identity (name + root) recorded on an env's labels.
 * Both labels are set by core/envOps.commonLabels at env.up time. Returns
 * null for envs created before the project-root label existed, or for
 * project-less envs — callers fall back to an explicit identity in that case.
 */
export function projectIdentityFromEnv(
  env: ManagedEnv,
): { projectName: string; projectRoot: string } | null {
  const projectName = env.labels['easy-env.project'];
  const projectRoot = env.labels['easy-env.project-root'];
  if (!projectName || !projectRoot) return null;
  return { projectName, projectRoot };
}
