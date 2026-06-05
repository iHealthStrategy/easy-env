// No-Docker regression tests for the traffic-monitor SELECTION layer:
//   1. monitor.set persists per-project, round-trips through the manifest.
//   2. The blocker fix: two worktrees of the SAME projectName each persist
//      their own selection with no ambiguity throw and no cross-contamination
//      (monitor.set keys by (name, root) -> slugFor, never resolveSlugFromName).
//   3. Manifests written before the `monitor` field parse fine (Zod default).
//   4. A partial env.init does NOT wipe a previously-set monitor selection.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { FsStore } from '../src/store/fsStore.js';
import { buildContext } from '../src/core/context.js';
import { runEnvInit } from '../src/tools/envInit.js';
import { runMonitorSet } from '../src/tools/monitor.js';
import { ProjectManifestStore } from '../src/store/projectManifestStore.js';
import { slugFor } from '../src/store/projectKey.js';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`MONITOR CONFIG FAIL: ${msg}`);
}

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'easy-env-monitor-test-'));
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
    const ctx = buildContext(FsStore.default());

    // 1. Basic persist + round-trip + dedup -------------------------------
    const rootA = await fs.mkdtemp(path.join(os.tmpdir(), 'easy-env-mon-A-'));
    const rootB = await fs.mkdtemp(path.join(os.tmpdir(), 'easy-env-mon-B-'));
    const name = 'multi-mongo-app';

    await runEnvInit({ projectName: name, projectRoot: rootA, mongo: { dbName: 'app' } }, ctx);
    await runEnvInit({ projectName: name, projectRoot: rootB, mongo: { dbName: 'app' } }, ctx);

    const setA = await runMonitorSet({ projectName: name, projectRoot: rootA, databases: ['orders', 'orders', 'users'] }, ctx);
    assert(JSON.stringify(setA.databases) === JSON.stringify(['orders', 'users']), `monitor.set dedups; got ${JSON.stringify(setA.databases)}`);
    console.log('  ✓ monitor.set persists + dedups');

    // 2. Blocker regression: same name, two worktrees, no collision -------
    const setB = await runMonitorSet({ projectName: name, projectRoot: rootB, databases: ['analytics'] }, ctx);
    assert(JSON.stringify(setB.databases) === JSON.stringify(['analytics']), 'worktree B has its own selection');

    const store = new ProjectManifestStore();
    const mA = await store.loadOrInit(name, rootA);
    const mB = await store.loadOrInit(name, rootB);
    assert(JSON.stringify(mA.monitor.mongo.databases) === JSON.stringify(['orders', 'users']), 'A selection intact after B write');
    assert(JSON.stringify(mB.monitor.mongo.databases) === JSON.stringify(['analytics']), 'B selection intact');
    assert(slugFor(name, rootA) !== slugFor(name, rootB), 'distinct slugs for the two worktrees');
    // Both manifest dirs exist independently.
    await fs.access(path.join(home, 'projects', slugFor(name, rootA), 'manifest.json'));
    await fs.access(path.join(home, 'projects', slugFor(name, rootB), 'manifest.json'));
    console.log('  ✓ two same-named worktrees persist independent selections (blocker fix)');

    // 3. Pre-monitor manifest parses (Zod default) ------------------------
    const legacyName = 'legacy-app';
    const legacyRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'easy-env-mon-legacy-'));
    const legacySlug = slugFor(legacyName, legacyRoot);
    const legacyDir = path.join(home, 'projects', legacySlug);
    await fs.mkdir(legacyDir, { recursive: true });
    await fs.writeFile(
      path.join(legacyDir, 'manifest.json'),
      JSON.stringify({ name: legacyName, projectRoot: legacyRoot, backends: { mongo: { dbName: 'x' } }, variables: [], seed: { json: [], scripts: [] } }),
    );
    const legacyLoaded = await store.loadOrInit(legacyName, legacyRoot);
    assert(legacyLoaded.monitor?.mongo?.databases?.length === 0, 'manifest without monitor defaults to empty selection');
    console.log('  ✓ pre-monitor manifest parses with default empty selection');

    // 4. Partial env.init preserves an existing selection -----------------
    const updated = await runEnvInit({ projectName: name, projectRoot: rootA, mongo: { image: 'mongo:7' } }, ctx);
    assert(updated.backends.mongo?.image === 'mongo:7', 'image updated');
    const mAfter = await store.loadOrInit(name, rootA);
    assert(JSON.stringify(mAfter.monitor.mongo.databases) === JSON.stringify(['orders', 'users']), 'monitor selection survives partial env.init');
    console.log('  ✓ partial env.init preserves the monitor selection');

    await fs.rm(rootA, { recursive: true, force: true });
    await fs.rm(rootB, { recursive: true, force: true });
    await fs.rm(legacyRoot, { recursive: true, force: true });
  });
  console.log('monitor-config: ALL PASS');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
