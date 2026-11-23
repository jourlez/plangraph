import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readCapped, readJsonl } from '../lib/jsonl.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'brain-read-'));
const code = (c) => (e) => e instanceof Error && /** @type {any} */ (e).code === c;

test('readCapped reads a normal file whole', () => {
  const d = tmp(); const f = path.join(d, 'a.jsonl'); fs.writeFileSync(f, 'héllo\n{"a":1}\n');
  assert.equal(readCapped(f, 1024), 'héllo\n{"a":1}\n');
});
test('readCapped: exactly maxBytes is fine, maxBytes + 1 is TOO_LARGE', () => {
  const d = tmp(); const f = path.join(d, 'a'); const g = path.join(d, 'b');
  fs.writeFileSync(f, 'x'.repeat(100000)); fs.writeFileSync(g, 'x'.repeat(100001));
  assert.equal(readCapped(f, 100000).length, 100000);
  assert.throws(() => readCapped(g, 100000), code('TOO_LARGE'));
  assert.throws(() => readCapped(g, 100000), /file too large \(limit 100000 bytes\)/);
});
test('readCapped refuses a directory', () => {
  const d = tmp();
  assert.throws(() => readCapped(d, 1024), code('NOT_A_FILE'));
  assert.throws(() => readCapped(d, 1024), /not a regular file/);
});
test('readCapped refuses a FIFO without blocking', (t) => {
  const d = tmp(); const p = path.join(d, 'fifo');
  try { execFileSync('mkfifo', [p]); } catch { t.skip('no mkfifo'); return; }
  const t0 = Date.now();
  assert.throws(() => readCapped(p, 1024), code('NOT_A_FILE'));
  assert.ok(Date.now() - t0 < 2000);
});
test('readCapped refuses a symlink to /dev/zero promptly', (t) => {
  if (!fs.existsSync('/dev/zero')) { t.skip('no /dev/zero'); return; }
  const d = tmp(); const p = path.join(d, 'z'); fs.symlinkSync('/dev/zero', p);
  const t0 = Date.now();
  assert.throws(() => readCapped(p, 1024), code('NOT_A_FILE'));
  assert.ok(Date.now() - t0 < 2000);
});
test('readCapped stops early on a huge file instead of reading it all', () => {
  const d = tmp(); const f = path.join(d, 'big'); fs.writeFileSync(f, ''); fs.truncateSync(f, 64 * 1024 * 1024);
  const t0 = Date.now();
  assert.throws(() => readCapped(f, 1024 * 1024), code('TOO_LARGE'));
  assert.ok(Date.now() - t0 < 2000);
});

// Regression (review round 3): a producer writing tiny chunks must not make the capped stdin reader retain 64 KiB per read.
test('readStreamCapped memory stays proportional to the input when a pipe delivers 1-byte writes', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path'); const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'rsc-'));
  const reader = join(dir, 'reader.mjs');
  writeFileSync(reader, `import { readStreamCapped } from ${JSON.stringify(new URL('../lib/jsonl.mjs', import.meta.url).href)};
const s = readStreamCapped(0, 9 * 1024 * 1024); process.stdout.write(JSON.stringify({ n: s.length, ab: process.memoryUsage().arrayBuffers }));`);
  const writer = `for (let i = 0; i < 60000; i++) process.stdout.write('x');`;
  const out = execFileSync('/bin/sh', ['-c', `node -e "${writer}" | node ${JSON.stringify(reader)}`], { encoding: 'utf8', timeout: 60000 });
  const { n, ab } = JSON.parse(out);
  assert.equal(n, 60000);
  assert.ok(ab < 20 * 1024 * 1024, `arrayBuffers ${ab} bytes for ${n} bytes of input: chunks are retaining their whole read buffer`);
});

// Item 9 (cleanup A2): the timeout is an IDLE timeout (reset whenever data arrives), for non-blocking fds. A FIFO opened O_NONBLOCK by the reader
// stands in for a non-blocking stdin pipe; the parent keeps a writer fd open so the reader never sees EOF, only silence.
test('readStreamCapped: the timeout is idle time, so a slow steady writer is not cut off, and silence after it times out', async (t) => {
  const { readStreamCapped } = await import('../lib/jsonl.mjs');
  const { spawn } = await import('node:child_process');
  const d = tmp(); const p = path.join(d, 'fifo');
  try { execFileSync('mkfifo', [p]); } catch { t.skip('no mkfifo'); return; }
  const rfd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  const keep = fs.openSync(p, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK); // no EOF while the child is between writes
  // 30 single bytes, one every 50 ms: 1.5 s of total time against a 500 ms idle bound (10x margin per gap for loaded CI runners).
  const child = spawn('/bin/sh', ['-c', `i=0; while [ $i -lt 30 ]; do printf x; sleep 0.05; i=$((i+1)); done > ${JSON.stringify(p)}`], { stdio: 'ignore' });
  const t0 = Date.now();
  try {
    assert.throws(() => readStreamCapped(rfd, 1024, { timeoutMs: 500 }), code('TIMEOUT'));
    const dt = Date.now() - t0;
    assert.ok(dt >= 1400, `gave up after ${dt} ms: the clock was not reset by arriving data`);
    assert.ok(dt < 5000, `took ${dt} ms`);
  } finally { child.kill(); fs.closeSync(rfd); fs.closeSync(keep); }
});

// Item 21: error labels carry the base name only, never a relative path.
test('readJsonl errors name the base name only: no slashes, no ..', () => {
  const root = tmp(); const deep = path.join(root, 'a', 'b'); fs.mkdirSync(deep, { recursive: true });
  const big = path.join(deep, 'big.jsonl'), bad = path.join(deep, 'bad.jsonl'), dir = path.join(deep, 'adir.jsonl');
  fs.writeFileSync(big, 'x'.repeat(100)); fs.writeFileSync(bad, '{"a":1}\nnot json\n'); fs.mkdirSync(dir);
  const prev = process.cwd(); process.chdir(os.tmpdir());
  try {
    for (const f of [big, dir]) assert.throws(() => readJsonl(f, { maxBytes: 10 }), (/** @type {any} */ e) => /^(big|adir)\.jsonl: /.test(e.message) && !/[/\\]|\.\./.test(e.message.replace(/\.jsonl/g, '')), f);
    assert.throws(() => readJsonl(bad), (/** @type {any} */ e) => /^bad\.jsonl:2:/.test(e.message) && !/\//.test(e.message));
  } finally { process.chdir(prev); }
});
