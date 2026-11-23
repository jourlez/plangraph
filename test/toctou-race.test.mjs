// Symlink / TOCTOU races, closed as far as Node allows (docs/CONTRACT.md, "Symlink and swap races"). Each race is made deterministic by an
// injected fsImpl that performs the swap at an exact point (right after the lstat/stat the code checks), and every test asserts that the
// OUTSIDE file is never read and never written. NOT covered (cannot be closed without openat): a swap of an intermediate directory component
// between the realpath walk and the open; Windows (no O_NOFOLLOW: the dev/ino identity check is the guard there, symlinks need privileges).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readCapped, readDataCapped, readJsonl } from '../lib/jsonl.mjs';
import { writeAtomicSafe } from '../lib/fsafe.mjs';
import { readConfig } from '../lib/model.mjs';

const skip = process.platform === 'win32' ? 'symlinks need privileges on Windows' : false;
const made = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
function world() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'race-'))); made.push(root);
  const out = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'race-out-'))); made.push(out);
  fs.mkdirSync(path.join(root, '.brain'));
  const secret = path.join(out, 'secret.jsonl'); fs.writeFileSync(secret, '{"key":"OUTSIDE"}\n');
  const data = path.join(root, '.brain', 'tickets.jsonl'); fs.writeFileSync(data, '{"key":"T-1"}\n');
  return { root, out, secret, data, secretBytes: () => fs.readFileSync(secret, 'utf8') };
}
// fsImpl that runs `swap` once, right after the nth call of `method` on `target` (the real call's result is returned: the check passed)
function hooked(method, target, swap, nth = 1) {
  let n = 0; const reads = [];
  const impl = {
    ...fs,
    [method]: (/** @type {any[]} */ ...a) => { const r = /** @type {any} */ (fs)[method](...a); if (a[0] === target && ++n === nth) swap(); return r; },
    readSync: (/** @type {any[]} */ ...a) => { reads.push(a[0]); return fs.readSync(.../** @type {[any, any, any, any, any]} */ (a)); },
  };
  return { impl, reads };
}

test('read: a data file swapped for a symlink to an outside file right after the lstat is refused, the outside file is never read', { skip }, () => {
  const w = world();
  const { impl, reads } = hooked('lstatSync', w.data, () => { fs.rmSync(w.data); fs.symlinkSync(w.secret, w.data); });
  assert.throws(() => readDataCapped(w.data, 1 << 20, { fsImpl: impl }), (/** @type {any} */ e) => e.code === 'SYMLINK' && e.message === 'is a symlink, not a regular file');
  assert.deepEqual(reads, []);
});

test('read: a data file swapped for another regular file (a copy of an outside file) after the lstat is refused by the dev/ino check', { skip }, () => {
  const w = world();
  const { impl, reads } = hooked('lstatSync', w.data, () => { fs.rmSync(w.data); fs.copyFileSync(w.secret, w.data); });
  assert.throws(() => readDataCapped(w.data, 1 << 20, { fsImpl: impl }), (/** @type {any} */ e) => e.code === 'SWAPPED' && e.message === 'file was replaced while it was opened');
  assert.deepEqual(reads, []);
});

test('read: a symlinked data file is refused before any open (lstat), and O_NOFOLLOW refuses it when the lstat is bypassed', { skip }, () => {
  const w = world(); fs.rmSync(w.data); fs.symlinkSync(w.secret, w.data);
  assert.throws(() => readDataCapped(w.data, 1 << 20), (/** @type {any} */ e) => e.code === 'SYMLINK');
  // an lstat that lies (says regular file): the open itself refuses the symlink (O_NOFOLLOW on macOS and Linux)
  const liar = { ...fs, lstatSync: () => fs.lstatSync(w.secret), readSync: () => { throw new Error('read reached'); } };
  assert.throws(() => readDataCapped(w.data, 1 << 20, { fsImpl: liar }), (/** @type {any} */ e) => e.code === 'SYMLINK');
  assert.throws(() => readJsonl(w.data), /tickets\.jsonl: is a symlink, not a regular file/);
  assert.equal(readCapped(w.secret, 1 << 20), '{"key":"OUTSIDE"}\n'); // the plain reader still follows (user-named input files)
});

test('read: config.json (the one config reader) swapped right after the lstat is refused as a symlink or as SWAPPED, never read', { skip }, () => {
  const w = world(), cfg = path.join(w.root, '.brain', 'config.json'), secret = path.join(w.out, 'secret.json');
  fs.writeFileSync(secret, '{"SECRET":"s3cr3t"}');
  for (const [swap, code, message] of /** @type {Array<[() => void, string, string]>} */ ([
    [() => { fs.rmSync(cfg); fs.symlinkSync(secret, cfg); }, 'SYMLINK', 'config.json: is a symlink'],
    [() => { fs.rmSync(cfg); fs.copyFileSync(secret, cfg); }, 'SWAPPED', 'config.json: file was replaced while it was opened'],
  ])) {
    fs.rmSync(cfg, { force: true }); fs.writeFileSync(cfg, '{"first_sprint":1}');
    const { impl, reads } = hooked('lstatSync', cfg, swap);
    assert.throws(() => readConfig(cfg, { fsImpl: impl }), (/** @type {any} */ e) => e.name === 'IngestError' && e.code === code && e.message === message);
    assert.deepEqual(reads, []);
  }
});

