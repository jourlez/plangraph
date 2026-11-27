// The MCP server is started through mcp/entry.js (plain JavaScript). Below the Node floor it must answer the handshake with no tools and exit 0 with
// nothing on stderr: a server that exits at once shows up in Claude Code as a failed connection (CONNECTION_CLOSED) in every session, which is what
// raising the floor to Node 26 did for everyone on an older Node until this launcher existed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { serveBelowFloor } from '../mcp/below-floor.js';
import { nodeSupported } from '../src/floor.js';

const ROOT = path.join(import.meta.dirname, '..');

/** Runs the below-floor stub on fake streams: the lines sent, then stdin ends. */
async function run(lines: string[], version = 'v20.20.2'): Promise<{ out: Array<Record<string, any>>; raw: string }> {
  const stdin = Object.assign(new EventEmitter(), { setEncoding() {} });
  const chunks: string[] = [];
  const stdout = Object.assign(new EventEmitter(), { write: (c: string) => { chunks.push(c); return true; } });
  const done = serveBelowFloor(stdin as never, stdout as never, version);
  for (const l of lines) stdin.emit('data', `${l}\n`);
  stdin.emit('end');
  await done;
  const raw = chunks.join('');
  return { out: raw.split('\n').filter(Boolean).map((l) => JSON.parse(l)), raw };
}
const req = (id: unknown, method: string, params?: unknown) => JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });

test('below the floor: initialize succeeds with no tools, tools/list is empty, tools/call is one fixed error result, ping works', async () => {
  const { out } = await run([req(1, 'initialize', { protocolVersion: '2025-06-18' }), JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), req('a', 'tools/list'), req(3, 'tools/call', { name: 'map' }), req(4, 'ping'), req(5, 'nope')]);
  assert.equal(out.length, 5, 'the notification gets no reply');
  assert.equal(out[0].id, 1);
  assert.equal(out[0].result.protocolVersion, '2025-06-18');
  assert.deepEqual(out[0].result.capabilities, { tools: {} });
  assert.match(out[0].result.instructions, /needs Node >= 26\.0 \(found v20\.20\.2\).*install Node 26\.0 or newer/);
  assert.deepEqual(out[1], { jsonrpc: '2.0', id: 'a', result: { tools: [] } });
  assert.equal(out[2].result.isError, true);
  assert.equal(out[2].result.content[0].text, out[0].result.instructions);
  assert.deepEqual(out[3], { jsonrpc: '2.0', id: 4, result: {} });
  assert.equal(out[4].error.code, -32601);
});

test('below the floor: bad input is ignored, ids are only echoed when a string or number, and the protocol version is only echoed when date-shaped', async () => {
  const hostile = 'x'.repeat(300) + '\n\u001b[31m';
  const { out, raw } = await run(['not json', '[]', '5', '{}', JSON.stringify({ jsonrpc: '2.0', id: { a: 1 }, method: 'ping' }), JSON.stringify({ jsonrpc: '2.0', id: null, method: 'ping' }), req(7, 'initialize', { protocolVersion: hostile }), req(8, 'initialize', {})]);
  assert.equal(out.length, 2);
  assert.equal(out[0].result.protocolVersion, '2025-11-25');
  assert.equal(out[1].result.protocolVersion, '2025-11-25');
  assert.ok(!raw.includes('x'.repeat(50)) && !raw.includes('\u001b'), 'no part of the request text is repeated');
});

test('below the floor: a last line without a newline is answered when stdin ends, and the version shown is bounded', async () => {
  const stdin = Object.assign(new EventEmitter(), { setEncoding() {} });
  const chunks: string[] = [];
  const stdout = Object.assign(new EventEmitter(), { write: (c: string) => { chunks.push(c); return true; } });
  const done = serveBelowFloor(stdin as never, stdout as never, `v${'9'.repeat(100)}`);
  stdin.emit('data', req(1, 'initialize', { protocolVersion: '2025-11-25' }));
  stdin.emit('end');
  await done;
  const r = JSON.parse(chunks.join('')) as Record<string, any>;
  assert.ok(r.result.instructions.length < 300);
});

test('below the floor: a closed stdout (EPIPE) stops the writing and the stub still finishes', async () => {
  const stdin = Object.assign(new EventEmitter(), { setEncoding() {} });
  let writes = 0;
  const stdout = Object.assign(new EventEmitter(), { write: () => { writes++; return true; } });
  const done = serveBelowFloor(stdin as never, stdout as never, 'v18.0.0');
  stdout.emit('error');
  stdin.emit('data', `${req(1, 'ping')}\n`);
  stdin.emit('end');
  await done;
  assert.equal(writes, 0);
});

test('mcp/entry.js on this Node: the handshake works with the option off (real server on a supported Node, the stub below the floor)', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'mcp/entry.js')], { cwd: ROOT, encoding: 'utf8', input: `${req(1, 'initialize', { protocolVersion: '2025-11-25' })}\n${req(2, 'tools/list')}\n`, env: { PATH: process.env.PATH, HOME: process.env.HOME, PLANGRAPH_MCP: 'off' } });
  assert.equal(r.status, 0); assert.equal(r.stderr, '');
  const lines = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines[0].result.serverInfo.name, 'plangraph');
  assert.equal(lines[0].result.serverInfo.version === 'below-node-floor', !nodeSupported(process.versions.node), 'a supported Node loads the real server, an older one the stub');
  assert.deepEqual(lines[1].result.tools, []);
});

test('the plugin registers the launcher, which is plain JavaScript that old Node can parse (no type syntax, no TypeScript import before the floor check)', () => {
  const s = JSON.parse(fs.readFileSync(path.join(ROOT, 'mcp/servers.json'), 'utf8')).mcpServers.plangraph;
  assert.deepEqual(s.args, ['${CLAUDE_PLUGIN_ROOT}/mcp/entry.js']);
  const entry = fs.readFileSync(path.join(ROOT, 'mcp/entry.js'), 'utf8');
  const firstStatic = [...entry.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]);
  assert.deepEqual(firstStatic, ['../src/floor.js'], 'the only static import is the plain-JS floor module');
  assert.ok(entry.indexOf("nodeSupported(process.versions.node)") < entry.indexOf("import('./plangraph-mcp.ts')"));
  const stub = fs.readFileSync(path.join(ROOT, 'mcp/below-floor.js'), 'utf8');
  assert.ok(!/\binterface\b|\bas (?:const|unknown|any)\b|: (?:string|number|boolean)\b(?! *[,)}])/.test(stub.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), 'no TypeScript syntax');
});
