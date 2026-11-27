// Coverage margin for lib/store2/txn.ts: a destination that turns into a symlink, an unreadable destination, journals that are not what the writer
// makes, the quarantine of a name that is already taken, the lock settings, and the unsynced (durable: false) staging.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withTxn, recoverTxn } from '../lib/store2/txn.ts';

const made: string[] = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'txn-margin-'))); made.push(d); return d; };
const rd = (root: string, rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const names = (root: string) => fs.readdirSync(path.join(root, '.txn')).filter((n) => n !== 'lock').sort();
const code = (c: string) => (e: unknown) => (e as NodeJS.ErrnoException).code === c;
const canLink = (() => { const d = tmp(); try { fs.symlinkSync('x', path.join(d, 'l')); return true; } catch { return false; } })();

test('durable: false writes the same files without syncing each one, and the lock settings may be given', () => {
  const root = tmp();
  withTxn(root, (tx) => { tx.write('a.txt', 'one\n'); tx.write('sub/b.txt', 'two\n'); }, { durable: false, lock: { retries: 5, waitMs: 1 } });
  assert.equal(rd(root, 'a.txt'), 'one\n');
  assert.equal(rd(root, 'sub/b.txt'), 'two\n');
  withTxn(root, (tx) => tx.remove('a.txt'), { lock: {} });
  assert.equal(fs.existsSync(path.join(root, 'a.txt')), false);
  assert.deepEqual(names(root), []);
});

test('recoverTxn of a directory with no staging area does nothing and creates nothing', () => {
  const root = tmp();
  recoverTxn(root);
  assert.equal(fs.existsSync(path.join(root, '.txn')), false);
  recoverTxn(root, { lock: { retries: 3, waitMs: 1 } });
});

test('a destination that is a symlink is refused before staging, and one that becomes a symlink before the apply is refused there', { skip: !canLink }, () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'real.txt'), 'real');
  fs.symlinkSync('real.txt', path.join(root, 'link.txt'));
  assert.throws(() => withTxn(root, (tx) => tx.write('link.txt', 'x')), code('SYMLINK'));
  assert.equal(rd(root, 'real.txt'), 'real');
  assert.deepEqual(names(root), [], 'a refusal before staging removes the staging directory');
  assert.throws(() => withTxn(root, (tx) => tx.write('late.txt', 'x'), { hooks: { beforeApply: () => fs.symlinkSync('real.txt', path.join(root, 'late.txt')) } }), code('SYMLINK'));
  assert.equal(rd(root, 'real.txt'), 'real');
  // the journal is committed: the transaction stays on disk; once the link is gone, recovery rolls it forward
  fs.rmSync(path.join(root, 'late.txt'));
  recoverTxn(root);
  assert.equal(rd(root, 'late.txt'), 'x');
  assert.deepEqual(names(root), []);
});

test('a destination whose parent is a regular file fails with the file system error, not a symlink refusal', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'file.txt'), 'x');
  assert.throws(() => withTxn(root, (tx) => tx.write('file.txt/child.txt', 'y')), (e: unknown) => (e as NodeJS.ErrnoException).code !== 'SYMLINK');
  assert.equal(rd(root, 'file.txt'), 'x');
  assert.deepEqual(names(root), []);
});

test('the beforeApply hook runs once, after the journal exists', () => {
  const root = tmp();
  let seen = 0;
  withTxn(root, (tx) => tx.write('a.txt', '1'), { hooks: { beforeApply: () => { seen++; assert.ok(names(root).length === 1); } } });
  assert.equal(seen, 1);
  assert.equal(rd(root, 'a.txt'), '1');
});

const stageDir = (root: string, id: string, journal: unknown, files: Record<string, string> = {}) => {
  const d = path.join(root, '.txn', id); fs.mkdirSync(d, { recursive: true });
  if (journal !== undefined) fs.writeFileSync(path.join(d, 'journal.json'), typeof journal === 'string' ? journal : JSON.stringify(journal));
  for (const [f, t] of Object.entries(files)) fs.writeFileSync(path.join(d, f), t);
  return d;
};

test('a journal that is not what the writer makes is quarantined, never applied, and the next transaction still works', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, '.txn'), { recursive: true });
  stageDir(root, 'j1', { id: 'j1', ops: [null] }, { f0: 'x' });
  stageDir(root, 'j2', { id: 'other', ops: [] });
  stageDir(root, 'j3', { id: 'j3', ops: 'no' });
  stageDir(root, 'j4', null);
  stageDir(root, 'j5', { id: 'j5', ops: [{ op: 'write', path: '../escape.txt', stage: 'f0' }] }, { f0: 'x' });
  stageDir(root, 'j6', { id: 'j6', ops: [{ op: 'write', path: 'a.txt', stage: '../f0' }] });
  stageDir(root, 'j7', { id: 'j7', ops: [{ op: 'rename', path: 'a.txt' }] });
  stageDir(root, 'j8', 'not json');
  stageDir(root, 'j9', { id: 'j9', ops: [{ op: 'remove', path: '.txn/x' }] });
  withTxn(root, (tx) => tx.write('ok.txt', 'fine'));
  assert.equal(rd(root, 'ok.txt'), 'fine');
  assert.deepEqual(names(root), ['j1.bad', 'j2.bad', 'j3.bad', 'j4.bad', 'j5.bad', 'j6.bad', 'j7.bad', 'j8.bad', 'j9.bad']);
  assert.equal(fs.existsSync(path.join(root, '..', 'escape.txt')), false);
  withTxn(root, (tx) => tx.write('again.txt', 'fine'));
  assert.equal(names(root).length, 9, 'a quarantined directory is left alone');
});

test('a quarantine name that is taken gets a number, a journal missing is rolled back, a valid one is rolled forward, and the lock file is ignored', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, '.txn'), { recursive: true });
  stageDir(root, 'dup.bad', undefined);
  stageDir(root, 'dup.bad.1', undefined);
  stageDir(root, 'dup', 'garbage');
  stageDir(root, 'staged-only', undefined, { f0: 'never committed' });
  stageDir(root, 'forward', { id: 'forward', ops: [{ op: 'write', path: 'deep/new.txt', stage: 'f0' }, { op: 'write', path: 'gone-stage.txt', stage: 'f1' }, { op: 'remove', path: 'old.txt' }] }, { f0: 'from journal' });
  fs.writeFileSync(path.join(root, 'old.txt'), 'old');
  fs.writeFileSync(path.join(root, '.txn', 'stray-file'), 'not a directory');
  recoverTxn(root);
  assert.equal(rd(root, 'deep/new.txt'), 'from journal');
  assert.equal(fs.existsSync(path.join(root, 'old.txt')), false);
  assert.equal(fs.existsSync(path.join(root, 'gone-stage.txt')), false, 'a staged file already moved by an earlier pass is skipped');
  assert.deepEqual(names(root), ['dup.bad', 'dup.bad.1', 'dup.bad.2', 'stray-file']);
});
