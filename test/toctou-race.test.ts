// Symlink / TOCTOU races, closed as far as Node allows (docs/CONTRACT.md, "Symlink and swap races"). Each race is made deterministic by an
// injected fsImpl that performs the swap at an exact point (right after the lstat/stat the code checks), and every test asserts that the
// OUTSIDE file is never read and never written. NOT covered (cannot be closed without openat): a swap of an intermediate directory component
// between the realpath walk and the open; Windows (no O_NOFOLLOW: the dev/ino identity check is the guard there, symlinks need privileges).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readCapped, readDataCapped, readJsonl } from '../lib/jsonl.ts';
import { writeAtomicSafe } from '../lib/fsafe.ts';
import { readConfig } from '../lib/model.ts';
import type { PlangraphError } from '../src/errors.ts';
/** The arguments the fake readSync passes through: whatever the reader called it with. */
type ReadArgs = [number, NodeJS.ArrayBufferView, number, number, fs.ReadPosition | null];

const skip = process.platform === 'win32' ? 'symlinks need privileges on Windows' : false;
const made: string[] = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
function world() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'race-'))); made.push(root);
  const out = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'race-out-'))); made.push(out);
  fs.mkdirSync(path.join(root, '.plangraph'));
  const secret = path.join(out, 'secret.jsonl'); fs.writeFileSync(secret, '{"key":"OUTSIDE"}\n');
  const data = path.join(root, '.plangraph', 'tickets.jsonl'); fs.writeFileSync(data, '{"key":"T-1"}\n');
  return { root, out, secret, data, secretBytes: () => fs.readFileSync(secret, 'utf8') };
}
// fsImpl that runs `swap` once, right after the nth call of `method` on `target` (the real call's result is returned: the check passed)
function hooked(method: 'lstatSync' | 'statSync' | 'fstatSync' | 'openSync', target: string, swap: () => void, nth = 1) {
  let n = 0; const reads: unknown[] = [];
  const impl = {
    ...fs,
    [method]: (...a: unknown[]) => { const r = (fs[method] as (...x: unknown[]) => unknown)(...a); if (a[0] === target && ++n === nth) swap(); return r; }, // the real fs method, called on fs
    readSync: (...a: unknown[]) => { reads.push(a[0]); return fs.readSync(...(a as ReadArgs)); }, // the caller's own arguments, passed through
  };
  return { impl, reads };
}

test('read: a data file swapped for a symlink to an outside file right after the lstat is refused, the outside file is never read', { skip }, () => {
  const w = world();
  const { impl, reads } = hooked('lstatSync', w.data, () => { fs.rmSync(w.data); fs.symlinkSync(w.secret, w.data); });
  assert.throws(() => readDataCapped(w.data, 1 << 20, { fsImpl: impl }), (e: NodeJS.ErrnoException) => e.code === 'SYMLINK' && e.message === 'is a symlink, not a regular file');
  assert.deepEqual(reads, []);
});

// The replacement is created while the original still exists (written beside it, then renamed over it, or a hard link to the live outside
// file), so its inode number necessarily differs from the original's on every filesystem: the dev/ino check is a guarantee here.
const SWAPS = ([
  ['a copy of an outside file renamed over it', (_w, target, src) => { fs.copyFileSync(src, `${target}.new`); fs.renameSync(`${target}.new`, target); }],
  ['a hard link to the outside file', (_w, target, src) => { fs.rmSync(target); fs.linkSync(src, target); }],
] as Array<[string, (w: ReturnType<typeof world>, target: string, src: string) => void]>); // a literal list of these tuples
for (const [what, swap] of SWAPS) {
  test(`read: a data file swapped for another regular file (${what}) after the lstat is refused by the dev/ino check`, { skip }, () => {
    const w = world();
    const { impl, reads } = hooked('lstatSync', w.data, () => swap(w, w.data, w.secret));
    assert.throws(() => readDataCapped(w.data, 1 << 20, { fsImpl: impl }), (e: NodeJS.ErrnoException) => e.code === 'SWAPPED' && e.message === 'file was replaced while it was opened');
    assert.deepEqual(reads, []);
  });
}

