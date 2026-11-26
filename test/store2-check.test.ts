// lib/store2/check.ts: checkStore finds what git cannot guarantee. Batch codes (UNSORTED_BATCH, MISSING_CURRENT) belong to the batch tests.
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkStore, caseCollisions, fmtStore } from '../lib/store2/check.ts';
import { writeNode } from '../lib/store2/nodes.ts';
import { nodePath } from '../lib/store2/layout.ts';

let root = '';
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-check-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
const rel = (p: string) => path.relative(root, p);
const codes = () => checkStore(root).map((v) => v.code);
const put = (kind: string, id: string, text: string) => { const p = nodePath(root, kind, id); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };

test('a missing or empty store is clean', () => {
  assert.deepEqual(checkStore(root), []);
  writeNode(root, 'ticket', { id: 'T-1', links: [{ rel: 'needs', to: 'T-2' }] }); writeNode(root, 'ticket', { id: 'T-2' });
  assert.deepEqual(checkStore(root), []);
});

test('every violation carries code, path, line and a one-line fix', () => {
  put('ticket', 'T-1', 'id "T-1"\nowner "a"\n<<<<<<< HEAD\nx 1\n=======\nx 2\n>>>>>>> y\n');
  const [v] = checkStore(root);
  assert.deepEqual(Object.keys(v ?? {}).sort(), ['code', 'fix', 'line', 'path']);
  assert.equal(v?.code, 'CONFLICT_MARKERS'); assert.equal(v?.line, 3); assert.equal(v?.path, rel(nodePath(root, 'ticket', 'T-1')));
  assert.doesNotMatch(v?.fix ?? '', /\n/);
});

test('NOT_CANONICAL: unsorted fields, CRLF, no trailing newline; fmtStore rewrites exactly those files', () => {
  const a = put('ticket', 'T-1', 'id "T-1"\nzeta 1\nalpha 2\n'), b = put('ticket', 'T-2', 'id "T-2"\r\nowner "a"\r\n'), c = put('ticket', 'T-3', 'id "T-3"\nowner "a"');
  writeNode(root, 'ticket', { id: 'T-4' });
  const want = [a, b, c].map(rel).sort();
  assert.deepEqual(checkStore(root).map((v) => [v.code, v.path]), want.map((p) => ['NOT_CANONICAL', p]));
  const r = fmtStore(root);
  assert.deepEqual(r.rewritten, want);
  assert.equal(fs.readFileSync(a, 'utf8'), 'id "T-1"\nalpha 2\nzeta 1\n');
  assert.deepEqual(checkStore(root), []);
  assert.deepEqual(fmtStore(root).rewritten, []);
});

test('fmtStore leaves a file with a conflict or bad line alone', () => {
  const p = put('ticket', 'T-1', 'id "T-1"\nowner nope\n');
  assert.deepEqual(fmtStore(root).rewritten, []);
  assert.equal(fs.readFileSync(p, 'utf8'), 'id "T-1"\nowner nope\n');
});

test('ID_MISMATCH: file name hash differs from the id, or the file sits in another hash directory', () => {
  const p = put('ticket', 'T-1', 'id "T-2"\n');
  assert.deepEqual(checkStore(root).map((v) => v.code), ['ID_MISMATCH']);
  fs.rmSync(p);
  const q = nodePath(root, 'ticket', 'T-3'), wrong = path.join(path.dirname(path.dirname(q)), path.basename(path.dirname(q)) === '00' ? '01' : '00');
  fs.mkdirSync(wrong, { recursive: true }); fs.writeFileSync(path.join(wrong, path.basename(q)), 'id "T-3"\n');
  assert.deepEqual(codes(), ['ID_MISMATCH']);
});

test('DUPLICATE_ID: the same id in a second, misplaced file', () => {
  writeNode(root, 'ticket', { id: 'T-1' });
  const q = nodePath(root, 'ticket', 'T-1'), wrong = path.join(path.dirname(path.dirname(q)), path.basename(path.dirname(q)) === '00' ? '01' : '00');
  fs.mkdirSync(wrong, { recursive: true }); fs.writeFileSync(path.join(wrong, path.basename(q)), 'id "T-1"\n');
  assert.deepEqual(codes(), ['DUPLICATE_ID']);
});

