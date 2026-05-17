import { z } from 'zod';
import { SettleCondition } from '../schemas/scenario.js';
import { settle } from '../core/settle.js';
import type { ToolContext } from '../core/context.js';

export const ScenarioSettleInput = z.object({
  // baseUrl is optional; falls back to config.app.baseUrl when omitted.
  baseUrl: z.string().url().optional(),
  condition: SettleCondition,
});

export type ScenarioSettleInput = z.infer<typeof ScenarioSettleInput>;

export async function runScenarioSettle(input: ScenarioSettleInput, ctx: ToolContext) {
  const baseUrl = input.baseUrl ?? ctx.resolved.baseUrl;
  if (!baseUrl) {
    throw new Error(
      'scenario.settle requires a baseUrl. Pass it as an argument or set app.baseUrl in easy-env.json.',
    );
  }
  const outcome = await settle(baseUrl, input.condition);
  return { ...outcome, resolvedBaseUrl: baseUrl };
}

export const scenarioSettleToolDescription = {
  name: 'scenario.settle',
  description:
    'Block until the system under test reaches an explicit quiescence condition (or timeout). The outcome (settled, waitedMs, polls, finalValue, timeoutReason?) is evidence, NOT a verdict — a settled:true result does NOT imply correctness. baseUrl defaults to easy-env.json app.baseUrl when omitted.',
  inputSchema: ScenarioSettleInput,
};
