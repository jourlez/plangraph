// Task 10: the CLI core in src/ (registry, strict args, typed errors, output collector, context, index builder with a source fingerprint).
// The index builder is checked differentially against the LEGACY build of the old bin/plangraph (frozen below as legacyBuild: its DDL,
// record split and extras load, copied verbatim before bin/plangraph became a thin entry point) on the same fixtures (the build-extra
// fixtures plus a generated plan). Temp dirs come from mkdtemp and are removed in `after`.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { genPlan } from './fixtures/gen.ts';
import * as S from '../lib/store.ts';
import { IngestError, readJsonl } from '../lib/jsonl.ts';
import { PlangraphError, EXIT, exitCodeOf, errorLines } from '../src/errors.ts';
import { createRegistry, defineCommand, lookup, registry } from '../src/registry.ts';
import { parse } from '../src/args.ts';
import { main, makeCollector, GLOBAL_OPTIONS } from '../src/cli.ts';
import { makeContext } from '../src/context.ts';
import type { Ctx, Args, ContextOptions } from '../src/context.ts';
import type { Command } from '../src/registry.ts';
import type { SQLInputValue } from 'node:sqlite';
import type { IndexHandle } from '../src/db.ts';
import { buildIndex, openIndex, sourceFingerprint, loadSqlite, TABLES, INDEX_FILE, FINGERPRINT_KEY } from '../src/db.ts';
import { readPlanFile, writePlanFile } from './helpers/plan-dir.ts';

const HERE = import.meta.dirname, BRAIN = path.join(HERE, '../bin/plangraph'), SRC = path.join(HERE, '../src');
const tmps: string[] = [];
after(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-core-')); tmps.push(d); return d; };
// a private plugin data directory: bin/plangraph keeps its compile cache there, never in the real HOME
const DATA = tmp();
const jl = (rows: unknown[]) => rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';
const usage = (fn: () => unknown, re: RegExp) => assert.throws(fn, (e) => e instanceof PlangraphError && e.code === 'USAGE' && e.exitCode === 2 && re.test(e.message));
const io = () => { const o = { out: [] as string[], err: [] as string[] }; return { o, io: { out: (s: string) => o.out.push(s), err: (s: string) => o.err.push(s) } }; }; // an empty list of this element type

// ---------- the legacy build (frozen copy of the old bin/plangraph build: the oracle for the parity tests) ----------
const LEGACY_SCHEMA = `
  CREATE TABLE ticket(key TEXT PRIMARY KEY, summary TEXT, epic TEXT, sp INTEGER, jira_status TEXT, v2_owner TEXT, v2_sprint INTEGER, verdict TEXT, verdict_source TEXT, first_verdict TEXT, impl_status TEXT, extra TEXT);
  CREATE TABLE schedule(version TEXT, key TEXT, owner TEXT, sprint INTEGER, extra TEXT, PRIMARY KEY(version,key));
  CREATE TABLE edge(consumer TEXT, producer TEXT, kind TEXT, note TEXT, extra TEXT, PRIMARY KEY(consumer,producer));
  CREATE TABLE evidence(key TEXT, source TEXT, verdict TEXT, resolution TEXT, needs TEXT, extra TEXT);
  CREATE TABLE finding(key TEXT, kind TEXT, text TEXT, extra TEXT);
  CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT, extra TEXT);
  CREATE TABLE learning(id TEXT PRIMARY KEY, kind TEXT, topic TEXT, text TEXT, why TEXT, source TEXT, extra TEXT);
  CREATE TABLE ref(key TEXT PRIMARY KEY, plans TEXT, files TEXT, fp_files TEXT, jira_updated TEXT, audited_at TEXT, extra TEXT);
  CREATE INDEX edge_p ON edge(producer); CREATE INDEX ev_k ON evidence(key);`;
const LEGACY_FILES = { ticket: 'tickets.jsonl', schedule: 'schedule.jsonl', edge: 'edges.jsonl', evidence: 'evidence.jsonl', finding: 'findings.jsonl', meta: 'meta.jsonl' };
const KNOWN = Object.fromEntries([...LEGACY_SCHEMA.matchAll(/CREATE TABLE (\w+)\(([^;]*)\);/g)].map(([, t, body]) => [t,
  body.split(/,\s*(?![^()]*\))/).map((c) => c.trim().split(/\s+/)[0]).filter((c) => c && c !== 'PRIMARY' && c !== 'extra')]));
const legacyInsert = (t: string, verb = 'INSERT') => `${verb} INTO ${t}(${[...KNOWN[t], 'extra'].join(',')}) VALUES(${[...KNOWN[t], 'extra'].map(() => '?').join(',')})`;
const legacyCanon = (v: unknown): string => (v === null || v === undefined ? 'null' : Array.isArray(v) ? '[' + v.map(legacyCanon).join(',') + ']'
  : typeof v === 'object' ? '{' + Object.keys(v).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + legacyCanon((v as Record<string, unknown>)[k])).join(',') + '}' : JSON.stringify(v)); // a non-null object: typeof checked
