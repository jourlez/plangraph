// Characterization goldens and behavior checks for lib/store.ts (test/golden/mutation-kills/store.json, UPDATE_GOLDEN=1 rewrites),
// written to kill mutants that survived scripts/mutate-all.ts: canonical values, lines and files for every schema (sets, defaults,
// unknown fields, duplicates, the evidence content hash), record reads and their refusals, the lock (exclusive create, a live owner kept,
// a stale dead owner stolen, symlinked lock paths refused, release only by the holder), format.json reads with every refusal and the
// read/write format gate, migration planning and running, and .gitattributes and git config for the merge driver in a temp repository.
// NOT covered: concurrent processes racing for the lock (test/store.test.ts); running as root.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as S from '../lib/store.ts';
import { golden, outcome } from './helpers/golden-json.ts';

// this process's pid appears in lock messages: replaced so the goldens do not depend on it
const G = (name: string, fn: () => unknown) => golden('store', name, JSON.parse(JSON.stringify(outcome(fn)).split(`pid ${process.pid}`).join('pid <self>')));
const made: string[] = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'storek-'))); made.push(d); return d; };
const put = (d: string, f: string, t: string) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), t); };
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

test('canonical values, lines and files for every schema', () => {
  G('keys', () => [S.keyStr(['a', null, 3, undefined]), S.showKey('a\u0000b\u0000'), S.schemaFor('x/tickets.jsonl').file, S.schemaFor('other.jsonl').file]);
  G('canon-value', () => [S.canonValue({ b: [3, 1, { z: undefined, y: null }], a: 'x' }), S.canonValue(['b', 'a', 'b'], true), S.canonValue(undefined), S.canonValue(null), S.canonValue([]), S.canonValue(1.0), S.canonValue({ __proto__: { x: 1 }, own: 1 })]);
  G('canon-line', () => [S.canonLine({ z: 1, key: 'A', sp: 2, summary: 's', extra: undefined }, S.SCHEMAS['tickets.jsonl']), S.canonLine({ key: 'K', plans: ['b', 'a', 'a'], files: { y: 1, x: 2 } }, S.SCHEMAS['refs.jsonl']), outcome(() => S.canonLine(([1] as unknown as S.Rec), {})), outcome(() => S.canonLine((null as unknown as S.Rec), {}))]); // deliberate misuse
  const recs = [{ key: 'B', sp: 1 }, { key: 'A', sp: 2 }, { key: 'A', sp: 2 }, { key: 'A', sp: 1 }];
  for (const name of S.V1_FILES) G(`canon-file-${name}`, () => S.canonFile(recs.map((r, i) => ({ ...r, consumer: `C${i % 2}`, producer: 'P', id: `L${i % 3}`, k: `k${i}`, kind: 'x', text: 't', version: i % 2 ? 'old' : 'current', source: 's', verdict: 'v' })), S.SCHEMAS[name]));
  G('canon-file-fallback', () => [S.canonFile([{ b: 1 }, { a: 1 }, { b: 1 }], null), S.canonFile([], null), S.canonFile([{ k: 2 }, { k: 1 }], (r: S.Rec) => String(r.k))]);
  G('canon-text', () => [S.canonText('{"key":"B"}\n\n{"key":"A","sp":1}\r\n', S.SCHEMAS['tickets.jsonl'], 't.jsonl'), outcome(() => S.canonText('{bad', {} as unknown as S.Schema, 'x.jsonl')), S.parseJsonlText('{"a":1}')]); // deliberate misuse: parsing fails before the spec is read
  G('defaults', () => [S.withDefaults(S.SCHEMAS['refs.jsonl'], { key: 'K', plans: undefined }), S.withDefaults(S.SCHEMAS['edges.jsonl'], { consumer: 'A', producer: 'B', kind: 'x' }), S.withDefaults({}, { a: 1 })]);
  G('spec', () => [S.specOf(null).file, S.specOf((r: S.Rec) => r.k as string).file, S.specOf({ id: (r: S.Rec) => r.k as string }).order, Object.keys(S.specOf({ id: (r: S.Rec) => r.k as string, sort: (r: S.Rec) => r.s as string }))]); // key functions over string fields
});

