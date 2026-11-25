// Tests for lib/merge.ts and bin/brain-merge. NOT covered: git hosts/versions other than the local git, rename/rename or
// mode conflicts, very large files (performance), concurrent merges of the same file by two processes, Windows path handling in %P.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rng } from './fixtures/gen.ts';
import { mergeJsonl } from '../lib/merge.ts';
import * as S from '../lib/store.ts';
import { readJsonl, IngestError } from '../lib/jsonl.ts';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/brain-merge');
type Rng = () => number;
/** A ticket record of these tests: key and sp always present. */
type TRec = { key: string; sp: number; [k: string]: unknown };
/** An edit of one key: a new record, or a deletion. */
type Edit = { set: TRec; del?: never } | { del: true; set?: never };
const T = S.SCHEMAS['tickets.jsonl'];
const txt = (recs: readonly S.Rec[], sch: S.KeySpec = T) => S.canonFile(recs, sch);
const m3 = (b: readonly S.Rec[], o: readonly S.Rec[], t: readonly S.Rec[], sch: S.Schema = T) => mergeJsonl({ base: txt(b, sch), ours: txt(o, sch), theirs: txt(t, sch) }, sch);
const tk = (key: string, over: S.Rec = {}): TRec => ({ key, summary: 's-' + key, epic: 'E', sp: 1, v2_owner: 'Ana', v2_sprint: 1, ...over });

// ---- oracle: a model of a file as Map key->record; an edit is {set: rec} or {del: true} ----
const applyEdits = (base: readonly TRec[], edits: Map<string, Edit>) => { const m = new Map(base.map((r): [string, TRec] => [r.key, r])); for (const [k, e] of edits) { if (e.del) m.delete(k); else m.set(k, e.set); } return [...m.values()]; };
function randBase(r: Rng, n: number): TRec[] { return Array.from({ length: n }, (_, i) => tk('T-' + i, { sp: Math.floor(r() * 9) })); }
function randEdits(r: Rng, base: readonly TRec[], keys: readonly string[]): Map<string, Edit> {
  const e = new Map<string, Edit>();
  for (const k of keys) {
    const x = r(), cur = base.find((b) => b.key === k);
    if (!cur) e.set(k, { set: tk(k, { sp: Math.floor(r() * 9) }) }); // add
    else if (x < 0.3) e.set(k, { del: true });
    else if (x < 0.7) e.set(k, { set: { ...cur, sp: cur.sp + 1 } });
    else e.set(k, { set: { ...cur, summary: 'new ' + Math.floor(r() * 99), note: 'n' } });
  }
  return e;
}

