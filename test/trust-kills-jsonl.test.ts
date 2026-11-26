// Read refusals of lib/jsonl.ts (readJsonl): each refusal code of the data-file reader that names the file is turned into a data error carrying
// the file's base name and the reader's reason. The races are injected by replacing methods of the node:fs object the module reads.
// NOT covered: the reader itself (test/jsonl-read.test.ts, test/fsafe.test.ts).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJsonl, DATA_REFUSALS, parseJsonl, readCapped, readStreamCapped } from '../lib/jsonl.ts';

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jsonlk-')));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const file = path.join(dir, 'x.jsonl');
fs.writeFileSync(file, '{"a":1}\n');

test('the refusal codes that name the file', () => {
  assert.deepEqual([...DATA_REFUSALS].sort(), ['NOT_A_FILE', 'SWAPPED', 'SYMLINK', 'TOO_LARGE']);
});

test('a data file swapped between the check and the open is refused as a data error naming the file', (t) => {
  assert.deepEqual(readJsonl(file), [{ a: 1 }]);
  const real = fs.fstatSync;
  t.mock.method(fs, 'fstatSync', (...a: unknown[]) => { const s = (real as (...x: unknown[]) => fs.Stats)(...a); return Object.assign(Object.create(Object.getPrototypeOf(s)), s, { ino: Number(s.ino) + 1 }); });
  assert.throws(() => readJsonl(file), (e: Error) => e.name === 'IngestError' && e.message === 'x.jsonl: file was replaced while it was opened');
});

test('a symlink swapped in after the check (the open fails with ELOOP) is refused as a data error naming the file', (t) => {
  const real = fs.openSync;
  t.mock.method(fs, 'openSync', (p: fs.PathLike, ...r: unknown[]) => { if (p === file) throw Object.assign(new Error('ELOOP'), { code: 'ELOOP' }); return (real as (...x: unknown[]) => number)(p, ...r); });
  assert.throws(() => readJsonl(file), (e: Error) => e.name === 'IngestError' && e.message === 'x.jsonl: is a symlink, not a regular file');
});

test('a file over the cap and a directory are data errors too; any other failure is not rewritten', () => {
  assert.throws(() => readJsonl(file, { maxBytes: 3 }), (e: Error) => e.name === 'IngestError' && e.message === 'x.jsonl: file too large (limit 3 bytes)');
  const d = path.join(dir, 'd.jsonl'); fs.mkdirSync(d);
  assert.throws(() => readJsonl(d), (e: Error) => e.name === 'IngestError' && e.message === 'd.jsonl: not a regular file');
});


const wrapFs = (over: Record<string, unknown>) => ({ ...fs, ...over }) as unknown as typeof fs;
const withStat = (s: fs.Stats, patch: Record<string, unknown>) => Object.assign(Object.create(Object.getPrototypeOf(s)), s, patch) as fs.Stats;

test('parseJsonl visits each line once: a counted loop, no clock', (t) => {
  const src = '{"a":1}\n{"a":2}\n{"a":3}';
  const real = String.prototype.indexOf;
  let calls = 0;
  t.mock.method(String.prototype, 'indexOf', function (this: string, ...a: [string, number?]) { if (String(this) === src && ++calls > 20) throw new Error('runaway line loop'); return real.apply(this, a); });
  assert.deepEqual(parseJsonl(src), [{ a: 1 }, { a: 2 }, { a: 3 }]);
  assert.ok(calls <= 5, `${calls} line searches for 3 lines`);
});

test('readStreamCapped gives up on a reader that never has data once the idle limit is passed (a counted loop)', () => {
  let reads = 0;
  const fsImpl = wrapFs({ readSync: () => { if (++reads > 5) throw new Error('runaway wait loop'); throw Object.assign(new Error('again'), { code: 'EAGAIN' }); } });
  assert.throws(() => readStreamCapped(0, 100, { timeoutMs: -1, fsImpl }), (e: Error & { code?: string }) => e.code === 'TIMEOUT' && e.message === 'timed out');
  assert.equal(reads, 1);
});

test('readCapped with follow: false refuses a symlink by its own lstat, even when the open would follow it', () => {
  const target = path.join(dir, 'target.jsonl'); fs.writeFileSync(target, 'secret\n');
  const link = path.join(dir, 'link.jsonl'); fs.symlinkSync(target, link);
  const noNofollow = wrapFs({ openSync: (p: string, flags: number, ...r: unknown[]) => fs.openSync(p, flags & ~(fs.constants.O_NOFOLLOW || 0), ...(r as [])) });
  assert.throws(() => readCapped(link, 100, { follow: false, fsImpl: noNofollow }), (e: Error & { code?: string }) => e.code === 'SYMLINK' && e.message === 'is a symlink, not a regular file');
  assert.throws(() => readCapped(link, 100, { follow: false }), (e: Error & { code?: string }) => e.code === 'SYMLINK' && e.message === 'is a symlink, not a regular file');
  assert.equal(readCapped(link, 100, { follow: true }), 'secret\n');
});

test('readCapped opens non-blocking, and without following links only for data files', { skip: !fs.constants.O_NOFOLLOW }, () => {
  const seen: number[] = [];
  const spy = wrapFs({ openSync: (p: string, flags: number, ...r: unknown[]) => { seen.push(flags); return fs.openSync(p, flags, ...(r as [])); } });
  readCapped(file, 100, { fsImpl: spy }); readCapped(file, 100, { follow: false, fsImpl: spy });
  assert.ok(seen[0] !== undefined && seen[1] !== undefined);
  assert.ok((seen[0] as number) & fs.constants.O_NONBLOCK); assert.ok((seen[1] as number) & fs.constants.O_NONBLOCK);
  assert.equal((seen[0] as number) & fs.constants.O_NOFOLLOW, 0); assert.ok((seen[1] as number) & fs.constants.O_NOFOLLOW);
});

test('an open that fails with ELOOP or EMLINK is a symlink refusal for data files; other failures and followed files pass through', () => {
  for (const code of ['ELOOP', 'EMLINK']) {
    const fsImpl = wrapFs({ openSync: () => { throw Object.assign(new Error(code), { code }); } });
    assert.throws(() => readCapped(file, 100, { follow: false, fsImpl }), (e: Error & { code?: string }) => e.code === 'SYMLINK' && e.message === 'is a symlink, not a regular file', code);
    assert.throws(() => readCapped(file, 100, { follow: true, fsImpl }), (e: Error & { code?: string }) => e.code === code, `${code} with follow`);
  }
  const eacces = wrapFs({ openSync: () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); } });
  assert.throws(() => readCapped(file, 100, { follow: false, fsImpl: eacces }), (e: Error & { code?: string }) => e.code === 'EACCES');
});

test('a data file is SWAPPED when its device, inode or change time differs from the lstat, each on its own', () => {
  assert.equal(readCapped(file, 100, { follow: false }), '{"a":1}\n');
  for (const patch of [{ dev: 1 + Number(fs.statSync(file).dev) }, { ino: 1 + Number(fs.statSync(file).ino) }, { ctimeMs: 1000 + fs.statSync(file).ctimeMs }]) {
    const fsImpl = wrapFs({ fstatSync: (fd: number) => withStat(fs.fstatSync(fd), patch) });
    assert.throws(() => readCapped(file, 100, { follow: false, fsImpl }), (e: Error & { code?: string }) => e.code === 'SWAPPED' && e.message === 'file was replaced while it was opened', JSON.stringify(patch));
    assert.equal(readCapped(file, 100, { follow: true, fsImpl }), '{"a":1}\n', 'a followed file is not compared with an lstat');
  }
});
