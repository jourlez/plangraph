// Tests for lib/store.ts. NOT covered: Windows rename semantics, fsync durability under power loss, NFS locking, clock skew between
// real machines, numbers beyond 2^53 (documented as lossy on first parse), git hosts other than a local bare repo.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rng } from './fixtures/gen.ts';
import { genPlan } from './fixtures/gen.ts';
import * as S from '../lib/store.ts';

const BIN_MERGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/brain-merge');
const tmp = (p = 'store-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
type Rng = () => number;
const sh = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });

// random records for each schema
function randRec(r: Rng, name: string, i: number): S.Rec {
  const w = () => ['a', 'b', 'é', 'x y', '"q"', '\\', 'ü ', '__proto__', '1'][Math.floor(r() * 9)];
  const extra = r() < 0.5 ? { zzz: w(), aaa: [w(), 2, null], nested: { b: 1, a: [w()] } } : {};
  const R = ({
    'tickets.jsonl': { sp: Math.floor(r() * 9), key: `T-${i}`, summary: w(), epic: w(), ...extra },
    'edges.jsonl': { note: w(), producer: `T-${i % 7}`, consumer: `T-${i}`, kind: w(), ...extra },
    'schedule.jsonl': { sprint: 3, key: `T-${i}`, owner: w(), version: w(), ...extra },
    'evidence.jsonl': { needs: w(), key: `T-${i % 5}`, source: w(), verdict: w(), resolution: w(), ...extra },
    'findings.jsonl': { text: w() + i, kind: w(), key: `T-${i % 4}`, ...extra },
    'meta.jsonl': { v: w(), k: `k${i}`, ...extra },
    'learnings.jsonl': { text: w(), id: `L${i}`, kind: w(), ...extra },
    'refs.jsonl': { files: { z: 1, a: 2 }, plans: [w(), w(), 'b'], key: `T-${i}`, ...extra },
  } as Record<string, S.Rec>)[name]; // the file names above are the keys
  return R;
}
const shuffle = <T>(r: Rng, a: T[]): T[] => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

