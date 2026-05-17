// Tests for the AI-driven vars flow: vars.declare (bulk submit) + vars.scan
// (read-only helper). Covers what the AI cares about — name persistence,
// value seeding, container-managed name rejection, removeUndeclared, and
// the implicit-declare behavior in vars.set.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { serve, type ServerType } from '@hono/node-server';

import { FsStore } from '../src/store/fsStore.js';
import { buildContext } from '../src/core/context.js';
import { buildApp } from '../src/daemon/server.js';
import { ProjectVarsStore } from '../src/store/projectVarsStore.js';

async function expect(cond: boolean, msg: string): Promise<void> {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'easy-env-declare-test-'));
  process.env.EASY_ENV_HOME = home;
  try {
    return await fn(home);
  } finally {
    delete process.env.EASY_ENV_HOME;
    await fs.rm(home, { recursive: true, force: true });
  }
}

async function withTempProject<T>(fn: (projectDir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'easy-env-declare-proj-'));
  const prev = process.env.EASY_ENV_CONFIG;
  process.env.EASY_ENV_CONFIG = path.join(dir, 'easy-env.json');
  try {
    return await fn(dir);
  } finally {
    if (prev !== undefined) process.env.EASY_ENV_CONFIG = prev;
    else delete process.env.EASY_ENV_CONFIG;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function startServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const ctx = buildContext(FsStore.default());
  const app = buildApp(ctx, Date.now());
  return new Promise((resolve, reject) => {
    let server: ServerType;
    server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, (info) => {
      resolve({
        baseUrl: `http://127.0.0.1:${info.port}`,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
    server.on('error', reject);
  });
}

type DeclareResponse = {
  configPath: string;
  projectName: string | null;
  declaredVariables: string[];
  removed: string[];
  results: Array<{
    name: string;
    declared: 'added' | 'unchanged' | 'rejected-container-managed';
    valueWritten?: boolean;
    valueSkippedReason?: 'already-set' | 'no-value' | 'no-project-name';
    evidence?: string;
  }>;
};

async function testDeclareBulk(): Promise<void> {
  await withTempHome(async () => {
    await withTempProject(async (projectDir) => {
      await fs.writeFile(
        path.join(projectDir, 'easy-env.json'),
        JSON.stringify({ version: 1, name: 'bulk-proj', variables: ['PRE_EXISTING'] }, null, 2),
      );
      const { baseUrl, close } = await startServer();
      try {
        const r = await fetch(`${baseUrl}/api/vars/declare`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            items: [
              { name: 'PORT', value: '3000', evidence: 'docker-compose' },
              { name: 'JWT_SECRET', value: 'dev-secret', evidence: '.env' },
              { name: 'NO_VALUE_VAR', evidence: 'src/app.ts' },
              { name: 'PRE_EXISTING', value: 'late-value', evidence: 're-declared' },
            ],
          }),
        });
        await expect(r.ok, `declare failed: ${r.status}`);
        const body = await r.json() as DeclareResponse;
        const byName = Object.fromEntries(body.results.map((x) => [x.name, x]));
        await expect(byName.PORT?.declared === 'added', 'PORT should be added');
        await expect(byName.PORT?.valueWritten === true, 'PORT value should be written');
        await expect(byName.JWT_SECRET?.declared === 'added', 'JWT_SECRET added');
        await expect(byName.JWT_SECRET?.valueWritten === true, 'JWT_SECRET seeded');
        await expect(byName.NO_VALUE_VAR?.declared === 'added', 'NO_VALUE_VAR added');
        await expect(byName.NO_VALUE_VAR?.valueSkippedReason === 'no-value', 'NO_VALUE_VAR has no value');
        await expect(byName.PRE_EXISTING?.declared === 'unchanged', 'PRE_EXISTING already declared');
        await expect(byName.PRE_EXISTING?.valueWritten === true, 'PRE_EXISTING value should still be seeded');

        const cfg = JSON.parse(await fs.readFile(path.join(projectDir, 'easy-env.json'), 'utf8')) as { variables: string[] };
        for (const n of ['PORT', 'JWT_SECRET', 'NO_VALUE_VAR', 'PRE_EXISTING']) {
          await expect(cfg.variables.includes(n), `${n} should be in easy-env.json`);
        }
        const store = new ProjectVarsStore();
        const persisted = await store.readAll('bulk-proj');
        await expect(persisted.PORT === '3000', 'PORT value stored');
        await expect(persisted.JWT_SECRET === 'dev-secret', 'JWT_SECRET value stored');
        await expect(!('NO_VALUE_VAR' in persisted), 'NO_VALUE_VAR should not be in store (no value)');
        console.log('  ✓ vars.declare bulk: added names + seeded values; pre-existing seeded too');
      } finally {
        await close();
      }
    });
  });
}

