// Tests for lib/store.ts. NOT covered: Windows rename semantics, fsync durability under power loss, NFS locking, clock skew between
// real machines, numbers beyond 2^53 (documented as lossy on first parse), git hosts other than a local bare repo.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rng } from './fixtures/gen.ts';
import { genPlan } from './fixtures/gen.ts';
import * as S from '../lib/store.ts';

const tmp = (p = 'store-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
type Rng = () => number;

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
    'people.jsonl': { name: w(), active: r() < 0.5, id: `P-${i}`, schema_version: 1, ...extra },
    'sprints.jsonl': { state: w(), n: i - 3, name: w(), start: '2026-01-05', end: '2026-01-16', ...extra },
    'epics.jsonl': { name: w(), id: `E-${i}`, ...extra },
    'repos.jsonl': { role: 'lib', id: `repo:r${i}`, owners: [w(), 'b', w()], langs: ['ts', 'py'], paths: [{ sub: w(), glob: 'a/**' }, { glob: 'b/**', sub: 'b' }], cmds: { test: 'test', build: 'build' }, ...extra },
    'capacity.jsonl': { sp: Math.floor(r() * 30), sprint: i % 5, person: `P-${i % 3}`, review_h: 2, ...extra },
    'links.jsonl': { to_type: 'repo', to: `repo:r${i % 4}`, rel: 'touches', from: `T-${i}`, from_type: 'ticket', attrs: { why: w(), conf: 'high' }, ...extra },
    'requirements.jsonl': { text: w(), id: `R-${i}`, kind: 'ears', status: 'accepted', source: 'docs/a.md', acceptance: [w(), 'b', w()], ...extra },
    'decisions.jsonl': { title: w(), id: `D-${i}`, status: 'proposed', date: '2026-01-05', affects: [w(), 'b', w()], ...extra },
    'teams.jsonl': { name: w(), id: `TEAM-${i}`, members: [w(), 'b', w()], owns: [w(), 'a'], ...extra },
    'xrefs.jsonl': { xid: `ABC-${i}`, sys: 'jira:acme', id: `T-${i % 6}`, type: 'ticket', seen: '2026-01-05', ...extra },
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

// ---- format ----
const legacyDir = () => tmp('legacy-'); // a directory with no format.json

test('format: an empty dir without format.json reads as v0 and passes checkFormat; too-new is a hard error; read mode honours min_reader', () => {
  const d = legacyDir();
  assert.equal(S.readFormat(d).format_version, 0);
  assert.equal(S.checkFormat(d).version, 0); // no stamp and no old-layout file: a fresh directory, not refused
  fs.writeFileSync(path.join(d, 'format.json'), '{"format_version":3,"min_reader":3}\n');
  assert.throws(() => S.checkFormat(d), (e: Error & { code?: string }) => e.code === 'TOO_NEW' && /upgrade/.test(e.message));
  assert.throws(() => S.checkFormat(d, undefined, { mode: 'read' }), (e: Error & { code?: string }) => e.code === 'TOO_NEW');
  fs.writeFileSync(path.join(d, 'format.json'), '{"format_version":3,"min_reader":1,"future":true}\n');
  assert.throws(() => S.checkFormat(d), (e: Error & { code?: string }) => e.code === 'TOO_NEW'); // writing to a newer dir: never
  assert.equal(S.checkFormat(d, undefined, { mode: 'read' }).status, 'newer-readable');
  fs.writeFileSync(path.join(d, 'format.json'), '{"format_version":"x"}\n');
  assert.throws(() => S.readFormat(d), (e: Error & { code?: string }) => e.code === 'BAD_FORMAT');
  fs.writeFileSync(path.join(d, 'format.json'), '{"format_version":2}\n'); // missing min_reader defaults
  assert.equal(S.readFormat(d).min_reader, 2);
  assert.equal(S.checkFormat(d).status, 'ok');
});
test('format: a directory below format 2, or unstamped beside old-layout files, is refused as pre-1.0 (and a stamped or empty one is not)', () => {
  const MSG = 'unsupported pre-1.0 directory: recreate it with plangraph takeover';
  const pre = (e: unknown) => e instanceof S.FormatError && e.code === 'PRE_1_0' && e.message === MSG;
  const v1 = tmp('v1-'); fs.writeFileSync(path.join(v1, 'format.json'), '{"format_version":1,"min_reader":1}\n');
  assert.throws(() => S.checkFormat(v1), pre);
  assert.throws(() => S.checkFormat(v1, undefined, { mode: 'read' }), pre);
  for (const f of ['tickets.jsonl', 'edges.jsonl', 'schedule.jsonl', 'learnings.jsonl', 'open-items.jsonl', 'people.jsonl', 'xrefs.jsonl']) {
    const d = tmp('old-'); fs.writeFileSync(path.join(d, f), '');
    assert.throws(() => S.checkFormat(d), pre, f);
  }
  const meta = tmp('meta-'); fs.writeFileSync(path.join(meta, 'meta.jsonl'), ''); // meta.jsonl is a file of the entity layout too
  assert.equal(S.checkFormat(meta).version, 0);
  const ok = tmp('v2-'); fs.writeFileSync(path.join(ok, 'format.json'), '{"format_version":2,"min_reader":2,"storage":"entity"}\n'); fs.writeFileSync(path.join(ok, 'tickets.jsonl'), '');
  assert.equal(S.checkFormat(ok).status, 'ok'); // a stamped directory is never judged by its leftover files
});
test('format.json write keeps unknown fields and writes the storage field when given', () => {
  const d = tmp(); fs.writeFileSync(path.join(d, 'format.json'), '{"format_version":1,"min_reader":1,"note":"x"}\n');
  S.writeFormat(d, { format_version: 2, min_reader: 1 });
  assert.equal(fs.readFileSync(path.join(d, 'format.json'), 'utf8'), '{"format_version":2,"min_reader":1,"note":"x"}\n');
  S.writeFormat(d, { format_version: 2, min_reader: 2, storage: 'entity' });
  assert.equal(fs.readFileSync(path.join(d, 'format.json'), 'utf8'), '{"format_version":2,"min_reader":2,"storage":"entity","note":"x"}\n');
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
  const d = tmp('lock-'), lock = path.join(d, 'x.lock'), log = path.join(d, 'log');
  fs.writeFileSync(lock, JSON.stringify({ pid: DEAD_PID, token: 'dead' })); fs.utimesSync(lock, OLD(), OLD());
  const script = path.join(d, 'c.mjs');
  // Each contender imports the module, prints "ready", then blocks reading stdin until the parent closes every pipe at once (the barrier).
  // The log records enter and exit order; the assertion reads that order, never elapsed time.
  fs.writeFileSync(script, `import fs from 'node:fs'; import { withLock } from ${JSON.stringify(new URL('../lib/store.ts', import.meta.url).href)};
const [lock, log] = process.argv.slice(2);
process.stdout.write('ready\\n');
try { fs.readSync(0, Buffer.alloc(1), 0, 1, null); } catch {}
withLock(lock, () => {
  fs.appendFileSync(log, 'enter ' + process.pid + '\\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); // widens the overlap window only; correctness does not depend on it
  fs.appendFileSync(log, 'exit ' + process.pid + '\\n');
}, { retries: 100000, waitMs: 5, staleMs: 10 });`);
  const kids = [1, 2, 3, 4].map(() => spawn(process.execPath, [script, lock, log], { stdio: ['pipe', 'pipe', 'inherit'] }));
  const exits = kids.map((k) => new Promise((res) => k.on('exit', res)));
  await Promise.all(kids.map((k) => new Promise<void>((res) => k.stdout.once('data', () => res()))));
  for (const k of kids) k.stdin.end(); // release all four together
  assert.deepEqual(await Promise.all(exits), [0, 0, 0, 0]);
  const events = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => l.split(' '));
  assert.equal(events.length, 8);
  for (let i = 0; i < 8; i += 2) {
    assert.equal(events[i][0], 'enter', `event ${i} must be an enter: ${JSON.stringify(events)}`);
    assert.deepEqual(events[i + 1], ['exit', events[i][1]], `contender ${events[i][1]} must exit before the next enter: ${JSON.stringify(events)}`);
  }
  assert.equal(new Set(events.filter((e) => e[0] === 'enter').map((e) => e[1])).size, 4);
});

// ---- composite keys and undefined fields (mutation-tested by scripts/mutate.ts) ----
test('composite keys that differ only around the separator never collide (edges A|B>C vs A>B|C, A:B vs A>:B)', async () => {
  const spec = S.SCHEMAS['edges.jsonl'];
  const pairs = [[{ consumer: 'A|B', producer: 'C' }, { consumer: 'A', producer: 'B|C' }], [{ consumer: 'A ', producer: '| B' }, { consumer: 'A | ', producer: 'B' }], [{ consumer: 'A,B', producer: 'C' }, { consumer: 'A', producer: 'B,C' }]];
  for (const [x, y] of pairs) {
    assert.notEqual(spec.id(x), spec.id(y), `${JSON.stringify(x)} and ${JSON.stringify(y)} must have different identities`);
    assert.equal(S.canonFile([x, y], spec).split('\n').filter(Boolean).length, 2, 'a canonical file keeps both (they are two records)');
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
