// lib/store2/resolve.ts: union-resolve conflict markers when every hunk holds only collection-field lines.
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveConflicts } from '../lib/store2/resolve.ts';
import { checkStore } from '../lib/store2/check.ts';
import { readNodes } from '../lib/store2/nodes.ts';
import { nodePath } from '../lib/store2/layout.ts';

let root = '';
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-resolve-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
const put = (id: string, text: string) => { const p = nodePath(root, 'ticket', id); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };
const rel = (p: string) => path.relative(root, p);
const targets = () => { for (const t of ['A', 'B', 'C']) put(t, `id "${t}"\n`); };

test('a hunk of link lines on both sides is unioned, deduplicated and sorted; the file is canonical afterwards', () => {
  targets();
  const p = put('T-1', 'id "T-1"\nlinks {"rel":"a","to":"A"}\n<<<<<<< HEAD\nlinks {"rel":"c","to":"C"}\nlinks {"rel":"b","to":"B"}\n=======\nlinks {"rel":"b","to":"B"}\nlinks {"rel":"a2","to":"A"}\n>>>>>>> t\nowner "x"\n');
  const r = resolveConflicts(root);
  assert.deepEqual([r.resolved, r.left], [[rel(p)], []]);
  assert.equal(fs.readFileSync(p, 'utf8'), 'id "T-1"\nlinks {"rel":"a","to":"A"}\nlinks {"rel":"a2","to":"A"}\nlinks {"rel":"b","to":"B"}\nlinks {"rel":"c","to":"C"}\nowner "x"\n');
  assert.deepEqual(checkStore(root), []);
});

test('several hunks, a one-sided hunk and members/acceptance lines all resolve', () => {
  const p = put('T-1', 'id "T-1"\n<<<<<<< HEAD\nacceptance "one"\n=======\n>>>>>>> t\nowner "x"\n<<<<<<< HEAD\n=======\nmembers "p1"\nmembers "p2"\n>>>>>>> t\n');
  assert.deepEqual(resolveConflicts(root).resolved, [rel(p)]);
  assert.equal(fs.readFileSync(p, 'utf8'), 'id "T-1"\nacceptance "one"\nmembers "p1"\nmembers "p2"\nowner "x"\n');
});

test('with a diff3 base, a link one side deleted stays deleted', () => {
  targets();
  const p = put('T-1', 'id "T-1"\n<<<<<<< HEAD\nlinks {"rel":"b","to":"B"}\n||||||| base\nlinks {"rel":"a","to":"A"}\nlinks {"rel":"b","to":"B"}\n=======\nlinks {"rel":"a","to":"A"}\nlinks {"rel":"b","to":"B"}\nlinks {"rel":"c","to":"C"}\n>>>>>>> t\n');
  assert.deepEqual(resolveConflicts(root).resolved, [rel(p)]);
  assert.equal(fs.readFileSync(p, 'utf8'), 'id "T-1"\nlinks {"rel":"b","to":"B"}\nlinks {"rel":"c","to":"C"}\n');
});

test('a hunk with a scalar line leaves the whole file untouched and reports file and field', () => {
  const text = 'id "T-1"\n<<<<<<< HEAD\nlinks {"rel":"a","to":"A"}\nowner "x"\n=======\nowner "y"\n>>>>>>> t\n';
  const p = put('T-1', text);
  const r = resolveConflicts(root);
  assert.deepEqual(r.resolved, []);
  assert.deepEqual(r.left.map((l) => [l.path, l.field, l.line]), [[rel(p), 'owner', 2]]);
  assert.equal(fs.readFileSync(p, 'utf8'), text);
});

test('an unterminated conflict and a result that does not parse are left in place', () => {
  const a = put('A', 'id "A"\n<<<<<<< HEAD\nlinks {"rel":"a","to":"A"}\n');
  const b = put('B', 'id "B"\n<<<<<<< HEAD\nlinks nope\n=======\nlinks {"rel":"a","to":"A"}\n>>>>>>> t\n');
  const r = resolveConflicts(root);
  assert.deepEqual(r.resolved, []);
  assert.deepEqual(r.left.map((l) => l.path).sort(), [rel(a), rel(b)].sort());
});

test('files without markers are not touched, and a clean store resolves nothing', () => {
  const p = put('T-1', 'id "T-1"\nowner "a"');
  assert.deepEqual(resolveConflicts(root), { resolved: [], left: [] });
  assert.equal(fs.readFileSync(p, 'utf8'), 'id "T-1"\nowner "a"');
  assert.equal(readNodes(root, 'ticket').nodes.length, 1);
});