test('property: edits on DISTINCT keys: merge == applying both in either order, symmetric, no conflicts', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const r = rng(seed), base = randBase(r, 3 + Math.floor(r() * 12));
    const universe = [...base.map((b) => b.key), 'T-new1', 'T-new2', 'T-new3'];
    const pick = universe.filter(() => r() < 0.5), ka = pick.filter(() => r() < 0.5), kb = pick.filter((k) => !ka.includes(k));
    const ea = randEdits(r, base, ka), eb = randEdits(r, base, kb);
    const ours = applyEdits(base, ea), theirs = applyEdits(base, eb);
    const want = txt(applyEdits(applyEdits(base, ea), eb)), want2 = txt(applyEdits(applyEdits(base, eb), ea));
    assert.equal(want, want2);
    const a = m3(base, ours, theirs), b = m3(base, theirs, ours);
    assert.deepEqual(a.conflicts, [], `seed ${seed}`);
    assert.equal(a.text, want, `seed ${seed}`); assert.equal(b.text, want, `symmetric seed ${seed}`);
    // idempotence: merging the result with either side changes nothing
    assert.equal(m3(base, S.parseJsonlText(a.text), ours).text, a.text);
    assert.equal(m3(base, theirs, S.parseJsonlText(a.text)).text, a.text);
    assert.equal(m3(ours, S.parseJsonlText(a.text), ours).text, a.text);
  }
});
test('property: SAME key edited on both sides: conflict iff the same field changed differently; disjoint fields merge', () => {
  for (let seed = 1; seed <= 100; seed++) {
    const r = rng(seed * 31), base = randBase(r, 5), cur = base[2];
    const fa = r() < 0.5 ? 'sp' : 'summary', fb = r() < 0.5 ? 'sp' : 'summary';
    const va = fa === 'sp' ? cur.sp + 1 : 'A', vb = fb === 'sp' ? cur.sp + 2 : 'B';
    const res = m3(base, applyEdits(base, new Map([[cur.key, { set: { ...cur, [fa]: va } }]])), applyEdits(base, new Map([[cur.key, { set: { ...cur, [fb]: vb } }]])));
    if (fa === fb) { assert.equal(res.conflicts.length, 1); assert.equal(res.conflicts[0].key, cur.key); assert.match(res.conflicts[0].detail, new RegExp(fa)); assert.match(res.text, /^<<<<<<< ours$/m); }
    else { assert.deepEqual(res.conflicts, []); const row = S.parseJsonlText(res.text).find((x) => x.key === cur.key) as S.Rec; assert.equal(row[fa], va); assert.equal(row[fb], vb); } // a conflict-free merge keeps the key
  }
});
test('same field changed to the SAME value on both sides is not a conflict', () => {
  const b = [tk('A')], o = [tk('A', { sp: 7 })], t = [tk('A', { sp: 7, epic: 'Z' })];
  const r = m3(b, o, t); assert.deepEqual(r.conflicts, []); assert.deepEqual(S.parseJsonlText(r.text)[0], { key: 'A', summary: 's-A', epic: 'Z', sp: 7, v2_owner: 'Ana', v2_sprint: 1 });
});
test('delete vs unchanged -> delete (both directions); both delete; delete vs edit -> conflict; add vs add', () => {
  const b = [tk('A'), tk('B')];
  assert.equal(m3(b, [tk('B')], b).text, txt([tk('B')])); assert.equal(m3(b, b, [tk('B')]).text, txt([tk('B')]));
  assert.equal(m3(b, [tk('B')], [tk('B')]).text, txt([tk('B')]));
  const de = m3(b, [tk('B')], [tk('A', { sp: 9 }), tk('B')]);
  assert.equal(de.conflicts.length, 1); assert.match(de.conflicts[0].detail, /deleted in ours/); assert.match(de.text, /<<<<<<< ours\n=======\n\{"key":"A".*\n>>>>>>> theirs/);
  const ed = m3(b, [tk('A', { sp: 9 }), tk('B')], [tk('B')]); assert.match(ed.conflicts[0].detail, /deleted in theirs/);
  assert.deepEqual(m3(b, [...b, tk('C')], [...b, tk('C')]).conflicts, []); // same add
  assert.equal(m3(b, [...b, tk('C', { sp: 1 })], [...b, tk('C', { sp: 2 })]).conflicts[0].detail, 'added differently on both sides');
  assert.deepEqual(m3([], [tk('A')], [tk('B')]).conflicts, []); // adjacent adds merge (plain git would conflict)
});
test('conflict output keeps canonical order, other keys merged cleanly, markers make readJsonl refuse the file', () => {
  const b = [tk('A'), tk('B'), tk('C')];
  const r = m3(b, [tk('A'), tk('B', { sp: 5 }), tk('C', { sp: 5 })], [tk('A', { sp: 3 }), tk('B', { sp: 6 }), tk('C')]);
  assert.equal(r.conflicts.length, 1); assert.equal(r.conflicts[0].key, 'B');
  const lines = r.text.trim().split('\n'); assert.equal(lines.length, 7); // A, 5 marker/record lines for B, C
  assert.ok(lines[0].includes('"sp":3') && (lines.at(-1) as string).includes('"key":"C"') && (lines.at(-1) as string).includes('"sp":5')); // the merged file has lines
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mg-')), 'x.jsonl'); fs.writeFileSync(f, r.text);
  assert.throws(() => readJsonl(f), IngestError);
});
test('set-like field (refs.plans) merges elementwise: both adds kept, a removal wins over unchanged', () => {
  const R = S.SCHEMAS['refs.jsonl'], mk = (plans: unknown, extra: S.Rec = {}) => ({ key: 'K', plans, files: {}, fp_files: '', jira_updated: '', audited_at: '', ...extra });
  const r = m3([mk(['a', 'b'])], [mk(['a', 'b', 'c'])], [mk(['b', 'd'])], R);
  assert.deepEqual(r.conflicts, []); assert.deepEqual(S.parseJsonlText(r.text)[0].plans, ['b', 'c', 'd']);
  assert.equal(m3([mk(['a'])], [mk(['a'], { audited_at: 'x' })], [mk(['a', 'z'])], R).conflicts.length, 0);
});
test('evidence is a set by content hash: union of adds, removal by one side wins, no field conflicts possible', () => {
  const E = S.SCHEMAS['evidence.jsonl'], ev = (key: string, source: string, verdict = 'READY') => ({ key, source, verdict, resolution: '', needs: '' });
  const b = [ev('T-1', 'a'), ev('T-1', 'b')];
  const r = m3(b, [ev('T-1', 'a'), ev('T-1', 'b'), ev('T-1', 'o')], [ev('T-1', 'b'), ev('T-1', 't')], E);
  assert.deepEqual(r.conflicts, []); assert.deepEqual(S.parseJsonlText(r.text).map((x) => x.source), ['b', 'o', 't']);
  const changed = m3(b, [ev('T-1', 'a', 'BLOCKED'), ev('T-1', 'b')], [ev('T-1', 'a', 'WAIT'), ev('T-1', 'b')], E); // both "edit" a: two new rows, old gone
  assert.deepEqual(changed.conflicts, []); assert.equal(S.parseJsonlText(changed.text).length, 3);
});
test('unknown jsonl file falls back to whole-line set semantics (never loses a line)', () => {
  const sch = S.schemaFor('whatever.jsonl'), L = (x: unknown) => ({ x });
  const r = m3([L(1), L(2)], [L(1), L(3)], [L(2), L(4)], sch);
  assert.deepEqual(r.conflicts, []); assert.deepEqual(S.parseJsonlText(r.text).map((x) => x.x), S.parseJsonlText(r.text).map((x) => x.x));
  assert.deepEqual(new Set(S.parseJsonlText(r.text).map((x) => x.x)), new Set([3, 4]));
});
test('duplicate key on a side that differs is reported, identical duplicates collapse; unreadable input throws with line', () => {
  const dup = mergeJsonl({ base: txt([tk('A')]), ours: '{"key":"A","sp":1}\n{"key":"A","sp":2}\n', theirs: txt([tk('A')]) }, T);
  assert.equal(dup.conflicts.length, 1);
  assert.throws(() => mergeJsonl({ base: '', ours: '{bad\n', theirs: '' }, T), /ours/);
  assert.equal(mergeJsonl({ base: '', ours: '{"key":"A"}\n{"key":"A"}\n', theirs: '' }, T).text, '{"key":"A"}\n');
});
test('keyFn argument works (function) and empty inputs give empty text', () => {
  assert.equal(mergeJsonl({}, (r) => r.id as string).text, ''); // never called: there are no records
  const r = mergeJsonl({ base: '{"id":1,"v":1}\n', ours: '{"id":1,"v":2}\n', theirs: '{"id":1,"v":1}\n' }, (r) => String(r.id));
  assert.equal(r.text, '{"id":1,"v":2}\n');
});
test('__proto__ field survives a field-level merge', () => {
  const b = '{"key":"A","__proto__":{"p":1},"sp":1}\n';
  const r = mergeJsonl({ base: b, ours: '{"key":"A","__proto__":{"p":1},"sp":2}\n', theirs: '{"key":"A","__proto__":{"p":2},"sp":1}\n' }, T);
  assert.deepEqual(r.conflicts, []); assert.equal(r.text, '{"key":"A","sp":2,"__proto__":{"p":2}}\n'); assert.equal(({} as Record<string, unknown>).p, undefined); // reads a key a fresh object does not have
});

// ---- bin/brain-merge as a process ----
test('brain-merge: exit 0 clean (result in %A), 1 on conflict (markers + keys on stderr), 2 on garbage', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-')), w = (n: string, t: string) => { fs.writeFileSync(path.join(d, n), t); return path.join(d, n); };
  const O = w('o', txt([tk('A'), tk('B')])), B = w('b', txt([tk('A', { sp: 3 }), tk('B')]));
  let A = w('a', txt([tk('A'), tk('B', { epic: 'Q' })]));
  let r = spawnSync(BIN, [O, A, B, '.plangraph/tickets.jsonl'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr); assert.equal(fs.readFileSync(A, 'utf8'), txt([tk('A', { sp: 3 }), tk('B', { epic: 'Q' })]));
  A = w('a2', txt([tk('A', { sp: 4 }), tk('B')]));
  r = spawnSync(BIN, [O, A, B, '.plangraph/tickets.jsonl'], { encoding: 'utf8' });
  assert.equal(r.status, 1); assert.match(r.stderr, /A: both sides changed field sp/); assert.match(fs.readFileSync(A, 'utf8'), /^<<<<<<< ours$/m);
  A = w('a3', 'not json\n'); r = spawnSync(BIN, [O, A, B, 'x.jsonl'], { encoding: 'utf8' });
  assert.equal(r.status, 2); assert.equal(fs.readFileSync(A, 'utf8'), 'not json\n'); // input untouched on failure
  assert.equal(spawnSync(BIN, [], { encoding: 'utf8' }).status, 2);
});

// ---- REAL git merge ----
const GENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', env: GENV, stdio: ['ignore', 'pipe', 'pipe'] });
const gitTry = (cwd: string, ...a: string[]) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8', env: GENV }); return { status: r.status, out: r.stdout + r.stderr }; };
function repo({ driver = true } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-'));
  git(d, 'init', '-q', '-b', 'main'); git(d, 'config', 'user.name', 'tester'); git(d, 'config', 'user.email', 't@example.invalid'); git(d, 'config', 'commit.gpgsign', 'false');
  fs.mkdirSync(path.join(d, '.plangraph'));
  if (driver) S.installMergeDriver(d, { driverPath: BIN });
  return d;
}
const put = (d: string, f: string, recs: readonly S.Rec[], sch: S.KeySpec) => fs.writeFileSync(path.join(d, '.plangraph', f), S.canonFile(recs, sch));
const commit = (d: string, msg: string) => { git(d, 'add', '-A'); git(d, 'commit', '-qm', msg); };
function scenario(driver: boolean) {
  const d = repo({ driver }), base = [tk('T-1'), tk('T-2'), tk('T-3')];
  put(d, 'tickets.jsonl', base, T); commit(d, 'base');
  git(d, 'checkout', '-qb', 'feature');
  put(d, 'tickets.jsonl', [tk('T-1', { sp: 8 }), tk('T-2'), tk('T-3'), tk('T-31')], T); commit(d, 'feature');
  git(d, 'checkout', '-q', 'main');
  put(d, 'tickets.jsonl', [tk('T-1', { summary: 'renamed' }), tk('T-2'), tk('T-3'), tk('T-32')], T); commit(d, 'main');
  return d;
}
test('git merge, driver configured: a case plain git cannot merge (same-line field edits + adjacent adds) merges cleanly and canonically', () => {
  const ctrl = scenario(false); assert.notEqual(gitTry(ctrl, 'merge', '--no-edit', 'feature').status, 0, 'control: plain git conflicts');
  const d = scenario(true), r = gitTry(d, 'merge', '--no-edit', 'feature');
  assert.equal(r.status, 0, r.out);
  const merged = fs.readFileSync(path.join(d, '.plangraph/tickets.jsonl'), 'utf8');
  assert.equal(merged, txt([tk('T-1', { sp: 8, summary: 'renamed' }), tk('T-2'), tk('T-3'), tk('T-31'), tk('T-32')]));
  assert.equal(git(d, 'status', '--porcelain', '-uno').trim(), ''); assert.equal(git(d, 'rev-list', '--parents', '-n1', 'HEAD').trim().split(' ').length, 3); // a real merge commit
});
test('git merge, driver configured: true same-field conflict stops the merge, leaves markers, names the key; resolving + commit works', () => {
  const d = repo(), base = [tk('T-1'), tk('T-2')];
  put(d, 'tickets.jsonl', base, T); commit(d, 'base');
  git(d, 'checkout', '-qb', 'feature'); put(d, 'tickets.jsonl', [tk('T-1', { sp: 8 }), tk('T-2')], T); commit(d, 'f');
  git(d, 'checkout', '-q', 'main'); put(d, 'tickets.jsonl', [tk('T-1', { sp: 5 }), tk('T-2', { sp: 2 })], T); commit(d, 'm');
  const r = gitTry(d, 'merge', '--no-edit', 'feature');
  assert.notEqual(r.status, 0); assert.match(r.out, /CONFLICT/); assert.match(r.out, /T-1: both sides changed field sp/);
  assert.equal(git(d, 'diff', '--name-only', '--diff-filter=U').trim(), '.plangraph/tickets.jsonl');
  const body = fs.readFileSync(path.join(d, '.plangraph/tickets.jsonl'), 'utf8');
  assert.match(body, /<<<<<<< ours\n\{"key":"T-1".*"sp":5.*\n=======\n\{"key":"T-1".*"sp":8.*\n>>>>>>> theirs\n\{"key":"T-2".*"sp":2/);
  assert.throws(() => readJsonl(path.join(d, '.plangraph/tickets.jsonl')), IngestError);
  put(d, 'tickets.jsonl', [tk('T-1', { sp: 8 }), tk('T-2', { sp: 2 })], T); git(d, 'add', '-A'); git(d, 'commit', '-qm', 'resolved');
  assert.equal(git(d, 'status', '--porcelain').trim(), '');
});
test('git merge: delete vs edit across branches conflicts; delete vs untouched deletes; rebase also uses the driver', () => {
  const d = repo(); put(d, 'tickets.jsonl', [tk('A'), tk('B'), tk('C')], T); commit(d, 'base');
  git(d, 'checkout', '-qb', 'feature'); put(d, 'tickets.jsonl', [tk('B'), tk('C', { sp: 4 })], T); commit(d, 'f'); // delete A, edit C
  git(d, 'checkout', '-q', 'main'); put(d, 'tickets.jsonl', [tk('A', { sp: 9 }), tk('B'), tk('C'), tk('D')], T); commit(d, 'm'); // edit A, add D
  const r = gitTry(d, 'merge', '--no-edit', 'feature'); assert.notEqual(r.status, 0); assert.match(r.out, /A: deleted in theirs, edited in ours/);
  git(d, 'merge', '--abort');
  git(d, 'checkout', '-q', 'feature'); const rb = gitTry(d, 'rebase', 'main'); assert.notEqual(rb.status, 0); // same conflict through rebase
  git(d, 'rebase', '--abort');
  // clean variant through rebase
  put(d, 'tickets.jsonl', [tk('A'), tk('B'), tk('C', { sp: 4 })], T); commit(d, 'f2');
  git(d, 'reset', '-q', '--hard', 'main'); git(d, 'checkout', '-qb', 'f3'); put(d, 'tickets.jsonl', [tk('A', { sp: 9 }), tk('B', { sp: 2 }), tk('C'), tk('D')], T); commit(d, 'f3');
  git(d, 'checkout', '-q', 'main'); put(d, 'tickets.jsonl', [tk('A', { sp: 9 }), tk('B'), tk('C', { sp: 6 }), tk('D'), tk('E')], T); commit(d, 'm2');
  git(d, 'checkout', '-q', 'f3'); const ok = gitTry(d, 'rebase', 'main'); assert.equal(ok.status, 0, ok.out);
  assert.equal(fs.readFileSync(path.join(d, '.plangraph/tickets.jsonl'), 'utf8'), txt([tk('A', { sp: 9 }), tk('B', { sp: 2 }), tk('C', { sp: 6 }), tk('D'), tk('E')]));
});

// ---- regressions found by the patterns review (fuzz: 1106 non-commutative results in 20000 cases when null was in the value pool) ----
import { mergeJsonl as mj } from '../lib/merge.ts';
import { schemaFor } from '../lib/store.ts';
const TK = schemaFor('tickets.jsonl');
const R = (...r: S.Rec[]) => r;
test('absent and null are different values: swapping ours and theirs gives the same merge (git rebase swaps them)', () => {
  const base = R({ key: 'T-1', sp: 1 }), A = R({ key: 'T-1', sp: 2, note: null }), B = R({ key: 'T-1', sp: 1, summary: 't' });
  const ab = mj({ base, ours: A, theirs: B }, TK), ba = mj({ base, ours: B, theirs: A }, TK);
  assert.equal(ab.text, ba.text);
  assert.deepEqual(ab.conflicts.map((c) => c.key), ba.conflicts.map((c) => c.key));
  assert.match(ab.text, /"note":null/, 'a field set to null on one side is kept, not dropped');
});
test('one side sets a field to null, the other removes it: a real conflict on that field, reported the same from either side', () => {
  const base = R({ key: 'T-1', sp: 1, x: 5 }), A = R({ key: 'T-1', sp: 2, x: null }), B = R({ key: 'T-1', sp: 2 });
  const ab = mj({ base, ours: A, theirs: B }, TK), ba = mj({ base, ours: B, theirs: A }, TK);
  assert.equal(ab.conflicts.length, 1);
  assert.equal(ba.conflicts.length, 1);
  assert.equal(ab.conflicts[0].detail, ba.conflicts[0].detail);
  assert.match(ab.conflicts[0].detail, /\bx\b/);
  // when only one side touched the field there is no conflict and the result is symmetric
  const only = mj({ base, ours: R({ key: 'T-1', sp: 2, x: null }), theirs: R({ key: 'T-1', sp: 1, x: 5, summary: 't' }) }, TK);
  const only2 = mj({ base, ours: R({ key: 'T-1', sp: 1, x: 5, summary: 't' }), theirs: R({ key: 'T-1', sp: 2, x: null }) }, TK);
  assert.equal(only.text, only2.text); assert.equal(only.conflicts.length, 0);
});
test('awkward key names (constructor, toString, __proto__, hasOwnProperty) merge exactly like a plain reference 3-way merge, in both orders', () => {
  const ref = (b: unknown, o: unknown, t: unknown) => (o === t ? { v: o } : o === b ? { v: t } : t === b ? { v: o } : { conflict: true });
  const vals = [undefined, 'a', 'b'];
  const line = (f: string, v: unknown, extra?: S.Rec) => JSON.stringify({ key: 'T-1', sp: 1, ...extra }).replace('}', v === undefined ? '}' : `,${JSON.stringify(f)}:${JSON.stringify(v)}}`);
  let n = 0;
  for (const f of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) for (const b of vals) for (const o of vals) for (const t of vals) {
    const base = line(f, b) + '\n', ours = line(f, o, { a1: 1 }) + '\n', theirs = line(f, t, { a2: 1 }) + '\n'; // both sides changed something else, so the field-level merge runs
    for (const [x, y] of [[ours, theirs], [theirs, ours]]) {
      const r = mj({ base, ours: x, theirs: y }, TK); n++;
      const expect = ref(b, x === ours ? o : t, x === ours ? t : o);
      assert.ok(!/undefined|function/.test(r.text), `${f} ${b}/${o}/${t}: output must be plain JSON, got ${r.text}`);
      if (expect.conflict) assert.equal(r.conflicts.length, 1, `${f} ${b}/${o}/${t}`);
      else {
        assert.equal(r.conflicts.length, 0, `${f} ${b}/${o}/${t}`);
        const got = JSON.parse(r.text.trim()); assert.equal(Object.hasOwn(got, f) ? got[f] : undefined, expect.v, `${f} ${b}/${o}/${t}`);
      }
    }
  }
  assert.equal(({} as Record<string, unknown>).polluted, undefined); assert.equal(n, 216); // reads a key a fresh object does not have
});

// Review M7: a clean text merge of the schedule or the links can still break a rule (edge T-2 needs T-1; base both Ana S2; ours moves T-2
// to Ben S3, theirs moves both to S3: clean merge, HANDOFF violation). The driver says so in one line; other files stay silent.
test('brain-merge: a clean merge of schedule.jsonl or edges.jsonl prints a one-line `brain check` hint; other files do not', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-merge-hint-'));
  try {
    const SC = S.SCHEMAS['schedule.jsonl'], row = (key: string, owner: string, sprint: number) => ({ version: 'current', key, owner, sprint });
    const put = (n: string, recs: readonly S.Rec[], sch: S.KeySpec) => { const f = path.join(d, n); fs.writeFileSync(f, S.canonFile(recs, sch)); return f; };
    const O = put('O', [row('T-1', 'Ana', 2), row('T-2', 'Ana', 2)], SC), A = put('A', [row('T-1', 'Ana', 2), row('T-2', 'Ben', 3)], SC), B = put('B', [row('T-1', 'Ana', 3), row('T-2', 'Ana', 3)], SC);
    const r = spawnSync(process.execPath, [BIN, O, A, B, '.plangraph/schedule.jsonl'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, 'brain-merge: schedule.jsonl merged cleanly, but a text merge can still break a handoff or capacity rule: run `brain build` then `brain check`\n');
    assert.equal(fs.readFileSync(A, 'utf8'), S.canonFile([row('T-1', 'Ana', 3), row('T-2', 'Ben', 3)], SC));
    const E = S.SCHEMAS['edges.jsonl'], ed = (consumer: string, producer: string) => ({ consumer, producer, kind: 'plan_need', note: '' });
    const eo = put('eo', [ed('T-2', 'T-1')], E), ea = put('ea', [ed('T-2', 'T-1'), ed('T-3', 'T-2')], E), eb = put('eb', [ed('T-2', 'T-1'), ed('T-1', 'T-3')], E);
    const re = spawnSync(process.execPath, [BIN, eo, ea, eb, 'sub/.plangraph/edges.jsonl'], { encoding: 'utf8' });
    assert.equal(re.status, 0, re.stderr); assert.match(re.stderr, /^brain-merge: edges\.jsonl merged cleanly, but .* `brain check`\n$/);
    const to = put('to', [tk('T-1')], T), ta = put('ta', [tk('T-1', { sp: 2 })], T), tb = put('tb', [tk('T-1')], T);
    const rt = spawnSync(process.execPath, [BIN, to, ta, tb, '.plangraph/tickets.jsonl'], { encoding: 'utf8' });
    assert.equal(rt.status, 0); assert.equal(rt.stderr, '');
    const so = put('so', [row('T-1', 'Ana', 2)], SC), sa = put('sa', [row('T-1', 'Ana', 2)], SC), sb = put('sb', [row('T-1', 'Ana', 2)], SC);
    assert.equal(spawnSync(process.execPath, [BIN, so, sa, sb, '.plangraph/my-schedule.jsonl'], { encoding: 'utf8' }).stderr, '', 'exact base names only');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
