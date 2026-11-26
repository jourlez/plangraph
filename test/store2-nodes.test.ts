// lib/store2/nodes.ts: read, write, delete, rename and erase of entity files; a damaged file is a problem, never a crash.
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readNodes, writeNode, deleteNode, renameNode, eraseNode } from '../lib/store2/nodes.ts';
import { nodePath } from '../lib/store2/layout.ts';

let root = '';
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-nodes-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

test('writeNode reports created, same and changed, and readNodes returns the nodes sorted by id', () => {
  assert.equal(writeNode(root, 'ticket', { id: 'T-2', title: 'b' }), 'created');
  assert.equal(writeNode(root, 'ticket', { id: 'T-1', title: 'a' }), 'created');
  assert.equal(writeNode(root, 'ticket', { id: 'T-1', title: 'a' }), 'same');
  assert.equal(writeNode(root, 'ticket', { id: 'T-1', title: 'a2' }), 'changed');
  const r = readNodes(root, 'ticket');
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.nodes, [{ id: 'T-1', title: 'a2' }, { id: 'T-2', title: 'b' }]);
  assert.ok(fs.existsSync(nodePath(root, 'ticket', 'T-1')));
  assert.deepEqual(readNodes(root, 'person'), { nodes: [], problems: [] });
});

test('a write leaves no temp file and the committed bytes are the canonical text', () => {
  writeNode(root, 'ticket', { id: 'T-1', z: 1, a: 2 });
  assert.equal(fs.readFileSync(nodePath(root, 'ticket', 'T-1'), 'utf8'), 'id "T-1"\na 2\nz 1\n');
  assert.deepEqual(fs.readdirSync(path.dirname(nodePath(root, 'ticket', 'T-1'))).filter((f) => !f.endsWith('.pg')), []);
});

test('deleteNode removes the file and is quiet when it is already gone', () => {
  writeNode(root, 'ticket', { id: 'T-1' });
  deleteNode(root, 'ticket', 'T-1');
  assert.ok(!fs.existsSync(nodePath(root, 'ticket', 'T-1')));
  assert.doesNotThrow(() => deleteNode(root, 'ticket', 'T-1'));
});

test('one conflicted file among 100: the other 99 load and the problem is CONFLICT_MARKERS with path and line', () => {
  for (let i = 0; i < 100; i++) writeNode(root, 'ticket', { id: `T-${i}`, owner: 'a', sprint: 1 });
  const p = nodePath(root, 'ticket', 'T-50');
  fs.writeFileSync(p, 'id "T-50"\n<<<<<<< HEAD\nowner "a"\n=======\nowner "b"\n>>>>>>> x\nsprint 1\n');
  const r = readNodes(root, 'ticket');
  assert.equal(r.nodes.length, 99);
  assert.equal(r.problems.length, 1);
  assert.deepEqual(r.problems[0], { code: 'CONFLICT_MARKERS', path: path.relative(root, p), line: 2, fix: r.problems[0]?.fix });
  assert.match(r.problems[0]?.fix ?? '', /resolve/);
});

test('hostile files give BAD_LINE, SYMLINK, OVERSIZE and ID_MISMATCH and never crash the read', () => {
  writeNode(root, 'ticket', { id: 'T-1' });
  const dir = path.dirname(nodePath(root, 'ticket', 'T-1'));
  fs.writeFileSync(path.join(dir, 'a~00000001.pg'), 'id "T-1"\nnote "x\u0000y"\n');
  fs.writeFileSync(path.join(dir, 'b~00000002.pg'), `id "T-1"\nnote "${'x'.repeat(20000)}"\n`);
  fs.writeFileSync(path.join(dir, 'c~00000003.pg'), 'x'.repeat(300 * 1024));
  fs.symlinkSync('/etc/hosts', path.join(dir, 'd~00000004.pg'));
  fs.writeFileSync(path.join(dir, 'e~00000005.pg'), 'id "T-1"\n');
  const fifo = path.join(dir, 'f~00000006.pg');
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
  const r = readNodes(root, 'ticket');
  assert.deepEqual(r.nodes, [{ id: 'T-1' }]);
  const by = Object.fromEntries(r.problems.map((p) => [path.basename(p.path)[0], p.code]));
  assert.deepEqual(by, { a: 'BAD_LINE', b: 'BAD_LINE', c: 'OVERSIZE', d: 'SYMLINK', e: 'ID_MISMATCH', f: 'BAD_LINE' });
});