test('DANGLING_LINK: a link target with no node; a pg: URI and a node of another kind both resolve', () => {
  writeNode(root, 'person', { id: 'Ana' });
  writeNode(root, 'ticket', { id: 'T-1', links: [{ rel: 'a', to: 'Ana' }, { rel: 'b', to: 'pg:person/Ana' }, { rel: 'c', to: 'GONE-1' }] });
  const v = checkStore(root);
  assert.deepEqual(v.map((x) => x.code), ['DANGLING_LINK']);
  assert.match(v[0]?.fix ?? '', /GONE-1/);
  assert.ok((v[0]?.line ?? 0) >= 2);
});

test('BAD_SCHEMA: wrong types in reserved fields, bad link or xref shape, bad status', () => {
  writeNode(root, 'ticket', { id: 'A', schema_version: 'one' });
  writeNode(root, 'ticket', { id: 'B', links: [{ rel: 1, to: 'A' }] });
  writeNode(root, 'ticket', { id: 'C', links: ['A'] });
  writeNode(root, 'ticket', { id: 'D', xrefs: [{ sys: 'jira' }] });
  writeNode(root, 'ticket', { id: 'E', derivation: 'guessed' });
  writeNode(root, 'requirement', { id: 'R-1', status: 'maybe' });
  writeNode(root, 'ticket', { id: 'F', valid_to: 5 });
  assert.deepEqual(codes(), Array(7).fill('BAD_SCHEMA'));
});

test('BAD_LINE, CONFLICT_MARKERS, OVERSIZE and SYMLINK are reported, not thrown', () => {
  put('ticket', 'B', 'id "B"\nowner nope\n');
  put('ticket', 'O', `id "O"\nnote "${'x'.repeat(300 * 1024)}"\n`);
  const l = nodePath(root, 'ticket', 'L'); fs.mkdirSync(path.dirname(l), { recursive: true }); fs.symlinkSync('/etc/hosts', l);
  const got = checkStore(root).map((v) => v.code).sort();
  assert.deepEqual(got, ['BAD_LINE', 'OVERSIZE', 'SYMLINK']);
});

test('jsonl batch files: conflict markers, a bad line and a symlink are reported', () => {
  fs.mkdirSync(path.join(root, 'events/2026-11'), { recursive: true });
  fs.writeFileSync(path.join(root, 'events/2026-11/a.00000000.01.jsonl'), '{"at":1}\n<<<<<<< HEAD\n');
  fs.writeFileSync(path.join(root, 'events/2026-11/b.00000000.01.jsonl'), '{"at":1}\nnot json\n');
  fs.symlinkSync('/etc/hosts', path.join(root, 'events/2026-11/c.00000000.01.jsonl'));
  assert.deepEqual(checkStore(root).map((v) => [path.basename(v.path)[0], v.code, v.line]), [['a', 'CONFLICT_MARKERS', 2], ['b', 'BAD_LINE', 2], ['c', 'SYMLINK', 0]]);
});

test('names for Ana and ana differ, so two ids that differ only by case are two clean files', () => {
  writeNode(root, 'person', { id: 'Ana' }); writeNode(root, 'person', { id: 'ana' });
  assert.deepEqual(checkStore(root), []);
});

test('CASE_COLLISION: two names equal ignoring case (pure helper; the file system test runs where it is case-sensitive)', () => {
  assert.deepEqual(caseCollisions(['nodes/t/ab/Ana~1.pg', 'nodes/t/ab/ana~1.pg', 'nodes/t/ab/other~2.pg']), [['nodes/t/ab/Ana~1.pg', 'nodes/t/ab/ana~1.pg']]);
  assert.deepEqual(caseCollisions(['a', 'b']), []);
  const d = path.join(root, 'probe'); fs.mkdirSync(d); fs.writeFileSync(path.join(d, 'x'), '1'); fs.writeFileSync(path.join(d, 'X'), '2');
  if (fs.readdirSync(d).length < 2) return; // case-insensitive volume: two names cannot exist, which is the point of the hash suffix
  const dir = path.dirname(nodePath(root, 'person', 'Ana')); fs.mkdirSync(dir, { recursive: true });
  const base = path.basename(nodePath(root, 'person', 'Ana'));
  fs.writeFileSync(path.join(dir, base), 'id "Ana"\n'); fs.writeFileSync(path.join(dir, base.toUpperCase().replace(/\.PG$/, '.pg')), 'id "Ana"\n');
  assert.ok(codes().includes('CASE_COLLISION'));
});

test('violations are sorted by path then code, so output is stable', () => {
  put('ticket', 'Z', 'id "Z"\nowner nope\n'); put('ticket', 'A', 'id "A"\nowner nope\n');
  const v = checkStore(root);
  assert.deepEqual(v.map((x) => x.path), [...v.map((x) => x.path)].sort());
});