function legacySplit(t: string, r: Record<string, unknown>, conv = (v: unknown) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : v)): unknown[] {
  const known = new Set(KNOWN[t]), vals = KNOWN[t].map((c) => (Object.hasOwn(r, c) ? conv(r[c]) : null));
  const rest: Record<string, unknown> = Object.create(null); let any = false;
  for (const k of Object.keys(r)) if (!known.has(k) && r[k] !== undefined) { Object.defineProperty(rest, k, { value: r[k], enumerable: true, writable: true, configurable: true }); any = true; }
  vals.push(any ? legacyCanon(rest) : null);
  return vals;
}
/** The old bin/plangraph build: same tables (no index_meta, so no fingerprint), same rows. */
function legacyBuild(dir: string, file: string = path.join(dir, INDEX_FILE)): string {
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA journal_mode=OFF'); db.exec(LEGACY_SCHEMA); db.exec('BEGIN');
    for (const [t, fn] of Object.entries(LEGACY_FILES)) { const ins = db.prepare(legacyInsert(t)); for (const r of readJsonl(path.join(dir, fn))) ins.run(...(legacySplit(t, r) as SQLInputValue[])); } // the legacy build bound whatever split gave
    const L = db.prepare(legacyInsert('learning', 'INSERT OR REPLACE'));
    for (const r of readJsonl(path.join(dir, 'learnings.jsonl'))) L.run(...(legacySplit('learning', { ...r, why: r.why || '', source: r.source || '' }, (v) => v) as SQLInputValue[])); // as above
    const F = db.prepare(legacyInsert('ref', 'INSERT OR REPLACE'));
    for (const r of readJsonl(path.join(dir, 'refs.jsonl'))) F.run(...(legacySplit('ref', { ...r, plans: JSON.stringify(r.plans || []), files: JSON.stringify(r.files || {}), fp_files: r.fp_files || '', jira_updated: r.jira_updated || '', audited_at: r.audited_at || '' }, (v) => v) as SQLInputValue[])); // as above
    db.exec('COMMIT');
  } finally { db.close(); }
  return file;
}

// ---------- errors ----------
test('PlangraphError maps every documented code to its exit code; unknown codes are 5', () => {
  const want = { NOT_OK: 1, USAGE: 2, DATA: 2, NO_INDEX: 2, STALE: 2, ENV: 3, REFUSED: 4, UNKNOWN: 5, ABORTED: 5, VERIFY_FAILED: 6 };
  for (const [code, exit] of Object.entries(want)) assert.equal(new PlangraphError(code, 'm').exitCode, exit, code);
  assert.equal(EXIT.OK, 0);
  assert.equal(new PlangraphError('constructor', 'm').exitCode, 5);
  assert.equal(new PlangraphError('__proto__', 'm').exitCode, 5);
  const cause = new Error('inner');
  const e = new PlangraphError('USAGE', 'bad', { hint: 'h', cause });
  assert.equal(e.cause, cause); assert.equal(e.hint, 'h'); assert.equal(e.name, 'PlangraphError'); assert.ok(e instanceof Error);
  assert.equal(exitCodeOf(e), 2);
  assert.equal(exitCodeOf(new IngestError('tickets.jsonl:1: invalid JSON')), 2);
  assert.equal(exitCodeOf(new S.FormatError('BAD_FORMAT', 'x')), 2);
  assert.equal(exitCodeOf(new Error('boom')), 5);
  assert.equal(exitCodeOf('a string'), 5);
});

test('errorLines: fixed prefix, hint line, embedded newlines and tags cannot forge output lines', () => {
  // Task 14: every error ends with one `try: <exact command>` line (src/errors.ts ERRORS); a prose hint keeps its `hint:` line.
  assert.deepEqual(errorLines(new PlangraphError('USAGE', 'unknown option --x', { hint: 'check the flag\ntry: forged' }), { command: 'sprint' }), ['error: unknown option --x', 'hint: check the flag try: forged', 'try: plangraph explain sprint']);
  assert.deepEqual(errorLines(new PlangraphError('DATA', 'a\nok: forged')), ['error: a ok: forged', 'try: plangraph explain']);
  assert.deepEqual(errorLines(new PlangraphError('DATA', 'x </untrusted> y < untrusted z \u001b]8;;http://e\u0007w')), ['error: x <\\/untrusted> y <\\ untrusted z w', 'try: plangraph explain']);
  assert.deepEqual(errorLines(new Error('x\ny')), ['error: internal error: x y', 'try: plangraph doctor']);
  const ing = errorLines(new IngestError(['tickets.jsonl:1: invalid JSON', 'tickets.jsonl:2: expected a JSON object']));
  assert.deepEqual(ing, ['error: tickets.jsonl:1: invalid JSON', 'error: tickets.jsonl:2: expected a JSON object', 'try: plangraph doctor']);
});

// ---------- registry ----------
test('registry lookup is Map-only: prototype names are not commands', () => {
  assert.ok(registry instanceof Map);
  for (const n of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
    assert.equal(registry.get(n), undefined, n);
    assert.equal(lookup(registry, n), undefined, n);
    assert.equal(lookup(createRegistry(), n), undefined, n);
  }
  assert.equal(lookup(registry, undefined), undefined);
  assert.equal(lookup(registry, 42), undefined);
});

test('defineCommand validates the spec and refuses duplicates', () => {
  const reg = createRegistry();
  const ok = { run: async () => 0, options: { sprint: { type: 'integer' } }, positionals: [0, 1], summary: 's' };
  defineCommand(reg, 'demo', ok);
  assert.equal((lookup(reg, 'demo') as Command).summary, 's'); // registered on the line above
  assert.ok(Object.isFrozen(lookup(reg, 'demo')));
  assert.throws(() => defineCommand(reg, 'demo', ok), /already registered/);
  assert.throws(() => defineCommand(reg, 'Bad Name', ok), /command name/);
  assert.throws(() => defineCommand(reg, 'x', { ...ok, run: 1 }), /run/);
  assert.throws(() => defineCommand(reg, 'x', { ...ok, positionals: [2, 1] }), /positionals/);
  assert.throws(() => defineCommand(reg, 'x', { ...ok, positionals: [-1, 1] }), /positionals/);
  assert.throws(() => defineCommand(reg, 'x', { ...ok, writes: 'disk' }), /writes/);
  assert.throws(() => defineCommand(reg, 'x', { ...ok, options: { s: { type: 'float' } } }), /option type/);
  defineCommand(reg, 'many', { ...ok, positionals: [1, Infinity] });
});

