// Behavior tests for writeAtomicSafe in lib/fsafe.ts, written to kill the mutants of the trust-root run: each swap check (directory before the
// write, directory before the rename, temp file, destination) refuses with SWAPPED and names what changed, a parent that is a file is refused
// with ENOTDIR, and the temp file is opened with O_NOFOLLOW. The swaps are injected through the module's fsImpl seam.
// NOT covered: real races, and the platform without O_NOFOLLOW.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeAtomicSafe } from '../lib/fsafe.ts';

const made: string[] = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fsk-'))); made.push(d); return d; };
const fake = (s: fs.Stats) => Object.assign(Object.create(Object.getPrototypeOf(s)), s, { ino: Number(s.ino) + 12345 }) as fs.Stats;
const swappedErr = (what: string) => (e: Error & { code?: string }) => e.code === 'SWAPPED' && e.message === `refusing to write: ${what} changed while it was being written`;
const leftovers = (d: string) => fs.readdirSync(d).filter((n) => n.includes('.tmp-'));

test('a parent that stats as a file (replaced after the symlink check) is refused with ENOTDIR and nothing is written', () => {
  const d = tmp(), f = path.join(d, 'afile'); fs.writeFileSync(f, 'x');
  const file = path.join(d, 'out.json');
  const fsImpl = { ...fs, statSync: ((p: fs.PathLike, ...r: unknown[]) => (fs.statSync as (...a: unknown[]) => fs.Stats)(p === d ? f : p, ...r)) } as unknown as typeof fs;
  assert.throws(() => writeAtomicSafe(file, 'y', { fsImpl }), (e: Error & { code?: string }) => e.code === 'ENOTDIR' && e.message === 'parent is not a directory');
  assert.equal(fs.existsSync(file), false); assert.deepEqual(leftovers(d), []);
});

test('a directory whose identity changes after the temp file is created is refused, naming the directory, and no temp file is left', () => {
  for (const nth of [2, 3]) { // statSync(dir): 1 = the confirmation, 2 = right after the open, 3 = right before the rename
    const d = tmp(), file = path.join(d, 'out.json');
    let n = 0;
    const fsImpl = { ...fs, statSync: ((p: fs.PathLike, ...r: unknown[]) => { const s = (fs.statSync as (...a: unknown[]) => fs.Stats)(p, ...r); return p === d && ++n === nth ? fake(s) : s; }) } as unknown as typeof fs;
    assert.throws(() => writeAtomicSafe(file, 'data', { fsImpl }), swappedErr('the directory'), `statSync call ${nth}`);
    assert.equal(fs.existsSync(file), false); assert.deepEqual(leftovers(d), []);
  }
});

test('a temp path whose identity differs from the written file is refused, naming the temp file', () => {
  const d = tmp(), file = path.join(d, 'out.json');
  let hit = 0;
  const fsImpl = { ...fs, lstatSync: ((p: fs.PathLike, ...r: unknown[]) => { const s = (fs.lstatSync as (...a: unknown[]) => fs.Stats)(p, ...r); return String(p).includes('.tmp-') && ++hit === 1 ? fake(s) : s; }) } as unknown as typeof fs;
  assert.throws(() => writeAtomicSafe(file, 'data', { fsImpl }), swappedErr('the temp file'));
  assert.equal(fs.existsSync(file), false); assert.deepEqual(leftovers(d), []);
});

test('a destination replaced right after the rename is refused, naming the destination', () => {
  const d = tmp(), file = path.join(d, 'out.json');
  let renamed = false;
  const fsImpl = {
    ...fs,
    renameSync: ((a: fs.PathLike, b: fs.PathLike) => { fs.renameSync(a, b); renamed = true; }),
    lstatSync: ((p: fs.PathLike, ...r: unknown[]) => { const s = (fs.lstatSync as (...a: unknown[]) => fs.Stats)(p, ...r); return renamed && p === file ? fake(s) : s; }),
  } as unknown as typeof fs;
  assert.throws(() => writeAtomicSafe(file, 'data', { fsImpl }), swappedErr('the destination'));
});

test('a destination that becomes a symlink between the first check and the rename is refused (second symlink check)', () => {
  const d = tmp(), file = path.join(d, 'out.json'), elsewhere = path.join(d, 'elsewhere');
  fs.writeFileSync(elsewhere, 'keep');
  let writes = 0;
  const fsImpl = { ...fs, fsyncSync: ((fd: number) => { fs.fsyncSync(fd); if (++writes === 1) fs.symlinkSync(elsewhere, file); }) } as unknown as typeof fs;
  assert.throws(() => writeAtomicSafe(file, 'data', { fsImpl }), (e: Error & { code?: string }) => e.code === 'SYMLINK');
  assert.equal(fs.readFileSync(elsewhere, 'utf8'), 'keep'); assert.deepEqual(leftovers(d), []);
});

test('the temp file is opened exclusively and without following symlinks', { skip: !fs.constants.O_NOFOLLOW }, () => {
  const d = tmp(); let flags = -1;
  const fsImpl = { ...fs, openSync: ((p: fs.PathLike, fl: number, m?: number) => { if (String(p).includes('.tmp-')) flags = fl; return fs.openSync(p, fl, m); }) } as unknown as typeof fs;
  writeAtomicSafe(path.join(d, 'out.json'), 'data', { fsImpl });
  assert.ok(flags & fs.constants.O_NOFOLLOW, 'O_NOFOLLOW');
  assert.ok(flags & fs.constants.O_EXCL, 'O_EXCL');
  assert.ok(flags & fs.constants.O_CREAT, 'O_CREAT');
});
