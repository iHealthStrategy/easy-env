// Tiny MCP client over stdio — verifies the server lists our 4 tools.
import { spawn } from 'node:child_process';
import path from 'node:path';

const serverPath = path.resolve('dist/src/server.js');
const proc = spawn('node', [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] });

let buf = '';
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

proc.stdout.on('data', (chunk: Buffer) => {
  buf += chunk.toString('utf8');
  let nl = buf.indexOf('\n');
  while (nl !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) {
      try {
        const msg = JSON.parse(line);
        if (typeof msg.id === 'number' && pending.has(msg.id)) {
          pending.get(msg.id)!.resolve(msg);
          pending.delete(msg.id);
        }
      } catch {}
    }
    nl = buf.indexOf('\n');
  }
});

proc.stderr.on('data', () => {});

function request(id: number, method: string, params: unknown): Promise<{ result?: unknown; error?: { message: string } }> {
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout waiting for response to ${method} id=${id}`));
      }
    }, 4000);
  });
}

function notify(method: string, params: unknown): void {
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

async function main() {
  const init = (await request(1, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke-client', version: '0.0.1' },
  })) as { result?: { serverInfo?: { name?: string; version?: string } } };
  console.log('initialize result:', init.result?.serverInfo);
  notify('notifications/initialized', {});

  const list = (await request(2, 'tools/list', {})) as { result?: { tools?: Array<{ name: string; description: string }> } };
  const tools = list.result?.tools ?? [];
  console.log(`tools exposed: ${tools.length}`);
  for (const t of tools) {
    console.log(`  - ${t.name}: ${t.description.slice(0, 70)}...`);
  }
  if (tools.length !== 21) throw new Error(`expected 21 tools, got ${tools.length}`);
  const expectedNames = [
    'env.init', 'env.up', 'env.list', 'env.status', 'env.reset', 'env.down',
    'db.seed', 'db.find', 'db.insert', 'db.update', 'db.delete',
    'vars.list', 'vars.set', 'vars.unset', 'vars.declare',
    'project.delete',
    'state.seed', 'state.capture', 'scenario.settle', 'diff.compare', 'scenario.replay',
  ];
  for (const name of expectedNames) {
    if (!tools.find((t) => t.name === name)) throw new Error(`${name} missing`);
  }
  if (!tools.find((t) => t.name === 'state.capture')) throw new Error('state.capture missing');
  if (!tools.find((t) => t.name === 'scenario.settle')) throw new Error('scenario.settle missing');
  if (!tools.find((t) => t.name === 'diff.compare')) throw new Error('diff.compare missing');
  if (!tools.find((t) => t.name === 'scenario.replay')) throw new Error('scenario.replay missing');

  console.log('MCP HANDSHAKE OK');
  proc.kill();
}

main().catch((e) => {
  console.error(e);
  proc.kill();
  process.exit(1);
});
