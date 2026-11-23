// Behavior tests for lib/jsonl.ts written to kill mutants that survived scripts/mutate-all.ts: IngestError defaults, the default name
// and exact messages of parseJsonl, a leading blank line, a BOM, undefined text, maxLine as an inclusive bound, primitives and null
// rejected, presentDataFile on ENOTDIR / EACCES / symlinks, readJsonl's 64 MiB default cap and error pass-through, and
// readStreamCapped's EOF, EAGAIN back-off and error paths through an injected fs.
// NOT covered: real non-blocking pipes (test/jsonl-read.test.ts); running as root (the permission cases are skipped).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IngestError, parseJsonl, presentDataFile, readJsonl, readStreamCapped } from '../lib/jsonl.ts';

const root0 = typeof process.getuid === 'function' && process.getuid() === 0, posix = process.platform !== 'win32';
const made: string[] = [];
const locked: string[] = [];
after(() => { for (const d of locked) fs.chmodSync(d, 0o700); for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-k-')); made.push(d); return d; };
const message = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as Error).message; } return 'no error'; }; // whatever was thrown: read its message

test('IngestError: defaults (name, total 0, plain "N more" unless atLeast)', () => {
  const e = new IngestError([]);
  assert.equal(e.total, 0); assert.equal(e.name, 'IngestError'); assert.equal(e.message, '');
  const many = Array.from({ length: 12 }, (_, i) => `m${i}`);
  assert.equal(new IngestError(many).message.split('\n').length, 10, 'without a total only the first 10 are kept, with no count line');
  assert.equal(new IngestError(many, 'X', { total: 12 }).message.split('\n').at(-1), '... and 2 more');
  assert.equal(new IngestError(many.slice(0, 3), 'X', { total: 20 }).message.split('\n').at(-1), '... and 10 more');
  assert.equal(new IngestError(many.slice(0, 3), 'X', { total: 20, atLeast: true }).message.split('\n').at(-1), '... and at least 10 more');
});

test('parseJsonl: default name, exact messages, error class name', () => {
  assert.equal(message(() => parseJsonl('x')), 'input:1: invalid JSON');
  assert.equal(message(() => parseJsonl('5')), 'input:1: expected a JSON object');
  assert.equal(message(() => parseJsonl('null')), 'input:1: expected a JSON object');
  assert.equal(message(() => parseJsonl('"s"\n[1]')), 'input:1: expected a JSON object\ninput:2: expected a JSON object');
  assert.throws(() => parseJsonl('x', 'f.jsonl'), (e: Error) => e.name === 'IngestError' && e instanceof IngestError);
});

test('parseJsonl: undefined text, a BOM, a leading blank line, maxLine is inclusive', () => {
  // @ts-expect-error deliberate misuse: an undefined text reads as empty
  assert.deepEqual(parseJsonl(undefined), []);
  assert.deepEqual(parseJsonl('﻿{"a":1}'), [{ a: 1 }]);
  assert.deepEqual(parseJsonl('\n{"a":1}\n{"b":2}\n'), [{ a: 1 }, { b: 2 }]);
  assert.deepEqual(parseJsonl('{"a":"12"}', 'f', { maxLine: 10 }), [{ a: '12' }]);
  assert.equal(message(() => parseJsonl('{"a":"123"}', 'f', { maxLine: 10 })), 'f:1: line too long');
});

test('presentDataFile: missing below a file is absent, a symlink is refused, other errors propagate', { skip: !posix }, () => {
  const d = tmp(), f = path.join(d, 'plain.jsonl'); fs.writeFileSync(f, '');
  assert.equal(presentDataFile(path.join(f, 'sub')), false);
  assert.equal(presentDataFile(path.join(d, 'none.jsonl')), false);
  assert.equal(presentDataFile(f), true);
  fs.symlinkSync(f, path.join(d, 'link.jsonl'));
  assert.equal(message(() => presentDataFile(path.join(d, 'link.jsonl'))), 'link.jsonl: is a symlink, not a regular file');
  if (root0) return;
  const shut = path.join(d, 'shut'); fs.mkdirSync(shut); fs.writeFileSync(path.join(shut, 'x.jsonl'), '{}\n'); fs.chmodSync(shut, 0o000); locked.push(shut);
  assert.throws(() => presentDataFile(path.join(shut, 'x.jsonl')), (e: NodeJS.ErrnoException) => e.code === 'EACCES');
  fs.chmodSync(shut, 0o700); locked.pop();
});

test('readJsonl: an unreadable file is an error, not an empty file', { skip: !posix || root0 }, () => {
  const d = tmp(), f = path.join(d, 'tickets.jsonl'); fs.writeFileSync(f, '{"key":"A"}\n'); fs.chmodSync(f, 0o000);
  assert.throws(() => readJsonl(f), (e: NodeJS.ErrnoException) => e.code === 'EACCES');
  fs.chmodSync(f, 0o600);
  assert.deepEqual(readJsonl(f), [{ key: 'A' }]);
});

test('readJsonl: the default cap is exactly 64 MiB', () => {
  const d = tmp(), f = path.join(d, 'big.jsonl');
  const fd = fs.openSync(f, 'w'); fs.ftruncateSync(fd, 64 * 1024 * 1024 + 1); fs.closeSync(fd); // sparse: no 64 MiB write
  assert.equal(message(() => readJsonl(f)), `big.jsonl: file too large (limit ${64 * 1024 * 1024} bytes)`);
});

test('readStreamCapped: EOF ends the read, EAGAIN backs off between retries and times out, other errors propagate', () => {
  const fake = (impl: (call: number, buf: Buffer) => number) => { let calls = 0; return { get calls() { return calls; }, readSync: (_fd: number, buf: Buffer) => impl(++calls, buf) }; };
  const eof = fake((n, buf) => { if (n === 1) { buf.write('ab'); return 2; } throw Object.assign(new Error('eof'), { code: 'EOF' }); });
  assert.equal(readStreamCapped(0, 10, { fsImpl: eof as unknown as typeof fs }), 'ab');
  const io = fake(() => { throw Object.assign(new Error('io'), { code: 'EIO' }); });
  assert.throws(() => readStreamCapped(0, 10, { fsImpl: io as unknown as typeof fs }), (e: NodeJS.ErrnoException) => e.code === 'EIO');
  const again = fake(() => { throw Object.assign(new Error('again'), { code: 'EAGAIN' }); });
  const t0 = Date.now();
  assert.throws(() => readStreamCapped(0, 10, { timeoutMs: 60, fsImpl: again as unknown as typeof fs }), (e: NodeJS.ErrnoException) => e.code === 'TIMEOUT' && e.message === 'timed out');
  assert.ok(Date.now() - t0 >= 60);
  assert.ok(again.calls <= 20, `EAGAIN retries sleep about 10 ms each (got ${again.calls} calls in 60 ms)`);
});