test('canon: idempotent, order-independent, byte-stable over random records for every schema', () => {
  for (const name of Object.keys(S.SCHEMAS).filter((n) => !['open-items.jsonl'].includes(n))) {
    for (let seed = 1; seed <= 40; seed++) {
      const r = rng(seed * 7919), n = 1 + Math.floor(r() * 12);
      const recs = Array.from({ length: n }, (_, i) => randRec(r, name, i));
      const sch = S.SCHEMAS[name];
      const c1 = S.canonFile(recs, sch);
      assert.ok(c1.endsWith('\n') && !c1.includes('\r') && !c1.includes('\n\n'));
      assert.equal(S.canonFile(S.parseJsonlText(c1), sch), c1, `${name} idempotent`);
      assert.equal(S.canonFile(shuffle(r, recs), sch), c1, `${name} order independent`);
      assert.equal(S.canonFile(recs.map((x) => JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(x).reverse())))), sch), c1, `${name} key-order independent`);
    }
  }
});
test('canon: golden bytes, fixed key order, unknown fields appended sorted, nested keys sorted, sets sorted', () => {
  const t = S.SCHEMAS['tickets.jsonl'];
  assert.equal(S.canonLine({ zed: 1, sp: 3, key: 'T-1', alpha: { b: 1, a: 2 }, summary: 's' }, t), '{"key":"T-1","summary":"s","sp":3,"alpha":{"a":2,"b":1},"zed":1}');
  assert.equal(S.canonLine({ key: 'K', plans: ['b', 'a', 'b'], files: { y: 1, x: 2 } }, S.SCHEMAS['refs.jsonl']), '{"key":"K","plans":["a","b"],"files":{"x":2,"y":1}}');
  assert.equal(S.canonFile([{ key: 'T-2' }, { key: 'T-10' }, { key: 'T-1' }], t), '{"key":"T-1"}\n{"key":"T-10"}\n{"key":"T-2"}\n'); // plain < : T-10 before T-2
  assert.equal(S.canonFile([], t), '');
  assert.equal(S.canonFile([{ key: 'A' }, { key: 'A' }], t), '{"key":"A"}\n'); // identical duplicate collapses
});
test('canon: __proto__ field survives (no prototype pollution), CRLF/BOM/blank lines tolerated, bad lines name file:line', () => {
  const recs = S.parseJsonlText('﻿{"key":"A","__proto__":{"x":1}}\r\n\r\n{"key":"B"}\r\n');
  const c = S.canonFile(recs, S.SCHEMAS['tickets.jsonl']);
  assert.equal(c, '{"key":"A","__proto__":{"x":1}}\n{"key":"B"}\n');
  assert.equal(({} as Record<string, unknown>).x, undefined); // reads a key a fresh object does not have
  assert.throws(() => S.parseJsonlText('{"a":1}\nnope\n', 'f.jsonl'), /f\.jsonl:2/);
  assert.throws(() => S.parseJsonlText('<<<<<<< ours\n', 'f'), /conflict marker/);
  assert.throws(() => S.parseJsonlText('[1]\n', 'f'), /expected a JSON object/);
});
test('canon: generated plan round-trips byte-stable', () => {
  const p = genPlan({ n: 60, seed: 3 });
  for (const [f, recs] of ([['tickets.jsonl', p.tickets], ['edges.jsonl', p.edges], ['schedule.jsonl', p.schedule]] as Array<[string, S.Rec[]]>)) { // literal tuples
    const c = S.canonFile(recs, S.SCHEMAS[f]);
    assert.equal(S.canonText(c, S.SCHEMAS[f]), c);
    assert.equal(S.parseJsonlText(c).length, recs.length);
  }
});
test('evidence identity is a content hash: same content same id, any field change a new id, file is a set', () => {
  const sch = S.SCHEMAS['evidence.jsonl'], a = { key: 'T-1', source: 'audit', verdict: 'READY', resolution: 'r', needs: '' };
  assert.equal(sch.id(a), sch.id({ ...a, extra: 1 })); // unknown fields are not identity
  for (const f of ['key', 'source', 'verdict', 'resolution', 'needs']) assert.notEqual(sch.id(a), sch.id({ ...a, [f]: 'zz' }), f);
  assert.equal(sch.id({ key: 'T-1', source: 's' }), sch.id({ key: 'T-1', source: 's', verdict: null })); // missing == null
  assert.equal(S.canonFile([a, { ...a }, { ...a, source: 'b' }], sch).split('\n').length, 3);
});
test('defaults fill missing optional fields on read only', () => {
  const d = tmp(); fs.writeFileSync(path.join(d, 'schedule.jsonl'), '{"key":"T-1","owner":"Ana","sprint":1}\n');
  assert.equal(S.readRecords(d, 'schedule.jsonl')[0].version, 'current');
  assert.equal(S.readRecords(d, 'schedule.jsonl', { defaults: false })[0].version, undefined);
  assert.deepEqual(S.readRecords(d, 'nope.jsonl'), []);
});

// ---- format + migration ----
const legacyDir = () => {
  const d = tmp('legacy-'), p = genPlan({ n: 12, seed: 5 });
  const messy = (recs: readonly S.Rec[]) => recs.slice().reverse().map((r) => JSON.stringify(Object.fromEntries(Object.entries(r).reverse()))).join('\n') + '\n\n';
  fs.writeFileSync(path.join(d, 'tickets.jsonl'), messy(p.tickets));
  fs.writeFileSync(path.join(d, 'edges.jsonl'), messy(p.edges));
  fs.writeFileSync(path.join(d, 'schedule.jsonl'), messy(p.schedule));
  fs.writeFileSync(path.join(d, 'config.json'), '{"caps":{"default":9}}\n');
  return d;
};
const snapshot = (d: string) => Object.fromEntries(fs.readdirSync(d).sort().map((f) => [f, fs.readFileSync(path.join(d, f), 'utf8')]));

