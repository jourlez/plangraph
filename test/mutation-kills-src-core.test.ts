// Characterization goldens for the pure parts of src/ (test/golden/mutation-kills/src-core.json, UPDATE_GOLDEN=1 rewrites): strict argument
// parsing over a grid of specs and argv, error classification and the error table (exit codes, hints, try lines, did-you-mean), the Node
// floor check, registry validation, the output collector and renderer, and the MCP protocol (message handling, tool argv, framing) with an
// injected runner. Written to kill mutants of src/args.ts, src/errors.ts, src/floor.js, src/registry.ts, src/cli.ts and src/mcp.ts
// that survived scripts/mutate-all.ts. No process is started.
// NOT covered: commands themselves (test/mutation-kills-cli.test.ts and the command tests).
import { test } from 'node:test';
import { parse } from '../src/args.ts';
import { PlangraphError, EXIT, EXIT_MEANING, exitCodeOf, errText, didYouMean, tryOf, errorLines } from '../src/errors.ts';
import { nodeSupported, floorMessage, floorTry, NODE_FLOOR } from '../src/floor.js';
import { createRegistry, defineCommand, lookup } from '../src/registry.ts';
import { makeCollector, render, strictOutput, relDir } from '../src/cli.ts';
import { createServer, serve, toolArgv, TOOLS, PROTOCOL_VERSIONS } from '../src/mcp.ts';
import { golden, outcome } from './helpers/golden-json.ts';
import type { RunIO } from '../src/mcp.ts';

const G = (name: string, fn: () => unknown) => golden('src-core', name, outcome(fn));

test('argument parsing over a grid of specs and argv', () => {
  const spec = { options: { n: { type: 'integer', min: 1, max: 9 }, x: { type: 'number' }, s: { type: 'string', short: 's' }, b: { type: 'boolean' }, m: { type: 'string', multiple: true }, req: { type: 'string', missing: 'needs a value for --req' }, many: { type: 'integer', multiple: true } }, positionals: [1, 2] };
  const argvs = [['a'], ['a', 'b'], [], ['a', 'b', 'c'], ['a', '--n', '3'], ['a', '--n', '0'], ['a', '--n', '10'], ['a', '--n', '1.5'], ['a', '--n', '-0'], ['a', '--x', '-2.5'], ['a', '--x', '1e3'], ['a', '--x', ' 1'], ['a', '--x', '+1'], ['a', '--x', '1'.repeat(41)],
    ['a', '--x', '9'.repeat(400)], ['a', '--n', '99999999999999999'], ['a', '-s', 'v'], ['a', '--s=v'], ['a', '--b'], ['a', '--b=yes'], ['a', '--s'], ['a', '--m', 'x', '--m', 'y'], ['a', '--many', '1', '--many', 'z'], ['a', '--req'], ['a', '--req', '-x'], ['a', '--req=-x'], ['a', '--req', '-'],
    ['a', '--nn', '3'], ['a', '--zzz'], ['a', `--${'q'.repeat(80)}`], ['a', '-z'], ['a', '--', '--n'], ['a', '--n', '9'], ['a', '--n', '1'], ['a', '--req', 'value'], ['a', '--req', 'v']];
  G('parse-grid', () => argvs.map((a) => [a.join(' '), outcome(() => parse(spec, a))]));
  G('parse-positionals', () => [[0, 0], [1, 1], [2, 2], [0, 1], [2, Infinity]].flatMap(([lo, hi]) => [[], ['a'], ['a', 'b', 'c']].map((a) => outcome(() => parse({ positionals: [lo, hi] }, a)))));
  G('parse-bad-spec', () => [outcome(() => parse({ options: { q: { type: 'date' } } }, [])), outcome(() => parse({}, ['x', 'y']))]);
});

