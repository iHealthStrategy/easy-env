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
//   ${mongo.url}     →  mongodb://<host>:<port>            (no /db, no query)
//   ${mongo.host}    →  host portion of the active mongo container
//   ${mongo.port}    →  host port portion of the active mongo container
//   ${mongo.dbName}  →  manifest.backends.mongo.dbName, if set
//   ${mongo.params}  →  "?replicaSet=<name>&directConnection=true" when the
//                       env is running as a replica set, otherwise "".
//                       Pattern: `${mongo.url}/<db>${mongo.params}` for a
//                       complete connection string that works for change
//                       streams / transactions.
//   ${redis.url}     →  redis://<host>:<port>
//   ${redis.host}    →  host portion of the active redis container
//   ${redis.port}    →  host port portion of the active redis container
//   ${rabbit.url}    →  amqp://<user>:<pass>@<host>:<port>
//   ${rabbit.host}   →  host portion of the active rabbit container
//   ${rabbit.port}   →  host port portion of the active rabbit container
//   ${clickhouse.url}    →  http://<host>:<port>  (HTTP interface only)
//   ${clickhouse.host}   →  host portion of the active clickhouse container
//   ${clickhouse.port}   →  host port portion of the active clickhouse container
//   ${clickhouse.dbName} →  manifest.backends.clickhouse.dbName (default "default")
//   ${clickhouse.cluster} →  cluster name when cluster mode is on (else empty
//                            so `ON CLUSTER ${clickhouse.cluster}` becomes
//                            `ON CLUSTER ` — easy spot for templating bugs)
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
import { slugFor } from '../store/projectKey.js';

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
  rabbitUrl?: string;
  rabbitManagementUrl?: string;
  clickhouseUrl?: string;
  clickhouseDbName?: string;
  clickhouseCluster?: string;
  dbName?: string;
  mongoHostPort?: number;
  redisHostPort?: number;
  rabbitHostPort?: number;
  clickhouseHostPort?: number;
}

export interface ResolveVarsResult {
  variables: VarsView;
  containers: ContainersView | null;
}

export interface ResolveVarsInput {
  ctx: ToolContext;
  projectName: string;
  /** When supplied (MCP path), used to derive the exact slug; without it
   *  the stores fall back to single-match resolution by projectName. */
  projectRoot?: string;
}

interface ServiceVars {
  url?: string;
  host?: string;
  port?: string;
  dbName?: string;
  /** Query-string suffix (e.g. "?replicaSet=rs0&directConnection=true").
   *  Only populated for mongo today; empty string for non-replica-set
   *  mongo so templates that reference ${mongo.params} stay valid. */
  params?: string;
  /** Synthetic cluster name (clickhouse only). */
  cluster?: string;
}

function parseHostPort(url: string | undefined): { host?: string; port?: string } {
  if (!url) return {};
  try {
    const u = new URL(
      url
        .replace(/^mongodb(\+srv)?:/, 'http$1:')
        .replace(/^redis:/, 'http:')
        .replace(/^amqp:/, 'http:'),
    );
    return { host: u.hostname || undefined, port: u.port || undefined };
  } catch {
    return {};
  }
}

/** Split a connection URL like "mongodb://h:p/?replicaSet=rs0" into its
 *  base ("mongodb://h:p") and query ("?replicaSet=rs0") parts. Leading
 *  slash before `?` is dropped from the base so templates can append
 *  `/<db>` without a stray `//`. */
function splitUrlParams(url: string | undefined): { base?: string; params?: string } {
  if (!url) return {};
  const qIdx = url.indexOf('?');
  if (qIdx < 0) return { base: url.replace(/\/+$/, ''), params: '' };
  const rawBase = url.slice(0, qIdx);
  const params = url.slice(qIdx);
  return { base: rawBase.replace(/\/+$/, ''), params };
}

function buildServiceVars(env: ManagedEnv | null): { mongo: ServiceVars; redis: ServiceVars; rabbit: ServiceVars; clickhouse: ServiceVars } {
  if (!env || env.status !== 'ready') return { mongo: {}, redis: {}, rabbit: {}, clickhouse: {} };
  // Mongo URL may carry a `?replicaSet=…&directConnection=true` suffix when
  // running as a replica set. Templates want the base for `${mongo.url}/db`
  // concatenation and a separate `${mongo.params}` slot for the query.
  const mSplit = splitUrlParams(env.resolved.mongoUrl);
  const m = parseHostPort(env.resolved.mongoUrl);
  const r = parseHostPort(env.resolved.redisUrl);
  const q = parseHostPort(env.resolved.rabbitUrl);
  const c = parseHostPort(env.resolved.clickhouseUrl);
  return {
    mongo: {
      url: mSplit.base,
      params: mSplit.params ?? '',
      host: m.host,
      port: m.port,
      dbName: env.resolved.dbName,
    },
    redis: {
      url: env.resolved.redisUrl,
      host: r.host,
      port: r.port,
    },
    rabbit: {
      url: env.resolved.rabbitUrl,
      host: q.host,
      port: q.port,
    },
    clickhouse: {
      url: env.resolved.clickhouseUrl,
      host: c.host,
      port: c.port,
      dbName: env.resolved.clickhouseDbName,
      cluster: env.resolved.clickhouseCluster,
    },
  };
}

// Recognized placeholders: ${service.field} where service ∈ {mongo, redis, rabbit, clickhouse}
// and field is a known property of the corresponding ServiceVars. Unknown
// placeholders are left as-is (caller can spot the leftover ${...} and fix
// their template or wait for env.up).
const PLACEHOLDER = /\$\{(mongo|redis|rabbit|clickhouse)\.([a-zA-Z]+)\}/g;

export function interpolate(value: VarValue, env: ManagedEnv | null): VarValue {
  if (typeof value !== 'string' || !value.includes('${')) return value;
  const services = buildServiceVars(env);
  return value.replace(PLACEHOLDER, (match, svc: 'mongo' | 'redis' | 'rabbit' | 'clickhouse', field: string) => {
    const bag = services[svc] as Record<string, string | undefined>;
    const replacement = bag[field];
    return replacement === undefined ? match : replacement;
  });
}

export async function resolveVars(input: ResolveVarsInput): Promise<ResolveVarsResult> {
  const { ctx, projectName, projectRoot } = input;

  // 1. Active env (used both for `containers` view and for template interpolation).
  const activeId = await ctx.registry.getActive();
  const env = activeId ? await ctx.registry.get(activeId) : null;

  // 2. Manifest declarations + per-project values. Interpolate user values
  //    against the active env so `${mongo.url}/blog` becomes a concrete URL.
  //    When projectRoot is known we read by deterministic slug; otherwise
  //    the stores fall back to a single-match scan by name.
  const manifestKey = projectRoot ? slugFor(projectName, projectRoot) : projectName;
  const manifest = await ctx.manifests.read(manifestKey);
  const declared = manifest?.variables ?? [];
  const userValues = await ctx.vars.readAll(projectName, projectRoot);

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
      rabbitUrl: env.resolved.rabbitUrl,
      rabbitManagementUrl: env.resolved.rabbitManagementUrl,
      clickhouseUrl: env.resolved.clickhouseUrl,
      clickhouseDbName: env.resolved.clickhouseDbName,
      clickhouseCluster: env.resolved.clickhouseCluster,
      dbName: env.resolved.dbName,
      mongoHostPort: env.mongo?.hostPort,
      redisHostPort: env.redis?.hostPort,
      rabbitHostPort: env.rabbit?.hostPort,
      clickhouseHostPort: env.clickhouse?.hostPort,
    };
  }

  return { variables, containers };
}
