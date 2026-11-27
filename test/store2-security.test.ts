// Regression tests for the storage-integrity findings of the independent review (B1, B2, M1, M2, m1, m2, m6 and the hash length).
// Each test reproduces the exploit as it was reported.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { withTxn } from '../lib/store2/txn.ts';

const made: string[] = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (): string => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sec2-'))); made.push(d); return d; };
const git = (cwd: string, ...a: string[]): string => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });

// ---------- B1: a committed journal ----------
function plant(root: string, id: string, journal: unknown, stagedAs?: string): void {
  const dir = path.join(root, '.txn', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'journal.json'), typeof journal === 'string' ? journal : JSON.stringify(journal));
  if (stagedAs) fs.writeFileSync(path.join(dir, stagedAs), 'staged\n');
}
const quarantined = (root: string, id: string): boolean => fs.readdirSync(path.join(root, '.txn')).some((n) => n.startsWith(`${id}.bad`));

test('B1: a journal whose stage escapes the txn directory moves nothing and is quarantined', () => {
  const base = tmp(), root = path.join(base, 'plan');
  fs.mkdirSync(path.join(base, 'secret'), { recursive: true });
  fs.writeFileSync(path.join(base, 'secret', 'key'), 'PRIVATE');
  plant(root, 'evil', { id: 'evil', ops: [{ op: 'write', path: 'stolen.txt', stage: '../../../secret/key' }] });
  withTxn(root, (tx) => { tx.write('ok.txt', 'fine\n'); }); // any later write triggers recovery and must still work
  assert.equal(fs.readFileSync(path.join(base, 'secret', 'key'), 'utf8'), 'PRIVATE', 'the secret file stays where it was');
  assert.equal(fs.existsSync(path.join(root, 'stolen.txt')), false);
  assert.equal(fs.readFileSync(path.join(root, 'ok.txt'), 'utf8'), 'fine\n', 'a bad journal is not a permanent denial of service');
  assert.equal(quarantined(root, 'evil'), true);
  assert.equal(fs.existsSync(path.join(root, '.txn', 'evil')), false);
});

for (const [name, journal] of [
  ['an id that is not the directory name', { id: 'other', ops: [{ op: 'write', path: 'x.txt', stage: 'f0' }] }],
  ['an unknown op', { id: 'bad', ops: [{ op: 'chmod', path: 'x.txt', stage: 'f0' }] }],
  ['an escaping path', { id: 'bad', ops: [{ op: 'write', path: '../x.txt', stage: 'f0' }] }],
  ['a path into the staging area', { id: 'bad', ops: [{ op: 'remove', path: '.txn/lock' }] }],
  ['a stage that is not f<digits>', { id: 'bad', ops: [{ op: 'write', path: 'x.txt', stage: 'journal.json' }] }],
  ['ops that are not a list', { id: 'bad', ops: 'x' }],
  ['text that is not JSON', 'not json'],
] as const) {
  test(`B1: ${name} applies nothing, deletes nothing and is quarantined`, () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, 'keep.txt'), 'keep');
    plant(root, 'bad', journal, 'f0');
    withTxn(root, (tx) => { tx.write('ok.txt', '1'); });
    assert.equal(fs.existsSync(path.join(root, 'x.txt')), false);
    assert.equal(fs.readFileSync(path.join(root, 'keep.txt'), 'utf8'), 'keep');
    assert.equal(fs.existsSync(path.join(root, 'ok.txt')), true);
    assert.equal(quarantined(root, 'bad'), true);
    assert.equal(fs.existsSync(path.join(root, '.txn', 'bad.bad', 'f0')), true, 'the quarantined files are kept for inspection');
  });
}

test('B1: a valid journal is still rolled forward', () => {
  const root = tmp();
  plant(root, 'good', { id: 'good', ops: [{ op: 'write', path: 'a/b.txt', stage: 'f0' }] }, 'f0');
  withTxn(root, () => {});
  assert.equal(fs.readFileSync(path.join(root, 'a', 'b.txt'), 'utf8'), 'staged\n');
});

test('B1: a journal that git tracks is never applied', () => {
  const root = tmp();
  git(root, 'init', '-q');
  plant(root, 'good', { id: 'good', ops: [{ op: 'write', path: 'a.txt', stage: 'f0' }] }, 'f0');
  git(root, 'add', '-f', '.txn/good');
  withTxn(root, (tx) => { tx.write('ok.txt', '1'); });
  assert.equal(fs.existsSync(path.join(root, 'a.txt')), false, 'a tracked journal is hostile data');
  assert.equal(fs.existsSync(path.join(root, 'ok.txt')), true, 'and does not block the writer');
  assert.equal(fs.existsSync(path.join(root, '.txn', 'good', 'journal.json')), true, 'a tracked entry is not deleted either');
});

test('B1: a journal that is a symlink is never read', () => {
  const base = tmp(), root = path.join(base, 'plan');
  fs.mkdirSync(path.join(root, '.txn', 'ln'), { recursive: true });
  fs.writeFileSync(path.join(base, 'j.json'), JSON.stringify({ id: 'ln', ops: [{ op: 'write', path: 'a.txt', stage: 'f0' }] }));
  fs.symlinkSync(path.join(base, 'j.json'), path.join(root, '.txn', 'ln', 'journal.json'));
  fs.writeFileSync(path.join(root, '.txn', 'ln', 'f0'), 'x');
  withTxn(root, () => {});
  assert.equal(fs.existsSync(path.join(root, 'a.txt')), false);
  assert.equal(quarantined(root, 'ln'), true);
});

// ---------- m6: no directory is created outside the root ----------
test('m6: a symlinked directory creates nothing outside the root', () => {
  const base = tmp(), root = path.join(base, 'plan'), out = path.join(base, 'out');
  fs.mkdirSync(root); fs.mkdirSync(out);
  fs.symlinkSync(out, path.join(root, 'nodes'));
  assert.throws(() => withTxn(root, (tx) => { tx.write('nodes/ticket/ab/x.pg', 'x'); }));
  assert.deepEqual(fs.readdirSync(out), [], 'no ticket/ab directory was made through the symlink');
  // the same through a journal that was committed before the symlink appeared
  plant(root, 'late', { id: 'late', ops: [{ op: 'write', path: 'nodes/ticket/ab/y.pg', stage: 'f0' }] }, 'f0');
  assert.throws(() => withTxn(root, () => {}));
  assert.deepEqual(fs.readdirSync(out), []);
});