test('errors: classification, text, suggestions, try lines, full lines', () => {
  const errs = [new PlangraphError('USAGE', 'bad <x>\nthing'), new PlangraphError('DATA', 'broken', { hint: 'run `plangraph build` now' }), new PlangraphError('NO_INDEX', 'no index'), new PlangraphError('ENV', 'no node'), new PlangraphError('REFUSED', 'outside'), new PlangraphError('NOPE', 'odd'),
    Object.assign(new Error('x'), { code: 'OUTSIDE_REPO' }), Object.assign(new Error('y'), { code: 'SYMLINK' }), Object.assign(new Error('z'), { code: 'BAD_DIR_NAME' }), new TypeError('t'), 'string error', null, Object.assign(new Error('fmt'), { name: 'FormatError', code: 'TOO_NEW' }), Object.assign(new Error('i'), { name: 'IngestError' })];
  G('exit-codes', () => [EXIT, EXIT_MEANING, errs.map((e) => exitCodeOf(e))]);
  G('err-text', () => [errText('a\n b\t<untrusted>c', 100), errText('x'.repeat(50), 10), errText(null, 5)]);
  G('did-you-mean', () => [didYouMean('tickt', ['ticket', 'chain']), didYouMean('xyzzy', ['ticket']), didYouMean('stal', ['stale', 'state']), didYouMean('', ['a']), didYouMean('ab', ['a', 'abc']), didYouMean('verifyy', ['verify'])]);
  G('try-of', () => errs.map((e) => [tryOf(e), tryOf(e, { command: 'ready' })]));
  G('error-lines', () => errs.map((e) => [errorLines(e), errorLines(e, { command: 'stale', root: '/r' })]));
});

test('node floor, registry validation, collector and renderer', () => {
  G('floor', () => [NODE_FLOOR, floorTry, floorMessage('v1.2.3'.repeat(9)), ['24.15.0', '24.14.9', '24.10.0', '25.0.0', '23.99.99', 'v24.15.0', '24.15', '24', 'x', '', '100.0.0', '24.15.0-pre'].map((v) => nodeSupported(v))]);
  const reg = createRegistry();
  const ok = { summary: 's', run: () => 0, positionals: [0, 1], options: { a: { type: 'string' } }, writes: 'none', guard: 'none' };
  G('registry', () => [outcome(() => defineCommand(reg, 'ok', ok)), lookup(reg, 'ok')?.summary, lookup(reg, 5), outcome(() => defineCommand(reg, 'ok', ok)),
    ...[{ ...ok, run: 5 }, { ...ok, summary: '' }, { ...ok, positionals: [2, 1] }, { ...ok, positionals: [-1, 1] }, { ...ok, options: { a: { type: 'date' } } }, { ...ok, writes: 'all' }, { ...ok, guard: 'loose' }, { ...ok, options: { json: { type: 'boolean' } } }].map((s, i) => outcome(() => defineCommand(reg, `c${i}`, s))),
    outcome(() => defineCommand(reg, 'Bad Name', ok))]);
  const col = makeCollector({ maxStored: 3 });
  for (let i = 0; i < 5; i++) col.out(`line ${i}`);
  col.outBlock(['b1', 'b2']);
  G('collector', () => [render(col, { name: 'x', code: 0 }), render(col, { name: 'x', code: 1, json: true, fresh: { fp: 'a', built: 'b' } }), render(makeCollector(), { name: 'y', code: 0, verbose: true })]);
  const strict = makeCollector({ strict: true });
  G('collector-strict', () => [outcome(() => strict.out('a\nb')), outcome(() => strict.out('a b')), outcome(() => makeCollector().out('a\rb'))]);
  G('strict-env', () => [strictOutput({ PLANGRAPH_STRICT_OUT: '1' }), strictOutput({ PLANGRAPH_STRICT_OUT: '0' }), strictOutput({})]);
  G('rel-dir', () => [relDir({ dir: '/r/.plangraph', root: '/r' }, 'in /r/.plangraph/x'), relDir({ dir: '/r', root: '/r' }, '/r/y'), relDir(null, 'z'), relDir({ root: '/r' }, '/r/z'), relDir({ dir: '/r/d' }, '/r/d/z')]);
});

