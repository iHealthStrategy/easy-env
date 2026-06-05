// MCP stdio server (thin client). All tool work is delegated to the
// long-running daemon over HTTP. See docs/DAEMON_API.md.
//
// Project identity is resolved HERE, on the MCP-client side, by reading
// the project's easy-env.json once at startup. Every outbound tool call
// gets { projectName, projectRoot } auto-injected into its body if the
// caller didn't supply them — so the AI can write `vars.declare({items})`
// without re-naming the project every time. The daemon NEVER opens any
// file inside the project directory.
import './core/requireNode.js'; // must be first: hard-exits on Node < 18
import fs from 'node:fs';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';

import { TOOL_REGISTRY } from './tools/registry.js';
import { DaemonClient } from './daemon/client.js';

interface ProjectIdentity {
  projectName: string;
  projectRoot: string;
}

/**
 * Walk up from `start` until we find an easy-env.json with a "name" field.
 * That file's directory is the projectRoot. Returns null if not found —
 * which is normal during initial bootstrap (the user is about to create
 * the file).
 */
function discoverProjectIdentity(start: string = process.cwd()): ProjectIdentity | null {
  let dir = path.resolve(start);
  while (true) {
    const candidate = path.join(dir, 'easy-env.json');
    if (fs.existsSync(candidate)) {
      try {
        const raw = fs.readFileSync(candidate, 'utf8');
        const parsed = JSON.parse(raw) as { name?: unknown };
        if (typeof parsed.name === 'string' && parsed.name.length > 0) {
          return { projectName: parsed.name, projectRoot: dir };
        }
      } catch {
        // unreadable / invalid JSON — keep walking just in case there's a
        // valid one further up
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const identity = discoverProjectIdentity();
if (!identity) {
  console.error(
    '[easy-env-mcp] no easy-env.json with a "name" found above ' + process.cwd() +
    '. Tools requiring projectName will fail until one is created.',
  );
}

// Tools that don't operate on a specific project — never inject identity.
const PROJECT_AGNOSTIC = new Set([
  'env.status',
  'env.down',
  'state.capture',
  'scenario.settle',
  'scenario.replay',
  'diff.compare',
  'db.seed',
  'db.find',
  'db.insert',
  'db.update',
  'db.delete',
  // traffic.* are env-scoped (keyed by envId), so they never need project
  // identity injected. monitor.set IS project-scoped and is intentionally
  // absent here so it gets { projectName, projectRoot } auto-injected.
  'traffic.targets',
  'traffic.enable',
  'traffic.disable',
  'traffic.tail',
]);

function injectIdentity(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  if (!identity) return args;
  if (PROJECT_AGNOSTIC.has(toolName)) return args;
  const out: Record<string, unknown> = { ...args };
  if (out.projectName === undefined) out.projectName = identity.projectName;
  if (out.projectRoot === undefined) out.projectRoot = identity.projectRoot;
  return out;
}

const daemon = new DaemonClient();

await daemon.ensureRunning().catch((e) => {
  console.error('[easy-env-mcp] failed to start daemon:', e instanceof Error ? e.message : e);
});

const server = new Server(
  { name: 'easy-env-mcp', version: '0.1.0-alpha' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOL_REGISTRY.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: zodToJsonSchema(t.inputSchema, { target: 'jsonSchema7' }),
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  await daemon.ensureRunning();
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;
  const enriched = injectIdentity(req.params.name, args);
  const result = await daemon.callTool(req.params.name, enriched);
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