test('reading records: defaults, symlinks, size and type refusals', () => {
  const d = tmp();
  put(d, 'refs.jsonl', '{"key":"B"}\n{"key":"A","plans":["p"]}\n');
  G('read', () => [S.readRecords(d, 'refs.jsonl'), S.readRecords(d, 'refs.jsonl', { defaults: false }), S.readRecords(d, 'missing.jsonl')]);
  fs.symlinkSync(path.join(d, 'refs.jsonl'), path.join(d, 'link.jsonl'));
  fs.mkdirSync(path.join(d, 'dir.jsonl'));
  G('read-refusals', () => [outcome(() => S.readRecords(d, 'link.jsonl')), outcome(() => S.readRecords(d, 'dir.jsonl'))]);
});

test('locks: exclusive, live owners kept, stale dead owners stolen, symlinks refused, release only by the holder', () => {
  const d = tmp(), lock = path.join(d, '.lock');
  const held = S.acquireLock(lock);
  const owner = JSON.parse(fs.readFileSync(lock, 'utf8'));
  assert.equal(owner.pid, process.pid);
  assert.match(owner.token, /^[0-9a-f]{24}$/);
  assert.throws(() => S.acquireLock(lock, { retries: 2, waitMs: 1 }), (e: Error & { code?: string }) => e.message === `could not take lock .lock: locked by pid ${process.pid}`);
  held[Symbol.dispose]();
  assert.equal(fs.existsSync(lock), false, 'released');
  fs.writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 7, token: 'old' }));
  const past = new Date(Date.now() - 120000); fs.utimesSync(lock, past, past);
  const stolen = S.acquireLock(lock, { staleMs: 1000, retries: 3, waitMs: 1 });
  assert.notEqual(JSON.parse(fs.readFileSync(lock, 'utf8')).token, 'old', 'a stale lock of a dead pid is taken over');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'someone-else' }));
  stolen[Symbol.dispose]();
  assert.equal(fs.existsSync(lock), true, 'a lock re-taken by someone else is not removed by the old holder');
  fs.rmSync(lock);
  fs.writeFileSync(lock, 'not json'); const old = new Date(Date.now() - 120000); fs.utimesSync(lock, old, old);
  S.acquireLock(lock, { staleMs: 1000, retries: 3, waitMs: 1 })[Symbol.dispose]();
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 't' })); fs.utimesSync(lock, old, old);
  assert.throws(() => S.acquireLock(lock, { staleMs: 1000, retries: 1, waitMs: 1 }), /locked by pid/, 'a live owner is never robbed, however old the file');
  fs.rmSync(lock);
  fs.symlinkSync(path.join(d, 'nowhere'), lock);
  assert.throws(() => S.acquireLock(lock, { retries: 1, waitMs: 1 }), (e: Error & { code?: string }) => e.code === 'SYMLINK' && e.message === 'lock path is a symlink: .lock');
  fs.rmSync(lock);
  assert.equal(S.withLock(lock, () => 42), 42);
  assert.equal(fs.existsSync(lock), false);
  assert.throws(() => S.acquireLock(path.join(d, 'no', 'dir', '.lock')), (e: Error & { code?: string }) => e.code === 'ENOENT');
});

test('format.json: reads, every refusal, the read and write gates, writes that keep unknown fields', () => {
  const cases = [['missing', null], ['ok', '{"format_version":1}'], ['bom', '﻿{"format_version":1,"min_reader":0,"x":1}'], ['bad-json', '{'], ['array', '[1]'], ['negative', '{"format_version":-1}'],
    ['float', '{"format_version":1.5}'], ['min-above', '{"format_version":1,"min_reader":2}'], ['min-negative', '{"format_version":1,"min_reader":-1}'], ['min-float', '{"format_version":2,"min_reader":1.5}'], ['newer', '{"format_version":3,"min_reader":1}'], ['newer-hard', '{"format_version":3,"min_reader":3}'], ['old', '{"format_version":0}']];
  const out = [];
  for (const [name, text] of cases) {
    const d = tmp(); if (text !== null) put(d, 'format.json', text);
    out.push([name, outcome(() => S.readFormat(d)), outcome(() => S.checkFormat(d)), outcome(() => S.checkFormat(d, undefined, { mode: 'read' }))]);
  }
  golden('store', 'format', JSON.parse(JSON.stringify(out).split(fs.realpathSync(os.tmpdir())).join('<tmp>').replace(/storek-[A-Za-z0-9]+/g, 'storek-X')));
  const d = tmp(); fs.symlinkSync(path.join(d, 'x'), path.join(d, 'format.json'));
  const e = tmp(); fs.mkdirSync(path.join(e, 'format.json'));
  const f = tmp(); put(f, 'format.json', `{"format_version":1}${' '.repeat(64 * 1024)}`);
  G('format-refusals', () => [outcome(() => S.readFormat(d)), outcome(() => S.readFormat(e)), outcome(() => S.readFormat(f))]);
  const w = tmp(); put(w, 'format.json', '{"format_version":0,"note":"keep"}');
  S.writeFormat(w, { format_version: 1, min_reader: 1 });
  const bad = tmp(); put(bad, 'format.json', '{');
  S.writeFormat(bad, { format_version: 1, min_reader: 0 });
  G('format-write', () => [fs.readFileSync(path.join(w, 'format.json'), 'utf8'), fs.readFileSync(path.join(bad, 'format.json'), 'utf8')]);
});

