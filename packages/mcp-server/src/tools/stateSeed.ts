// state.seed — apply this project's declared seed files. The AI calls
// this with just { projectName, projectRoot } (and optional reset/only);
// the daemon reads the seed paths from the manifest, parses + applies
// the JSON fixtures, then spawns the scripts. The AI does NOT need to
// read the seed file contents — by design.
import { z } from 'zod';
import type { ToolContext } from '../core/context.js';
import { StateSeedInput, StateSeedResult, SeedJsonResult, SeedScriptResult } from '../schemas/seed.js';
import { resolveSeedPath, readJsonSeedFile, applyJsonSeed, runSeedScript } from '../core/seed.js';
import { envReset, resolveEnv } from '../core/envOps.js';
import { DEFAULT_RABBIT_USER, DEFAULT_RABBIT_PASSWORD } from '../core/backends.js';
import type { ManagedEnv } from '../schemas/env.js';
import type { ProjectManifest } from '../schemas/manifest.js';

export { StateSeedInput };

/**
 * Apply a project's declared seed files (manifest.seed.json then scripts)
 * against a ready managed env. Shared by:
 *   - state.seed tool (manual / on-demand re-seed, supports reset + only)
 *   - env.up auto-seed (runs once on fresh provisioning, no reset/only)
 *
 * Stops on first script failure so the caller sees the failing script's
 * stderr in the partial result rather than a generic late error.
 */
export async function applyManifestSeed(opts: {
  manifest: ProjectManifest;
  env: ManagedEnv;
  ctx: ToolContext;
  only?: { json?: number[]; scripts?: number[] };
}): Promise<{
  json: z.infer<typeof SeedJsonResult>[];
  scripts: z.infer<typeof SeedScriptResult>[];
}> {
  const { manifest, env, ctx, only } = opts;
  const jsonPaths = manifest.seed.json;
  const scriptPaths = manifest.seed.scripts;
  const jsonIdxs = filterIndices(jsonPaths.length, only?.json);
  const scriptIdxs = filterIndices(scriptPaths.length, only?.scripts);

  const rabbitCreds = manifest.backends.rabbit && env.resolved.rabbitManagementUrl
    ? {
        user: manifest.backends.rabbit.user ?? DEFAULT_RABBIT_USER,
        password: manifest.backends.rabbit.password ?? DEFAULT_RABBIT_PASSWORD,
        managementUrl: env.resolved.rabbitManagementUrl,
      }
    : undefined;

  const json: z.infer<typeof SeedJsonResult>[] = [];
  for (const idx of jsonIdxs) {
    const rel = jsonPaths[idx];
    const abs = resolveSeedPath(manifest.projectRoot, rel);
    const t0 = Date.now();
    const data = await readJsonSeedFile(abs);
    const applied = await applyJsonSeed(data, env, rabbitCreds);
    json.push({
      file: rel,
      mongo: applied.mongo,
      redis: applied.redis,
      rabbit: applied.rabbit,
      clickhouse: applied.clickhouse,
      durationMs: Date.now() - t0,
    });
  }

  const scripts: z.infer<typeof SeedScriptResult>[] = [];
  for (const idx of scriptIdxs) {
    const rel = scriptPaths[idx];
    const abs = resolveSeedPath(manifest.projectRoot, rel);
    const t0 = Date.now();
    const r = await runSeedScript({
      scriptAbsPath: abs,
      projectRoot: manifest.projectRoot,
      ctx,
      projectName: manifest.name,
    });
    scripts.push({
      file: rel,
      exitCode: r.exitCode,
      durationMs: Date.now() - t0,
      stdoutTail: r.stdoutTail,
      stderrTail: r.stderrTail,
    });
    if (r.exitCode !== 0) break;
  }

  return { json, scripts };
}

export async function runStateSeed(input: z.infer<typeof StateSeedInput>, ctx: ToolContext) {
  const manifest = await ctx.manifests.read(input.projectName);
  if (!manifest) {
    throw new Error(`project not initialized: ${input.projectName} (call env.init first)`);
  }

  const env = await resolveEnv(undefined, ctx.registry);
  if (!env || env.status !== 'ready') {
    throw new Error('no active env. Run env.up before state.seed.');
  }

  if (input.reset) {
    // Fast reset — dropDatabase + flushdb against existing containers,
    // preserving envId/container handles. Matches env.reset {recreate:false}.
    await envReset(env.envId, ctx.registry, false, null, input.projectName);
  }

  const applied = await applyManifestSeed({ manifest, env, ctx, only: input.only });

  return {
    projectName: input.projectName,
    envId: env.envId,
    reset: input.reset,
    json: applied.json,
    scripts: applied.scripts,
  };
}

function filterIndices(total: number, only: number[] | undefined): number[] {
  if (only === undefined) return Array.from({ length: total }, (_, i) => i);
  // De-dup and clamp to valid range.
  return Array.from(new Set(only.filter((i) => i >= 0 && i < total))).sort((a, b) => a - b);
}

export const stateSeedToolDescription = {
  name: 'state.seed',
  description:
    "Apply this project's pre-declared seed files against the active env. Pass { projectName, projectRoot, reset?, only? }. The daemon reads the paths recorded in the manifest (via env.init's `seed` field) — the AI does NOT need to read the seed file contents itself. JSON files run first (declarative: mongo collections / redis keys / rabbit topology / clickhouse tables), then scripts (imperative .js/.mjs run with `node`, cwd=projectRoot, process.env populated from vars.list + EASY_ENV_* URL hints including EASY_ENV_CLICKHOUSE_URL / EASY_ENV_CLICKHOUSE_DB). reset:true runs env.reset (fast: dropDatabase + flushdb + clickhouse DROP/CREATE) before seeding. only restricts which files to apply (indices into the manifest's seed arrays). Mongo collection write modes: replace (default, drop+insertMany), upsert (replaceOne by _id), insert (errors on duplicate). Rabbit topology calls the *-management HTTP API to declare exchanges/queues/bindings idempotently. ClickHouse table modes: replace (TRUNCATE + INSERT FORMAT JSONEachRow), insert (append). Tables must exist — use a seed script to CREATE TABLE before the JSON seed runs.",
  inputSchema: StateSeedInput,
};