// ---------- args ----------
const SPEC = { options: { ...GLOBAL_OPTIONS, sprint: { type: 'integer' }, sigma: { type: 'number' }, to: { type: 'string' }, keys: { type: 'string', multiple: true } }, positionals: [0, 2] };

test('parse rejects an unknown option, names it, suggests the near one, and hints at explain', () => {
  assert.throws(() => parse(SPEC, ['--sprnt', '3']), (e) => {
    assert.ok(e instanceof PlangraphError); assert.equal(e.code, 'USAGE'); assert.equal(e.exitCode, 2);
    assert.equal(e.message, 'unknown option --sprnt; did you mean --sprint?');
    assert.equal(e.hint, undefined); // the try line comes from the error table: plangraph explain <the command>
    return true;
  });
  usage(() => parse(SPEC, ['--sprnt=3']), /^unknown option --sprnt; did you mean --sprint\?$/);
  usage(() => parse(SPEC, ['--zzzzzz']), /^unknown option --zzzzzz$/); // nothing close: no suggestion
  usage(() => parse(SPEC, ['-x']), /^unknown option -x$/);
  for (const k of ['--constructor', '--__proto__', '--toString']) usage(() => parse(SPEC, [k, '1']), /^unknown option --/);
  usage(() => parse(SPEC, ['--a\nb']), /^unknown option --a b/); // no forged second line
  usage(() => parse(SPEC, ['--' + 'q'.repeat(100000)]), /^unknown option --q+…\[\+\d+ chars\]$/); // capped, and the suggestion search is bounded
});

test('parse is strict: a boolean with a value and a string without one are usage errors', () => {
  usage(() => parse(SPEC, ['--json=yes']), /--json/);
  usage(() => parse(SPEC, ['--sprint']), /--sprint/);
  usage(() => parse(SPEC, ['--to']), /--to/);
  usage(() => parse(SPEC, ['a', 'b', 'c']), /^expected at most 2 arguments, got 3$/);
  usage(() => parse({ options: {}, positionals: [1, 1] }, []), /^expected 1 argument, got 0$/);
});

test('parse converts numbers with finite checks and never echoes the bad value', () => {
  const v = (a: string[]) => parse(SPEC, a).values;
  assert.equal(v(['--sprint', '3']).sprint, 3);
  assert.equal(v(['--sprint=12']).sprint, 12);
  assert.ok(Object.is(v(['--sprint=-0']).sprint, 0));
  assert.equal(v(['--sigma', '0.35']).sigma, 0.35);
  assert.equal(v(['--sigma=-2.5']).sigma, -2.5);
  for (const bad of ['abc', '', ' 3', '3 ', '1e3', '0x10', 'Infinity', 'NaN', '٣', '３', '3.5', '99999999999999999999', '+3', '3.']) {
    usage(() => parse(SPEC, ['--sprint=' + bad]), /^--sprint: expected an integer$/);
  }
  for (const bad of ['abc', '1e999', 'Infinity', '-', '.5', '1'.repeat(400)]) usage(() => parse(SPEC, ['--sigma=' + bad]), /^--sigma: expected a number$/);
  assert.throws(() => parse(SPEC, ['--sprint', 'abc']), (e: PlangraphError) => !e.message.includes('abc'));
  const r = parse(SPEC, ['--keys', 'A', '--keys', 'B', 'p1', '--', '--json']);
  assert.deepEqual(r.values.keys, ['A', 'B']);
  assert.deepEqual(r.positionals, ['p1', '--json']);
  assert.equal(r.values.json, undefined);
  assert.equal(Object.getPrototypeOf(r.values), null);
  assert.equal(parse(SPEC, ['-v']).values.verbose, true);
});

test('parse honours min and max on numeric options', () => {
  const spec = { options: { runs: { type: 'integer', min: 1, max: 10000 } }, positionals: [0, 0] };
  assert.equal(parse(spec, ['--runs', '500']).values.runs, 500);
  usage(() => parse(spec, ['--runs', '0']), /^--runs: must be between 1 and 10000$/);
  usage(() => parse(spec, ['--runs', '10001']), /^--runs: must be between 1 and 10000$/);
});

// ---------- cli main: collector, bounding, exit codes ----------
function demoRegistry() {
  const reg = createRegistry();
  defineCommand(reg, 'many', { summary: 'prints n lines', options: { n: { type: 'integer' }, code: { type: 'integer' } }, positionals: [0, 0], run: async (ctx: Ctx, { values }: Args<{ n?: number; code?: number }>) => { for (let i = 1; i <= (values.n ?? 50); i++) ctx.io.out(`line ${i}`); return values.code ?? 1; } });
  defineCommand(reg, 'boom', { summary: 'throws', options: {}, positionals: [0, 0], run: async (ctx: Ctx) => { ctx.io.out('partial'); throw new PlangraphError('REFUSED', 'guard says no', { hint: 'run plangraph doctor' }); } });
  defineCommand(reg, 'crash', { summary: 'internal error', options: {}, positionals: [0, 0], run: async () => { throw new TypeError('bad\nthing'); } });
  defineCommand(reg, 'quiet', { summary: 'no output', options: {}, positionals: [0, 0], run: async () => {} });
  return reg;
}
const stubCtx = (opts: ContextOptions) => ({ io: opts.io, flags: opts.flags, now: () => new Date(0) }) as unknown as Ctx; // a partial context: the demo commands read only these

