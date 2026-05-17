// Resolve the effective view of a project's variables for the AI to
// consume. Merges:
//   - user values from ProjectVarsStore (with template interpolation)
//   - declared-but-unset names from the project's manifest
//
// Container connection info (mongoUrl, redisUrl, dbName, host ports) is
// also returned as a SEPARATE `containers` field — the AI can use either
// the templated values or the raw containers handle, whichever fits.
//
// Template syntax (interpolated against the active env at vars.list time):
//   ${mongo.url}     →  mongodb://<host>:<port>            (no /db)
//   ${mongo.host}    →  host portion of the active mongo container
//   ${mongo.port}    →  host port portion of the active mongo container
//   ${mongo.dbName}  →  manifest.backends.mongo.dbName, if set
//   ${redis.url}     →  redis://<host>:<port>
//   ${redis.host}    →  host portion of the active redis container
//   ${redis.port}    →  host port portion of the active redis container
//
// Why templates? The project may need many derived URLs that share a
// host:port but differ in db name (e.g. blog-backend has MONGO_URL,
// MONGO_BG, MONGO_BP, MONGO_PARROT all pointing to the same Mongo with
// different dbs). Storing `${mongo.url}/blog` keeps the value durable
// across daemon restarts where ports may change — the substitution
// happens at read time, not at write time.
import type { ToolContext } from './context.js';
import type { ManagedEnv } from '../schemas/env.js';
import { type VarValue } from '../store/projectVarsStore.js';

export type VarSource = 'user' | 'unset';

export interface VarEntry {
  value: VarValue | null;
  source: VarSource;
}

export type VarsView = Record<string, VarEntry>;

export interface ContainersView {
  envId: string;
  mongoUrl?: string;
  redisUrl?: string;
  dbName?: string;
  mongoHostPort?: number;
  redisHostPort?: number;
}

export interface ResolveVarsResult {
  variables: VarsView;
  containers: ContainersView | null;
}

export interface ResolveVarsInput {
  ctx: ToolContext;
  projectName: string;
}

interface ServiceVars {
  url?: string;
  host?: string;
  port?: string;
  dbName?: string;
}

function parseHostPort(url: string | undefined): { host?: string; port?: string } {
  if (!url) return {};
  try {
    const u = new URL(url.replace(/^mongodb(\+srv)?:/, 'http$1:').replace(/^redis:/, 'http:'));
    return { host: u.hostname || undefined, port: u.port || undefined };
  } catch {
    return {};
  }
}

function buildServiceVars(env: ManagedEnv | null): { mongo: ServiceVars; redis: ServiceVars } {
  if (!env || env.status !== 'ready') return { mongo: {}, redis: {} };
  const m = parseHostPort(env.resolved.mongoUrl);
  const r = parseHostPort(env.resolved.redisUrl);
  return {
    mongo: {
      url: env.resolved.mongoUrl,
      host: m.host,
      port: m.port,
      dbName: env.resolved.dbName,
    },
    redis: {
      url: env.resolved.redisUrl,
      host: r.host,
      port: r.port,
    },
  };
}

// Recognized placeholders: ${service.field} where service ∈ {mongo, redis}
// and field is a known property of the corresponding ServiceVars. Unknown
// placeholders are left as-is (caller can spot the leftover ${...} and fix
// their template or wait for env.up).
const PLACEHOLDER = /\$\{(mongo|redis)\.([a-zA-Z]+)\}/g;

export function interpolate(value: VarValue, env: ManagedEnv | null): VarValue {
  if (typeof value !== 'string' || !value.includes('${')) return value;
  const services = buildServiceVars(env);
  return value.replace(PLACEHOLDER, (match, svc: 'mongo' | 'redis', field: string) => {
    const bag = services[svc] as Record<string, string | undefined>;
    const replacement = bag[field];
    return replacement === undefined ? match : replacement;
  });
}

export async function resolveVars(input: ResolveVarsInput): Promise<ResolveVarsResult> {
  const { ctx, projectName } = input;

  // 1. Active env (used both for `containers` view and for template interpolation).
  const activeId = await ctx.registry.getActive();
  const env = activeId ? await ctx.registry.get(activeId) : null;

  // 2. Manifest declarations + per-project values. Interpolate user values
  //    against the active env so `${mongo.url}/blog` becomes a concrete URL.
  const manifest = await ctx.manifests.read(projectName);
  const declared = manifest?.variables ?? [];
  const userValues = await ctx.vars.readAll(projectName);

  const variables: VarsView = {};
  for (const name of declared) {
    if (name in userValues) {
      variables[name] = { value: interpolate(userValues[name], env), source: 'user' };
    } else {
      variables[name] = { value: null, source: 'unset' };
    }
  }
  // Stray values (set without prior declaration) — still surfaced so the
  // user can see them.
  for (const [name, value] of Object.entries(userValues)) {
    if (!(name in variables)) {
      variables[name] = { value: interpolate(value, env), source: 'user' };
    }
  }

  // 3. Active env containers, returned as a separate handle.
  let containers: ContainersView | null = null;
  if (env && env.status === 'ready') {
    containers = {
      envId: env.envId,
      mongoUrl: env.resolved.mongoUrl,
      redisUrl: env.resolved.redisUrl,
      dbName: env.resolved.dbName,
      mongoHostPort: env.mongo?.hostPort,
      redisHostPort: env.redis?.hostPort,
    };
  }

  return { variables, containers };
}
