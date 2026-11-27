// Tests for lib/store2/batches.ts and check-batches.ts, with real git repositories (no merge driver anywhere): what git actually does is asserted.
// NOT covered: GitHub web merges, clock skew between real machines (the clock is injected), compaction racing in real CI.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendEvent, readEvents, writeRun, readRuns, writeSchedule, setCurrent, currentVersion, compact, branchHash } from '../lib/store2/batches.ts';
import { checkBatches } from '../lib/store2/check-batches.ts';

const made: string[] = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'batches-'))); made.push(d); return d; };
const sha8 = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 8);
const git = (cwd: string, ...a: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...a],
  { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
const ok = (r: ReturnType<typeof git>) => { assert.equal(r.status, 0, r.stdout + r.stderr); return r.stdout; };
function repo(): string {
  const d = tmp();
  ok(git(d, 'init', '-q', '-b', 'main'));
  fs.writeFileSync(path.join(d, 'README'), 'x\n');
  ok(git(d, 'add', '-A')); ok(git(d, 'commit', '-q', '-m', 'init'));
  return d;
}
const commit = (d: string) => { ok(git(d, 'add', '-A')); ok(git(d, 'commit', '-q', '-m', 'c')); };
const T = (s: string) => new Date(s);
const files = (root: string, sub: string): string[] => {
  const out: string[] = [];
  const walk = (d: string) => { for (const n of fs.readdirSync(d).sort()) { const p = path.join(d, n); fs.statSync(p).isDirectory() ? walk(p) : out.push(path.relative(root, p)); } };
  if (fs.existsSync(path.join(root, sub))) walk(path.join(root, sub));
  return out;
};
const ev = (task: string, to = 'doing', by = 'ana') => ({ task, to, by });

test('branchHash: first 8 hex of sha256 of the branch name; nogit outside git and on a detached HEAD', () => {
  const d = repo();
  assert.equal(branchHash(d), sha8('main'));
  ok(git(d, 'checkout', '-q', '-b', 'feat/x'));
  assert.equal(branchHash(d), sha8('feat/x'));
  ok(git(d, 'checkout', '-q', '--detach'));
  assert.equal(branchHash(d), sha8('nogit'));
  assert.equal(branchHash(tmp()), sha8('nogit'));
});

test('appendEvent: file name events/<yyyy-mm>/<actor>.<bh8>.<dd>.jsonl, at to the second, seq counts within one at', () => {
  const d = repo();
  const a = appendEvent(d, 'ana', ev('T-1'), { now: T('2026-03-09T10:11:12.987Z') });
  assert.equal(a.at, '2026-03-09T10:11:12Z'); assert.equal(a.seq, 0);
  const b = appendEvent(d, 'ana', ev('T-2'), { now: T('2026-03-09T10:11:12.100Z') });
  assert.equal(b.seq, 1, 'same second: seq increases');
  const c = appendEvent(d, 'ana', ev('T-3'), { now: T('2026-03-09T10:11:13Z') });
  assert.equal(c.seq, 0, 'new at: counter restarts');
  assert.deepEqual(files(d, 'events'), [`events/2026-03/ana.${sha8('main')}.09.jsonl`]);
  const text = fs.readFileSync(path.join(d, files(d, 'events')[0] as string), 'utf8');
  assert.equal(text.split('\n').length, 4); assert.ok(text.endsWith('\n'));
  assert.deepEqual(readEvents(d).map((e) => e.task), ['T-1', 'T-2', 'T-3']);
});

test('two branches append the same day to different files, merge clean, and read order is stable over 20 shuffles', () => {
  const d = repo(), now = T('2026-03-09T10:00:00Z');
  ok(git(d, 'checkout', '-q', '-b', 'a')); appendEvent(d, 'ana', ev('T-1'), { now }); appendEvent(d, 'ana', ev('T-2', 'done'), { now }); commit(d);
  ok(git(d, 'checkout', '-q', 'main')); ok(git(d, 'checkout', '-q', '-b', 'b')); appendEvent(d, 'ana', ev('T-3'), { now }); commit(d);
  ok(git(d, 'checkout', '-q', 'a'));
  const m = git(d, 'merge', '--no-edit', 'b'); assert.equal(m.status, 0, m.stdout + m.stderr);
  assert.equal(files(d, 'events').length, 2);
  const base = readEvents(d);
  assert.equal(base.length, 3);
  // same at, same actor: seq 0 on both branches, ordered by (seq, actor, bh8)
  const want = [...base].sort((x, y) => x.at.localeCompare(y.at) || x.seq - y.seq || x.actor.localeCompare(y.actor) || x.bh8.localeCompare(y.bh8)).map((e) => e.task);
  assert.deepEqual(base.map((e) => e.task), want);
  let s = 7; const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 20; i++) {
    const got = readEvents(d, { fileOrder: (fs2) => [...fs2].sort(() => rnd() - 0.5) });
    assert.deepEqual(got, base);
  }
  assert.deepEqual(checkBatches(d), []);
});

