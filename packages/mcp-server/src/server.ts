// MCP stdio server (thin client). All tool work is delegated to the
// long-running daemon over HTTP. See docs/DAEMON_API.md.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';

import { TOOL_REGISTRY } from './tools/registry.js';
import { DaemonClient } from './daemon/client.js';

const daemon = new DaemonClient();

// Best-effort: ensure daemon is up before we start serving tool calls.
// Errors here are non-fatal — we'll surface them on first call.
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
  // Ensure daemon is up on every call — covers cold start and crashes.
  await daemon.ensureRunning();
  const result = await daemon.callTool(req.params.name, req.params.arguments ?? {});
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