test('migrations: plan, dry run, write, re-run, refusals, a custom chain', () => {
  const d = tmp();
  put(d, 'tickets.jsonl', '{"sp":1,"key":"B"}\n{"key":"A"}\n'); put(d, 'edges.jsonl', '{"consumer":"A","producer":"B","kind":"plan_need","note":""}\n'); put(d, 'other.jsonl', 'x\n');
  G('migrate-plan', () => S.planMigration(d));
  G('migrate-dry', () => S.runMigration(d));
  const writes: string[] = [];
  G('migrate-write', () => S.runMigration(d, { write: true, onWrite: (f) => writes.push(f) }));
  G('migrate-after', () => [writes, fs.readFileSync(path.join(d, 'tickets.jsonl'), 'utf8'), fs.readFileSync(path.join(d, 'format.json'), 'utf8'), S.planMigration(d), S.runMigration(d, { write: true })]);
  const n = tmp(); put(n, 'format.json', '{"format_version":9}');
  const s = tmp(); fs.symlinkSync(path.join(s, 'x'), path.join(s, 'tickets.jsonl'));
  const dd = tmp(); fs.mkdirSync(path.join(dd, 'tickets.jsonl'));
  const ms = [{ from: 0, to: 1, plan: () => [{ file: 'b.jsonl', text: 'b' }, { file: 'a.jsonl', text: 'a' }] }, { from: 1, to: 3, min_reader: 2, describe: 'jump', plan: (_d: string, read: (n: string) => string | null) => [{ file: 'c.jsonl', text: String(read('a.jsonl')) + String(read('zz.jsonl')) }] }];
  const c = tmp();
  G('migrate-refusals', () => [JSON.stringify(outcome(() => S.planMigration(n))).replaceAll(n, '<dir>'), outcome(() => S.planMigration(s)), outcome(() => S.planMigration(dd)), outcome(() => S.planMigration(c, { migrations: [{ from: 1, to: 2, plan: () => [] }] })), S.planMigration(c, { migrations: ms }), S.runMigration(c, { write: true, migrations: ms }), fs.readFileSync(path.join(c, 'c.jsonl'), 'utf8'), fs.readFileSync(path.join(c, 'format.json'), 'utf8')]);
});