test('write: the destination swapped for a symlink to an outside file right after its first lstat is refused before the rename', { skip }, () => {
  const w = world(); const before = w.secretBytes();
  const { impl } = hooked('lstatSync', w.data, () => { fs.rmSync(w.data); fs.symlinkSync(w.secret, w.data); });
  assert.throws(() => writeAtomicSafe(w.data, 'NEW\n', { root: w.root, fsImpl: impl }), (/** @type {any} */ e) => e.code === 'SYMLINK');
  assert.equal(w.secretBytes(), before);
  assert.deepEqual(fs.readdirSync(path.join(w.root, '.brain')).filter((f) => f.includes('.tmp-')), [], 'the temp file is removed');
});

test('write: a swap right after the pre-rename check is replaced by the rename (never followed): the outside file is unchanged', { skip }, () => {
  const w = world(); const before = w.secretBytes();
  // lstat calls on the destination: 1 the first refusal check, 2 the pre-rename re-check, 3 the post-rename identity check
  const { impl } = hooked('lstatSync', w.data, () => { fs.rmSync(w.data); fs.symlinkSync(w.secret, w.data); }, 2);
  writeAtomicSafe(w.data, 'NEW\n', { root: w.root, fsImpl: impl });
  assert.equal(w.secretBytes(), before);
  assert.equal(fs.lstatSync(w.data).isFile(), true, 'the planted symlink was replaced, not followed');
  assert.equal(fs.readFileSync(w.data, 'utf8'), 'NEW\n');
});

test('write: the parent directory swapped for a symlink to an outside directory after the confinement check is refused', { skip }, () => {
  const w = world(); const dir = path.join(w.root, '.brain');
  const { impl } = hooked('statSync', dir, () => { fs.renameSync(dir, `${dir}.moved`); fs.symlinkSync(w.out, dir); });
  assert.throws(() => writeAtomicSafe(path.join(dir, 'tickets.jsonl'), 'NEW\n', { root: w.root, fsImpl: impl }), (/** @type {any} */ e) => e.code === 'SWAPPED' || e.code === 'OUTSIDE_REPO');
  assert.deepEqual(fs.readdirSync(w.out).sort(), ['secret.jsonl'], 'nothing written in the outside directory');
  assert.equal(w.secretBytes(), '{"key":"OUTSIDE"}\n');
});

test('write: the temp file swapped for a symlink after it was created is detected before the rename (fstat vs lstat identity)', { skip }, () => {
  const w = world(); const before = w.secretBytes(); let tmp = '';
  const impl = { ...fs, fsyncSync: (/** @type {number} */ fd) => {
    fs.fsyncSync(fd);
    if (!tmp) { tmp = fs.readdirSync(path.join(w.root, '.brain')).find((f) => f.includes('.tmp-')) ?? ''; const t = path.join(w.root, '.brain', tmp); fs.rmSync(t); fs.symlinkSync(w.secret, t); }
  } };
  assert.throws(() => writeAtomicSafe(w.data, 'NEW\n', { root: w.root, fsImpl: impl }), (/** @type {any} */ e) => e.code === 'SWAPPED');
  assert.ok(tmp, 'the swap ran');
  assert.equal(w.secretBytes(), before);
  assert.equal(fs.readFileSync(w.data, 'utf8'), '{"key":"T-1"}\n', 'the destination is unchanged');
});

test('write: the temp file is created with O_EXCL|O_NOFOLLOW (a pre-planted symlink at the temp name is never written through)', { skip }, async () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '../lib/fsafe.mjs'), 'utf8');
  assert.match(src, /O_CREAT \| fs\.constants\.O_EXCL \| NOFOLLOW/);
});

test('index: a brain.sqlite symlink is refused on open, and a planted symlink at the build temp name is refused and left alone', { skip }, async () => {
  const { buildIndex, openIndex, INDEX_FILE } = await import('../src/db.mjs');
  const w = world(); const dir = path.join(w.root, '.brain'), file = path.join(dir, INDEX_FILE);
  const target = path.join(w.out, 'planted.sqlite'); const before = w.secretBytes();
  fs.symlinkSync(w.secret, file);
  assert.throws(() => openIndex(file, { dir }), (/** @type {any} */ e) => e.code === 'DATA' && e.message === 'the index is a symlink, not a regular file' && e.hint === 'run `brain build` to rebuild it');
  fs.rmSync(file);
  const tmp = `${file}.tmp-${process.pid}`; fs.symlinkSync(target, tmp);
  assert.throws(() => buildIndex({ dir }), (/** @type {any} */ e) => e.code === 'REFUSED' && e.message === 'refusing to build the index: its temp path already exists and was not created by this build');
  assert.equal(fs.lstatSync(tmp).isSymbolicLink(), true, 'not ours: left in place');
  assert.equal(fs.existsSync(target), false, 'nothing created through the planted symlink');
  fs.rmSync(tmp);
  buildIndex({ dir }); // and a clean build still works
  assert.equal(w.secretBytes(), before);
});