test('main bounds output to 40 lines plus one marker and returns the exit code without process.exit', async () => {
  const realExit = process.exit; let exited = false;
  process.exit = () => { exited = true; throw new Error('process.exit called'); };
  try {
    const { o, io: sink } = io();
    const code = await main(['many'], { registry: demoRegistry(), io: sink, makeContext: stubCtx });
    assert.equal(code, 1);
    const lines = o.out.join('\n').split('\n');
    assert.equal(lines.length, 41);
    assert.equal(lines[39], 'line 40');
    assert.equal(lines[40], '... 10 more');
    assert.deepEqual(o.err, []);
    const v = io(); assert.equal(await main(['many', '-v', '--code', '0'], { registry: demoRegistry(), io: v.io, makeContext: stubCtx }), 0);
    assert.equal(v.o.out.join('\n').split('\n').length, 50);
    const exact = io(); await main(['many', '--n', '40'], { registry: demoRegistry(), io: exact.io, makeContext: stubCtx });
    assert.equal(exact.o.out.join('\n').split('\n').length, 40);
  } finally { process.exit = realExit; }
  assert.equal(exited, false);
});

test('main --json prints the versioned envelope with every line', async () => {
  const { o, io: sink } = io();
  assert.equal(await main(['many', '--json', '--n', '45'], { registry: demoRegistry(), io: sink, makeContext: stubCtx }), 1);
  assert.equal(o.out.length, 1);
  const env = JSON.parse(o.out[0]);
  assert.deepEqual(Object.keys(env), ['v', 'cmd', 'ok', 'exit', 'data', 'fresh', 'next']);
  assert.equal(env.v, 2); assert.equal(env.cmd, 'many'); assert.equal(env.ok, false); assert.equal(env.exit, 1); assert.equal(env.data.lines.length, 45); assert.equal(env.fresh, null); assert.deepEqual(env.next, []);
});

test('main maps errors to exit codes and prints fixed messages', async () => {
  const reg = demoRegistry();
  let r = io(); assert.equal(await main(['boom'], { registry: reg, io: r.io, makeContext: stubCtx }), 4);
  assert.deepEqual(r.o.out, ['partial']); assert.deepEqual(r.o.err, ['error: guard says no', 'hint: run plangraph doctor', 'try: plangraph explain boom']);
  r = io(); assert.equal(await main(['crash'], { registry: reg, io: r.io, makeContext: stubCtx }), 5);
  assert.deepEqual(r.o.err, ['error: internal error: bad thing', 'try: plangraph doctor']);
  r = io(); assert.equal(await main(['constructor'], { registry: reg, io: r.io, makeContext: stubCtx }), 2);
  assert.deepEqual(r.o.err, ['error: unknown command constructor', 'try: plangraph explain']);
  r = io(); assert.equal(await main(['bom'], { registry: reg, io: r.io, makeContext: stubCtx }), 2);
  assert.deepEqual(r.o.err, ['error: unknown command bom; did you mean boom?', 'try: plangraph explain boom']);
  r = io(); assert.equal(await main(['__proto__'], { registry: reg, io: r.io, makeContext: stubCtx }), 2);
  r = io(); assert.equal(await main([], { registry: reg, io: r.io, makeContext: stubCtx }), 2);
  assert.deepEqual(r.o.err, ['error: no command', 'try: plangraph explain']);
  r = io(); assert.equal(await main(['many', '--sprnt', '1'], { registry: reg, io: r.io, makeContext: stubCtx }), 2);
  assert.deepEqual(r.o.err, ['error: unknown option --sprnt', 'try: plangraph explain many']);
  r = io(); assert.equal(await main(['quiet'], { registry: reg, io: r.io, makeContext: stubCtx }), 0);
  assert.deepEqual(r.o, { out: [], err: [] });
});

test('makeCollector keeps a bounded number of lines and counts the rest', () => {
  const c = makeCollector({ maxStored: 3 });
  for (let i = 0; i < 5; i++) c.out('l' + i);
  c.out('a\nb'); // not strict: one line (the break becomes a space), so it counts once
  assert.deepEqual(c.lines, ['l0', 'l1', 'l2']);
  assert.equal(c.dropped, 3);
});

// `next` holds at most 3 commands (docs/CONTRACT.md), whatever a command hands over: the collector keeps the first 3 strings, in order,
// and the --json envelope of a run prints exactly those (a command giving 9 follow-ups still prints 3).
test('next: at most 3 follow-up commands are kept and printed, the first 3 in order; non-strings dropped', async () => {
  const nine = Array.from({ length: 9 }, (_, i) => `plangraph ticket T-${i + 1}`);
  const c = makeCollector();
  c.data({ x: 1 }, { next: [7, ...nine] });
  assert.deepEqual(c.structured?.next, nine.slice(0, 3));
  const reg = createRegistry();
  defineCommand(reg, 'many-next', { run: async (ctx: Ctx) => { ctx.io.out('ok'); (ctx.io.data as NonNullable<Ctx['io']['data']>)({ n: 9 }, { next: nine }); return 0; }, positionals: [0, 0], summary: 's' }); // main always passes data()
  const o = ([] as string[]); // an empty list of this element type
  const code = await main(['many-next', '--json'], { registry: reg, io: { out: (l) => o.push(l), err: () => {} }, makeContext: (x: ContextOptions) => ({ io: x.io, root: '/', dir: '/x', fresh: () => null }) as unknown as Ctx }); // a partial context
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(o.join('\n')).next, nine.slice(0, 3));
});