test('merge driver: .gitattributes and git config in a temp repository, doctor findings', () => {
  const r = tmp();
  execFileSync('git', ['init', '-q', r], { env: GIT_ENV });
  const scrub = (v: unknown) => JSON.parse(JSON.stringify(v).split(r).join('<repo>'));
  G('driver-refusals', () => [outcome(() => S.installMergeDriver(r, { driverPath: '/x/plugins/cache/p/1/bin/plangraph-merge' })), outcome(() => S.installMergeDriver(r, { dir: 'a b' })), outcome(() => S.installMergeDriver(r, { dir: (5 as unknown as string) }))]); // deliberate misuse
  G('doctor-none', () => scrub(S.doctorMergeDriver(r)));
  put(r, '.gitattributes', '*.md text');
  const quoted = path.join(r, "it's here", 'plangraph-merge'); fs.mkdirSync(path.dirname(quoted)); fs.writeFileSync(quoted, '#!/bin/sh\n'); fs.chmodSync(quoted, 0o755);
  G('install-quoted-doctor', () => scrub([S.installMergeDriver(r, { driverPath: quoted }), execFileSync('git', ['-C', r, 'config', '--get', 'merge.plangraph-jsonl.name'], { env: GIT_ENV, encoding: 'utf8' }), S.doctorMergeDriver(r)]));
  G('install', () => scrub([S.installMergeDriver(r, { driverPath: "/opt/plangraph's tools/plangraph-merge" }), fs.readFileSync(path.join(r, '.gitattributes'), 'utf8'), S.installMergeDriver(r, { driverPath: 'no-such-plangraph-merge-on-path', dir: 'data/plangraph' }), fs.readFileSync(path.join(r, '.gitattributes'), 'utf8')]));
  G('doctor-installed', () => scrub(S.doctorMergeDriver(r)));
  G('doctor-other-dir', () => scrub(S.doctorMergeDriver(r, { dir: 'elsewhere' })));
  const shimDir = path.join(r, 'data-dir'), bin = path.join(shimDir, 'bin'); fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'plangraph-merge'), '#!/bin/sh\n# reads driver.target\n'); fs.chmodSync(path.join(bin, 'plangraph-merge'), 0o755);
  S.installMergeDriver(r, { driverPath: path.join(bin, 'plangraph-merge') });
  G('doctor-shim-empty', () => scrub(S.doctorMergeDriver(r)));
  fs.writeFileSync(path.join(shimDir, 'driver.target'), path.join(r, 'missing.mjs')); fs.writeFileSync(path.join(shimDir, 'driver.node'), path.join(r, 'missing-node'));
  G('doctor-shim-missing', () => scrub(S.doctorMergeDriver(r)));
  fs.writeFileSync(path.join(shimDir, 'driver.target'), path.join(bin, 'plangraph-merge')); fs.writeFileSync(path.join(shimDir, 'driver.node'), process.execPath);
  G('doctor-shim-ok', () => scrub(S.doctorMergeDriver(r)).problems);
  S.installMergeDriver(r, { driverPath: '/home/u/.claude/plugins/cache/x/1/bin/plangraph-merge'.replace('plugins/cache', 'plugins/cache-not') });
  execFileSync('git', ['-C', r, 'config', 'merge.plangraph-jsonl.driver', '/u/.claude/plugins/cache/x/1/bin/plangraph-merge %O %A %B %P'], { env: GIT_ENV });
  G('doctor-versioned', () => scrub(S.doctorMergeDriver(r)));
  fs.rmSync(path.join(r, '.gitattributes')); fs.symlinkSync(path.join(r, 'x'), path.join(r, '.gitattributes'));
  G('attr-symlink', () => [scrub(S.doctorMergeDriver(r)).problems, outcome(() => S.installMergeDriver(r))]);
  fs.rmSync(path.join(r, '.gitattributes')); fs.mkdirSync(path.join(r, '.gitattributes'));
  G('attr-dir', () => [scrub(S.doctorMergeDriver(r)).problems, outcome(() => S.installMergeDriver(r))]);
  fs.rmSync(path.join(r, '.gitattributes'), { recursive: true }); put(r, '.gitattributes', 'x'.repeat(S.GITATTRIBUTES_MAX + 1));
  G('attr-big', () => [scrub(S.doctorMergeDriver(r)).problems, outcome(() => S.installMergeDriver(r))]);
});

