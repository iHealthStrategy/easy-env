// Single source of truth for the MCP tools.
// Both the MCP server (stdio) and the daemon HTTP API import from here.
import { z, type ZodTypeAny } from 'zod';
import type { ToolContext } from '../core/context.js';

import { runStateCapture, StateCaptureInput, stateCaptureToolDescription } from './stateCapture.js';
import { runScenarioSettle, ScenarioSettleInput, scenarioSettleToolDescription } from './scenarioSettle.js';
import { runDiffCompare, DiffCompareInput, diffCompareToolDescription } from './diffCompare.js';
import { runScenarioReplay, ScenarioReplayInput, scenarioReplayToolDescription } from './scenarioReplay.js';
import {
  runEnvUp, EnvUpInput, envUpToolDescription,
  runEnvList, EnvListInput, envListToolDescription,
  runEnvStatus, EnvStatusInput, envStatusToolDescription,
  runEnvReset, EnvResetInput, envResetToolDescription,
  runEnvDown, EnvDownInput, envDownToolDescription,
} from './envLifecycle.js';
import {
  runDbSeed, DbSeedInput, dbSeedToolDescription,
  runDbFind, DbFindInput, dbFindToolDescription,
  runDbInsert, DbInsertInput, dbInsertToolDescription,
  runDbUpdate, DbUpdateInput, dbUpdateToolDescription,
  runDbDelete, DbDeleteInput, dbDeleteToolDescription,
} from './db.js';
import {
  runVarsList, VarsListInput, varsListToolDescription,
  runVarsSet, VarsSetInput, varsSetToolDescription,
  runVarsUnset, VarsUnsetInput, varsUnsetToolDescription,
} from './vars.js';
import { runVarsDeclare, VarsDeclareInput, varsDeclareToolDescription } from './varsDeclare.js';
import { runEnvInit, EnvInitInput, envInitToolDescription } from './envInit.js';
import { runProjectDelete, ProjectDeleteInput, projectDeleteToolDescription } from './projectDelete.js';
import { runStateSeed, StateSeedInput, stateSeedToolDescription } from './stateSeed.js';

export interface ToolEntry {
  name: string;
  description: string;
  inputSchema: ZodTypeAny;
  run: (args: unknown, ctx: ToolContext) => Promise<unknown>;
}

export const TOOL_REGISTRY: ReadonlyArray<ToolEntry> = [
  // env lifecycle
  { name: envInitToolDescription.name, description: envInitToolDescription.description, inputSchema: EnvInitInput, run: (a, c) => runEnvInit(EnvInitInput.parse(a), c) },
  { name: envUpToolDescription.name, description: envUpToolDescription.description, inputSchema: EnvUpInput, run: (a, c) => runEnvUp(EnvUpInput.parse(a), c) },
  { name: envListToolDescription.name, description: envListToolDescription.description, inputSchema: EnvListInput, run: (a, c) => runEnvList(EnvListInput.parse(a), c) },
  { name: envStatusToolDescription.name, description: envStatusToolDescription.description, inputSchema: EnvStatusInput, run: (a, c) => runEnvStatus(EnvStatusInput.parse(a), c) },
  { name: envResetToolDescription.name, description: envResetToolDescription.description, inputSchema: EnvResetInput, run: (a, c) => runEnvReset(EnvResetInput.parse(a), c) },
  { name: envDownToolDescription.name, description: envDownToolDescription.description, inputSchema: EnvDownInput, run: (a, c) => runEnvDown(EnvDownInput.parse(a), c) },

  // data ops (env-scoped)
  { name: dbSeedToolDescription.name, description: dbSeedToolDescription.description, inputSchema: DbSeedInput, run: (a, c) => runDbSeed(DbSeedInput.parse(a), c) },
  { name: dbFindToolDescription.name, description: dbFindToolDescription.description, inputSchema: DbFindInput, run: (a, c) => runDbFind(DbFindInput.parse(a), c) },
  { name: dbInsertToolDescription.name, description: dbInsertToolDescription.description, inputSchema: DbInsertInput, run: (a, c) => runDbInsert(DbInsertInput.parse(a), c) },
  { name: dbUpdateToolDescription.name, description: dbUpdateToolDescription.description, inputSchema: DbUpdateInput, run: (a, c) => runDbUpdate(DbUpdateInput.parse(a), c) },
  { name: dbDeleteToolDescription.name, description: dbDeleteToolDescription.description, inputSchema: DbDeleteInput, run: (a, c) => runDbDelete(DbDeleteInput.parse(a), c) },

  // variables
  { name: varsListToolDescription.name, description: varsListToolDescription.description, inputSchema: VarsListInput, run: (a, c) => runVarsList(VarsListInput.parse(a), c) },
  { name: varsSetToolDescription.name, description: varsSetToolDescription.description, inputSchema: VarsSetInput, run: (a, c) => runVarsSet(VarsSetInput.parse(a), c) },
  { name: varsUnsetToolDescription.name, description: varsUnsetToolDescription.description, inputSchema: VarsUnsetInput, run: (a, c) => runVarsUnset(VarsUnsetInput.parse(a), c) },
  { name: varsDeclareToolDescription.name, description: varsDeclareToolDescription.description, inputSchema: VarsDeclareInput, run: (a, c) => runVarsDeclare(VarsDeclareInput.parse(a), c) },
  { name: projectDeleteToolDescription.name, description: projectDeleteToolDescription.description, inputSchema: ProjectDeleteInput, run: (a, c) => runProjectDelete(ProjectDeleteInput.parse(a), c) },

  // state + scenario
  { name: stateSeedToolDescription.name, description: stateSeedToolDescription.description, inputSchema: StateSeedInput, run: (a, c) => runStateSeed(StateSeedInput.parse(a), c) },
  { name: stateCaptureToolDescription.name, description: stateCaptureToolDescription.description, inputSchema: StateCaptureInput, run: (a, c) => runStateCapture(StateCaptureInput.parse(a), c) },
  { name: scenarioSettleToolDescription.name, description: scenarioSettleToolDescription.description, inputSchema: ScenarioSettleInput, run: (a, c) => runScenarioSettle(ScenarioSettleInput.parse(a), c) },
  { name: diffCompareToolDescription.name, description: diffCompareToolDescription.description, inputSchema: DiffCompareInput, run: (a, c) => runDiffCompare(DiffCompareInput.parse(a), c) },
  { name: scenarioReplayToolDescription.name, description: scenarioReplayToolDescription.description, inputSchema: ScenarioReplayInput, run: (a, c) => runScenarioReplay(ScenarioReplayInput.parse(a), c) },
];

export function findTool(name: string): ToolEntry | undefined {
  return TOOL_REGISTRY.find((t) => t.name === name);
}

export { z };