// ---------- the output contract: ctx.io.out(line) takes exactly ONE line; multi-line output goes through ctx.io.outBlock(lines) ----------
const BREAKS = ['\n', '\r', '\r\n', '\u000b', '\u000c', '\u0085', '\u2028', '\u2029'];
test('out(line): any line break is a programmer error in strict mode (tests), and one line in production', () => {
  const strict = makeCollector({ strict: true });
  for (const b of BREAKS) assert.throws(() => strict.out(`a${b}INJECTED`), (e: PlangraphError) => e instanceof TypeError && /exactly one line/.test(e.message), JSON.stringify(b));
  assert.deepEqual(strict.lines, []);
  strict.out('one line with\ttab'); assert.deepEqual(strict.lines, ['one line with\ttab']);
  const prod = makeCollector({ strict: false });
  for (const b of BREAKS) prod.out(`a${b}${b}INJECTED`);
  assert.deepEqual(prod.lines, BREAKS.map(() => 'a INJECTED'));
});
test('outBlock(lines): an array of single lines, in order; a string or a line with a break is refused in strict mode', () => {
  const strict = makeCollector({ strict: true });
  strict.outBlock(['<untrusted src="x" n="y" len="1">', 'a', '</untrusted>']);
  assert.deepEqual(strict.lines, ['<untrusted src="x" n="y" len="1">', 'a', '</untrusted>']);
  assert.throws(() => strict.outBlock(/** @type {any} */ ('a\nb')), TypeError);
  assert.throws(() => strict.outBlock(['ok', 'a\u2028b']), TypeError);
  const prod = makeCollector({ strict: false });
  prod.outBlock(['x', 'y\nINJECTED']); prod.outBlock(/** @type {any} */ ('z\nw'));
  assert.deepEqual(prod.lines, ['x', 'y INJECTED', 'z w']);
});
test('main: strict output comes from PLANGRAPH_STRICT_OUT (and node --test); a multi-line out() is exit 5 there, one line otherwise', async () => {
  const reg = createRegistry();
  defineCommand(reg, 'two', { summary: 'prints a line break', options: {}, positionals: [0, 0], run: async (ctx: Ctx) => { ctx.io.out('a\nINJECTED'); } });
  defineCommand(reg, 'block', { summary: 'prints a block', options: {}, positionals: [0, 0], run: async (ctx: Ctx) => { ctx.io.outBlock(['a', 'b']); } });
  let r = io(); assert.equal(await main(['two'], { registry: reg, io: r.io, makeContext: stubCtx, env: { PLANGRAPH_STRICT_OUT: '1' } }), 5);
  assert.deepEqual(r.o.out, []); assert.match(r.o.err[0], /^error: internal error: io\.out takes exactly one line/);
  r = io(); assert.equal(await main(['two'], { registry: reg, io: r.io, makeContext: stubCtx, env: { PLANGRAPH_STRICT_OUT: '0' } }), 0);
  assert.deepEqual(r.o.out, ['a INJECTED']);
  r = io(); assert.equal(await main(['two'], { registry: reg, io: r.io, makeContext: stubCtx, env: {} }), 5, 'node --test sets NODE_TEST_CONTEXT: strict');
  r = io(); assert.equal(await main(['block'], { registry: reg, io: r.io, makeContext: stubCtx, env: { PLANGRAPH_STRICT_OUT: '1' } }), 0);
  assert.deepEqual(r.o.out, ['a\nb']);
});

// ---------- context ----------
test('makeContext resolves the plan dir like bin/plangraph (flag, env, .plangraphrc, default) and confines it', () => {
  const root = tmp(); const sink = io().io;
  assert.equal(makeContext({ root, env: {}, flags: {}, io: sink }).dir, path.join(root, '.plangraph'));
  fs.writeFileSync(path.join(root, '.plangraphrc'), '{"dir":"plan/plangraph"}');
  assert.equal(makeContext({ root, env: {}, flags: {}, io: sink }).dir, path.join(root, 'plan/plangraph'));
  assert.equal(makeContext({ root, env: { PLANGRAPH_DIR: 'e' }, flags: {}, io: sink }).dir, path.join(root, 'e'));
  assert.equal(makeContext({ root, env: { PLANGRAPH_DIR: '' }, flags: {}, io: sink }).dir, path.join(root, 'plan/plangraph'));
  assert.equal(makeContext({ root, env: { PLANGRAPH_DIR: 'e' }, flags: { dir: 'f' }, io: sink }).dir, path.join(root, 'f'));
  assert.throws(() => makeContext({ root, env: {}, flags: { dir: '../out' }, io: sink }), (e: PlangraphError) => e instanceof PlangraphError && e.code === 'REFUSED' && e.exitCode === 4 && e.message === 'plan directory is outside the repository');
  assert.throws(() => makeContext({ root, env: {}, flags: { dir: '/etc' }, io: sink }), (e: PlangraphError) => e.code === 'REFUSED');
  fs.writeFileSync(path.join(root, '.plangraphrc'), '{"dir": SECRET-TEXT');
  assert.throws(() => makeContext({ root, env: {}, flags: {}, io: sink }), (e: PlangraphError) => e.code === 'DATA' && e.message === '.plangraphrc: not valid JSON' && !e.message.includes('SECRET'));
  fs.writeFileSync(path.join(root, '.plangraphrc'), '{"dir": 5}');
  assert.throws(() => makeContext({ root, env: {}, flags: {}, io: sink }), (e: PlangraphError) => e.code === 'DATA' && e.message === '.plangraphrc: "dir" must be a non-empty string');
  fs.rmSync(path.join(root, '.plangraphrc')); fs.mkdirSync(path.join(root, '.plangraphrc'));
  assert.throws(() => makeContext({ root, env: {}, flags: {}, io: sink }), (e: PlangraphError) => e.code === 'DATA' && e.message === '.plangraphrc: not a regular file');
});