test('readEvents de-duplicates by (task, to, by, at, seq) across files', () => {
  const d = repo(), now = T('2026-03-09T10:00:00Z');
  appendEvent(d, 'ana', ev('T-1'), { now });
  const [f] = files(d, 'events') as [string];
  fs.copyFileSync(path.join(d, f), path.join(d, f.replace(sha8('main'), 'deadbeef')));
  assert.equal(readEvents(d).length, 1);
});

test('a clone whose clock is one hour fast does not outrank a later event once it has been read', () => {
  const d = repo(), real = T('2026-03-09T10:00:00Z'), fast = T('2026-03-09T11:00:00Z');
  ok(git(d, 'checkout', '-q', '-b', 'fastclone')); appendEvent(d, 'zed', ev('T-fast', 'doing', 'zed'), { now: fast }); commit(d);
  ok(git(d, 'checkout', '-q', 'main')); ok(git(d, 'checkout', '-q', '-b', 'normal'));
  ok(git(d, 'merge', '-q', '--no-edit', 'fastclone'));
  const later = appendEvent(d, 'amy', ev('T-later', 'doing', 'amy'), { now: real }); // actor sorts BEFORE zed: only at/seq can put it after
  assert.equal(later.at, '2026-03-09T11:00:00Z', 'at = max(wall clock, latest seen)');
  assert.ok(later.seq > 0);
  assert.deepEqual(readEvents(d).map((e) => e.task), ['T-fast', 'T-later']);
  const wall = appendEvent(d, 'amy', ev('T-wall', 'doing', 'amy'), { now: T('2026-03-09T12:00:00Z') });
  assert.equal(wall.at, '2026-03-09T12:00:00Z');
  assert.deepEqual(readEvents(d).map((e) => e.task), ['T-fast', 'T-later', 'T-wall']);
});

test('writeRun: content-hash file name, identical runs are one file, readRuns returns the rows', () => {
  const d = tmp(), now = T('2026-03-09T10:00:00Z');
  const p1 = writeRun(d, 'evidence', [{ k: 'b', v: 1 }, { k: 'a', v: 2 }], { now });
  const p2 = writeRun(d, 'evidence', [{ v: 2, k: 'a' }, { v: 1, k: 'b' }], { now: T('2026-04-01T00:00:00Z') });
  assert.equal(p1, p2);
  assert.match(p1, /^runs\/evidence\/2026-03\/[0-9a-f]{8}\.jsonl$/);
  assert.equal(files(d, 'runs').length, 1);
  const p3 = writeRun(d, 'evidence', [{ k: 'c' }], { now });
  assert.notEqual(p3, p1);
  assert.deepEqual(readRuns(d, 'evidence').map((r) => r.k).sort(), ['a', 'b', 'c']);
  assert.deepEqual(readRuns(d, 'findings'), []);
  const raw = fs.readFileSync(path.join(d, p1), 'utf8');
  assert.equal(sha8(raw), path.basename(p1, '.jsonl'));
});

test('schedules: v<n>-<h8 of content>, CURRENT holds one name, setCurrent validates', () => {
  const d = tmp();
  const v1 = writeSchedule(d, [{ key: 'T-1', sprint: 1 }]);
  assert.match(v1, /^v1-[0-9a-f]{8}$/);
  assert.equal(writeSchedule(d, [{ sprint: 1, key: 'T-1' }]), v1, 'same content, same version');
  const rows = [{ key: 'T-1', sprint: 2 }];
  const v2 = writeSchedule(d, rows);
  assert.match(v2, /^v2-[0-9a-f]{8}$/);
  const text = fs.readFileSync(path.join(d, `schedules/${v2}.jsonl`), 'utf8');
  assert.equal(sha8(text), v2.split('-')[1]);
  assert.equal(currentVersion(d), null);
  setCurrent(d, v2);
  assert.equal(fs.readFileSync(path.join(d, 'schedules/CURRENT'), 'utf8'), `${v2}\n`);
  assert.equal(currentVersion(d), v2);
  assert.throws(() => setCurrent(d, 'v9-00000000'), /version/i);
  assert.throws(() => setCurrent(d, '../x'), /version/i);
  assert.deepEqual(checkBatches(d), []);
});