// Delete-then-create: the original is removed first, so its inode number is free, and ext4 (and overlayfs on it, the Linux CI runner and
// Docker) hands the same number to the very next file created in that directory: dev/ino alone cannot see this swap there (APFS and tmpfs
// do not reuse a number at once, so the dev/ino check catches it on macOS). The reader also compares the change time (ctime, which no
// unprivileged process can set): a recreated file has a new ctime unless it was created within the timestamp granularity of the original's
// last change (a jiffy, at most 10 ms, on kernels with coarse timestamps). Here the original is 50 ms old when it is swapped, so the ctime
// comparison is the guard wherever dev/ino is not; the inode outcome is reported as a diagnostic, never assumed.
test('read: delete-then-create (the inode number may be reused) is refused as SWAPPED by the ctime comparison; the outcome is reported', { skip }, (t) => {
  const w = world();
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); // the original's ctime is now older than any timestamp granularity
  let pre: fs.Stats | null = null, post: fs.Stats | null = null;
  const { impl, reads } = hooked('lstatSync', w.data, () => { pre = fs.lstatSync(w.data); fs.rmSync(w.data); fs.copyFileSync(w.secret, w.data); post = fs.lstatSync(w.data); });
  assert.throws(() => readDataCapped(w.data, 1 << 20, { fsImpl: impl }), (e: NodeJS.ErrnoException) => e.code === 'SWAPPED' && e.message === 'file was replaced while it was opened');
  assert.deepEqual(reads, []);
  const a = (pre as unknown as fs.Stats), b = (post as unknown as fs.Stats); // set by the hook, which ran (the throws above)
  t.diagnostic(`inode number reused: ${a.dev === b.dev && a.ino === b.ino} (${process.platform}); ctime differs: ${a.ctimeMs !== b.ctimeMs}`);
});

// The same swap made deterministic on every filesystem: the lstat reports the very dev/ino the fstat will (as an inode reuse does).
test('read: an lstat and fstat with the same dev/ino but a different ctime are refused (SWAPPED); identical identity reads (the documented limit)', { skip }, () => {
  const w = world();
  for (const [shift, refused] of ([[-5, true], [0, false]] as Array<[number, boolean]>)) { // a literal list of these tuples
    const reads: unknown[] = [];
    const impl = {
      ...fs,
      lstatSync: (p: fs.PathLike) => { const s = fs.lstatSync(p); return Object.assign(Object.create(Object.getPrototypeOf(s)), s, { ctimeMs: s.ctimeMs + shift }); },
      readSync: (...a: unknown[]) => { reads.push(a[0]); return fs.readSync(...(a as ReadArgs)); }, // the caller's own arguments, passed through
    };
    if (refused) {
      assert.throws(() => readDataCapped(w.data, 1 << 20, { fsImpl: impl }), (e: NodeJS.ErrnoException) => e.code === 'SWAPPED');
      assert.deepEqual(reads, []);
    } else assert.equal(readDataCapped(w.data, 1 << 20, { fsImpl: impl }), '{"key":"T-1"}\n'); // same dev, ino and ctime: indistinguishable
  }
});

