// Behavior tests for lib/fsafe.ts written to kill mutants that survived scripts/mutate-all.ts: exact messages and codes, the lexical
// escape check when the repository root is itself reached through a symlink (the case where it is not redundant with assertInside),
// absolute directories inside the root, error codes other than ENOENT/ENOTDIR propagating unchanged, a symlink into a file being
// dangling, the durability contract (file fsync plus directory fsync, the directory step skipped on win32 and tolerant of EINVAL and
// ENOTSUP only), and a failed temp-file creation surfacing its own error.
// NOT covered: crash consistency (power loss between fsync and rename); running as root (the permission cases are skipped).
import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertInside, resolveBrainDir, writeAtomicSafe } from '../lib/fsafe.ts';

const root0 = typeof process.getuid === 'function' && process.getuid() === 0, posix = process.platform !== 'win32';
const made: string[] = [];
const tmp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fsafe-k-'))); made.push(d); return d; };
const locked: string[] = [];
after(() => { for (const d of locked) fs.chmodSync(d, 0o700); for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const fails = (fn: () => unknown, code: string, message?: string) => assert.throws(fn, (e: NodeJS.ErrnoException) => e.code === code && (message === undefined || e.message === message), `${code} ${message ?? ''}`);
const BAD_NAME = 'brain directory name has a character that is not allowed (whitespace, control characters and * ? [ ] \\ ! # " are refused)';

test('resolveBrainDir: exact code and message for a bad name, and for an escape (excerpt of 80 characters)', () => {
  const root = tmp();
  fails(() => resolveBrainDir(root, 'a b'), 'BAD_DIR_NAME', BAD_NAME);
  fails(() => resolveBrainDir(root, '../x'), 'OUTSIDE_REPO', 'brain directory is outside the repository: ../x');
  const long = `../${'y'.repeat(120)}`;
  fails(() => resolveBrainDir(root, long), 'OUTSIDE_REPO', `brain directory is outside the repository: ${long.slice(0, 80)}`);
});

test('resolveBrainDir: an absolute directory is refused even when it lies inside the root', () => {
  const root = tmp();
  fails(() => resolveBrainDir(root, path.join(root, 'b')), 'OUTSIDE_REPO', `brain directory is outside the repository: ${path.join(root, 'b').slice(0, 80)}`);
});

test('resolveBrainDir: a lexical escape is refused even when the real path lands back inside a symlinked root', () => {
  const base = tmp(), real = path.join(base, 'real'), inner = path.join(real, 'inner');
  fs.mkdirSync(inner, { recursive: true });
  const viaLink = path.join(base, 'link'); fs.symlinkSync(real, viaLink); // root /base/link -> /base/real
  fails(() => resolveBrainDir(viaLink, '../real/x'), 'OUTSIDE_REPO', 'brain directory is outside the repository: ../real/x');
  const selfLink = path.join(inner, 'self'); fs.symlinkSync(inner, selfLink); // root /base/real/inner/self -> /base/real/inner
  fails(() => resolveBrainDir(selfLink, '..'), 'OUTSIDE_REPO', 'brain directory is outside the repository: ..');
});

test('resolveBrainDir: a symlink escape is reported with the brain-directory message, other errors pass through', () => {
  const root = tmp(), out = tmp();
  fs.symlinkSync(out, path.join(root, 'lnk'));
  fails(() => resolveBrainDir(root, 'lnk'), 'OUTSIDE_REPO', 'brain directory is outside the repository: lnk');
  fs.symlinkSync(path.join(root, 'nowhere'), path.join(root, 'dead'));
  fails(() => resolveBrainDir(root, 'dead/x'), 'OUTSIDE_REPO', 'brain directory is outside the repository: dead/x');
});

test('assertInside: excerpt of 80 characters, ENOTDIR ends the walk, a symlink into a file is dangling', () => {
  const root = tmp(), out = tmp();
  const rel = path.relative(root, path.join(out, 'z'.repeat(120)));
  fails(() => assertInside(root, path.join(out, 'z'.repeat(120))), 'OUTSIDE_REPO', `path is outside the repository: ${rel.slice(0, 80)}`);
  fs.writeFileSync(path.join(root, 'file'), 'x');
  assert.equal(assertInside(root, path.join(root, 'file', 'sub')), path.join(root, 'file', 'sub'));
  fs.symlinkSync(path.join(root, 'file', 'sub'), path.join(root, 'tofile'));
  fails(() => assertInside(root, path.join(root, 'tofile', 'x')), 'OUTSIDE_REPO', 'path contains a dangling symlink');
});

test('assertInside and resolveBrainDir: a permission error is not swallowed', { skip: !posix || root0 }, () => {
  const root = tmp(), shut = path.join(root, 'shut'); fs.mkdirSync(path.join(shut, 'in'), { recursive: true });
  fs.symlinkSync(path.join(shut, 'in'), path.join(root, 'via'));
  fs.chmodSync(shut, 0o000); locked.push(shut);
  fails(() => assertInside(root, path.join(shut, 'in', 'x')), 'EACCES');
  fails(() => resolveBrainDir(root, 'shut/in'), 'EACCES');
  fails(() => assertInside(root, path.join(root, 'via', 'x')), 'EACCES');
  fs.chmodSync(shut, 0o700); locked.pop();
});

test('writeAtomicSafe: fsyncs the file and then its directory; win32 skips the directory step', (t) => {
  const root = tmp(), f = path.join(root, 'a.txt');
  const sync = t.mock.method(fs, 'fsyncSync');
  writeAtomicSafe(f, 'x');
  assert.equal(sync.mock.callCount(), 2, 'file fsync plus directory fsync');
  assert.equal(fs.readFileSync(f, 'utf8'), 'x');
  const desc = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor; // process.platform is an own property
  Object.defineProperty(process, 'platform', { ...desc, value: 'win32' });
  try { writeAtomicSafe(f, 'y'); } finally { Object.defineProperty(process, 'platform', desc); }
  assert.equal(sync.mock.callCount(), 3, 'on win32 only the file is fsynced');
});

test('writeAtomicSafe: a directory fsync failing with EINVAL or ENOTSUP is tolerated, any other error is thrown; the fd is closed', (t) => {
  const root = tmp(), f = path.join(root, 'b.txt'), real = fs.fsyncSync;
  for (const [code, ok] of ([['EINVAL', true], ['ENOTSUP', true], ['EIO', false]] as Array<[string, boolean]>)) { // tuples, not (string | boolean)[]
    let n = 0;
    const sync = t.mock.method(fs, 'fsyncSync', (fd: number) => { if (++n === 2) throw Object.assign(new Error(code), { code }); return real(fd); });
    const close = t.mock.method(fs, 'closeSync');
    if (ok) writeAtomicSafe(f, code); else fails(() => writeAtomicSafe(f, code), code);
    assert.equal(close.mock.callCount(), 2, `${code}: the temp fd and the directory fd are both closed`);
    assert.equal(fs.readFileSync(f, 'utf8'), code, 'the rename already happened');
    sync.mock.restore(); close.mock.restore();
  }
  const realOpen = fs.openSync;
  const open = t.mock.method(fs, 'openSync', (...a: unknown[]) => { if (a[1] === 'r') throw Object.assign(new Error('ENOTSUP'), { code: 'ENOTSUP' }); return Reflect.apply(realOpen, fs, a); });
  const close = t.mock.method(fs, 'closeSync');
  writeAtomicSafe(f, 'z');
  assert.equal(close.mock.callCount(), 1, 'no directory fd to close when it never opened');
  open.mock.restore(); close.mock.restore();
  mock.restoreAll();
});

test('writeAtomicSafe: a temp file that cannot be created surfaces its own error and leaves nothing', { skip: !posix || root0 }, () => {
  const root = tmp(), dir = path.join(root, 'ro'); fs.mkdirSync(dir); fs.chmodSync(dir, 0o500); locked.push(dir);
  fails(() => writeAtomicSafe(path.join(dir, 'c.txt'), 'x'), 'EACCES');
  fs.chmodSync(dir, 0o700); locked.pop();
  assert.deepEqual(fs.readdirSync(dir), []);
});
