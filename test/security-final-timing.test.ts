// Timing file (Task 21A): guardOutput and fence() stay linear on hostile input; ratios between sizes (n vs 4n), no absolute limit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { guardOutput, fence } from '../lib/sanitize.ts';
import { scaling } from './helpers/perf.ts';

test('I3: guardOutput is linear on hostile input (many opener lines, long space runs)', () => {
  const opener = '<untrusted src="x" n="y" len="999999">';
  const hostile = (n: number) => guardOutput(`${opener}\n`.repeat(n) + `<${' '.repeat(n)}x\n` + '< '.repeat(n));
  const s = scaling(hostile, 20000);
  assert.ok(s.ratio < s.maxRatio, `guardOutput scaling ratio ${s.ratio.toFixed(1)} (linear ~4, quadratic ~16)`);
});

test('M1: fence() is linear on `<` followed by a long whitespace run', () => {
  for (const body of [(n: number) => `<${' '.repeat(n)}x`, (n: number) => `<${'\t'.repeat(n)}/${' '.repeat(n)}x`]) {
    const s = scaling((n: number) => fence('x', body(n), { max: Infinity }), 16000);
    assert.ok(s.ratio < s.maxRatio, `fence scaling ratio ${s.ratio.toFixed(1)} (linear ~4, quadratic ~16)`);
  }
});