test('setCurrent on two branches conflicts in CURRENT by design, while the schedule files merge clean', () => {
  const d = repo();
  const v1 = writeSchedule(d, [{ key: 'T-1', sprint: 1 }]); setCurrent(d, v1); commit(d);
  ok(git(d, 'checkout', '-q', '-b', 'a')); const va = writeSchedule(d, [{ key: 'T-1', sprint: 2 }]); setCurrent(d, va); commit(d);
  ok(git(d, 'checkout', '-q', 'main')); ok(git(d, 'checkout', '-q', '-b', 'b')); const vb = writeSchedule(d, [{ key: 'T-1', sprint: 3 }]); setCurrent(d, vb); commit(d);
  ok(git(d, 'checkout', '-q', 'a'));
  const m = git(d, 'merge', '--no-edit', 'b');
  assert.notEqual(m.status, 0);
  assert.match(m.stdout + m.stderr, /CONFLICT.*schedules\/CURRENT/);
  const unmerged = ok(git(d, 'diff', '--name-only', '--diff-filter=U')).trim().split('\n');
  assert.deepEqual(unmerged, ['schedules/CURRENT'], 'only CURRENT conflicts');
  assert.match(fs.readFileSync(path.join(d, 'schedules/CURRENT'), 'utf8'), /^<<<<<<< /m);
  assert.ok(checkBatches(d).some((v) => v.code === 'CONFLICT_MARKERS' && v.path === 'schedules/CURRENT'));
});

test('compact refuses without CI=true or opts.ci', () => {
  const d = tmp(), prev = process.env.CI;
  try {
    delete process.env.CI;
    assert.throws(() => compact(d, { now: T('2026-06-01T00:00:00Z') }), /CI/);
    process.env.CI = '1';
    assert.throws(() => compact(d, { now: T('2026-06-01T00:00:00Z') }), /CI/);
    process.env.CI = 'true';
    compact(d, { now: T('2026-06-01T00:00:00Z') });
    delete process.env.CI;
    compact(d, { ci: true, now: T('2026-06-01T00:00:00Z') });
  } finally { if (prev === undefined) delete process.env.CI; else process.env.CI = prev; }
});

function snapshot(root: string): Record<string, string> {
  const o: Record<string, string> = {};
  for (const f of files(root, '.')) if (!f.startsWith('.txn') && !f.startsWith('.git/')) o[f] = fs.readFileSync(path.join(root, f), 'utf8');
  return o;
}

test('compact merges sealed months into one content-hashed file per month and kind; idempotent and byte-deterministic', () => {
  const build = (): string => {
    const d = tmp();
    // two branches' files for March, one for April (sealed), May is the current month (untouched)
    appendEvent(d, 'ana', ev('T-1'), { now: T('2026-03-09T10:00:00Z'), branch: 'a' });
    appendEvent(d, 'bob', ev('T-2', 'doing', 'bob'), { now: T('2026-03-10T10:00:00Z'), branch: 'b' });
    appendEvent(d, 'ana', ev('T-3'), { now: T('2026-03-10T10:00:00Z'), branch: 'c' });
    appendEvent(d, 'ana', ev('T-4'), { now: T('2026-04-02T10:00:00Z'), branch: 'a' });
    appendEvent(d, 'ana', ev('T-5'), { now: T('2026-05-03T10:00:00Z'), branch: 'a' });
    writeRun(d, 'evidence', [{ k: 1 }], { now: T('2026-03-01T00:00:00Z') });
    writeRun(d, 'evidence', [{ k: 2 }], { now: T('2026-03-02T00:00:00Z') });
    writeRun(d, 'evidence', [{ k: 3 }], { now: T('2026-05-02T00:00:00Z') });
    return d;
  };
  const d1 = build(), d2 = build(), now = T('2026-05-15T00:00:00Z');
  const before = readEvents(d1).map((e) => [e.task, e.at, e.seq]);
  const beforeRuns = readRuns(d1, 'evidence').map((r) => r.k).sort();
  const r1 = compact(d1, { ci: true, now });
  assert.ok(r1.merged.length >= 3);
  const ev1 = files(d1, 'events');
  assert.equal(ev1.filter((f) => f.startsWith('events/2026-03/')).length, 1);
  assert.equal(ev1.filter((f) => f.startsWith('events/2026-04/')).length, 1);
  assert.equal(ev1.filter((f) => f.startsWith('events/2026-05/')).length, 1, 'the current month is not sealed');
  assert.match(ev1.find((f) => f.startsWith('events/2026-03/')) as string, /^events\/2026-03\/_compact\.[0-9a-f]{8}\.jsonl$/);
  assert.equal(files(d1, 'runs/evidence/2026-03').length, 1);
  assert.equal(files(d1, 'runs/evidence/2026-05').length, 1);
  assert.deepEqual(readEvents(d1).map((e) => [e.task, e.at, e.seq]), before, 'reading after compaction gives the same events');
  assert.deepEqual(readRuns(d1, 'evidence').map((r) => r.k).sort(), beforeRuns);
  const snap = snapshot(d1);
  const r2 = compact(d1, { ci: true, now });
  assert.deepEqual(r2.merged, [], 'second run changes nothing');
  assert.deepEqual(snapshot(d1), snap);
  compact(d2, { ci: true, now });
  assert.deepEqual(snapshot(d2), snap, 'two builds compact to the same bytes');
  assert.deepEqual(checkBatches(d1), []);
  // an event later than a compacted month lands in a fresh file and the next compaction folds it in
  // (a long-lived branch merged late: appendEvent would put it in May by the hybrid clock, so the file is placed as git would)
  fs.writeFileSync(path.join(d1, `events/2026-03/ana.${sha8('late')}.31.jsonl`), '{"at":"2026-03-31T10:00:00Z","by":"ana","seq":0,"task":"T-6","to":"doing"}\n');
  assert.equal(files(d1, 'events/2026-03').length, 2);
  compact(d1, { ci: true, now });
  assert.equal(files(d1, 'events/2026-03').length, 1);
  assert.equal(readEvents(d1).length, 6);
});

