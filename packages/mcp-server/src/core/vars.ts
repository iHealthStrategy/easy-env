// Resolve the effective view of a project's variables for the AI to
// consume. Merges:
//   - user values from ProjectVarsStore
//   - container-derived values from the active managed env
//   - declared-but-unset names from easy-env.json#variables
import type { ToolContext } from './context.js';
import { ProjectVarsStore, type VarValue } from '../store/projectVarsStore.js';

export type VarSource = 'user' | 'container' | 'unset';

export interface VarEntry {
  value: VarValue | null;
  source: VarSource;
}

export type VarsView = Record<string, VarEntry>;

const CONTAINER_VAR_NAMES = new Set(['MONGO_URL', 'MONGO_DB_NAME', 'REDIS_URL']);

export function isContainerManagedName(name: string): boolean {
  return CONTAINER_VAR_NAMES.has(name);
}

/**
 * Many Node MongoDB libs (mongodb-auto-reconnect, mongoose, ad-hoc usage)
 * expect MONGO_URL to include /<dbname> in the path. easy-env's container
 * gives us a bare URL plus a separate dbName, so we splice them together
 * when exposing MONGO_URL to projects. If the URL already has a path, we
 * leave it alone — the user's intent wins.
 */
export function composeMongoUrl(baseUrl: string, dbName?: string): string {
  if (!dbName) return baseUrl;
  try {
    // Use a parseable scheme since URL doesn't always accept 'mongodb:'.
    const u = new URL(baseUrl.replace(/^mongodb(\+srv)?:/, 'http$1:'));
    if (u.pathname && u.pathname !== '/' && u.pathname !== '') return baseUrl;
  } catch {
    // If we can't parse, fall through to naive append.
  }
  return baseUrl.endsWith('/') ? `${baseUrl}${dbName}` : `${baseUrl}/${dbName}`;
}

export interface VarsContext {
  ctx: ToolContext;
  store?: ProjectVarsStore;
}

export async function resolveVars(input: VarsContext): Promise<VarsView> {
  const { ctx } = input;
  const store = input.store ?? new ProjectVarsStore();

  const out: VarsView = {};

  // 1. Container-managed vars from the active env (always editable=false).
  const activeId = await ctx.registry.getActive();
  if (activeId) {
    const env = await ctx.registry.get(activeId);
    if (env && env.status === 'ready') {
      if (env.resolved.mongoUrl) {
        out.MONGO_URL = {
          value: composeMongoUrl(env.resolved.mongoUrl, env.resolved.dbName),
          source: 'container',
        };
      }
      if (env.resolved.dbName)   out.MONGO_DB_NAME = { value: env.resolved.dbName, source: 'container' };
      if (env.resolved.redisUrl) out.REDIS_URL = { value: env.resolved.redisUrl, source: 'container' };
    }
  }

  // 2. Declared user-managed vars from easy-env.json#variables.
  const projectName = ctx.config.name;
  const declared = ctx.config.variables ?? [];
  let userValues: Record<string, VarValue> = {};
  if (projectName) {
    userValues = await store.readAll(projectName);
  }

  for (const name of declared) {
    // Container vars take precedence over a clashing user declaration.
    if (out[name]?.source === 'container') continue;
    if (name in userValues) {
      out[name] = { value: userValues[name], source: 'user' };
    } else {
      out[name] = { value: null, source: 'unset' };
    }
  }

  // 3. Stray user values (user set something not declared) — surface them
  //    so they're visible, but they won't be in the AI's consumption path
  //    if `vars.set` rejects undeclared names. We still show them in case
  //    the user removed a declaration without cleaning up.
  for (const [name, value] of Object.entries(userValues)) {
    if (!(name in out)) {
      out[name] = { value, source: 'user' };
    }
  }

  return out;
}