test('read: a symlinked data file is refused before any open (lstat), and O_NOFOLLOW refuses it when the lstat is bypassed', { skip }, () => {
  const w = world(); fs.rmSync(w.data); fs.symlinkSync(w.secret, w.data);
  assert.throws(() => readDataCapped(w.data, 1 << 20), (e: NodeJS.ErrnoException) => e.code === 'SYMLINK');
  // an lstat that lies (says regular file): the open itself refuses the symlink (O_NOFOLLOW on macOS and Linux)
  const liar = { ...fs, lstatSync: () => fs.lstatSync(w.secret), readSync: () => { throw new Error('read reached'); } };
  assert.throws(() => readDataCapped(w.data, 1 << 20, { fsImpl: liar as unknown as typeof fs /* a partial fs double that only lies about lstat and read */ }), (e: NodeJS.ErrnoException) => e.code === 'SYMLINK');
  assert.throws(() => readJsonl(w.data), /tickets\.jsonl: is a symlink, not a regular file/);
  assert.equal(readCapped(w.secret, 1 << 20), '{"key":"OUTSIDE"}\n'); // the plain reader still follows (user-named input files)
});

test('read: config.json (the one config reader) swapped right after the lstat is refused as a symlink or as SWAPPED, never read', { skip }, () => {
  const w = world(), cfg = path.join(w.root, '.plangraph', 'config.json'), secret = path.join(w.out, 'secret.json');
  fs.writeFileSync(secret, '{"SECRET":"s3cr3t"}');
  for (const [swap, code, message] of ([
    [() => { fs.rmSync(cfg); fs.symlinkSync(secret, cfg); }, 'SYMLINK', 'config.json: is a symlink'],
    // created beside the original, then renamed over it: a different inode on every filesystem (see SWAPS above)
    [() => { fs.copyFileSync(secret, `${cfg}.new`); fs.renameSync(`${cfg}.new`, cfg); }, 'SWAPPED', 'config.json: file was replaced while it was opened'],
    [() => { fs.rmSync(cfg); fs.linkSync(secret, cfg); }, 'SWAPPED', 'config.json: file was replaced while it was opened'],
  ] as Array<[() => void, string, string]>)) { // a literal list of these tuples
    fs.rmSync(cfg, { force: true }); fs.writeFileSync(cfg, '{"first_sprint":1}');
    const { impl, reads } = hooked('lstatSync', cfg, swap);
    assert.throws(() => readConfig(cfg, { fsImpl: impl }), (e: NodeJS.ErrnoException) => e.name === 'IngestError' && e.code === code && e.message === message);
    assert.deepEqual(reads, []);
  }
});

test('write: the destination swapped for a symlink to an outside file right after its first lstat is refused before the rename', { skip }, () => {
  const w = world(); const before = w.secretBytes();
  const { impl } = hooked('lstatSync', w.data, () => { fs.rmSync(w.data); fs.symlinkSync(w.secret, w.data); });
  assert.throws(() => writeAtomicSafe(w.data, 'NEW\n', { root: w.root, fsImpl: impl }), (e: NodeJS.ErrnoException) => e.code === 'SYMLINK');
  assert.equal(w.secretBytes(), before);
  assert.deepEqual(fs.readdirSync(path.join(w.root, '.plangraph')).filter((f) => f.includes('.tmp-')), [], 'the temp file is removed');
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
  const w = world(); const dir = path.join(w.root, '.plangraph');
  const { impl } = hooked('statSync', dir, () => { fs.renameSync(dir, `${dir}.moved`); fs.symlinkSync(w.out, dir); });
  assert.throws(() => writeAtomicSafe(path.join(dir, 'tickets.jsonl'), 'NEW\n', { root: w.root, fsImpl: impl }), (e: NodeJS.ErrnoException) => e.code === 'SWAPPED' || e.code === 'OUTSIDE_REPO');
  assert.deepEqual(fs.readdirSync(w.out).sort(), ['secret.jsonl'], 'nothing written in the outside directory');
  assert.equal(w.secretBytes(), '{"key":"OUTSIDE"}\n');
});

