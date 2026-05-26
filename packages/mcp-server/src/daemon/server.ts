// Hono HTTP app exposing tool calls + resource endpoints.
// See docs/DAEMON_API.md for the API contract.
import { Hono, type Context } from 'hono';
import { ZodError } from 'zod';

import type { ToolContext } from '../core/context.js';
import { findTool, TOOL_REGISTRY } from '../tools/registry.js';
import { ActivityLog } from './activity.js';

const VERSION = '0.1.0-alpha';

export function buildApp(ctx: ToolContext, startedAt: number): Hono {
  const app = new Hono();
  const activity = new ActivityLog();

  const invokeTool = async (toolName: string, args: unknown): Promise<unknown> => {
    const tool = findTool(toolName);
    if (!tool) throw new Error(`unknown tool: ${toolName}`);
    const startedAtMs = Date.now();
    const startedAtIso = new Date(startedAtMs).toISOString();
    try {
      const result = await tool.run(args, ctx);
      activity.record({
        tool: toolName,
        startedAt: startedAtIso,
        durationMs: Date.now() - startedAtMs,
        status: 'ok',
      });
      return result;
    } catch (e) {
      activity.record({
        tool: toolName,
        startedAt: startedAtIso,
        durationMs: Date.now() - startedAtMs,
        status: 'error',
        errorMessage: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  };

  // ── meta ──────────────────────────────────────────────────────────────────
  app.get('/api/health', (c) =>
    c.json({
      ok: true,
      version: VERSION,
      pid: process.pid,
      startedAt: new Date(startedAt).toISOString(),
      uptimeMs: Date.now() - startedAt,
    }),
  );

  app.get('/api/activity', (c) => {
    const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? 50)));
    return c.json({ entries: activity.recent(limit), stats: activity.stats() });
  });

  app.get('/api/tools', (c) =>
    c.json({
      tools: TOOL_REGISTRY.map((t) => ({ name: t.name, description: t.description })),
    }),
  );

  // ── projects index (Web UI) ───────────────────────────────────────────────
  // `key` is the on-disk slug (`<name>__<rootHash>`), unique per worktree.
  // UI uses it for subsequent /api/projects/:key/... routes so two
  // worktrees of the same project don't collide on the URL space.
  app.get('/api/projects', async (c) => {
    try {
      const slugs = await ctx.manifests.list();
      const projects = await Promise.all(
        slugs.map(async (slug) => {
          const m = await ctx.manifests.read(slug);
          return m
            ? {
                key: slug,
                name: m.name,
                projectRoot: m.projectRoot,
                backends: m.backends,
                variableCount: m.variables.length,
              }
            : null;
        }),
      );
      return c.json({ projects: projects.filter(Boolean) });
    } catch (e) {
      return handleError(c, e);
    }
  });

  // `:name` here is the on-disk slug emitted by GET /api/projects (the
  // `key` field). We resolve it to the manifest's real `(name, root)`
  // before invoking any tool so downstream code never has to detect
  // whether it's holding a slug or a bare projectName.
  app.get('/api/projects/:name', async (c) => {
    try {
      const m = await ctx.manifests.read(c.req.param('name'));
      if (!m) return c.json({ error: { code: 'not-found', message: 'project not found' } }, 404);
      return c.json({ manifest: m });
    } catch (e) {
      return handleError(c, e);
    }
  });

  app.delete('/api/projects/:name', async (c) => {
    try {
      const m = await ctx.manifests.read(c.req.param('name'));
      if (!m) return c.json({ error: { code: 'not-found', message: 'project not found' } }, 404);
      return c.json(await invokeTool('project.delete', {
        projectName: m.name,
        projectRoot: m.projectRoot,
      }));
    } catch (e) {
      return handleError(c, e);
    }
  });

  // ── generic tool dispatch (MCP thin client uses this) ─────────────────────
  app.post('/api/tools/:name', async (c) => {
    const name = c.req.param('name');
    if (!findTool(name)) {
      return c.json(
        { error: { code: 'unknown-tool', message: `unknown tool: ${name}` } },
        404,
      );
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    try {
      const result = await invokeTool(name, body ?? {});
      return c.json(result);
    } catch (e) {
      return handleError(c, e);
    }
  });

  // ── envs resource endpoints (Web UI) ──────────────────────────────────────
  app.get('/api/envs', async (c) => {
    try {
      const projectName = c.req.query('projectName') ?? undefined;
      return c.json(await invokeTool('env.list', projectName ? { projectName } : {}));
    } catch (e) {
      return handleError(c, e);
    }
  });

  app.get('/api/envs/:envId', async (c) => {
    try {
      return c.json(await invokeTool('env.status', { envId: c.req.param('envId') }));
    } catch (e) {
      return handleError(c, e);
    }
  });

  // ── snapshots / diffs resource endpoints ──────────────────────────────────
  app.get('/api/snapshots', async (c) => {
    try {
      const items = await ctx.store.listSnapshots();
      return c.json({ snapshots: items });
    } catch (e) {
      return handleError(c, e);
    }
  });

  app.get('/api/snapshots/:id', async (c) => {
    try {
      const snap = await ctx.store.getSnapshot(c.req.param('id'));
      if (!snap) return c.json({ error: { code: 'not-found', message: 'snapshot not found' } }, 404);
      return c.json(snap);
    } catch (e) {
      return handleError(c, e);
    }
  });

  app.get('/api/diffs', async (c) => {
    try {
      const items = await ctx.store.listDiffs();
      return c.json({ diffs: items });
    } catch (e) {
      return handleError(c, e);
    }
  });

  app.get('/api/diffs/:id', async (c) => {
    try {
      const diff = await ctx.store.getDiff(c.req.param('id'));
      if (!diff) return c.json({ error: { code: 'not-found', message: 'diff not found' } }, 404);
      return c.json(diff);
    } catch (e) {
      return handleError(c, e);
    }
  });

  // ── vars resource endpoints (Web UI) ──────────────────────────────────────
  // All vars endpoints require ?projectName=… because the daemon never
  // assumes a "current project" — every call carries its own identity.
  app.get('/api/projects/:name/vars', async (c) => {
    try {
      const m = await ctx.manifests.read(c.req.param('name'));
      if (!m) return c.json({ error: { code: 'not-found', message: 'project not found' } }, 404);
      return c.json(await invokeTool('vars.list', {
        projectName: m.name,
        projectRoot: m.projectRoot,
      }));
    } catch (e) {
      return handleError(c, e);
    }
  });

  app.put('/api/projects/:name/vars/:varName', async (c) => {
    try {
      const m = await ctx.manifests.read(c.req.param('name'));
      if (!m) return c.json({ error: { code: 'not-found', message: 'project not found' } }, 404);
      const body = (await c.req.json().catch(() => ({}))) as { value?: unknown };
      return c.json(await invokeTool('vars.set', {
        projectName: m.name,
        projectRoot: m.projectRoot,
        name: c.req.param('varName'),
        value: body.value ?? null,
      }));
    } catch (e) {
      return handleError(c, e);
    }
  });

  app.delete('/api/projects/:name/vars/:varName', async (c) => {
    try {
      const m = await ctx.manifests.read(c.req.param('name'));
      if (!m) return c.json({ error: { code: 'not-found', message: 'project not found' } }, 404);
      return c.json(await invokeTool('vars.unset', {
        projectName: m.name,
        projectRoot: m.projectRoot,
        name: c.req.param('varName'),
      }));
    } catch (e) {
      return handleError(c, e);
    }
  });

  // ── 404 ───────────────────────────────────────────────────────────────────
  app.notFound((c) =>
    c.json({ error: { code: 'not-found', message: `no route for ${c.req.method} ${c.req.path}` } }, 404),
  );

  return app;
}

function handleError(c: Context, e: unknown) {
  if (e instanceof ZodError) {
    return c.json(
      { error: { code: 'invalid-input', message: 'input validation failed', details: e.flatten() } },
      400,
    );
  }
  const msg = e instanceof Error ? e.message : String(e);
  if (/not found/i.test(msg)) {
    return c.json({ error: { code: 'not-found', message: msg } }, 404);
  }
  return c.json({ error: { code: 'internal', message: msg } }, 500);
}