test('schemas: identity fields drive the three-way merge, field order and defaults are exact for every file', async () => {
  const { mergeJsonl } = await import('../lib/merge.ts');
  const jlines = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  // two records that share all identity fields but one: each side adds one, so a correct identity merges cleanly
  const pairs = ([
    ['edges.jsonl', { consumer: 'A', producer: 'P' }, { consumer: 'B', producer: 'P' }], ['edges.jsonl', { consumer: 'A', producer: 'P' }, { consumer: 'A', producer: 'Q' }],
    ['schedule.jsonl', { version: 'current', key: 'A' }, { version: 'v2', key: 'A' }], ['schedule.jsonl', { version: 'current', key: 'A' }, { version: 'current', key: 'B' }],
    ['findings.jsonl', { key: 'A', kind: 'k', text: 't' }, { key: 'B', kind: 'k', text: 't' }], ['findings.jsonl', { key: 'A', kind: 'k', text: 't' }, { key: 'A', kind: 'j', text: 't' }], ['findings.jsonl', { key: 'A', kind: 'k', text: 't' }, { key: 'A', kind: 'k', text: 'u' }],
    ['meta.jsonl', { k: 'a', v: 1 }, { k: 'b', v: 1 }], ['learnings.jsonl', { id: 'L1', text: 'x' }, { id: 'L2', text: 'x' }], ['refs.jsonl', { key: 'A' }, { key: 'B' }],
    ['open-items.jsonl', { key: 'A', kind: 'k' }, { key: 'B', kind: 'k' }], ['open-items.jsonl', { key: 'A', kind: 'k' }, { key: 'A', kind: 'j' }], ['tickets.jsonl', { key: 'A' }, { key: 'B' }],
  ] as Array<[string, object, object]>); // literal tuples
  for (const [file, a, b] of pairs) {
    const r = mergeJsonl({ base: '', ours: jlines([a]), theirs: jlines([b]) }, S.SCHEMAS[file]);
    assert.deepEqual(r.conflicts, [], `${file}: ${JSON.stringify(a)} and ${JSON.stringify(b)} are different records`);
    assert.equal(r.text.split('\n').filter(Boolean).length, 2, file);
  }
  const full = { impl_status: 'done', first_verdict: 'READY', verdict_source: 'audit', verdict: 'READY', v2_sprint: 2, v2_owner: 'Ana', jira_status: 'Done', sp: 3, epic: 'E', summary: 's', key: 'A', zz: 1, aa: 2 };
  G('order-tickets', () => S.canonLine(full, S.SCHEMAS['tickets.jsonl']));
  G('order-open-items', () => S.canonLine({ text: 't', status: 'open', due_sprint: 1, kind: 'k', key: 'A', owner: 'x' }, S.SCHEMAS['open-items.jsonl']));
  G('order-all', () => Object.entries(S.SCHEMAS).filter(([f]) => S.V1_FILES.includes(f)).map(([f, s]) => [f, s.file, s.order, s.sets, s.defaults])); // the nine format-1 files; the graph files are pinned in test/graph-files.test.ts
  const d = tmp();
  for (const f of ['edges.jsonl', 'evidence.jsonl', 'learnings.jsonl', 'schedule.jsonl', 'tickets.jsonl']) put(d, f, `${JSON.stringify({ key: 'A', consumer: 'A', producer: 'B', id: 'L', source: 's' })}\n`);
  G('read-defaults', () => ['edges.jsonl', 'evidence.jsonl', 'learnings.jsonl', 'schedule.jsonl', 'tickets.jsonl'].map((f) => S.readRecords(d, f)));
  G('evidence-order', () => S.canonFile(Array.from({ length: 8 }, (_, i) => ({ key: 'A', source: 's', verdict: `v${i}` })), S.SCHEMAS['evidence.jsonl']));
  G('parse-default-name', () => outcome(() => S.parseJsonlText('{bad')));
  const big = tmp(), fd = fs.openSync(path.join(big, 'tickets.jsonl'), 'w'); fs.ftruncateSync(fd, 64 * 1024 * 1024 + 1); fs.closeSync(fd);
  G('read-cap', () => outcome(() => S.readRecords(big, 'tickets.jsonl')));
});

