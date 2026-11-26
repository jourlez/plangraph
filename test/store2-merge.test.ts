// What stock git ACTUALLY does with .pg files (spec 4.0 rule 2): real repositories, no merge driver, no .gitattributes.
// Names record the observed behavior. Each scenario was run against real git before the assertion was written.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeNode, readNodes } from '../lib/store2/nodes.ts';
import { checkStore } from '../lib/store2/check.ts';
import { resolveConflicts } from '../lib/store2/resolve.ts';
import { nodePath } from '../lib/store2/layout.ts';
import type { Node } from '../lib/store2/pg.ts';

let BASE = '', n = 0;
const ENV = { PATH: process.env.PATH as string, HOME: '/nonexistent', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' };
const git = (cwd: string, ...a: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...a], { cwd, env: ENV, encoding: 'utf8' });
const ok = (cwd: string, ...a: string[]) => { const r = git(cwd, ...a); assert.equal(r.status, 0, `${a.join(' ')}: ${r.stderr}${r.stdout}`); return r.stdout; };
const commit = (cwd: string, m: string) => { ok(cwd, 'add', '-A'); ok(cwd, 'commit', '-qm', m); };

/** A repo whose main branch holds `base`; returns a helper that edits on two branches and merges `theirs` into `ours`. */
function repo(base: Node[], kind = 'ticket') {
  const d = path.join(BASE, `r${n++}`); fs.mkdirSync(d); ok(d, 'init', '-q', '-b', 'main');
  assert.ok(!fs.existsSync(path.join(d, '.gitattributes')));
  for (const x of base) writeNode(d, kind, x);
  commit(d, 'base');
  const branch = (name: string, edit: () => void) => { ok(d, 'checkout', '-q', '-b', name, 'main'); edit(); commit(d, name); };
  const merge = (ours: string, theirs: string) => { ok(d, 'checkout', '-q', ours); return git(d, 'merge', '--no-edit', theirs); };
  return { d, branch, merge };
}
before(() => { BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-merge-')); });
after(() => { fs.rmSync(BASE, { recursive: true, force: true }); });

const T = (extra: Partial<Node> = {}): Node => ({ id: 'T-1', owner: 'ana', sprint: 1, status: 'todo', title: 't', ...extra });
const text = (d: string, id: string) => fs.readFileSync(nodePath(d, 'ticket', id), 'utf8');

test('git merges two branches that edit NON-ADJACENT scalar fields of one node cleanly, and checkStore is clean after', () => {
  const r = repo([T()]);
  r.branch('o', () => writeNode(r.d, 'ticket', T({ owner: 'bob' })));
  r.branch('t', () => writeNode(r.d, 'ticket', T({ status: 'done' })));
  assert.equal(r.merge('o', 't').status, 0);
  assert.deepEqual(readNodes(r.d, 'ticket').nodes, [T({ owner: 'bob', status: 'done' })]);
  assert.deepEqual(checkStore(r.d), []);
});

test('git CONFLICTS when two branches edit ADJACENT scalar fields; readNodes still loads the other 99 files and reports CONFLICT_MARKERS for that one', () => {
  const base = Array.from({ length: 100 }, (_, i) => T({ id: `T-${i}` }));
  const r = repo(base);
  r.branch('o', () => writeNode(r.d, 'ticket', T({ id: 'T-7', owner: 'bob' })));
  r.branch('t', () => writeNode(r.d, 'ticket', T({ id: 'T-7', sprint: 2 })));
  const m = r.merge('o', 't');
  assert.equal(m.status, 1); assert.match(m.stdout, /CONFLICT \(content\)/);
  const got = readNodes(r.d, 'ticket');
  assert.equal(got.nodes.length, 99);
  assert.deepEqual(got.problems.map((p) => [p.code, p.path]), [['CONFLICT_MARKERS', path.relative(r.d, nodePath(r.d, 'ticket', 'T-7'))]]);
  assert.deepEqual(checkStore(r.d).map((v) => v.code), ['CONFLICT_MARKERS']);
  assert.match(text(r.d, 'T-7'), /<<<<<<< HEAD\nowner "bob"\nsprint 1\n=======\nowner "ana"\nsprint 2\n>>>>>>> t\n/);
});

const L = (rel: string, to: string) => ({ rel, to });
const targets = ['A', 'B', 'F', 'G', 'H'].map((id) => ({ id }));
const withTargets = (r: (nodes: Node[]) => ReturnType<typeof repo>, links: Array<{ rel: string; to: string }>) => r([...targets, T({ links })]);

test('git merges two links added at DIFFERENT sorted positions (separated by an unchanged link) cleanly; checkStore is clean after', () => {
  const r = withTargets(repo, [L('b', 'B'), L('f', 'F')]);
  r.branch('o', () => writeNode(r.d, 'ticket', T({ links: [L('a', 'A'), L('b', 'B'), L('f', 'F')] })));
  r.branch('t', () => writeNode(r.d, 'ticket', T({ links: [L('b', 'B'), L('f', 'F'), L('g', 'G')] })));
  assert.equal(r.merge('o', 't').status, 0);
  assert.deepEqual(readNodes(r.d, 'ticket').nodes.find((x) => x.id === 'T-1')?.links, [L('a', 'A'), L('b', 'B'), L('f', 'F'), L('g', 'G')]);
  assert.deepEqual(checkStore(r.d), []);
});

test('git CONFLICTS when two links are added at the SAME position; resolve unions and sorts them, and checkStore is clean afterwards', () => {
  const r = withTargets(repo, [L('b', 'B'), L('f', 'F')]);
  r.branch('o', () => writeNode(r.d, 'ticket', T({ links: [L('b', 'B'), L('f', 'F'), L('g', 'G')] })));
  r.branch('t', () => writeNode(r.d, 'ticket', T({ links: [L('b', 'B'), L('f', 'F'), L('h', 'H')] })));
  assert.equal(r.merge('o', 't').status, 1);
  assert.deepEqual(readNodes(r.d, 'ticket').problems.map((p) => p.code), ['CONFLICT_MARKERS']);
  const res = resolveConflicts(r.d);
  assert.deepEqual([res.resolved, res.left], [[path.relative(r.d, nodePath(r.d, 'ticket', 'T-1'))], []]);
  assert.deepEqual(readNodes(r.d, 'ticket').nodes.find((x) => x.id === 'T-1')?.links, [L('b', 'B'), L('f', 'F'), L('g', 'G'), L('h', 'H')]);
  assert.deepEqual(checkStore(r.d), []);
  ok(r.d, 'add', '-A'); ok(r.d, 'commit', '-qm', 'merge'); // the merge can be concluded
});

test('a conflict on a scalar hunk stays in place: resolve leaves the file untouched and names file and field', () => {
  const r = repo([T()]);
  r.branch('o', () => writeNode(r.d, 'ticket', T({ owner: 'bob' })));
  r.branch('t', () => writeNode(r.d, 'ticket', T({ sprint: 2 })));
  assert.equal(r.merge('o', 't').status, 1);
  const before = text(r.d, 'T-1'), res = resolveConflicts(r.d);
  assert.deepEqual(res.resolved, []);
  assert.deepEqual(res.left.map((l) => [l.path, l.field]), [[path.relative(r.d, nodePath(r.d, 'ticket', 'T-1')), 'owner']]);
  assert.equal(text(r.d, 'T-1'), before);
});

test('git merges two branches that create DIFFERENT new ids cleanly', () => {
  const r = repo([T()]);
  r.branch('o', () => writeNode(r.d, 'ticket', { id: 'N-1', title: 'one' }));
  r.branch('t', () => writeNode(r.d, 'ticket', { id: 'N-2', title: 'two' }));
  assert.equal(r.merge('o', 't').status, 0);
  assert.deepEqual(readNodes(r.d, 'ticket').nodes.map((x) => x.id), ['N-1', 'N-2', 'T-1']);
  assert.deepEqual(checkStore(r.d), []);
});

test('git CONFLICTS (add/add) when two branches create the SAME new id with different content', () => {
  const r = repo([T()]);
  r.branch('o', () => writeNode(r.d, 'ticket', { id: 'N-1', title: 'one' }));
  r.branch('t', () => writeNode(r.d, 'ticket', { id: 'N-1', title: 'two' }));
  const m = r.merge('o', 't');
  assert.equal(m.status, 1); assert.match(m.stdout, /CONFLICT \(add\/add\)/);
  assert.deepEqual(readNodes(r.d, 'ticket').problems.map((p) => p.code), ['CONFLICT_MARKERS']);
});

test('git merges two branches that create the same new id with IDENTICAL bytes cleanly', () => {
  const r = repo([T()]);
  r.branch('o', () => writeNode(r.d, 'ticket', { id: 'N-1', title: 'same' }));
  r.branch('t', () => writeNode(r.d, 'ticket', { id: 'N-1', title: 'same' }));
  assert.equal(r.merge('o', 't').status, 0);
  assert.deepEqual(checkStore(r.d), []);
});
