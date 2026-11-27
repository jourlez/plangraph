// mcp/plangraph-mcp.ts run in process: the Node floor refusal, a served session, and a client that goes away mid-session (EPIPE).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { main, type McpHost } from '../mcp/plangraph-mcp.ts';
import { floorMessage } from '../src/floor.js';

const rpc = (rows: object[]): string => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

function host(over: Partial<McpHost>, input = ''): { h: McpHost; out: string[]; err: string[]; errorListeners: Array<() => void> } {
  const out: string[] = [], err: string[] = [], errorListeners: Array<() => void> = [];
  const h: McpHost = {
    version: process.version, versions: process.versions.node, env: {}, cwd: os.tmpdir(), stdin: Readable.from([input]),
    stdout: { write: (c) => out.push(c), on: (_e, l) => errorListeners.push(l) },
    stderr: { write: (c) => err.push(c) },
    ...over,
  };
  return { h, out, err, errorListeners };
}

test('below the Node floor it writes the floor message to stderr, serves nothing and returns 3', async () => {
  const { h, out, err } = host({ version: 'v20.11.0', versions: '20.11.0' }, rpc([{ jsonrpc: '2.0', id: 1, method: 'ping' }]));
  assert.equal(await main(h), 3);
  assert.deepEqual(err, [`${floorMessage('v20.11.0')}\n`]);
  assert.deepEqual(out, []);
});

test('on a supported Node it answers initialize and tools/list on stdout and returns 0 when stdin ends', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-mcp-br-'));
  try {
    fs.mkdirSync(path.join(tmp, '.plangraph')); // with no plan directory the server answers one error and exits quietly (docs/MCP.md)
    const { h, out, err } = host({ cwd: tmp }, rpc([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ]));
    assert.equal(await main(h), 0);
    assert.deepEqual(err, []);
    const msgs = out.join('').trim().split('\n').map((l) => JSON.parse(l) as { id: number; result: { protocolVersion?: string; tools?: Array<{ name: string }> } });
    assert.equal(msgs[0]?.result.protocolVersion, '2025-11-25');
    assert.deepEqual(msgs[1]?.result.tools?.map((t) => t.name).sort(), ['context', 'flow_next', 'graph', 'map', 'ready', 'ticket', 'whatif']);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('after a stdout error nothing more is written but the session still drains and returns 0', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-mcp-br-'));
  try {
    let hook: (() => void) | undefined;
    const written: string[] = [];
    const { h } = host({
      cwd: tmp,
      stdin: (async function* () { yield rpc([{ jsonrpc: '2.0', id: 1, method: 'ping' }]); hook?.(); yield rpc([{ jsonrpc: '2.0', id: 2, method: 'ping' }]); })(),
      stdout: { write: (c) => written.push(c), on: (_e, l) => { hook = l; } },
    });
    assert.equal(await main(h), 0);
    assert.equal(written.length, 1);
    assert.equal((JSON.parse(written[0] ?? '') as { id: number }).id, 1);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