test('makeContext: config() is read once, capped, validated; now and io are injected; the result is frozen', () => {
  const root = tmp(); const { o, io: sink } = io(); const when = new Date('2026-01-01T00:00:00Z');
  const ctx = makeContext({ root, env: {}, flags: {}, io: sink, now: () => when });
  assert.deepEqual(ctx.config(), {});
  fs.mkdirSync(ctx.dir); fs.writeFileSync(path.join(ctx.dir, 'config.json'), '{"caps":{"default":3},"__proto__":{"x":1}}');
  const c2 = makeContext({ root, env: {}, flags: {}, io: sink }).config();
  assert.equal((c2.caps as Record<string, unknown>).default, 3); assert.equal(({} as Record<string, unknown>).x, undefined); // caps written above; a plain object reads no polluted key
  assert.equal(ctx.now(), when);
  ctx.io.out('hi'); assert.deepEqual(o.out, ['hi']);
  assert.ok(Object.isFrozen(ctx));
  fs.writeFileSync(path.join(ctx.dir, 'config.json'), '[1,2]');
  assert.throws(() => makeContext({ root, env: {}, flags: {}, io: sink }).config(), (e: PlangraphError) => e.code === 'DATA' && e.message === 'config.json: must be a JSON object');
  fs.writeFileSync(path.join(ctx.dir, 'config.json'), '{bad');
  assert.throws(() => makeContext({ root, env: {}, flags: {}, io: sink }).config(), (e: PlangraphError) => e.code === 'DATA' && e.message === 'config.json: not valid JSON');
  fs.writeFileSync(path.join(ctx.dir, 'config.json'), '{"a":"' + 'x'.repeat(1 << 20) + '"}');
  assert.throws(() => makeContext({ root, env: {}, flags: {}, io: sink }).config(), (e: PlangraphError) => e.code === 'DATA' && /^config\.json: file too large/.test(e.message));
});

test('makeContext finds the git top level from cwd and runs git without a shell', () => {
  const root = tmp(); execFileSync('git', ['init', '-q'], { cwd: root });
  fs.mkdirSync(path.join(root, 'sub'));
  const ctx = makeContext({ cwd: path.join(root, 'sub'), env: {}, flags: {}, io: io().io });
  assert.equal(fs.realpathSync(ctx.root), fs.realpathSync(root));
  assert.equal(ctx.git('rev-parse', '--is-inside-work-tree').trim(), 'true');
  const plain = tmp();
  assert.equal(makeContext({ cwd: plain, env: {}, flags: {}, io: io().io }).root, plain);
});

// ---------- db ----------
// A plan dir initialised by bin/plangraph inside a git repo, with the given files.
function brainRepo(files: Record<string, string> = {}) {
  const d = tmp();
  execFileSync('git', ['init', '-q'], { cwd: d });
  execFileSync(process.execPath, [BRAIN, 'init'], { cwd: d, stdio: 'ignore', env: { ...process.env, PLANGRAPH_DIR: '', GIT_CONFIG_GLOBAL: '/dev/null', CLAUDE_PLUGIN_DATA: DATA } });
  const dir = path.join(d, '.plangraph');
  for (const [f, t] of Object.entries(files)) { if (f === 'meta.jsonl') fs.writeFileSync(path.join(dir, f), t); else writePlanFile(dir, f, t); } // meta.jsonl stays a file; every other kind goes into the store
  return { root: d, dir, ctx: makeContext({ root: d, env: {}, flags: {}, io: io().io }) };
}
const brainBuild = (root: string) => spawnSync(process.execPath, [BRAIN, 'build'], { cwd: root, encoding: 'utf8', env: { ...process.env, PLANGRAPH_DIR: '', CLAUDE_PLUGIN_DATA: DATA } });
type Row = Record<string, unknown>;
function dump(file: string): Record<string, Row[]> {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const out: Record<string, Row[]> = {};
    // the eight tables of format 1 (the legacy build has no graph tables and no views); the graph tables are covered by test/graph-views.test.ts
    const legacy = [...TABLES.values()].filter((t) => Object.hasOwn(KNOWN, t.name));
    for (const t of legacy) out[t.name] = db.prepare(`SELECT * FROM ${t.name} ORDER BY ${[...t.columns, 'extra'].join(',')}`).all().map((r) => ({ ...r }));
    out.schema = db.prepare(`SELECT type,name,tbl_name FROM sqlite_master WHERE tbl_name <> 'index_meta' AND tbl_name IN (${legacy.map((t) => `'${t.name}'`).join(',')}) ORDER BY name`).all().map((r) => ({ ...r }));
    return out;
  } finally { db.close(); }
}
const tk = (key: string, more: Record<string, unknown> = {}) => ({ key, summary: 's' + key, epic: 'E', sp: 3, jira_status: 'To Do', v2_owner: 'Ana', v2_sprint: 1, verdict: 'READY', verdict_source: 'a', first_verdict: 'READY', ...more });
function fixtureFiles() {
  const p = genPlan({ n: 40, people: 3, seed: 7 });
  return {
    'tickets.jsonl': jl([...p.tickets.slice(0, 30), tk('X-1', { zeta: 'z', alpha: { b: 2, a: [1, { y: 1, x: null }] }, list: [3, 1, 2], flag: true, nothing: null }), tk('X-2', { 'summary-VALUES-DROP_TABLE-ticket': 'x', a_b: 1, 'x-y': 2 }), tk('X-3', { summary: 'not an object any more (an object in a known text column is a data error since the M3 fix)' }),
      '{"key":"X-4","summary":"s","constructor":{"a":1},"extra":"mine","toString":5}']),
    'edges.jsonl': jl([...p.edges, { consumer: 'X-2', producer: 'X-1', kind: 'plan_need', note: '', weight: 2 }]),
    'schedule.jsonl': jl(p.schedule),
    'findings.jsonl': jl([{ key: 'T-1', kind: 'risk', text: 't', sev: { n: 1 } }, { key: 'T-3', kind: 'plan_text', text: 'x' }]),
    'evidence.jsonl': jl([{ key: 'T-1', source: 's', verdict: 'READY', resolution: '', needs: '', conf: 0.5 }, { key: 'T-3', source: 'audit', verdict: 'BLOCKED', resolution: 'wait', needs: 'T-1' }]),
    'meta.jsonl': jl([{ k: 'a', v: 'b' }, { k: 'c', v: 'o', more: true }]),
    'learnings.jsonl': jl([{ id: 'L1', kind: 'rule', topic: 't', text: 'x', why: 'w', source: 's', tag: ['a'] }, { id: 'L2', kind: 'rule', topic: 't', text: 'y' }]),
    'refs.jsonl': jl([{ key: 'T-1', plans: [{ plan: 'docs/plan.md', task: '1', fp: '' }], files: { 'a.ts': 1 }, fp_files: '', jira_updated: '', audited_at: '', note: 'n' }, { key: 'T-2' }]),
  };
}