test('format: legacy dir is v0; checkFormat asks to migrate; too-new is a hard error; read mode honours min_reader', () => {
  const d = legacyDir();
  assert.equal(S.readFormat(d).format_version, 0);
  assert.throws(() => S.checkFormat(d), (e: Error & { code?: string }) => e.code === 'NEEDS_MIGRATION' && /brain migrate/.test(e.message));
  fs.writeFileSync(path.join(d, 'format.json'), '{"format_version":3,"min_reader":3}\n');
  assert.throws(() => S.checkFormat(d), (e: Error & { code?: string }) => e.code === 'TOO_NEW' && /upgrade/.test(e.message));
  assert.throws(() => S.checkFormat(d, undefined, { mode: 'read' }), (e: Error & { code?: string }) => e.code === 'TOO_NEW');
  fs.writeFileSync(path.join(d, 'format.json'), '{"format_version":3,"min_reader":1,"future":true}\n');
  assert.throws(() => S.checkFormat(d), (e: Error & { code?: string }) => e.code === 'TOO_NEW'); // writing to a newer dir: never
  assert.equal(S.checkFormat(d, undefined, { mode: 'read' }).status, 'newer-readable');
  fs.writeFileSync(path.join(d, 'format.json'), '{"format_version":"x"}\n');
  assert.throws(() => S.readFormat(d), (e: Error & { code?: string }) => e.code === 'BAD_FORMAT');
  fs.writeFileSync(path.join(d, 'format.json'), '{"format_version":1}\n'); // missing min_reader defaults
  assert.equal(S.readFormat(d).min_reader, 1);
  assert.equal(S.checkFormat(d).status, 'ok');
});
test('migration 0->1: dry run writes nothing, --write canonicalizes + adds format.json LAST, re-run is a no-op, unknown fields kept', () => {
  const d = legacyDir(); fs.appendFileSync(path.join(d, 'tickets.jsonl'), '{"key":"T-99","future_field":{"b":1,"a":2}}\n');
  const before = snapshot(d);
  const plan = S.planMigration(d);
  assert.equal(plan.pending, true); assert.deepEqual(plan.steps[0].files, ['edges.jsonl', 'schedule.jsonl', 'tickets.jsonl']);
  assert.equal(S.runMigration(d).written, false); assert.deepEqual(snapshot(d), before);
  const order: string[] = []; const r = S.runMigration(d, { write: true, onWrite: (f) => order.push(f) });
  assert.equal(r.written, true); assert.equal(order.at(-1), 'format.json');
  assert.deepEqual(S.readFormat(d).format_version, 1); S.checkFormat(d);
  const after = snapshot(d);
  assert.equal(after['config.json'], before['config.json']); // non-jsonl untouched
  assert.match(after['tickets.jsonl'], /"key":"T-99","future_field":\{"a":2,"b":1\}\}\n$/);
  for (const f of ['tickets', 'edges', 'schedule']) assert.equal(S.canonText(after[f + '.jsonl'], S.schemaFor(f + '.jsonl')), after[f + '.jsonl']);
  assert.equal(S.planMigration(d).pending, false);
  assert.equal(S.runMigration(d, { write: true }).written, false); assert.deepEqual(snapshot(d), after);
  assert.equal(fs.readdirSync(d).filter((f) => f.includes('.tmp-') || f.endsWith('.lock')).length, 0);
});
test('migration: crash injected before every possible write, re-run converges to the same bytes as an uninterrupted run', () => {
  const ref = legacyDir(); S.runMigration(ref, { write: true }); const want = snapshot(ref);
  for (const crashAt of [0, 1, 2, 3]) {
    const d = legacyDir(); let n = 0;
    assert.throws(() => S.runMigration(d, { write: true, onWrite: () => { if (n++ === crashAt) throw new Error('boom'); } }), /boom/);
    assert.equal(S.readFormat(d).format_version, 0, 'format.json is bumped last: still legacy after a crash');
    assert.equal(fs.existsSync(path.join(d, '.migrate.lock')), false);
    S.runMigration(d, { write: true });
    assert.deepEqual(snapshot(d), want, `crash at write ${crashAt}`);
  }
});
test('migration: aborts before writing anything when a file does not parse; chained 1->2 plan (dry run) sees step-1 output', () => {
  const d = legacyDir(); fs.appendFileSync(path.join(d, 'edges.jsonl'), 'garbage\n');
  const before = snapshot(d);
  assert.throws(() => S.runMigration(d, { write: true }), /edges\.jsonl:\d+/); assert.deepEqual(snapshot(d), before);
  const d2 = legacyDir();
  const ms: S.Migration[] = [...S.migrations, { from: 1, to: 2, min_reader: 1, plan: (dir, read) => [{ file: 'meta.jsonl', text: S.canonFile([{ k: 'steps', v: String((read('tickets.jsonl') as string).split('\n')[0].length > 0) }], S.schemaFor('meta.jsonl')) }] }]; // the directory has tickets.jsonl
  const p = S.planMigration(d2, { migrations: ms });
  assert.deepEqual(p.steps.map((s) => [s.from, s.to]), [[0, 1], [1, 2]]);
  S.runMigration(d2, { write: true, migrations: ms });
  assert.equal(S.readFormat(d2).format_version, 2); assert.equal(S.readFormat(d2).min_reader, 1);
  assert.equal(fs.readFileSync(path.join(d2, 'meta.jsonl'), 'utf8'), '{"k":"steps","v":"true"}\n');
  assert.throws(() => S.planMigration(d2, { migrations: S.migrations }), (e: Error & { code?: string }) => e.code === 'TOO_NEW');
});
test('format.json write keeps unknown fields', () => {
  const d = tmp(); fs.writeFileSync(path.join(d, 'format.json'), '{"format_version":1,"min_reader":1,"note":"x"}\n');
  S.writeFormat(d, { format_version: 2, min_reader: 1 });
  assert.equal(fs.readFileSync(path.join(d, 'format.json'), 'utf8'), '{"format_version":2,"min_reader":1,"note":"x"}\n');
});