test('lock stealing: a live owner put in place during the steal is restored, a vanished lock is retaken, guards are honoured', () => {
  const d = tmp(), lock = path.join(d, '.lock'), old = new Date(Date.now() - 120000);
  const dead = (token: string) => { fs.writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 9, token })); fs.utimesSync(lock, old, old); };
  // 1. while we decide, a live owner replaces the stale file: the rename moves the live file, which is linked back, and we keep waiting
  dead('stale');
  assert.throws(() => S.acquireLock(lock, { staleMs: 1000, retries: 2, waitMs: 1, onStealDecision: () => { fs.rmSync(lock); fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'live' })); } }), (e: Error & { code?: string }) => e.message === `could not take lock .lock: locked by pid ${process.pid}`);
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).token, 'live', 'the live owner keeps the lock');
  assert.deepEqual(fs.readdirSync(d).sort(), ['.lock'], 'no stale-* or guard file is left behind');
  // 2. the stale file vanishes during the decision: the rename finds nothing and the create is retried at once
  dead('stale2');
  const got = S.acquireLock(lock, { staleMs: 1000, retries: 2, waitMs: 1, onStealDecision: () => fs.rmSync(lock) });
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).pid, process.pid);
  got[Symbol.dispose]();
  // 3. a fresh guard (another stealer at work) makes us wait instead of stealing
  dead('stale3');
  fs.writeFileSync(`${lock}.steal`, JSON.stringify({ pid: process.pid }));
  assert.throws(() => S.acquireLock(lock, { staleMs: 1000, retries: 2, waitMs: 1 }), /locked by pid/);
  assert.equal(fs.existsSync(`${lock}.steal`), true, 'a live stealer guard is not removed');
  // 4. a guard left by a crashed stealer (old, dead pid) is removed, then the stale lock is taken
  fs.writeFileSync(`${lock}.steal`, JSON.stringify({ pid: 2 ** 22 + 11 })); fs.utimesSync(`${lock}.steal`, old, old);
  const after = S.acquireLock(lock, { staleMs: 1000, retries: 3, waitMs: 1 });
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).pid, process.pid);
  assert.equal(fs.existsSync(`${lock}.steal`), false);
  after[Symbol.dispose]();
  // 5. owners with an invalid pid count as dead; a pid we may not signal (EPERM) counts as alive
  for (const pid of [0, -5, 1.5, 'x']) { fs.writeFileSync(lock, JSON.stringify({ pid, token: 't' })); fs.utimesSync(lock, old, old); S.acquireLock(lock, { staleMs: 1000, retries: 2, waitMs: 1 })[Symbol.dispose](); }
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    fs.writeFileSync(lock, JSON.stringify({ pid: 1, token: 't' })); fs.utimesSync(lock, old, old);
    assert.throws(() => S.acquireLock(lock, { staleMs: 1000, retries: 1, waitMs: 1 }), /locked by pid 1$/, 'pid 1 exists but belongs to root: alive, never robbed');
    fs.rmSync(lock);
  }
  // 6. a fresh lock is never stolen whatever its owner, and an unreadable owner gives a message without a pid
  fs.writeFileSync(lock, 'garbage');
  assert.throws(() => S.acquireLock(lock, { retries: 1, waitMs: 1 }), (e: Error & { code?: string }) => e.message === 'could not take lock .lock: locked');
  fs.rmSync(lock);
});