test('a node in the wrong directory (hash directory does not match) is ID_MISMATCH and skipped', () => {
  writeNode(root, 'ticket', { id: 'T-1' });
  const p = nodePath(root, 'ticket', 'T-1'), other = path.join(path.dirname(path.dirname(p)), p.includes('/00/') ? '01' : '00');
  fs.mkdirSync(other, { recursive: true });
  fs.renameSync(p, path.join(other, path.basename(p)));
  const r = readNodes(root, 'ticket');
  assert.deepEqual([r.nodes.length, r.problems.map((x) => x.code)], [0, ['ID_MISMATCH']]);
});

test('renameNode moves the file, rewrites links and xrefs in other nodes, and leaves alias_of when asked', () => {
  writeNode(root, 'ticket', { id: 'sp:p/1', title: 'a', links: [{ rel: 'needs', to: 'sp:p/1' }] });
  writeNode(root, 'ticket', { id: 'T-9', links: [{ rel: 'needs', to: 'sp:p/1' }, { rel: 'needs', to: 'other' }], xrefs: [{ sys: 'pg', xid: 'sp:p/1' }, { sys: 'jira', xid: 'ABC-1' }] });
  renameNode(root, 'ticket', 'sp:p/1', 'ABC-1', { keepAlias: true });
  const m = new Map(readNodes(root, 'ticket').nodes.map((n) => [n.id, n]));
  assert.deepEqual(m.get('ABC-1'), { id: 'ABC-1', title: 'a', links: [{ rel: 'needs', to: 'ABC-1' }] });
  assert.deepEqual(m.get('sp:p/1'), { id: 'sp:p/1', alias_of: 'ABC-1' });
  assert.deepEqual(m.get('T-9'), { id: 'T-9', links: [{ rel: 'needs', to: 'ABC-1' }, { rel: 'needs', to: 'other' }], xrefs: [{ sys: 'jira', xid: 'ABC-1' }, { sys: 'pg', xid: 'ABC-1' }] });
  renameNode(root, 'ticket', 'ABC-1', 'ABC-2');
  assert.ok(!fs.existsSync(nodePath(root, 'ticket', 'ABC-1')));
  assert.equal(readNodes(root, 'ticket').nodes.find((n) => n.id === 'T-9')?.links?.toString(), [{ rel: 'needs', to: 'ABC-2' }, { rel: 'needs', to: 'other' }].toString());
});

test('renameNode refuses a missing source and an existing target', () => {
  writeNode(root, 'ticket', { id: 'A' }); writeNode(root, 'ticket', { id: 'B' });
  assert.throws(() => renameNode(root, 'ticket', 'nope', 'C'), /not found/);
  assert.throws(() => renameNode(root, 'ticket', 'A', 'B'), /exists/);
});

test('eraseNode lists the node file, every node that links to the id, and every event and run line that names it; it changes nothing', () => {
  writeNode(root, 'ticket', { id: 'T-1' });
  writeNode(root, 'ticket', { id: 'T-2', links: [{ rel: 'needs', to: 'T-1' }] });
  writeNode(root, 'ticket', { id: 'T-3', links: [{ rel: 'needs', to: 'T-2' }] });
  fs.mkdirSync(path.join(root, 'events/2026-11'), { recursive: true });
  fs.writeFileSync(path.join(root, 'events/2026-11/ana.00000000.01.jsonl'), '{"task":"T-1","to":"done"}\n{"task":"T-2","to":"done"}\n{"task":"T-1","to":"todo"}\n');
  const before = fs.readFileSync(nodePath(root, 'ticket', 'T-2'), 'utf8');
  const plan = eraseNode(root, 'ticket', 'T-1');
  assert.deepEqual(plan.files, [path.relative(root, nodePath(root, 'ticket', 'T-1'))]);
  assert.deepEqual(plan.links, [{ path: path.relative(root, nodePath(root, 'ticket', 'T-2')), rel: 'needs' }]);
  assert.deepEqual(plan.events.map((e) => [e.path, e.line]), [['events/2026-11/ana.00000000.01.jsonl', 1], ['events/2026-11/ana.00000000.01.jsonl', 3]]);
  assert.equal(fs.readFileSync(nodePath(root, 'ticket', 'T-2'), 'utf8'), before);
  assert.ok(fs.existsSync(nodePath(root, 'ticket', 'T-1')));
});
