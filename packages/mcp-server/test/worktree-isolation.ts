// Regression test for the worktree-isolation feature: two checkouts of
// the same project (same projectName, different projectRoot) must each
// get their own manifest and vars file, with no collision and no
// migration of one into the other.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { FsStore } from '../src/store/fsStore.js';
import { buildContext } from '../src/core/context.js';
import { runEnvInit } from '../src/tools/envInit.js';
import { runVarsDeclare } from '../src/tools/varsDeclare.js';
import { runProjectDelete } from '../src/tools/projectDelete.js';
import { ProjectManifestStore } from '../src/store/projectManifestStore.js';
import { ProjectVarsStore } from '../src/store/projectVarsStore.js';
import { slugFor } from '../src/store/projectKey.js';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`WORKTREE ISOLATION FAIL: ${msg}`);
}

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'easy-env-wt-test-'));
  process.env.EASY_ENV_HOME = home;
  try {
    return await fn(home);
  } finally {
    delete process.env.EASY_ENV_HOME;
    await fs.rm(home, { recursive: true, force: true });
  }
}

async function main() {
  await withTempHome(async (home) => {
    const projectName = 'sample-app';
    // Two worktrees of the same project. Different absolute paths.
    const rootA = await fs.mkdtemp(path.join(os.tmpdir(), 'easy-env-wt-A-'));
    const rootB = await fs.mkdtemp(path.join(os.tmpdir(), 'easy-env-wt-B-'));
    try {
      const ctx = buildContext(FsStore.default());

      // env.init from worktree A
      const initA = await runEnvInit(
        { projectName, projectRoot: rootA, mongo: { port: 27100, dbName: 'app_db' } },
        ctx,
      );
      assert(initA.projectRoot === rootA, 'A: projectRoot recorded');

      // env.init from worktree B with the SAME name — used to throw
      // ProjectNameConflictError; now it must succeed and produce a
      // separate manifest.
      const initB = await runEnvInit(
        { projectName, projectRoot: rootB, mongo: { port: 27100, dbName: 'app_db' } },
        ctx,
      );
      assert(initB.projectRoot === rootB, 'B: projectRoot recorded');
      console.log('  ✓ env.init from two worktrees with the same name both succeed');

      // Slug directories on disk are distinct.
      const slugA = slugFor(projectName, rootA);
      const slugB = slugFor(projectName, rootB);
      assert(slugA !== slugB, 'slugs differ for different roots');
      await fs.access(path.join(home, 'projects', slugA, 'manifest.json'));
      await fs.access(path.join(home, 'projects', slugB, 'manifest.json'));
      console.log(`  ✓ two slug dirs exist on disk: ${slugA}, ${slugB}`);

      // vars.declare lands in each worktree's own vars.json.
      await runVarsDeclare(
        { projectName, projectRoot: rootA, items: [{ name: 'API_KEY', value: 'A-secret' }], removeUndeclared: false },
        ctx,
      );
      await runVarsDeclare(
        { projectName, projectRoot: rootB, items: [{ name: 'API_KEY', value: 'B-secret' }], removeUndeclared: false },
        ctx,
      );
      const varsStore = new ProjectVarsStore();
      const valuesA = await varsStore.readAll(projectName, rootA);
      const valuesB = await varsStore.readAll(projectName, rootB);
      assert(valuesA.API_KEY === 'A-secret', `A vars isolated; got ${JSON.stringify(valuesA)}`);
      assert(valuesB.API_KEY === 'B-secret', `B vars isolated; got ${JSON.stringify(valuesB)}`);
      console.log('  ✓ vars.declare writes to each worktree independently');

      // Reading by projectName alone (no root) still works when only one
      // matches — back-compat path for UI-style callers. Now both exist,
      // so this should throw the disambiguation error.
      const manifests = new ProjectManifestStore();
      let threw = false;
      try {
        await manifests.read(projectName);
      } catch (e) {
        threw = true;
        const msg = (e as Error).message;
        assert(msg.includes('multiple registered worktrees'), `expected disambiguation error, got: ${msg}`);
      }
      assert(threw, 'read-by-bare-name should error when name is ambiguous');
      console.log('  ✓ bare-name read errors with disambiguation hint when ambiguous');

      // Reading by slug still works for both.
      const mA = await manifests.read(slugA);
      const mB = await manifests.read(slugB);
      assert(mA && mA.projectRoot === rootA, 'slug A resolves to root A');
      assert(mB && mB.projectRoot === rootB, 'slug B resolves to root B');
      console.log('  ✓ slug-keyed reads return the expected manifests');

      // project.delete with projectRoot removes only that worktree's slug.
      await runProjectDelete({ projectName, projectRoot: rootA }, ctx);
      await assertNotExists(path.join(home, 'projects', slugA), 'A slug dir removed');
      await fs.access(path.join(home, 'projects', slugB, 'manifest.json')); // B still there
      console.log('  ✓ project.delete with projectRoot targets the right worktree');

      // Now reading by bare name should silently resolve to the one
      // remaining slug.
      const remaining = await manifests.read(projectName);
      assert(remaining && remaining.projectRoot === rootB, 'unambiguous bare-name read returns B');
      console.log('  ✓ bare-name read works once only one worktree remains');
    } finally {
      await fs.rm(rootA, { recursive: true, force: true });
      await fs.rm(rootB, { recursive: true, force: true });
    }
  });
  console.log('worktree-isolation: ALL PASS');
}

async function assertNotExists(p: string, msg: string): Promise<void> {
  try {
    await fs.access(p);
    throw new Error(`WORKTREE ISOLATION FAIL: ${msg} (path still exists: ${p})`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT' && !(e as Error).message.startsWith('WORKTREE')) return;
    if ((e as Error).message.startsWith('WORKTREE')) throw e;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