test('lock races, simulated through fs: the lock vanishes, turns into a symlink or turns fresh between the first look and the steal', (t) => {
  const d = tmp(), lock = path.join(d, '.lock'), old = new Date(Date.now() - 120000);
  const stale = () => { fs.writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 13, token: 's' })); fs.utimesSync(lock, old, old); };
  /** run acquireLock with fs.lstatSync on the lock path replaced on its n-th call */
  const withLstat = (n: number, fake: (real: typeof fs.lstatSync, p: fs.PathLike) => unknown, opts: S.LockOptions) => {
    const real = fs.lstatSync; let k = 0;
    const m = t.mock.method(fs, 'lstatSync', (p: fs.PathLike, o?: fs.StatSyncOptions) => (p === lock && ++k === n ? fake(real, p) : real(p, o)));
    try { return outcome(() => { S.acquireLock(lock, opts)[Symbol.dispose](); return 'acquired'; }); } finally { m.mock.restore(); }
  };
  const enoent = () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); };
  stale(); G('race-vanished-in-steal', () => withLstat(2, enoent, { staleMs: 1000, retries: 2, waitMs: 1 }));
  stale(); G('race-symlink-in-steal', () => withLstat(2, () => ({ isSymbolicLink: () => true, mtimeMs: 0 }), { staleMs: 1000, retries: 2, waitMs: 1 }));
  stale(); G('race-fresh-in-steal', () => withLstat(2, (real, p) => { const s = real(p); return { isSymbolicLink: () => false, mtimeMs: Date.now(), ino: s.ino, dev: s.dev }; }, { staleMs: 1000, retries: 0, waitMs: 1 }));
  stale(); G('race-vanished-first-look', () => withLstat(1, enoent, { staleMs: 1000, retries: 0, waitMs: 1 }));
  stale(); G('race-lstat-error', () => withLstat(1, () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); }, { staleMs: 1000, retries: 2, waitMs: 1 }));
  if (fs.existsSync(lock)) fs.rmSync(lock);
  // a steal with no retries left still succeeds (the steal is a retry of its own), and so does a rename that finds the lock gone
  stale(); G('steal-retries-0', () => outcome(() => { S.acquireLock(lock, { staleMs: 1000, retries: 0, waitMs: 1 })[Symbol.dispose](); return 'acquired'; }));
  stale(); G('steal-vanish-retries-0', () => outcome(() => { S.acquireLock(lock, { staleMs: 1000, retries: 0, waitMs: 1, onStealDecision: () => fs.rmSync(lock) })[Symbol.dispose](); return 'acquired'; }));
  // the stale file rewritten in place by a live owner (same inode, new token), or replaced by an identical copy (new inode): never removed
  stale(); G('steal-rewritten-in-place', () => [outcome(() => S.acquireLock(lock, { staleMs: 1000, retries: 1, waitMs: 1, onStealDecision: () => fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'live2' })) }) && 'acquired'), JSON.parse(fs.readFileSync(lock, 'utf8')).token]);
  fs.rmSync(lock);
  stale(); G('steal-replaced-identical', () => [outcome(() => S.acquireLock(lock, { staleMs: 1000, retries: 1, waitMs: 1, onStealDecision: () => { const c = fs.readFileSync(lock); fs.writeFileSync(lock + ".copy", c); fs.renameSync(lock + ".copy", lock); /* the copy exists while the original does: a new inode on every filesystem (delete-then-create reuses the inode on ext4) */ } }) && 'acquired'), fs.readdirSync(d).sort()]);
  fs.rmSync(lock);
  // a rename failing for another reason surfaces its own error
  stale();
  const ren = t.mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('cross device'), { code: 'EXDEV' }); });
  G('steal-rename-error', () => outcome(() => S.acquireLock(lock, { staleMs: 1000, retries: 1, waitMs: 1 })));
  ren.mock.restore();
  fs.rmSync(lock); for (const f of fs.readdirSync(d)) fs.rmSync(path.join(d, f));
  // a fresh guard whose stealer died is not old enough to remove: we wait
  stale(); fs.writeFileSync(`${lock}.steal`, JSON.stringify({ pid: 2 ** 22 + 15 }));
  G('guard-fresh-dead', () => outcome(() => S.acquireLock(lock, { staleMs: 1000, retries: 1, waitMs: 1 })));
  fs.rmSync(`${lock}.steal`); fs.rmSync(lock);
  // the retry count: with retries 1 a live lock is looked at exactly twice
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'x' }));
  let looks = 0; const real = fs.lstatSync;
  const cnt = t.mock.method(fs, 'lstatSync', (p: fs.PathLike, o?: fs.StatSyncOptions) => { if (p === lock) looks++; return real(p, o); });
  G('retry-looks', () => [outcome(() => S.acquireLock(lock, { retries: 1, waitMs: 1 })), looks]);
  cnt.mock.restore(); fs.rmSync(lock);
});

test('lock files that cannot be read or created', { skip: process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0) }, () => {
  const d = tmp(), lock = path.join(d, '.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'x' })); fs.chmodSync(lock, 0o000);
  G('lock-unreadable', () => outcome(() => S.acquireLock(lock, { retries: 0, waitMs: 1 })));
  fs.chmodSync(lock, 0o600); fs.rmSync(lock);
  const ro = path.join(d, 'ro'); fs.mkdirSync(ro);
  const rlock = path.join(ro, '.lock'), old = new Date(Date.now() - 120000);
  fs.writeFileSync(rlock, JSON.stringify({ pid: 2 ** 22 + 17, token: 's' })); fs.utimesSync(rlock, old, old); fs.chmodSync(ro, 0o500);
  try { G('guard-cannot-create', () => { try { S.acquireLock(rlock, { staleMs: 1000, retries: 1, waitMs: 1 }); return 'acquired'; } catch (e) { return (e as Error & { code?: string }).code; } }); } finally { fs.chmodSync(ro, 0o700); } // whatever acquireLock throws is read for its code
});

