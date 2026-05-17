// vars.init — scan the project for env-var references and (optionally)
// merge the discovered names into easy-env.json#variables.
import path from 'node:path';
import { z } from 'zod';
import type { ToolContext } from '../core/context.js';
import { findConfigPath, loadConfig, saveConfig } from '../core/config.js';
import { scanProjectVars, type VarCandidate } from '../core/varsScanner.js';

export const VarsInitInput = z.object({
  dryRun: z.boolean().default(true),
});

export async function runVarsInit(input: z.infer<typeof VarsInitInput>, ctx: ToolContext) {
  const configPath = ctx.configPath ?? findConfigPath();
  if (!configPath) {
    throw new Error(
      'no easy-env.json found in this project. Create one before running vars.init.',
    );
  }
  const projectRoot = path.dirname(configPath);
  const candidates = await scanProjectVars({ projectRoot });
  const declared = ctx.config.variables ?? [];
  const declaredSet = new Set(declared);

  const proposal = {
    existing: declared.slice(),
    additions: candidates.filter((c) => !declaredSet.has(c.name)),
    unchanged: candidates.filter((c) => declaredSet.has(c.name)),
    configPath,
    projectName: ctx.config.name ?? null,
  };

  if (input.dryRun) {
    return { applied: false, ...proposal };
  }

  // Apply: merge candidates with existing, preserving original order
  // and appending new names in scanner-sorted order.
  const merged = [...declared];
  for (const c of proposal.additions) merged.push(c.name);

  saveConfig({ variables: merged }, projectRoot);
  // Refresh ctx so subsequent vars.list sees the merged list.
  try {
    const reloaded = loadConfig();
    ctx.config = reloaded.config;
    ctx.configPath = reloaded.configPath;
  } catch {
    // non-fatal
  }

  return { applied: true, ...proposal, mergedVariables: merged };
}

export const varsInitToolDescription = {
  name: 'vars.init',
  description:
    "Scan the project for env-var references (.env files, docker-compose.yaml, and process.env.X usages in source) and return a proposal of variable names to declare. dryRun:true (default) returns the proposal without writing; dryRun:false merges discovered names into easy-env.json#variables. Container-managed names (MONGO_URL, REDIS_URL, MONGO_DB_NAME) are filtered out.",
  inputSchema: VarsInitInput,
};

// Helper exposed for the daemon's REST endpoint.
export type VarsInitProposal = {
  applied: boolean;
  existing: string[];
  additions: VarCandidate[];
  unchanged: VarCandidate[];
  configPath: string;
  projectName: string | null;
  mergedVariables?: string[];
};
