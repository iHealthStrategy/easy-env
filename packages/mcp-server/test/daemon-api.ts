// Daemon HTTP API contract test. Starts the daemon in-process (via
// buildApp on a random port), then exercises the resource endpoints and
// the generic tool dispatch. Does NOT require Docker — we only call tools
// that don't touch containers (env.config, env.list).
import { serve, type ServerType } from '@hono/node-server';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { FsStore } from '../src/store/fsStore.js';
import { buildContext } from '../src/core/context.js';
import { buildApp } from '../src/daemon/server.js';

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'easy-env-daemon-test-'));
  process.env.EASY_ENV_HOME = home;
  try {
    return await fn(home);
  } finally {
    delete process.env.EASY_ENV_HOME;
    await fs.rm(home, { recursive: true, force: true });
  }
}

async function withTempProject<T>(fn: (projectDir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'easy-env-project-'));
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

async function expect(cond: boolean, msg: string): Promise<void> {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

async function main(): Promise<void> {
  await withTempHome(async () => {
    const { baseUrl, close } = await startServer();
    try {
      // health
      {
        const r = await fetch(`${baseUrl}/api/health`).then((r) => r.json()) as { ok: boolean; version: string };
        await expect(r.ok === true, 'health.ok should be true');
        await expect(typeof r.version === 'string', 'health.version should be string');
        console.log('  ✓ GET /api/health');
      }

      // tool listing
      {
        const r = await fetch(`${baseUrl}/api/tools`).then((r) => r.json()) as { tools: Array<{ name: string }> };
        await expect(r.tools.length === 21, `expected 21 tools, got ${r.tools.length}`);
        const names = r.tools.map((t) => t.name);
        await expect(names.includes('vars.declare'), 'vars.declare missing from tool list');
        await expect(names.includes('vars.scan'), 'vars.scan missing from tool list');
        await expect(!names.includes('vars.init'), 'vars.init should be replaced by vars.scan + vars.declare');
        console.log('  ✓ GET /api/tools (21 tools, vars.declare + vars.scan present)');
      }

      // env.config via generic dispatch
      {
        const r = await fetch(`${baseUrl}/api/tools/env.config`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        await expect(r.ok, `env.config returned ${r.status}`);
        const body = await r.json() as Record<string, unknown>;
        await expect('configPath' in body || 'config' in body || 'resolved' in body, 'env.config payload looks empty');
        console.log('  ✓ POST /api/tools/env.config');
      }

      // env.list resource endpoint (no envs yet)
      {
        const r = await fetch(`${baseUrl}/api/envs`).then((r) => r.json()) as { envs: unknown[]; activeEnvId: string | null };
        await expect(Array.isArray(r.envs), 'envs should be array');
        await expect(r.envs.length === 0, 'expected no envs in empty home');
        await expect(r.activeEnvId === null, 'no active env expected');
        console.log('  ✓ GET /api/envs (empty)');
      }

      // snapshots / diffs lists (empty)
      {
        const s = await fetch(`${baseUrl}/api/snapshots`).then((r) => r.json()) as { snapshots: unknown[] };
        await expect(Array.isArray(s.snapshots) && s.snapshots.length === 0, 'expected empty snapshots');
        const d = await fetch(`${baseUrl}/api/diffs`).then((r) => r.json()) as { diffs: unknown[] };
        await expect(Array.isArray(d.diffs) && d.diffs.length === 0, 'expected empty diffs');
        console.log('  ✓ GET /api/snapshots, /api/diffs (empty)');
      }

      // unknown tool → 404 + structured error
      {
        const r = await fetch(`${baseUrl}/api/tools/no.such`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        await expect(r.status === 404, `expected 404, got ${r.status}`);
        const body = await r.json() as { error: { code: string; message: string } };
        await expect(body.error.code === 'unknown-tool', `unexpected error code: ${body.error.code}`);
        console.log('  ✓ POST /api/tools/no.such → 404 unknown-tool');
      }

      // invalid input → 400 with zod details (env.status requires envId)
      {
        const r = await fetch(`${baseUrl}/api/tools/env.status`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        await expect(r.status === 400, `expected 400, got ${r.status}`);
        const body = await r.json() as { error: { code: string } };
        await expect(body.error.code === 'invalid-input', `unexpected error code: ${body.error.code}`);
        console.log('  ✓ POST /api/tools/env.status without envId → 400 invalid-input');
      }

      // missing resource → 404
      {
        const r = await fetch(`${baseUrl}/api/snapshots/does-not-exist`);
        await expect(r.status === 404, `expected 404, got ${r.status}`);
        console.log('  ✓ GET /api/snapshots/:missing → 404');
      }
    } finally {
      await close();
    }
  });
  await testVarsFlow();
  console.log('DAEMON API OK');
}

async function testVarsFlow(): Promise<void> {
  await withTempHome(async () => {
    await withTempProject(async (projectDir) => {
      // Set up a project with name + initial variables + sources to scan.
      await fs.writeFile(
        path.join(projectDir, 'easy-env.json'),
        JSON.stringify({ version: 1, name: 'test-proj', variables: ['API_PREFIX'] }, null, 2),
      );
      await fs.writeFile(path.join(projectDir, '.env.example'), 'API_PREFIX=/v1\nDISCOVERED=1\n');
      await fs.mkdir(path.join(projectDir, 'src'));
      await fs.writeFile(
        path.join(projectDir, 'src/app.ts'),
        'const x = process.env.CODE_VAR; const y = process.env.MONGO_URL;',
      );

      const { baseUrl, close } = await startServer();
      try {
        // initial list — only declared API_PREFIX as unset
        {
          const r = await fetch(`${baseUrl}/api/vars`).then((r) => r.json()) as { projectName: string; variables: Record<string, { source: string }> };
          await expect(r.projectName === 'test-proj', 'project name mismatch');
          await expect(r.variables.API_PREFIX?.source === 'unset', 'API_PREFIX should be unset');
          await expect(!('DISCOVERED' in r.variables), 'undeclared DISCOVERED should not appear yet');
          console.log('  ✓ GET /api/vars (declared only, unset)');
        }

        // set undeclared name → implicitly declares + sets (AI ergonomic path)
        {
          const r = await fetch(`${baseUrl}/api/vars/UNDECLARED`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ value: 'x' }),
          });
          await expect(r.ok, `set undeclared should succeed (implicit declare): ${r.status}`);
          const body = await r.json() as { value: string; source: string; autoDeclared: boolean };
          await expect(body.autoDeclared === true, 'autoDeclared flag should be true');
          await expect(body.value === 'x' && body.source === 'user', 'set return shape wrong');
          const cfg = JSON.parse(await fs.readFile(path.join(projectDir, 'easy-env.json'), 'utf8')) as { variables: string[] };
          await expect(cfg.variables.includes('UNDECLARED'), 'UNDECLARED should be auto-declared into easy-env.json');
          console.log('  ✓ PUT /api/vars/:undeclared → auto-declared + set');
        }

        // set container-managed name → still rejected
        {
          const r = await fetch(`${baseUrl}/api/vars/MONGO_URL`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ value: 'mongodb://hijack' }),
          });
          await expect(!r.ok, 'setting MONGO_URL should fail');
          console.log('  ✓ PUT /api/vars/MONGO_URL → rejected (container-managed)');
        }

        // set declared name → ok
        {
          const r = await fetch(`${baseUrl}/api/vars/API_PREFIX`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ value: '/api/v2' }),
          });
          await expect(r.ok, `set should succeed, got ${r.status}`);
          const body = await r.json() as { value: string; source: string; autoDeclared: boolean };
          await expect(body.value === '/api/v2' && body.source === 'user', 'set return shape wrong');
          await expect(body.autoDeclared === false, 'already-declared name should not be re-declared');
          console.log('  ✓ PUT /api/vars/API_PREFIX (already declared)');
        }

        // list reflects set
        {
          const r = await fetch(`${baseUrl}/api/vars`).then((r) => r.json()) as { variables: Record<string, { value: unknown; source: string }> };
          await expect(r.variables.API_PREFIX.value === '/api/v2', 'value not persisted');
          await expect(r.variables.API_PREFIX.source === 'user', 'source should be user');
          console.log('  ✓ GET /api/vars reflects set');
        }

        // vars.scan — read-only scanner output
        {
          const r = await fetch(`${baseUrl}/api/vars/scan`, { method: 'POST' }).then((r) => r.json()) as {
            candidates: Array<{ name: string; proposedValue?: string }>;
            newCandidates: Array<{ name: string }>;
          };
          const names = r.candidates.map((c) => c.name).sort();
          await expect(names.includes('DISCOVERED'), 'DISCOVERED should be in scan candidates');
          await expect(names.includes('CODE_VAR'), 'CODE_VAR should be in scan candidates');
          await expect(!names.includes('MONGO_URL'), 'MONGO_URL container-managed; must be filtered');
          // scan must NOT write to easy-env.json
          const cfg = JSON.parse(await fs.readFile(path.join(projectDir, 'easy-env.json'), 'utf8')) as { variables: string[] };
          await expect(!cfg.variables.includes('DISCOVERED'), 'scan must not write to easy-env.json');
          await expect(!cfg.variables.includes('CODE_VAR'), 'scan must not write to easy-env.json');
          console.log('  ✓ POST /api/vars/scan (read-only candidate list)');
        }

        // vars.declare — AI submits final list with values
        {
          const r = await fetch(`${baseUrl}/api/vars/declare`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              items: [
                { name: 'DISCOVERED', value: '1', evidence: '.env.example' },
                { name: 'CODE_VAR', evidence: 'src/app.ts' },
                { name: 'MONGO_URL', value: 'should-be-rejected', evidence: 'AI mistake' },
              ],
            }),
          });
          await expect(r.ok, `declare failed: ${r.status}`);
          const body = await r.json() as {
            results: Array<{ name: string; declared: string; valueWritten?: boolean; valueSkippedReason?: string }>;
            declaredVariables: string[];
          };
          const byName = Object.fromEntries(body.results.map((r) => [r.name, r]));
          await expect(byName.DISCOVERED?.declared === 'added', 'DISCOVERED should be added');
          await expect(byName.DISCOVERED?.valueWritten === true, 'DISCOVERED value should be written');
          await expect(byName.CODE_VAR?.declared === 'added', 'CODE_VAR should be added');
          await expect(byName.CODE_VAR?.valueSkippedReason === 'no-value', 'CODE_VAR has no value');
          await expect(byName.MONGO_URL?.declared === 'rejected-container-managed', 'MONGO_URL should be rejected');
          await expect(!body.declaredVariables.includes('MONGO_URL'), 'MONGO_URL must not enter declared list');
          const cfg = JSON.parse(await fs.readFile(path.join(projectDir, 'easy-env.json'), 'utf8')) as { variables: string[] };
          await expect(cfg.variables.includes('DISCOVERED'), 'DISCOVERED should be in easy-env.json');
          await expect(cfg.variables.includes('CODE_VAR'), 'CODE_VAR should be in easy-env.json');
          console.log('  ✓ POST /api/vars/declare (added 2, rejected MONGO_URL, seeded DISCOVERED)');
        }

        // list after declare — DISCOVERED is user-sourced, CODE_VAR still unset
        {
          const r = await fetch(`${baseUrl}/api/vars`).then((r) => r.json()) as { variables: Record<string, { value: unknown; source: string }> };
          await expect(r.variables.DISCOVERED?.source === 'user', 'DISCOVERED should be user after declare');
          await expect(r.variables.DISCOVERED?.value === '1', `DISCOVERED value mismatch: ${JSON.stringify(r.variables.DISCOVERED?.value)}`);
          await expect(r.variables.CODE_VAR?.source === 'unset', 'CODE_VAR (no value) should be unset');
          console.log('  ✓ GET /api/vars after declare: DISCOVERED seeded, CODE_VAR still unset');
        }

        // unset
        {
          const r = await fetch(`${baseUrl}/api/vars/API_PREFIX`, { method: 'DELETE' });
          await expect(r.ok, 'unset failed');
          const list = await fetch(`${baseUrl}/api/vars`).then((r) => r.json()) as { variables: Record<string, { source: string }> };
          await expect(list.variables.API_PREFIX.source === 'unset', 'API_PREFIX should be unset again');
          console.log('  ✓ DELETE /api/vars/API_PREFIX');
        }
      } finally {
        await close();
      }
    });
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