test('write: the temp file swapped for a symlink after it was created is detected before the rename (fstat vs lstat identity)', { skip }, () => {
  const w = world(); const before = w.secretBytes(); let tmp = '';
  const impl = { ...fs, fsyncSync: (fd: number) => {
    fs.fsyncSync(fd);
    if (!tmp) { tmp = fs.readdirSync(path.join(w.root, '.plangraph')).find((f) => f.includes('.tmp-')) ?? ''; const t = path.join(w.root, '.plangraph', tmp); fs.rmSync(t); fs.symlinkSync(w.secret, t); }
  } };
  assert.throws(() => writeAtomicSafe(w.data, 'NEW\n', { root: w.root, fsImpl: impl }), (e: NodeJS.ErrnoException) => e.code === 'SWAPPED');
  assert.ok(tmp, 'the swap ran');
  assert.equal(w.secretBytes(), before);
  assert.equal(fs.readFileSync(w.data, 'utf8'), '{"key":"T-1"}\n', 'the destination is unchanged');
});

test('write: the temp file is created with O_EXCL|O_NOFOLLOW (a pre-planted symlink at the temp name is never written through)', { skip }, async () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '../lib/fsafe.ts'), 'utf8');
  assert.match(src, /O_CREAT \| fs\.constants\.O_EXCL \| NOFOLLOW/);
});

test('index: a plangraph.sqlite symlink is refused on open, and a planted symlink at the build temp name is refused and left alone', { skip }, async () => {
  const { buildIndex, openIndex, INDEX_FILE } = await import('../src/db.ts');
  const w = world(); const dir = path.join(w.root, '.plangraph'), file = path.join(dir, INDEX_FILE);
  const target = path.join(w.out, 'planted.sqlite'); const before = w.secretBytes();
  fs.symlinkSync(w.secret, file);
  assert.throws(() => openIndex(file, { dir }), (e: PlangraphError) => e.code === 'DATA' && e.message === 'the index is a symlink, not a regular file' && e.hint === 'run `plangraph build` to rebuild it');
  fs.rmSync(file);
  const tmp = `${file}.tmp-${process.pid}`; fs.symlinkSync(target, tmp);
  assert.throws(() => buildIndex({ dir }), (e: PlangraphError) => e.code === 'REFUSED' && e.message === 'refusing to build the index: its temp path already exists and was not created by this build');
  assert.equal(fs.lstatSync(tmp).isSymbolicLink(), true, 'not ours: left in place');
  assert.equal(fs.existsSync(target), false, 'nothing created through the planted symlink');
  fs.rmSync(tmp);
  buildIndex({ dir }); // and a clean build still works
  assert.equal(w.secretBytes(), before);
});

test('index: the build temp file deleted and recreated after SQLite closed it is refused before the rename (the build holds its fd, so the inode number cannot be reused)', { skip }, async () => {
  const { buildIndex, INDEX_FILE } = await import('../src/db.ts');
  const w = world(); const dir = path.join(w.root, '.plangraph'), file = path.join(dir, INDEX_FILE), tmp = `${file}.tmp-${process.pid}`;
  const mfs = (fs as unknown as Record<string, unknown>), real = { lstatSync: fs.lstatSync, openSync: fs.openSync, closeSync: fs.closeSync }; // src/db.ts calls node:fs directly
  let swapped = false, tfd = -1, heldAtCheck = false, closed = false;
  // which descriptor the build opens on its temp path, and whether it is still open at the identity check (whatever the filesystem does
  // with inode numbers: APFS and tmpfs never reuse one at once, so only this makes the guarantee testable everywhere)
  mfs.openSync = (...a: unknown[]) => { const fd = real.openSync(...(a as Parameters<typeof fs.openSync>)); if (a[0] === tmp) tfd = fd; return fd; };
  mfs.closeSync = (fd: number) => { if (fd === tfd) closed = true; return real.closeSync(fd); };
  // the first lstat of the temp path is the identity check right before the rename: swap it there (delete, then create a planted file)
  mfs.lstatSync = (...a: unknown[]) => {
    if (a[0] === tmp && !swapped) { swapped = true; heldAtCheck = tfd >= 0 && !closed; fs.rmSync(tmp); fs.writeFileSync(tmp, 'PLANTED'); }
    return real.lstatSync(...(a as [fs.PathLike])); // the caller's own arguments, passed through
  };
  try {
    assert.throws(() => buildIndex({ dir }), (e: PlangraphError) => e.code === 'REFUSED' && e.message === 'refusing to build the index: its temp file was replaced during the build');
  } finally { Object.assign(mfs, real); }
  assert.ok(swapped, 'the swap ran');
  assert.ok(heldAtCheck, 'the temp file descriptor is still open at the identity check');
  assert.ok(closed, 'and closed afterwards (no descriptor leak)');
  assert.equal(fs.existsSync(file), false, 'the planted file never becomes the index');
  assert.equal(fs.readFileSync(tmp, 'utf8'), 'PLANTED', 'not ours: left in place'); fs.rmSync(tmp);
});