// ---- locks ----
const OLD = () => new Date(Date.now() - 3600e3);
const mkLock = (content: string, old = true) => { const d = tmp('lock-'), lock = path.join(d, 'x.lock'); fs.writeFileSync(lock, content); if (old) fs.utimesSync(lock, OLD(), OLD()); return lock; };
const DEAD_PID = 2 ** 22 + 12345; // a pid that does not exist
const quick = { retries: 2, waitMs: 1, staleMs: 10 };
test('a live owner keeps its lock; a dead owner past staleMs loses it; release respects the token', () => {
  const lock = mkLock(JSON.stringify({ pid: process.pid, token: 'live' }));
  assert.throws(() => S.withLock(lock, () => 1, quick), /locked/i, 'live pid is never stolen');
  fs.writeFileSync(lock, JSON.stringify({ pid: DEAD_PID, token: 'dead' })); fs.utimesSync(lock, OLD(), OLD());
  assert.equal(S.withLock(lock, () => 'ran', quick), 'ran');
  assert.equal(fs.existsSync(lock), false, 'released');
});
test('claims, hash ids and compaction are gone', () => {
  for (const n of ['claimTicket', 'claimTicketGit', 'resolveClaims', 'newId', 'idLength', 'base32']) assert.equal(n in S, false, n);
  assert.equal('claims.jsonl' in S.SCHEMAS, false);
  assert.equal(fs.existsSync(new URL('../lib/compact.ts', import.meta.url)), false);
});
test('a dead owner within staleMs is not stolen', () => {
  const lock = mkLock(JSON.stringify({ pid: DEAD_PID, token: 'dead' }), false);
  assert.throws(() => S.withLock(lock, () => 1, { retries: 2, waitMs: 1, staleMs: 3600e3 }), /locked/i);
  assert.equal(fs.existsSync(lock), true);
});
test('unparseable lock content counts as stale only by age', () => {
  const fresh = mkLock('garbage', false);
  assert.throws(() => S.withLock(fresh, () => 1, { retries: 2, waitMs: 1, staleMs: 3600e3 }), /locked/i);
  assert.equal(S.withLock(mkLock('garbage'), () => 'ran', quick), 'ran');
});
test("the lock file holds pid and token, and release leaves another owner's lock alone", () => {
  const lock = path.join(tmp('lock-'), 'x.lock');
  let seen: { pid?: unknown; token: string } | undefined;
  S.withLock(lock, () => { seen = JSON.parse(fs.readFileSync(lock, 'utf8')); fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'other' })); }, quick);
  assert.equal((seen as { pid?: unknown }).pid, process.pid); assert.equal(typeof (seen as { token: string }).token, 'string'); assert.ok((seen as { token: string }).token.length >= 8); // set by fn, which withLock ran
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).token, 'other', 'not removed');
});
test('doctorMergeDriver reports problems; installMergeDriver is idempotent and quotes paths', () => {
  const root = tmp('doc-'); sh(root, 'init', '-q');
  const d0 = S.doctorMergeDriver(root); assert.equal(d0.installed, false); assert.ok(d0.problems.length >= 2);
  fs.writeFileSync(path.join(root, '.gitattributes'), '*.png binary');
  S.installMergeDriver(root, { driverPath: BIN_MERGE }); S.installMergeDriver(root, { driverPath: BIN_MERGE });
  assert.equal(fs.readFileSync(path.join(root, '.gitattributes'), 'utf8'), '*.png binary\n.plangraph/*.jsonl merge=plangraph-jsonl\n');
  assert.equal(S.doctorMergeDriver(root).installed, true);
  S.installMergeDriver(root, { driverPath: '/no such dir/brain-merge' });
  const d1 = S.doctorMergeDriver(root); assert.equal(d1.installed, false); assert.equal(d1.executable, false); assert.match(d1.problems.join(), /not found/);
  S.installMergeDriver(root, { dir: 'x/y', driverPath: BIN_MERGE }); assert.equal(S.doctorMergeDriver(root, { dir: 'x/y' }).attributes, true);
});

