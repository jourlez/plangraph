// Tests for lib/store2/txn.ts. NOT covered: power loss between fsync and rename on real hardware (failure is injected through hooks),
// NFS locking, Windows rename semantics.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { withTxn, recoverTxn } from '../lib/store2/txn.ts';

const made: string[] = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'txn-'))); made.push(d); return d; };
const rd = (root: string, rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const has = (root: string, rel: string) => fs.existsSync(path.join(root, rel));
const leftovers = (root: string) => { try { return fs.readdirSync(path.join(root, '.txn')).filter((n) => n !== 'lock'); } catch { return []; } };
const LIB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../lib/store2/txn.ts');

test('withTxn writes and removes files, creating parents, and leaves no staging behind', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'old.txt'), 'old');
  withTxn(root, (tx) => { tx.write('a/b/c.txt', 'one\n'); tx.write('d.txt', 'two\n'); tx.remove('old.txt'); });
  assert.equal(rd(root, 'a/b/c.txt'), 'one\n');
  assert.equal(rd(root, 'd.txt'), 'two\n');
  assert.equal(has(root, 'old.txt'), false);
  assert.deepEqual(leftovers(root), []);
});

test('the last operation on a path wins', () => {
  const root = tmp();
  withTxn(root, (tx) => { tx.write('x.txt', '1'); tx.write('x.txt', '2'); tx.write('y.txt', '1'); tx.remove('y.txt'); });
  assert.equal(rd(root, 'x.txt'), '2');
  assert.equal(has(root, 'y.txt'), false);
});

test('a throw inside fn applies nothing and removes the staging directory', () => {
  const root = tmp();
  assert.throws(() => withTxn(root, (tx) => { tx.write('a.txt', 'x'); throw new Error('boom'); }), /boom/);
  assert.equal(has(root, 'a.txt'), false);
  assert.deepEqual(leftovers(root), []);
});

test('killed between stage and journal: the next call rolls back with no partial state', () => {
  const root = tmp();
  assert.throws(() => withTxn(root, (tx) => { tx.write('a.txt', '1'); tx.write('b.txt', '2'); }, { hooks: { beforeJournal() { throw new Error('killed'); } } }), /killed/);
  assert.equal(leftovers(root).length, 1, 'the dead transaction is still on disk, as after a real kill');
  assert.equal(has(root, 'a.txt'), false);
  withTxn(root, () => {}); // any later call recovers
  assert.deepEqual(leftovers(root), []);
  assert.equal(has(root, 'a.txt'), false);
  assert.equal(has(root, 'b.txt'), false);
});

test('killed between renames (journal written): the next call rolls forward to the full state', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'gone.txt'), 'g');
  assert.throws(() => withTxn(root, (tx) => { tx.write('a.txt', '1'); tx.write('b.txt', '2'); tx.write('c.txt', '3'); tx.remove('gone.txt'); },
    { hooks: { afterOp(i) { if (i === 0) throw new Error('killed'); } } }), /killed/);
  const present = ['a.txt', 'b.txt', 'c.txt'].filter((f) => has(root, f)).length;
  assert.equal(present, 1, 'partial state exists on disk right after the kill');
  recoverTxn(root);
  assert.deepEqual(['a.txt', 'b.txt', 'c.txt'].map((f) => rd(root, f)), ['1', '2', '3']);
  assert.equal(has(root, 'gone.txt'), false);
  assert.deepEqual(leftovers(root), []);
  recoverTxn(root); // idempotent
});

test('a recovery on the next withTxn call also runs when the new fn writes', () => {
  const root = tmp();
  assert.throws(() => withTxn(root, (tx) => { tx.write('a.txt', '1'); tx.write('b.txt', '2'); }, { hooks: { afterOp() { throw new Error('killed'); } } }), /killed/);
  withTxn(root, (tx) => { tx.write('z.txt', '9'); });
  assert.equal(rd(root, 'a.txt'), '1'); assert.equal(rd(root, 'b.txt'), '2'); assert.equal(rd(root, 'z.txt'), '9');
});

test('paths that escape the plan directory or touch the staging area are refused', () => {
  const root = tmp();
  for (const bad of ['../x', '/abs', 'a/../../x', '', '.txn/x', 'a\0b']) {
    assert.throws(() => withTxn(root, (tx) => { tx.write(bad, 'x'); }), /path/i, JSON.stringify(bad));
  }
  assert.deepEqual(leftovers(root), []);
});

test('a symlink at the destination is refused and the transaction leaves nothing half done', () => {
  const root = tmp(), out = tmp();
  fs.symlinkSync(path.join(out, 'target'), path.join(root, 'link'));
  assert.throws(() => withTxn(root, (tx) => { tx.write('link', 'x'); }), /symlink/i);
  assert.equal(fs.existsSync(path.join(out, 'target')), false);
});

test('two processes in one clone serialize: no lost update', async () => {
  const root = tmp(), dir = tmp(), script = path.join(dir, 'w.mjs');
  fs.writeFileSync(script, `import fs from 'node:fs';
import { withTxn } from ${JSON.stringify(LIB)};
const [root, n] = process.argv.slice(2);
for (let i = 0; i < Number(n); i++) withTxn(root, (tx) => {
  const f = root + '/counter'; const v = fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8')) : 0;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3);
  tx.write('counter', String(v + 1));
});`);
  const run = promisify(execFile);
  await Promise.all([1, 2, 3, 4].map(() => run(process.execPath, [script, root, '6'])));
  assert.equal(rd(root, 'counter'), '24');
  assert.deepEqual(leftovers(root), []);
});