test('MCP: tool argv, every message shape, framing with oversized and partial lines', async () => {
  G('tools', () => [TOOLS.map((t) => t.name), PROTOCOL_VERSIONS]);
  G('tool-argv', () => [['ready', { key: 'T-1' }], ['ready', { key: 'T-1', jira: 'x' }], ['ready', {}], ['ready', { key: 5 }], ['whatif', { key: 'T-1', sprint: 3, to: 'Ana' }], ['whatif', { key: 'T-1', sprint: 'x' }], ['whatif', { key: 'T-1', sprint: 1.5 }], ['whatif', { key: 'T-1', write: true }],
    ['ticket', { key: 'T-1' }], ['ticket', { key: '-x' }], ['ticket', { key: 'a'.repeat(300) }], ['ticket', { key: 'T-1', extra: 1 }], ['nope', {}]].map(([n, a]) => outcome(() => toolArgv((n as string), (a as Record<string, unknown>))))); // each case is [tool name, arguments object]
  const calls: Array<[string[], unknown]> = [];
  const run = async (argv: string[], io: RunIO, ctx: { cwd: string }) => { calls.push([argv, ctx.cwd]); io.out(`ran ${argv.join(' ')}`); io.err('warn'); return argv.includes('T-2') ? 2 : 0; };
  const s = createServer({ cwd: '/w', run });
  const enc = (o: unknown) => new TextEncoder().encode(typeof o === 'string' ? o : JSON.stringify(o));
  const msgs = ['not json', [], [1], 5, { jsonrpc: '1.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: { x: 1 }, method: 'ping' }, { jsonrpc: '2.0', id: 1.5, method: 'ping' }, { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ready' } }, { jsonrpc: '2.0', id: 3, method: 'initialize', params: {} }, { jsonrpc: '2.0', id: 4, method: 'initialize', params: { protocolVersion: '1999-01-01' } }, { jsonrpc: '2.0', id: 5, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 'p', method: 'ping' }, { jsonrpc: '2.0', id: 6, method: 'tools/list' }, { jsonrpc: '2.0', id: 7, method: 'tools/list', params: { cursor: 'x' } }, { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'ready', arguments: { key: 'T-1' } } },
    { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'ready', arguments: { key: 'T-2' } } }, { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'ready', arguments: { key: 5 } } }, { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'nope' } }, { jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 5 } },
    { jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'ready', arguments: [1] } }, { jsonrpc: '2.0', id: 14, method: 'other' }, { jsonrpc: '2.0', id: 15, result: {} }, { jsonrpc: '2.0', id: 16 }, { jsonrpc: '2.0' }, { jsonrpc: '2.0', id: 17, error: {} }];
  const out = [];
  for (const m of msgs) out.push(await s.handle(enc(m)));
  out.push(await s.handle(new Uint8Array([0xff, 0xfe])));
  golden('src-core', 'mcp-handle', { out, calls });
  const lines = ([] as string[]); // an empty list of this element type
  const s2 = createServer({ run });
  const big = 'x'.repeat(1024 * 1024 + 5);
  const chunks = [`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } })}\n  \n{"jsonrpc":"2.0","id":2,`, `"method":"ping"}\n${big}`, `${big}\n`, new TextEncoder().encode('{"jsonrpc":"2.0","id":3,"method":"ping"}')];
  await serve((async function* () { for (const c of chunks) yield c; })(), (l) => lines.push(l), s2);
  golden('src-core', 'mcp-serve', lines);
  const s3 = createServer({ run: async () => { throw new Error('boom'); } });
  golden('src-core', 'mcp-internal-error', [await s3.handle(enc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } })), await s3.handle(enc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ticket', arguments: { key: 'T-1' } } }))]);
});
