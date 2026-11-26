// Counted loops of lib/jsonl.ts and lib/jira/redact.ts, in a file of its own that does almost nothing else (so it runs first among the tests of
// those modules): a mutant that makes a scan loop endless fails here at once. The guard of test/helpers/runaway.ts caps every string search and
// character read in the process; the tests below also bound the exact number of reads. No clock.
// NOT covered: what the loops compute (test/trust-kills-jsonl.test.ts, test/trust-kills-jira-redact*.test.ts).
import './helpers/runaway.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseJsonl, readStreamCapped, readCapped } from '../lib/jsonl.ts';
import { registerSecret, redact } from '../lib/jira/redact.ts';
import { guardedCalls } from './helpers/runaway.ts';

test('parseJsonl visits each line once', () => {
  const before = guardedCalls();
  assert.deepEqual(parseJsonl('{"a":1}\n{"a":2}\n{"a":3}'), [{ a: 1 }, { a: 2 }, { a: 3 }]);
  assert.ok(guardedCalls() - before <= 40, `${guardedCalls() - before} string calls for 3 lines`);
  assert.deepEqual(parseJsonl(''), []); assert.deepEqual(parseJsonl('\n\n'), []);
});

test('readStreamCapped gives up on an idle reader at the first EAGAIN once its limit is passed', () => {
  let reads = 0;
  const fsImpl = { ...fs, readSync: () => { if (++reads > 5) throw new Error('runaway wait loop'); throw Object.assign(new Error('again'), { code: 'EAGAIN' }); } } as unknown as typeof fs;
  assert.throws(() => readStreamCapped(0, 100, { timeoutMs: -1, fsImpl }), (e: Error & { code?: string }) => e.code === 'TIMEOUT' && e.message === 'timed out');
  assert.equal(reads, 1);
});

test('readCapped opens a file non-blocking, so a FIFO without a writer cannot hang the open', { skip: !fs.constants.O_NONBLOCK }, () => {
  const seen: number[] = [];
  const spy = { ...fs, openSync: (p: string, flags: number, ...r: unknown[]) => { seen.push(flags); return fs.openSync(p, flags, ...(r as [])); } } as unknown as typeof fs;
  readCapped(import.meta.filename, 1 << 20, { fsImpl: spy }); readCapped(import.meta.filename, 1 << 20, { fsImpl: spy, follow: false });
  assert.equal(seen.length, 2);
  for (const f of seen) assert.ok(f & fs.constants.O_NONBLOCK, `flags ${f}`);
});

test('redact registers and scans each position once', () => {
  const tok = 'Counted-Loop-Raw-Token-0123456789';
  let before = guardedCalls();
  registerSecret({ raw: tok });
  assert.ok(guardedCalls() - before <= 4 * tok.length + 40, `${guardedCalls() - before} reads to register ${tok.length} characters`);
  registerSecret({ raw: 'ShortLoop-12x' });
  const text = `${'q'.repeat(100)} shortloop-12x ${'z'.repeat(100)} shortloop-12x ${tok.toLowerCase()}`;
  before = guardedCalls();
  assert.equal(redact(text), `${'q'.repeat(100)} [redacted] ${'z'.repeat(100)} [redacted] [redacted]`);
  assert.ok(guardedCalls() - before <= 4 * text.length + 100, `${guardedCalls() - before} reads for ${text.length} characters`);
});
