#!/usr/bin/env node
// Token cost of the optional MCP adapter (docs/MCP.md), measured the way docs/research/ai-engineering.md section 6 asks:
//   node test/bench-mcp.ts [--dir SCRATCH] [--check [--doc FILE]]
// --check compares the block with the one between the MCP-BENCH markers of docs/MCP.md (or FILE) and exits 1 on drift; it never writes.
// 1. the up-front cost: bytes of the tools/list result (what a client without deferred tool loading puts in context every session)
//    and of the initialize result; 2. the per-call cost on the token benchmark's plan (test/bench-tokens.ts, 1400 tickets): for each
//    of its 24 questions that one of the tools can answer (ticket, ready), the CLI answer vs the MCP tool text and the whole
//    JSON-RPC reply line. est tok = ceil(chars/4 x factor) from test/token-calibration.json (UNVERIFIED until the owner calibrates it).
// Prints a markdown block; docs/MCP.md holds a copy. Limits: what a client adds around a tool result (tool-use framing, the
// mcp__server__tool name) is client-specific and not measured; no live model call is made.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { estimator, loadCalibration } from './bench-tokens.ts';
import { createServer, serve, TOOLS } from '../src/mcp.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const SCRATCH = path.resolve(argv.includes('--dir') ? argv[argv.indexOf('--dir') + 1] : path.join(os.tmpdir(), 'plangraph-bench-mcp'));
const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

const gen = spawnSync(process.execPath, [path.join(ROOT, 'test/bench-tokens.ts'), '--dir', SCRATCH, '--no-write'], { encoding: 'utf8', timeout: 300000 });
if (gen.status !== 0) { console.error('bench-tokens failed:\n' + (gen.stderr || '').slice(0, 800)); process.exit(2); }
const env = { ...process.env, PLANGRAPH_DIR: 'plangraph', CLAUDE_PLUGIN_DATA: path.join(SCRATCH, '.plugin-data') }; // private data dir: bin/plangraph's compile cache never goes to the real HOME
const est = estimator(loadCalibration());

// The bench-tokens questions a tool answers (same numbering and keys: K1 T-700, K2 T-1200, K3 T-20).
/** @type {Array<[number | string, string, Record<string, unknown>, string[]]>} */
/** One measured call: bench question id (or a label), tool, tool arguments, the matching CLI argv. */
type Call = [number | string, string, Record<string, unknown>, string[]];
const Q: Call[] = [[1, 'ticket', { key: 'T-700' }, ['ticket', 'T-700']], [4, 'ready', { key: 'T-700' }, ['ready', 'T-700']], [15, 'ticket', { key: 'T-1200' }, ['ticket', 'T-1200']],
  [21, 'ticket', { key: 'T-20' }, ['ticket', 'T-20']], [22, 'ticket', { key: 'T-99999' }, ['ticket', 'T-99999']]];
const EXTRA: Call[] = [['whatif (no bench question)', 'whatif', { key: 'T-700', sprint: 3 }, ['whatif', 'T-700', '--sprint', '3']]];

const lines = [JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'bench', version: '0' } } }),
  JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  ...[...Q, ...EXTRA].map(([, name, args], i) => JSON.stringify({ jsonrpc: '2.0', id: 10 + i, method: 'tools/call', params: { name, arguments: args } }))];
const out: string[] = [];
async function* input() { yield Buffer.from(lines.join('\n') + '\n'); }
await serve(input(), (l) => out.push(l), createServer({ env, cwd: SCRATCH }));
const reply = (id: number) => { const l = out.find((x) => JSON.parse(x).id === id); if (!l) throw new Error(`no reply ${id}`); return l; };
const cli = (a: string[]) => { const r = spawnSync(process.execPath, [path.join(ROOT, 'bin/plangraph'), ...a], { cwd: SCRATCH, env, encoding: 'utf8' }); return [r.stdout, r.stderr].map((s) => s.replace(/\n$/, '')).filter(Boolean).join('\n'); };

const list = reply(1), init = reply(0), defs = JSON.stringify(TOOLS);
const MAX_LIST_BYTES = 2600; // amendment 3.8: tools/list stays under this many bytes (the reply line, what a client loads eagerly)
if (bytes(list) > MAX_LIST_BYTES) { console.error(`tools/list reply is ${bytes(list)} bytes, over the ${MAX_LIST_BYTES} byte bound`); process.exit(1); }
const md = [`Tokenizer: est tok = ceil(chars/4) x ${loadCalibration().factor} (test/token-calibration.json, unverified). Bytes are exact.`, '',
  '| up-front item | bytes | est tok |', '|---|--:|--:|',
  `| tool definitions (JSON of the ${TOOLS.length} tools) | ${bytes(defs)} | ${est(defs)} |`,
  ...TOOLS.map((t) => `| - ${t.name} | ${bytes(JSON.stringify(t))} | ${est(JSON.stringify(t))} |`),
  `| tools/list reply line | ${bytes(list)} | ${est(list)} |`, `| initialize reply line | ${bytes(init)} | ${est(init)} |`, '',
  '| # | call | cli bytes | mcp text bytes | same text | reply line bytes | wrapper bytes | cli est tok | reply est tok |', '|--:|---|--:|--:|:-:|--:|--:|--:|--:|'];
let sc = 0, sr = 0;
[...Q, ...EXTRA].forEach(([id, name, args, a], i) => {
  const r = reply(10 + i), text = JSON.parse(r).result.content[0].text, c = cli(a);
  sc += bytes(c); sr += bytes(r);
  md.push(`| ${id} | ${name} ${JSON.stringify(args).replace(/\|/g, '/')} | ${bytes(c)} | ${bytes(text)} | ${text === c ? 'yes' : 'NO'} | ${bytes(r)} | ${bytes(r) - bytes(text)} | ${est(c)} | ${est(r)} |`);
});
md.push(`| | total | ${sc} | | | ${sr} | ${sr - sc} | | |`);
const block = md.join('\n');
console.log(block);
if (argv.includes('--check')) {
  const doc = argv.includes('--doc') ? path.resolve(argv[argv.indexOf('--doc') + 1]) : path.join(ROOT, 'docs/MCP.md');
  const A = '<!-- MCP-BENCH:START -->', B = '<!-- MCP-BENCH:END -->';
  const cur = fs.readFileSync(doc, 'utf8'), i = cur.indexOf(A), j = cur.indexOf(B);
  const same = i >= 0 && j > i && cur.slice(i + A.length, j) === '\n' + block + '\n';
  if (!same) { console.error('docs/MCP.md token table is stale: paste the output of node test/bench-mcp.ts between the MCP-BENCH markers'); process.exit(1); }
}
