// Behavior tests for lib/driver.ts written to kill mutants that survived scripts/mutate-all.ts: each refusal of the data directory
// names its own reason (symlink, not a directory, foreign owner, writable mode in octal, the bin/ label), argument errors name the bad
// argument, an lstat error other than ENOENT propagates unchanged, the win32 branch skips the POSIX checks, and a failed shim write
// leaves no temp file behind and surfaces the original error.
// NOT covered: the shim script itself (test/driver.test.ts); running as root (the ownership and permission cases are skipped).
import baseTest, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureStableDriver } from '../lib/driver.ts';

const posix = process.platform !== 'win32', root0 = typeof process.getuid === 'function' && process.getuid() === 0;
const test = (name: string, fn: () => void) => baseTest(name, { skip: !posix }, fn);
const made: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'drvk-')); made.push(d); return d; };
after(() => { for (const d of made) { try { fs.chmodSync(path.join(d, 'data', 'bin'), 0o700); } catch { /* absent */ } fs.rmSync(d, { recursive: true, force: true }); } });
const target = (dir: string) => { const f = path.join(dir, 't.mjs'); fs.writeFileSync(f, 'console.log(1);\n'); return f; };
const refuses = (fn: () => unknown, re: RegExp) => assert.throws(fn, (e: TypeError) => e instanceof TypeError && re.test(e.message), `expected ${re}`);

test('each refusal names its reason and the directory label', () => {
  const root = tmp(), t = target(root);
  const real = path.join(root, 'real'); fs.mkdirSync(real, { mode: 0o700 });
  const link = path.join(root, 'link'); fs.symlinkSync(real, link);
  refuses(() => ensureStableDriver({ dataDir: link, target: t }), /^data directory is not private: directory is a symlink \(/);
  const file = path.join(root, 'file'); fs.writeFileSync(file, 'x');
  refuses(() => ensureStableDriver({ dataDir: file, target: t }), /^data directory is not private: directory is not a directory \(/);
  const open = path.join(root, 'open'); fs.mkdirSync(open); fs.chmodSync(open, 0o775);
  refuses(() => ensureStableDriver({ dataDir: open, target: t }), /^data directory is not private: directory is group or world writable, mode 775 \(/);
  const withBin = path.join(root, 'wb'); fs.mkdirSync(path.join(withBin, 'bin'), { recursive: true, mode: 0o700 }); fs.chmodSync(withBin, 0o700); fs.chmodSync(path.join(withBin, 'bin'), 0o722);
  refuses(() => ensureStableDriver({ dataDir: withBin, target: t }), /^data directory is not private: bin\/ is group or world writable, mode 722 \(/);
});

baseTest('a directory owned by another user is refused for its owner, before any write', { skip: !posix || root0 || typeof process.getuid !== 'function' }, () => {
  const root = tmp(), t = target(root);
  const foreign = fs.statSync('/usr').uid === (process.getuid as () => number)() ? null : '/usr';
  if (!foreign) return; // only when /usr is not ours (always on a normal machine)
  refuses(() => ensureStableDriver({ dataDir: foreign, target: t }), /^data directory is not private: directory is not owned by the current user \(\/usr\)$/);
});

test('argument errors name the argument', () => {
  const root = tmp(), t = target(root);
  refuses(() => ensureStableDriver({ dataDir: 'rel', target: t }), /^dataDir must be an absolute path$/);
  refuses(() => ensureStableDriver({ dataDir: root, target: 't.mjs' }), /^target must be an absolute path$/);
  refuses(() => ensureStableDriver({ dataDir: root, target: t, nodePath: 'node' }), /^nodePath must be an absolute path$/);
});

test('an lstat failure other than a missing directory propagates with its own code', () => {
  const root = tmp(), t = target(root), file = path.join(root, 'plain'); fs.writeFileSync(file, 'x');
  assert.throws(() => ensureStableDriver({ dataDir: path.join(file, 'sub'), target: t }), (e: NodeJS.ErrnoException) => e.code === 'ENOTDIR');
});

test('win32: the ownership and mode checks are skipped (a group-writable data directory is used as is)', () => {
  const root = tmp(), t = target(root), open = path.join(root, 'open'); fs.mkdirSync(open); fs.chmodSync(open, 0o775);
  const desc = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor; // process.platform is an own property
  Object.defineProperty(process, 'platform', { ...desc, value: 'win32' });
  try { assert.equal(ensureStableDriver({ dataDir: open, target: t }), path.join(open, 'bin', 'brain-merge')); } finally { Object.defineProperty(process, 'platform', desc); }
  assert.equal(fs.statSync(open).mode & 0o777, 0o775, 'never chmodded');
});

baseTest('a failed shim write surfaces the original error and leaves no temp file in bin/', { skip: !posix || root0 }, () => {
  const root = tmp(), t = target(root), dataDir = path.join(root, 'data');
  ensureStableDriver({ dataDir, target: t });
  const bin = path.join(dataDir, 'bin');
  fs.rmSync(path.join(bin, 'brain-merge'));
  fs.chmodSync(bin, 0o500); // still private (no group/world write) but not writable: the temp file cannot be created
  try {
    assert.throws(() => ensureStableDriver({ dataDir, target: t }), (e: NodeJS.ErrnoException) => e.code === 'EACCES');
  } finally { fs.chmodSync(bin, 0o700); }
  assert.deepEqual(fs.readdirSync(bin), []);
  // the rename fails (the destination is a non-empty directory): the temp file is removed and the rename error is thrown
  fs.mkdirSync(path.join(bin, 'brain-merge', 'x'), { recursive: true });
  assert.throws(() => ensureStableDriver({ dataDir, target: t }), (e: NodeJS.ErrnoException) => ['EISDIR', 'ENOTEMPTY', 'EEXIST', 'EPERM'].includes(e.code as string)); // an OS error always carries a code
  assert.deepEqual(fs.readdirSync(bin), ['brain-merge']);
});