async function testDeclareContainerRejection(): Promise<void> {
  await withTempHome(async () => {
    await withTempProject(async (projectDir) => {
      await fs.writeFile(
        path.join(projectDir, 'easy-env.json'),
        JSON.stringify({ version: 1, name: 'reject-proj' }, null, 2),
      );
      const { baseUrl, close } = await startServer();
      try {
        const r = await fetch(`${baseUrl}/api/vars/declare`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            items: [
              { name: 'MONGO_URL', value: 'should-reject' },
              { name: 'MONGO_DB_NAME', value: 'should-reject' },
              { name: 'REDIS_URL', value: 'should-reject' },
              { name: 'SAFE', value: 'ok' },
            ],
          }),
        });
        const body = await r.json() as DeclareResponse;
        const byName = Object.fromEntries(body.results.map((x) => [x.name, x]));
        for (const n of ['MONGO_URL', 'MONGO_DB_NAME', 'REDIS_URL']) {
          await expect(byName[n]?.declared === 'rejected-container-managed', `${n} should be rejected`);
        }
        await expect(byName.SAFE?.declared === 'added', 'SAFE should pass');
        const cfg = JSON.parse(await fs.readFile(path.join(projectDir, 'easy-env.json'), 'utf8')) as { variables: string[] };
        await expect(!cfg.variables.includes('MONGO_URL'), 'MONGO_URL must not enter declared list');
        await expect(!cfg.variables.includes('REDIS_URL'), 'REDIS_URL must not enter declared list');
        const store = new ProjectVarsStore();
        const persisted = await store.readAll('reject-proj');
        await expect(!('MONGO_URL' in persisted), 'MONGO_URL must not be in store');
        console.log('  ✓ vars.declare rejects container-managed names (MONGO_URL/DB_NAME, REDIS_URL)');
      } finally {
        await close();
      }
    });
  });
}

async function testDeclareNoOverwrite(): Promise<void> {
  await withTempHome(async () => {
    await withTempProject(async (projectDir) => {
      await fs.writeFile(
        path.join(projectDir, 'easy-env.json'),
        JSON.stringify({ version: 1, name: 'no-clobber', variables: ['DB_HOST'] }, null, 2),
      );
      const { baseUrl, close } = await startServer();
      try {
        // User sets DB_HOST manually first
        await fetch(`${baseUrl}/api/vars/DB_HOST`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ value: 'user-value' }),
        });

        const r = await fetch(`${baseUrl}/api/vars/declare`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            items: [{ name: 'DB_HOST', value: 'compose-value', evidence: 'docker-compose' }],
          }),
        });
        const body = await r.json() as DeclareResponse;
        const dbHost = body.results.find((x) => x.name === 'DB_HOST');
        await expect(dbHost?.valueWritten !== true, 'DB_HOST value should NOT be overwritten');
        await expect(dbHost?.valueSkippedReason === 'already-set', `expected already-set, got ${dbHost?.valueSkippedReason}`);

        const store = new ProjectVarsStore();
        const persisted = await store.readAll('no-clobber');
        await expect(persisted.DB_HOST === 'user-value', `user value clobbered: ${persisted.DB_HOST}`);
        console.log('  ✓ vars.declare never overwrites existing user-set values');
      } finally {
        await close();
      }
    });
  });
}

async function testDeclareRemoveUndeclared(): Promise<void> {
  await withTempHome(async () => {
    await withTempProject(async (projectDir) => {
      await fs.writeFile(
        path.join(projectDir, 'easy-env.json'),
        JSON.stringify({ version: 1, name: 'authoritative', variables: ['OLD_A', 'OLD_B', 'KEEP'] }, null, 2),
      );
      const { baseUrl, close } = await startServer();
      try {
        const r = await fetch(`${baseUrl}/api/vars/declare`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            items: [
              { name: 'KEEP', evidence: 'still needed' },
              { name: 'NEW_C', value: 'fresh' },
            ],
            removeUndeclared: true,
          }),
        });
        const body = await r.json() as DeclareResponse;
        await expect(body.removed.includes('OLD_A'), `OLD_A should be removed: ${body.removed}`);
        await expect(body.removed.includes('OLD_B'), `OLD_B should be removed: ${body.removed}`);
        await expect(!body.removed.includes('KEEP'), 'KEEP must not be removed');
        await expect(body.declaredVariables.includes('KEEP'), 'KEEP should remain');
        await expect(body.declaredVariables.includes('NEW_C'), 'NEW_C should be added');
        await expect(!body.declaredVariables.includes('OLD_A'), 'OLD_A should be gone');
        console.log('  ✓ vars.declare removeUndeclared: prunes old names, keeps overlap, adds new');
      } finally {
        await close();
      }
    });
  });
}