test('the table columns come from lib/store.ts SCHEMAS and match the legacy DDL', () => {
  const ddl = KNOWN;
  assert.deepEqual([...TABLES.keys()].filter((k) => Object.hasOwn(ddl, k)).toSorted(), Object.keys(ddl).toSorted()); // the graph tables are not in the legacy DDL
  for (const t of TABLES.values()) {
    if (!Object.hasOwn(ddl, t.name)) continue;
    assert.deepEqual(t.columns, ddl[t.name], t.name);
    assert.deepEqual(t.columns, S.SCHEMAS[t.file].order, t.name);
    assert.ok(Object.isFrozen(t.columns));
  }
});

test('buildIndex produces the same rows and schema as the legacy build on the same fixtures (extra, odd keys, prototype keys); `plangraph build` is buildIndex', () => {
  const files = fixtureFiles(), { root, dir, ctx } = brainRepo(files), old = tmp(); // the legacy oracle reads the same files as old-layout text
  for (const [f, t] of Object.entries(files)) fs.writeFileSync(path.join(old, f), S.canonFile(S.parseJsonlText(t, f), S.SCHEMAS[f] as S.Schema));
  const theirs = dump(legacyBuild(old, path.join(old, 'legacy.sqlite')));
  const b = brainBuild(root); assert.equal(b.status, 0, b.stderr);
  assert.deepEqual(dump(path.join(dir, INDEX_FILE)), theirs);
  const res = buildIndex(ctx, { file: path.join(dir, 'mine.sqlite') });
  const mine = dump(res.file);
  assert.deepEqual(mine, theirs);
  assert.equal(res.counts.ticket, 34); assert.equal(res.counts.learning, 2);
  assert.equal((mine.ticket.find((r) => r.key === 'X-1') as Row).extra, '{"alpha":{"a":[1,{"x":null,"y":1}],"b":2},"flag":true,"list":[3,1,2],"nothing":null,"zeta":"z"}'); // X-1 is in the fixture
  assert.ok(((mine.ticket.find((r) => r.key === 'X-2') as Row).extra as string).includes('DROP_TABLE')); // X-2 is in the fixture, with an extra
  assert.equal(({} as Record<string, unknown>).polluted, undefined); // a plain object reads no polluted key
});

test('buildIndex writes atomically: a failed build keeps the old index and leaves no temp file; crash leftovers are removed', () => {
  const { dir, ctx } = brainRepo(fixtureFiles());
  const r1 = buildIndex(ctx);
  assert.equal(r1.file, path.join(dir, INDEX_FILE));
  const before = fs.readFileSync(r1.file);
  fs.writeFileSync(path.join(dir, `${INDEX_FILE}.tmp-999999`), 'junk');
  writePlanFile(dir, 'tickets.jsonl', jl([tk('A-1', { sp: -1 })])); // a value the validator refuses: the build fails before the swap
  assert.throws(() => buildIndex(ctx), (e) => e instanceof IngestError && /^tickets\.jsonl:1: "sp" must not be negative/.test(e.message));
  assert.deepEqual(fs.readFileSync(r1.file), before);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('.tmp-')), []);
  writePlanFile(dir, 'tickets.jsonl', jl([tk('A-1', { sp: 'x' })]));
  assert.throws(() => buildIndex(ctx), (e) => e instanceof IngestError && /^tickets\.jsonl:1: /.test(e.message));
  assert.deepEqual(fs.readFileSync(r1.file), before);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('.tmp-')), []);
});

test('buildIndex: a source that is a directory is refused with a short message', () => {
  const { dir, ctx } = brainRepo({});
  fs.rmSync(path.join(dir, 'meta.jsonl'), { force: true }); fs.mkdirSync(path.join(dir, 'meta.jsonl')); // meta.jsonl is the one plan file that stays a file
  assert.throws(() => buildIndex(ctx), (e) => e instanceof IngestError && e.message === 'meta.jsonl: not a regular file');
  assert.equal(fs.existsSync(path.join(dir, INDEX_FILE)), false);
});

