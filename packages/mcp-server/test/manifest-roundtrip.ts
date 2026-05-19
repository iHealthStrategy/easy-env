// Regression test for the dbName round-trip bug:
// env.init { mongo: { dbName } } must end up on disk AND survive loadOrInit,
// so env.up sees it and db.* tools can resolve a database.
//
// Before the schema fix, MongoBackendManifest didn't declare dbName, so
// zod's strip-unknown behaviour silently dropped it during write/read. The
// daemon claimed success but env.resolved.dbName was always undefined.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { FsStore } from '../src/store/fsStore.js';
import { buildContext } from '../src/core/context.js';
import { runEnvInit } from '../src/tools/envInit.js';
import { ProjectManifestStore } from '../src/store/projectManifestStore.js';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`MANIFEST ROUND-TRIP FAIL: ${msg}`);
}

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'easy-env-manifest-test-'));
  process.env.EASY_ENV_HOME = home;
  try {
    return await fn(home);
  } finally {
    delete process.env.EASY_ENV_HOME;
    await fs.rm(home, { recursive: true, force: true });
  }
}

async function withTempProject<T>(fn: (projectDir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'easy-env-manifest-proj-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function main() {
  await withTempHome(async (home) => {
    await withTempProject(async (projectRoot) => {
      const projectName = 'mft-fixture';
      const ctx = buildContext(FsStore.default());

      // 1. env.init records dbName ----------------------------------------
      const init = await runEnvInit(
        {
          projectName,
          projectRoot,
          mongo: { image: 'mongo:6', port: 31000, dbName: 'app_db', replicaSet: 'rs0' },
          rabbit: { user: 'guest', password: 'guest' },
          seed: { json: ['seeds/base.json'], scripts: ['seeds/derive.mjs'] },
        },
        ctx,
      );
      assert(init.backends.mongo?.dbName === 'app_db', 'env.init response keeps dbName');
      assert(init.backends.mongo?.replicaSet === 'rs0', 'env.init response keeps replicaSet');
      console.log('  ✓ env.init returns dbName in response');

      // 2. The manifest on disk has dbName --------------------------------
      const manifestPath = path.join(home, 'projects', projectName, 'manifest.json');
      const raw = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      assert(raw.backends?.mongo?.dbName === 'app_db', `dbName missing on disk; got: ${JSON.stringify(raw.backends?.mongo)}`);
      assert(raw.backends?.mongo?.replicaSet === 'rs0', 'replicaSet missing on disk');
      assert(Array.isArray(raw.seed?.json) && raw.seed.json[0] === 'seeds/base.json', 'seed.json persisted');
      console.log('  ✓ dbName + replicaSet + seed persisted to manifest.json');

      // 3. loadOrInit reads dbName back -----------------------------------
      const store = new ProjectManifestStore();
      const loaded = await store.loadOrInit(projectName, projectRoot);
      assert(loaded.backends.mongo?.dbName === 'app_db', 'loadOrInit returns dbName');
      assert(loaded.backends.mongo?.replicaSet === 'rs0', 'loadOrInit returns replicaSet');
      assert(loaded.seed.json.length === 1 && loaded.seed.scripts.length === 1, 'loadOrInit returns seed paths');
      console.log('  ✓ loadOrInit round-trips dbName + seed');

      // 4. Partial update preserves dbName --------------------------------
      const update = await runEnvInit(
        {
          projectName,
          projectRoot,
          mongo: { image: 'mongo:7' }, // only image; dbName should NOT be wiped
        },
        ctx,
      );
      assert(update.backends.mongo?.image === 'mongo:7', 'image updated');
      assert(update.backends.mongo?.dbName === 'app_db', 'dbName survives partial update');
      assert(update.backends.mongo?.replicaSet === 'rs0', 'replicaSet survives partial update');
      console.log('  ✓ partial env.init preserves dbName');
    });
  });
  console.log('manifest-roundtrip: ALL PASS');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