// ---- lock hardening (cleanup A2, items 24, 25, 27) ----
const within = (ms: number, fn: () => unknown) => { const t0 = Date.now(); let err: Error | null = null; try { fn(); } catch (e) { err = e as Error; } assert.ok(Date.now() - t0 < ms, `took ${Date.now() - t0} ms`); return err; }; // whatever fn throws here is an Error
test('a dangling symlink at the lock path throws promptly and is never followed', () => {
  const d = tmp('lock-'), lock = path.join(d, 'x.lock'), target = path.join(d, 'nowhere');
  fs.symlinkSync(target, lock);
  const err = within(2000, () => S.withLock(lock, () => assert.fail('fn must not run'), { retries: 100, waitMs: 1, staleMs: 10 }));
  assert.match(err?.message ?? '', /lock path is a symlink/);
  assert.equal(fs.existsSync(target), false); assert.ok(fs.lstatSync(lock).isSymbolicLink(), 'left in place');
});
test('a symlink to an existing file at the lock path is an error and the target is left alone', () => {
  const d = tmp('lock-'), lock = path.join(d, 'x.lock'), target = path.join(d, 'victim');
  fs.writeFileSync(target, JSON.stringify({ pid: DEAD_PID, token: 't' })); fs.utimesSync(target, OLD(), OLD());
  fs.symlinkSync(target, lock);
  const err = within(2000, () => S.withLock(lock, () => assert.fail('fn must not run'), { retries: 100, waitMs: 1, staleMs: 10 }));
  assert.match(err?.message ?? '', /lock path is a symlink/);
  assert.equal(fs.readFileSync(target, 'utf8'), JSON.stringify({ pid: DEAD_PID, token: 't' })); assert.ok(fs.lstatSync(lock).isSymbolicLink());
});
test('steal race: a lock replaced by a live owner between the decision and the steal is never deleted and fn does not run', () => {
  const lock = mkLock(JSON.stringify({ pid: DEAD_PID, token: 'dead' })), liveBody = JSON.stringify({ pid: process.pid, token: 'A-live' });
  let ran = false, decisions = 0;
  const err = within(2000, () => S.withLock(lock, () => { ran = true; }, {
    retries: 3, waitMs: 1, staleMs: 10,
    // TEST ONLY: runs after the contender decided the owner is dead and before it acts. Contender A wins the steal here and takes a fresh lock.
    onStealDecision: () => { if (decisions++ === 0) { fs.rmSync(lock); fs.writeFileSync(lock, liveBody); } },
  }));
  assert.equal(ran, false, 'fn ran while a live owner held the lock');
  assert.match(err?.message ?? '', /locked/);
  assert.equal(fs.readFileSync(lock, 'utf8'), liveBody, "the live owner's lock file survived untouched");
  assert.deepEqual(fs.readdirSync(path.dirname(lock)).filter((f) => f.includes('.stale-')), [], 'no renamed stale file left behind');
});
test('a stolen stale lock leaves no renamed file behind', () => {
  const lock = mkLock(JSON.stringify({ pid: DEAD_PID, token: 'dead' }));
  assert.equal(S.withLock(lock, () => 'ran', quick), 'ran');
  assert.deepEqual(fs.readdirSync(path.dirname(lock)), []);
});
test('steal race, real processes: four contenders on one stale lock never overlap inside fn', async () => {
  const { spawn } = await import('node:child_process');
  const d = tmp('lock-'), lock = path.join(d, 'x.lock'), marker = path.join(d, 'inside'), log = path.join(d, 'log');
  fs.writeFileSync(lock, JSON.stringify({ pid: DEAD_PID, token: 'dead' })); fs.utimesSync(lock, OLD(), OLD());
  const script = path.join(d, 'c.mjs');
  fs.writeFileSync(script, `import fs from 'node:fs'; import { withLock } from ${JSON.stringify(new URL('../lib/store.ts', import.meta.url).href)};
const [lock, marker, log] = process.argv.slice(2);
withLock(lock, () => {
  if (fs.existsSync(marker)) fs.appendFileSync(log, 'OVERLAP\\n'); else fs.writeFileSync(marker, String(process.pid));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60);
  fs.appendFileSync(log, 'ran\\n'); fs.rmSync(marker);
}, { retries: 2000, waitMs: 5, staleMs: 10 });`);
  const codes = await Promise.all([1, 2, 3, 4].map(() => new Promise((res) => spawn(process.execPath, [script, lock, marker, log], { stdio: 'inherit' }).on('exit', res))));
  assert.deepEqual(codes, [0, 0, 0, 0]);
  assert.equal(fs.readFileSync(log, 'utf8'), 'ran\nran\nran\nran\n');
});