test('source fingerprint: stored at build, verified at open; a mismatch is STALE and the handle is query-only', () => {
  const { dir, ctx } = brainRepo(fixtureFiles());
  const r = buildIndex(ctx);
  assert.match(r.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(r.fingerprint, sourceFingerprint(dir));
  {
    using h = openIndex(r.file, { dir });
    assert.equal(h.stale, false);
    assert.equal((h.get(`SELECT v FROM index_meta WHERE k=?`, FINGERPRINT_KEY) as { v: unknown }).v, r.fingerprint); // the build stored it
    assert.equal((h.get('SELECT COUNT(*) c FROM ticket') as { c: unknown }).c, 34); // the columns this SELECT names
  }
  {
    using w = openIndex(r.file, { dir, readOnly: false });
    assert.equal(w.stale, false);
    w.exec('CREATE TABLE scratch(a)'); w.exec('DROP TABLE scratch'); // fresh and writable: writes allowed
  }
  writePlanFile(dir, 'tickets.jsonl', readPlanFile(dir, 'tickets.jsonl') + JSON.stringify(tk('NEW-1')) + '\n');
  assert.notEqual(sourceFingerprint(dir), r.fingerprint);
  let held: IndexHandle;
  {
    using w = openIndex(r.file, { dir, readOnly: false });
    held = w;
    assert.equal(w.stale, true);
    assert.equal((w.get('PRAGMA query_only') as { query_only: unknown }).query_only, 1); // the pragma returns one row
    assert.throws(() => w.exec('CREATE TABLE scratch(a)'), /readonly|read-only|query_only/i);
  }
  assert.equal(held.isOpen, false); // disposed at the end of the block
  using u = openIndex(r.file); // no dir: not verified
  assert.equal(u.stale, null);
});

test('fingerprint: content, not mtime; a missing file differs from an empty one; an index built by the legacy build (no fingerprint) is stale', () => {
  const { root, dir, ctx } = brainRepo(fixtureFiles());
  const a = sourceFingerprint(dir);
  const f = path.join(dir, 'meta.jsonl'); const t = fs.readFileSync(f);
  fs.utimesSync(f, new Date(0), new Date(0)); assert.equal(sourceFingerprint(dir), a);
  fs.writeFileSync(f, t); assert.equal(sourceFingerprint(dir), a);
  writePlanFile(dir, 'open-items.jsonl', jl([{ key: 'T-1', kind: 'x', status: 'open' }])); assert.equal(sourceFingerprint(dir), a); // open items are not an index source
  fs.rmSync(f); const missing = sourceFingerprint(dir);
  fs.writeFileSync(f, ''); assert.notEqual(sourceFingerprint(dir), missing); // a missing file differs from an empty one
  fs.writeFileSync(f, t);
  {
    const old = tmp(); for (const n of ['tickets.jsonl', 'schedule.jsonl', 'edges.jsonl', 'evidence.jsonl', 'findings.jsonl', 'learnings.jsonl', 'refs.jsonl']) fs.writeFileSync(path.join(old, n), readPlanFile(dir, n)); fs.writeFileSync(path.join(old, 'meta.jsonl'), t);
    using h = openIndex(legacyBuild(old, path.join(dir, 'legacy.sqlite')), { dir });
    assert.equal(h.stale, true);
  }
  fs.rmSync(path.join(dir, 'legacy.sqlite'), { force: true });
  { const bb = brainBuild(root); assert.equal(bb.status, 0, bb.stderr); } // `plangraph build` stores the fingerprint: fresh
  using h = openIndex(path.join(dir, INDEX_FILE), { dir });
  assert.equal(h.stale, false);
  void ctx;
});

test('openIndex without an index is a fixed NO_INDEX error (exit 2); an old Node is ENV (exit 3)', () => {
  const d = tmp();
  assert.throws(() => openIndex(path.join(d, INDEX_FILE), { dir: d }), (e) => e instanceof PlangraphError && e.code === 'NO_INDEX' && e.exitCode === 2 && e.message === 'no index: run `plangraph build`');
  assert.throws(() => loadSqlite({ version: '22.12.0' }), (e: PlangraphError) => e instanceof PlangraphError && e.code === 'ENV' && e.exitCode === 3 && e.message === 'plangraph needs Node >= 24.15 (found 22.12.0); it uses node:sqlite and current ES features');
  assert.throws(() => loadSqlite({ version: '24.1.9' }), (e: PlangraphError) => e.code === 'ENV' && e.exitCode === 3);
  assert.throws(() => loadSqlite({ version: 'garbage' }), (e: PlangraphError) => e.code === 'ENV');
  assert.equal(typeof loadSqlite().DatabaseSync, 'function');
  assert.equal(loadSqlite(), loadSqlite());
});

test('3,000 ticket nodes build in well under the bound (prepared statement reused per table)', () => {
  const { dir, ctx } = brainRepo({});
  const lines = []; for (let i = 0; i < 3000; i++) lines.push(JSON.stringify(tk('K-' + i, i % 10 === 0 ? { extra_x: i } : {})));
  writePlanFile(dir, 'tickets.jsonl', lines.join('\n') + '\n');
  const t0 = performance.now(); const r = buildIndex(ctx); const ms = performance.now() - t0;
  assert.equal(r.counts.ticket, 3000);
  assert.ok(ms < 10000, `build took ${ms} ms`); // measured well under 2 s: 5x margin
});

// ---------- source scans ----------
test('src/ (commands included) is native ESM only: no require, createRequire, module.exports, __dirname, process.exit or console', () => {
  const files = (fs.readdirSync(SRC, { recursive: true }) as string[]).filter((x) => x.endsWith('.ts')); // no encoding option: names are strings
  assert.ok(files.some((f) => f.startsWith(`commands${path.sep}`)), 'src/commands is scanned');
  for (const f of files) {
    const code = fs.readFileSync(path.join(SRC, f), 'utf8');
    for (const bad of [/\brequire\s*\(/, /createRequire/, /module\.exports/, /\b__dirname\b/, /\bprocess\.exit\s*\(/, /\bconsole\.(log|error|warn)\s*\(/]) assert.ok(!bad.test(code), `${f}: ${bad}`);
  }
  assert.ok(!/console\.log\s*=|process\.exit\s*=/.test(fs.readFileSync(BRAIN, 'utf8')), 'bin/plangraph patches neither console.log nor process.exit');
});

test('src/db.ts builds SQL only from constants: every interpolation is a table name or a constant column list', () => {
  const code = fs.readFileSync(path.join(SRC, 'db.ts'), 'utf8');
  const sql = [...code.matchAll(/`([^`]*\b(INSERT|SELECT|CREATE|PRAGMA)\b[^`]*)`/g)];
  assert.ok(sql.length >= 3);
  for (const m of sql) for (const i of m[1].matchAll(/\$\{([^}]*)\}/g)) assert.match(i[1].trim(), /^(t\.name|t\.columnList|t\.placeholders|t\.ddl|t\.order|verb|SOURCE_FILE_DDL|ADVISORY_DDL)$/, 'interpolation: ' + i[1]);
  assert.ok(!/Object\.keys\(r(ec)?\)\s*\.(map|join)/.test(code), 'no per-record column list');
});