// docs/CONTRACT.md states exactly this: a REGULAR file at the build's own temp name (`plangraph.sqlite.tmp-<this pid>`) is a leftover of a
// crashed build (a build runs synchronously, so no live build of this process owns it) and removeStaleTemps unlinks that name (a hard link
// to an outside file loses only the link); a symlink or other non-file there is refused (exit 4) and left alone; a file that appears at the
// name after that clean-up, right before the build's O_CREAT|O_EXCL|O_NOFOLLOW open, is refused and left alone too.
test('index: the temp-name rules are what docs/CONTRACT.md says (own-pid regular file removed as a leftover, symlink or late file refused and kept)', { skip }, async () => {
  const { buildIndex, INDEX_FILE } = await import('../src/db.ts');
  const w = world(); const dir = path.join(w.root, '.plangraph'), file = path.join(dir, INDEX_FILE), tmp = `${file}.tmp-${process.pid}`;
  const before = w.secretBytes();
  fs.linkSync(w.secret, tmp); // a regular file (hard link to an outside file) at our own temp name: a leftover, unlinked, the outside file kept
  buildIndex({ dir });
  assert.equal(fs.existsSync(tmp), false); assert.equal(w.secretBytes(), before); assert.equal(fs.statSync(w.secret).nlink, 1);
  fs.symlinkSync(w.secret, tmp);
  assert.throws(() => buildIndex({ dir }), (e: PlangraphError) => e.code === 'REFUSED' && e.message === 'refusing to build the index: its temp path already exists and was not created by this build');
  assert.equal(fs.lstatSync(tmp).isSymbolicLink(), true); fs.rmSync(tmp);
  const mfs = (fs as unknown as Record<string, unknown>), real = fs.openSync; let planted = false; // node:fs patched for the test (src/db.ts calls it directly)
  mfs.openSync = (...a: unknown[]) => { if (a[0] === tmp && !planted) { planted = true; fs.writeFileSync(tmp, 'LATE'); } return real(...(a as Parameters<typeof fs.openSync>)); }; // the caller's own arguments, passed through
  try {
    assert.throws(() => buildIndex({ dir }), (e: PlangraphError) => e.code === 'REFUSED' && e.message === 'refusing to build the index: its temp path already exists and was not created by this build');
  } finally { mfs.openSync = real; }
  assert.ok(planted); assert.equal(fs.readFileSync(tmp, 'utf8'), 'LATE', 'not ours: left in place'); fs.rmSync(tmp);
  assert.equal(w.secretBytes(), before);
  const doc = fs.readFileSync(path.join(import.meta.dirname, '../docs/CONTRACT.md'), 'utf8').replace(/\s+/g, ' ');
  assert.ok(!doc.includes('refuses (exit 4, nothing removed) a file or symlink already at that predictable name'), 'CONTRACT.md must not claim a regular file at the temp name is refused');
  assert.ok(doc.includes('A regular file already at that predictable name with this process\'s pid (or a dead pid, or older than 10 minutes) is a leftover of a crashed build and is removed first'), 'CONTRACT.md states the leftover rule');
});