test('store edges: permission errors pass through, null format, field order on write, migration caps and races, default driver path', { skip: process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0) }, (t) => {
  const code = (fn: () => unknown) => { try { fn(); return 'ok'; } catch (e) { return `${(e as Error).constructor.name} ${(e as Error & { code?: string }).code ?? ''} ${(e as Error).message.replace(/\/[^ ]*storek-[^ ]*/g, '<path>')}`; } }; // the store throws Errors
  const d = tmp();
  put(d, 'tickets.jsonl', '{"key":"A"}\n'); fs.chmodSync(path.join(d, 'tickets.jsonl'), 0o000);
  put(d, 'format.json', '{"format_version":1}'); fs.chmodSync(path.join(d, 'format.json'), 0o000);
  G('perm-records-format-migrate', () => [code(() => S.readRecords(d, 'tickets.jsonl')), code(() => S.readFormat(d))]);
  fs.chmodSync(path.join(d, 'format.json'), 0o600); fs.rmSync(path.join(d, 'format.json'));
  G('perm-migrate', () => code(() => S.planMigration(d)));
  fs.chmodSync(path.join(d, 'tickets.jsonl'), 0o600);
  const n = tmp(); put(n, 'format.json', 'null');
  G('format-null', () => code(() => S.readFormat(n)));
  const w = tmp(); put(w, 'format.json', '{"format_version":0,"a":1,"zz":2}'); S.writeFormat(w, { format_version: 1, min_reader: 1 });
  G('format-write-order', () => fs.readFileSync(path.join(w, 'format.json'), 'utf8'));
  const big = tmp(); const fd = fs.openSync(path.join(big, 'tickets.jsonl'), 'w'); fs.ftruncateSync(fd, 64 * 1024 * 1024 + 1); fs.closeSync(fd);
  G('migrate-cap', () => code(() => S.planMigration(big)));
  G('migrate-none', () => [S.planMigration(tmp(), { migrations: [] })]);
  let calls = 0;
  const once = [{ from: 0, to: 1, plan: () => (++calls === 1 ? [{ file: 'x.jsonl', text: 'x' }] : []) }];
  G('migrate-raced', () => S.runMigration(tmp(), { write: true, migrations: once }));
  const r = tmp(); execFileSync('git', ['init', '-q', r], { env: GIT_ENV });
  G('driver-default', () => [S.installMergeDriver(r), fs.readFileSync(path.join(r, '.gitattributes'), 'utf8')]);
  S.installMergeDriver(r, { driverPath: 'git' });
  G('driver-on-path', () => S.doctorMergeDriver(r).executable);
  const locked = path.join(r, 'locked-driver'); fs.writeFileSync(locked, 'x'); fs.chmodSync(locked, 0o000);
  execFileSync('git', ['-C', r, 'config', 'merge.plangraph-jsonl.driver', `${locked} %O %A %B %P`], { env: GIT_ENV });
  G('driver-unreadable', () => code(() => S.doctorMergeDriver(r).problems));
  fs.chmodSync(locked, 0o600);
  fs.chmodSync(path.join(r, '.gitattributes'), 0o000);
  G('attr-unreadable', () => [code(() => S.doctorMergeDriver(r)), code(() => S.installMergeDriver(r))]);
  fs.chmodSync(path.join(r, '.gitattributes'), 0o600);
  // a lock that vanishes inside the steal with no retries left; an lstat error inside the steal
  const ld = tmp(), lock = path.join(ld, '.lock'), old = new Date(Date.now() - 120000);
  const stale = () => { fs.writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 19, token: 's' })); fs.utimesSync(lock, old, old); };
  const real = fs.lstatSync;
  for (const [name, fake] of ([['vanished', () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); }], ['denied', () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); }]] as Array<[string, () => never]>)) { // literal tuples
    stale(); let k = 0;
    const m = t.mock.method(fs, 'lstatSync', (p: fs.PathLike, o?: fs.StatSyncOptions) => (p === lock && ++k === 2 ? fake() : real(p, o)));
    G(`steal-${name}-retries-0`, () => code(() => S.acquireLock(lock, { staleMs: 1000, retries: 0, waitMs: 1 })[Symbol.dispose]()));
    m.mock.restore();
    if (fs.existsSync(lock)) fs.rmSync(lock);
  }
});
