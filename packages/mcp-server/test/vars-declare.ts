// Tests for the AI-driven vars flow, exercising the tool functions directly
// (like manifest-roundtrip / worktree-isolation) rather than the daemon HTTP
// surface. Covers what the AI relies on: bulk declare (added/unchanged),
// value seeding, never-overwrite, removeUndeclared, and the implicit-declare
// in vars.set. Container-managed names are NOT rejected — the daemon reserves
// no names; projects template ${mongo.url} etc. instead.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { FsStore } from '../src/store/fsStore.js';
import { buildContext, type ToolContext } from '../src/core/context.js';
import { runVarsDeclare } from '../src/tools/varsDeclare.js';
import { runVarsSet, runVarsList } from '../src/tools/vars.js';

async function expect(cond: boolean, msg: string): Promise<void> {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

// Each test runs against a throwaway EASY_ENV_HOME so the manifest/vars stores
// start empty and don't leak between tests.
async function withTempHome<T>(fn: (ctx: ToolContext, project: { projectName: string; projectRoot: string }) => Promise<T>): Promise<T> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'easy-env-declare-test-'));
  process.env.EASY_ENV_HOME = home;
  try {
    const ctx = buildContext(FsStore.default());
    return await fn(ctx, { projectName: 'declare-fixture', projectRoot: path.join(home, 'proj') });
  } finally {
    delete process.env.EASY_ENV_HOME;
    await fs.rm(home, { recursive: true, force: true });
  }
}

async function testDeclareBulk(): Promise<void> {
  await withTempHome(async (ctx, p) => {
    const res = await runVarsDeclare(
      {
        ...p,
        items: [
          { name: 'PORT', value: '3000', evidence: 'compose' },
          { name: 'SECRET', evidence: 'src/auth.ts — no default' }, // no value
        ],
        removeUndeclared: false,
      },
      ctx,
    );
    const byName = Object.fromEntries(res.results.map((r) => [r.name, r]));
    await expect(byName.PORT.declared === 'added', 'PORT should be added');
    await expect(byName.PORT.valueWritten === true, 'PORT value should be written');
    await expect(byName.SECRET.declared === 'added', 'SECRET should be added');
    await expect(byName.SECRET.valueSkippedReason === 'no-value', 'SECRET should skip with no-value');
    await expect(res.declaredVariables.includes('PORT') && res.declaredVariables.includes('SECRET'), 'both names declared');

    const list = await runVarsList(p, ctx);
    await expect(list.variables.PORT?.value === '3000' && list.variables.PORT.source === 'user', 'PORT resolves to user value');
    await expect(list.variables.SECRET?.source === 'unset', 'SECRET shows unset');
    console.log('  ✓ vars.declare: bulk add, value seeding, no-value skip, list reflects');
  });
}

async function testNeverOverwrite(): Promise<void> {
  await withTempHome(async (ctx, p) => {
    await runVarsSet({ ...p, name: 'TOKEN', value: 'user-chosen' }, ctx);
    // Re-declaring with a different value must NOT clobber the user's value.
    const res = await runVarsDeclare(
      { ...p, items: [{ name: 'TOKEN', value: 'declared-default' }], removeUndeclared: false },
      ctx,
    );
    const r = res.results.find((x) => x.name === 'TOKEN')!;
    await expect(r.valueSkippedReason === 'already-set', 'TOKEN should be skipped as already-set');
    const list = await runVarsList(p, ctx);
    await expect(list.variables.TOKEN?.value === 'user-chosen', 'user value preserved');
    console.log('  ✓ vars.declare: never overwrites an existing user value');
  });
}

async function testRemoveUndeclared(): Promise<void> {
  await withTempHome(async (ctx, p) => {
    await runVarsDeclare({ ...p, items: [{ name: 'OLD_A' }, { name: 'KEEP_B' }], removeUndeclared: false }, ctx);
    const res = await runVarsDeclare(
      { ...p, items: [{ name: 'KEEP_B' }, { name: 'NEW_C' }], removeUndeclared: true },
      ctx,
    );
    await expect(res.removed.includes('OLD_A'), 'OLD_A should be removed');
    await expect(!res.removed.includes('KEEP_B'), 'KEEP_B should survive');
    await expect(res.declaredVariables.includes('KEEP_B') && res.declaredVariables.includes('NEW_C'), 'B + C declared');
    await expect(!res.declaredVariables.includes('OLD_A'), 'A gone');
    console.log('  ✓ vars.declare removeUndeclared: prunes old names, keeps overlap, adds new');
  });
}

async function testSetImplicitDeclare(): Promise<void> {
  await withTempHome(async (ctx, p) => {
    // vars.set on a name that was never declared should auto-declare it.
    const res = await runVarsSet({ ...p, name: 'FRESH_VAR', value: 'v' }, ctx);
    await expect(res.autoDeclared === true, 'FRESH_VAR should be auto-declared');
    await expect(res.source === 'user' && res.value === 'v', 'set return shape');
    const list = await runVarsList(p, ctx);
    await expect(list.variables.FRESH_VAR?.value === 'v', 'FRESH_VAR persisted + listed');
    console.log('  ✓ vars.set: auto-declares an unknown name');
  });
}

async function main(): Promise<void> {
  await testDeclareBulk();
  await testNeverOverwrite();
  await testRemoveUndeclared();
  await testSetImplicitDeclare();
  console.log('vars-declare: ALL PASS');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
