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

async function testComposeMongoUrl(): Promise<void> {
  const { composeMongoUrl } = await import('../src/core/vars.js');
  await expect(
    composeMongoUrl('mongodb://localhost:32799', 'blog') === 'mongodb://localhost:32799/blog',
    'bare URL should append dbName',
  );
  await expect(
    composeMongoUrl('mongodb://localhost:32799/', 'blog') === 'mongodb://localhost:32799/blog',
    'trailing slash should append dbName cleanly',
  );
  await expect(
    composeMongoUrl('mongodb://localhost:32799/existing', 'blog') === 'mongodb://localhost:32799/existing',
    'preserve existing path',
  );
  await expect(
    composeMongoUrl('mongodb://localhost:32799', undefined) === 'mongodb://localhost:32799',
    'no dbName → unchanged',
  );
  console.log('  ✓ composeMongoUrl: bare / trailing-slash / preserve / no-dbName');
}

async function main(): Promise<void> {
  await testComposeMongoUrl();
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
        await expect(r.tools.length === 20, `expected 20 tools, got ${r.tools.length}`);
        console.log('  ✓ GET /api/tools (20 tools)');
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

        // set undeclared name → rejected
        {
          const r = await fetch(`${baseUrl}/api/vars/UNDECLARED`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ value: 'x' }),
          });
          await expect(!r.ok, 'setting undeclared name should fail');
          console.log('  ✓ PUT /api/vars/:undeclared → rejected');
        }

        // set declared name → ok
        {
          const r = await fetch(`${baseUrl}/api/vars/API_PREFIX`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ value: '/api/v2' }),
          });
          await expect(r.ok, `set should succeed, got ${r.status}`);
          const body = await r.json() as { value: string; source: string };
          await expect(body.value === '/api/v2' && body.source === 'user', 'set return shape wrong');
          console.log('  ✓ PUT /api/vars/API_PREFIX');
        }

        // list reflects set
        {
          const r = await fetch(`${baseUrl}/api/vars`).then((r) => r.json()) as { variables: Record<string, { value: unknown; source: string }> };
          await expect(r.variables.API_PREFIX.value === '/api/v2', 'value not persisted');
          await expect(r.variables.API_PREFIX.source === 'user', 'source should be user');
          console.log('  ✓ GET /api/vars reflects set');
        }

        // init dryRun — should find DISCOVERED + CODE_VAR, NOT MONGO_URL
        {
          const r = await fetch(`${baseUrl}/api/vars/init?dryRun=1`, { method: 'POST' }).then((r) => r.json()) as {
            applied: boolean;
            additions: Array<{ name: string }>;
          };
          await expect(r.applied === false, 'dryRun should not apply');
          const names = r.additions.map((a) => a.name).sort();
          await expect(names.includes('DISCOVERED'), 'DISCOVERED should be proposed');
          await expect(names.includes('CODE_VAR'), 'CODE_VAR should be proposed');
          await expect(!names.includes('MONGO_URL'), 'MONGO_URL is container-managed; must be filtered');
          await expect(!names.includes('API_PREFIX'), 'API_PREFIX already declared; not an addition');
          console.log('  ✓ POST /api/vars/init?dryRun=1 (DISCOVERED + CODE_VAR, MONGO_URL filtered)');
        }

        // init apply — writes back to easy-env.json
        {
          const r = await fetch(`${baseUrl}/api/vars/init?dryRun=0`, { method: 'POST' });
          await expect(r.ok, `apply failed: ${r.status}`);
          const cfg = JSON.parse(await fs.readFile(path.join(projectDir, 'easy-env.json'), 'utf8')) as { variables: string[] };
          await expect(cfg.variables.includes('DISCOVERED'), 'DISCOVERED not written to config');
          await expect(cfg.variables.includes('CODE_VAR'), 'CODE_VAR not written to config');
          console.log('  ✓ POST /api/vars/init?dryRun=0 (writes easy-env.json)');
        }

        // list after apply — newly declared names visible as unset
        {
          const r = await fetch(`${baseUrl}/api/vars`).then((r) => r.json()) as { variables: Record<string, { source: string }> };
          await expect(r.variables.DISCOVERED?.source === 'unset', 'DISCOVERED should be unset after init');
          console.log('  ✓ GET /api/vars after init shows newly declared');
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