// ---- composite keys and undefined fields (mutation-tested by scripts/mutate.ts) ----
test('composite keys that differ only around the separator never collide (edges A|B>C vs A>B|C, A:B vs A>:B)', async () => {
  const { mergeJsonl } = await import('../lib/merge.ts');
  const spec = S.SCHEMAS['edges.jsonl'];
  const pairs = [[{ consumer: 'A|B', producer: 'C' }, { consumer: 'A', producer: 'B|C' }], [{ consumer: 'A ', producer: '| B' }, { consumer: 'A | ', producer: 'B' }], [{ consumer: 'A,B', producer: 'C' }, { consumer: 'A', producer: 'B,C' }]];
  for (const [x, y] of pairs) {
    assert.notEqual(spec.id(x), spec.id(y), `${JSON.stringify(x)} and ${JSON.stringify(y)} must have different identities`);
    // real behaviour: each side adds one of them; the merge keeps both and reports no conflict
    const r = mergeJsonl({ base: '', ours: `${S.canonLine(x, spec)}\n`, theirs: `${S.canonLine(y, spec)}\n` }, spec, { name: 'edges.jsonl' });
    assert.deepEqual(r.conflicts, []);
    assert.equal(r.text.split('\n').filter(Boolean).length, 2, r.text);
  }
  assert.equal(S.showKey(S.keyStr(['A', 'B'])), 'A | B');
});
test('undefined-valued fields are dropped, never written as null, and the record round trips', () => {
  const spec = S.SCHEMAS['tickets.jsonl'];
  assert.equal(S.canonLine({ key: 'K-1', summary: undefined, sp: 3, zz: undefined }, spec), '{"key":"K-1","sp":3}');
  const text = S.canonFile([{ key: 'K-1', verdict: undefined, extra: undefined }, { key: 'K-2', sp: undefined }], spec);
  assert.equal(text, '{"key":"K-1"}\n{"key":"K-2"}\n');
  assert.deepEqual(S.parseJsonlText(text).map((r) => Object.keys(r)), [['key'], ['key']]);
  assert.equal(S.canonText(text, spec), text, 'stable on a second pass');
});