async function testVarsScanReadOnly(): Promise<void> {
  await withTempHome(async () => {
    await withTempProject(async (projectDir) => {
      await fs.writeFile(
        path.join(projectDir, 'easy-env.json'),
        JSON.stringify({ version: 1, name: 'scan-only' }, null, 2),
      );
      await fs.writeFile(path.join(projectDir, '.env'), 'API_KEY=abc\n');
      await fs.writeFile(
        path.join(projectDir, 'docker-compose.local.yml'),
        ['services:', '  api:', '    environment:', '      - PORT=3000', ''].join('\n'),
      );

      const { baseUrl, close } = await startServer();
      try {
        const r = await fetch(`${baseUrl}/api/vars/scan`, { method: 'POST' });
        await expect(r.ok, `scan failed: ${r.status}`);
        const body = await r.json() as {
          candidates: Array<{ name: string; proposedValue?: string }>;
          newCandidates: Array<{ name: string }>;
          declared: string[];
        };
        const names = body.candidates.map((c) => c.name);
        await expect(names.includes('API_KEY'), 'API_KEY should be in candidates');
        await expect(names.includes('PORT'), 'PORT should be in candidates (compose.local.yml)');

        // Must NOT write anything
        const cfg = JSON.parse(await fs.readFile(path.join(projectDir, 'easy-env.json'), 'utf8')) as { variables?: string[] };
        await expect(!cfg.variables || cfg.variables.length === 0, 'scan must not touch easy-env.json');
        const store = new ProjectVarsStore();
        const persisted = await store.readAll('scan-only');
        await expect(Object.keys(persisted).length === 0, 'scan must not write to store');
        console.log('  ✓ vars.scan: returns candidates with values, never writes');
      } finally {
        await close();
      }
    });
  });
}

async function testVarsSetImplicitDeclare(): Promise<void> {
  await withTempHome(async () => {
    await withTempProject(async (projectDir) => {
      await fs.writeFile(
        path.join(projectDir, 'easy-env.json'),
        JSON.stringify({ version: 1, name: 'implicit' }, null, 2),
      );
      const { baseUrl, close } = await startServer();
      try {
        const r = await fetch(`${baseUrl}/api/vars/FRESH_VAR`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ value: 'hi' }),
        });
        await expect(r.ok, `set should succeed: ${r.status}`);
        const body = await r.json() as { value: unknown; source: string; autoDeclared: boolean };
        await expect(body.autoDeclared === true, 'set should auto-declare');
        await expect(body.value === 'hi' && body.source === 'user', 'set return shape');

        const cfg = JSON.parse(await fs.readFile(path.join(projectDir, 'easy-env.json'), 'utf8')) as { variables: string[] };
        await expect(cfg.variables.includes('FRESH_VAR'), 'FRESH_VAR should be auto-declared');
        console.log('  ✓ vars.set on undeclared name → implicit declare + set (autoDeclared:true)');
      } finally {
        await close();
      }
    });
  });
}

async function testNoProjectName(): Promise<void> {
  await withTempHome(async () => {
    await withTempProject(async (projectDir) => {
      // No `name` field — vars.declare should still write names to easy-env.json
      // but skip value-seeding with reason 'no-project-name'.
      await fs.writeFile(
        path.join(projectDir, 'easy-env.json'),
        JSON.stringify({ version: 1 }, null, 2),
      );
      const { baseUrl, close } = await startServer();
      try {
        const r = await fetch(`${baseUrl}/api/vars/declare`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            items: [{ name: 'NAMELESS', value: 'no-project' }],
          }),
        });
        const body = await r.json() as DeclareResponse;
        const r1 = body.results.find((x) => x.name === 'NAMELESS');
        await expect(r1?.declared === 'added', 'name should still land in easy-env.json');
        await expect(r1?.valueSkippedReason === 'no-project-name', `expected no-project-name, got ${r1?.valueSkippedReason}`);
        const cfg = JSON.parse(await fs.readFile(path.join(projectDir, 'easy-env.json'), 'utf8')) as { variables: string[] };
        await expect(cfg.variables.includes('NAMELESS'), 'NAMELESS should be in config');
        console.log('  ✓ vars.declare without project name: declares but skips value seeding');
      } finally {
        await close();
      }
    });
  });
}

async function main(): Promise<void> {
  await testDeclareBulk();
  await testDeclareContainerRejection();
  await testDeclareNoOverwrite();
  await testDeclareRemoveUndeclared();
  await testVarsScanReadOnly();
  await testVarsSetImplicitDeclare();
  await testNoProjectName();
  console.log('VARS DECLARE/SCAN OK');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