test('compact leaves a month alone when one of its files has a bad line', () => {
  const d = tmp();
  appendEvent(d, 'ana', ev('T-1'), { now: T('2026-03-09T10:00:00Z'), branch: 'a' });
  appendEvent(d, 'ana', ev('T-2'), { now: T('2026-03-09T10:00:00Z'), branch: 'b' });
  const f = path.join(d, files(d, 'events')[0] as string);
  fs.appendFileSync(f, 'not json\n');
  const before = snapshot(d);
  const r = compact(d, { ci: true, now: T('2026-06-01T00:00:00Z') });
  assert.deepEqual(snapshot(d), before);
  assert.ok(r.skipped.length >= 1);
});

test('checkBatches: UNSORTED_BATCH for out-of-order lines, MISSING_CURRENT for a missing or dangling CURRENT', () => {
  const d = tmp();
  appendEvent(d, 'ana', ev('T-1'), { now: T('2026-03-09T10:00:00Z'), branch: 'a' });
  appendEvent(d, 'ana', ev('T-2'), { now: T('2026-03-09T10:00:05Z'), branch: 'a' });
  assert.deepEqual(checkBatches(d), []);
  const f = path.join(d, files(d, 'events')[0] as string);
  const lines = fs.readFileSync(f, 'utf8').trimEnd().split('\n');
  fs.writeFileSync(f, `${lines[1]}\n${lines[0]}\n`);
  const v = checkBatches(d);
  assert.equal(v.length, 1);
  assert.deepEqual(Object.keys(v[0] as object).sort(), ['code', 'fix', 'line', 'path']);
  assert.equal(v[0]?.code, 'UNSORTED_BATCH'); assert.equal(v[0]?.path, path.relative(d, f)); assert.equal(v[0]?.line, 2);
  assert.ok(v[0]?.fix.length);
  // schedules without CURRENT
  const ver = writeSchedule(d, [{ key: 'T-1' }]);
  fs.writeFileSync(f, `${lines[0]}\n${lines[1]}\n`);
  assert.deepEqual(checkBatches(d).map((x) => [x.code, x.path]), [['MISSING_CURRENT', 'schedules/CURRENT']]);
  setCurrent(d, ver);
  assert.deepEqual(checkBatches(d), []);
  fs.writeFileSync(path.join(d, 'schedules/CURRENT'), 'v7-00000000\n');
  assert.deepEqual(checkBatches(d).map((x) => x.code), ['MISSING_CURRENT']);
  // unsorted run file
  fs.writeFileSync(path.join(d, 'schedules/CURRENT'), `${ver}\n`);
  const rp = writeRun(d, 'evidence', [{ k: 'a' }, { k: 'b' }], { now: T('2026-03-01T00:00:00Z') });
  const rl = fs.readFileSync(path.join(d, rp), 'utf8').trimEnd().split('\n');
  fs.writeFileSync(path.join(d, rp), `${rl[1]}\n${rl[0]}\n`);
  assert.deepEqual(checkBatches(d).map((x) => x.code), ['UNSORTED_BATCH']);
});

test('hostile batch files never crash readers: a symlink, a NUL line and a huge line are skipped', () => {
  const d = tmp(), now = T('2026-03-09T10:00:00Z');
  appendEvent(d, 'ana', ev('T-1'), { now, branch: 'a' });
  const dir = path.join(d, 'events/2026-03');
  fs.symlinkSync('/etc/hosts', path.join(dir, `eve.${sha8('x')}.09.jsonl`));
  fs.writeFileSync(path.join(dir, `bad.${sha8('y')}.09.jsonl`), `\0\0\n${'x'.repeat(2 << 20)}\n{"at":1}\n`);
  assert.deepEqual(readEvents(d).map((e) => e.task), ['T-1']);
  assert.ok(Array.isArray(checkBatches(d)));
});
