// test/helpers/perf.ts: the ratio check itself, driven with an injected clock (no wall clock, so this file is deterministic and not a timing file).
// Covered: a uniform slowdown of any factor leaves the ratio unchanged and passes; a slow path that grows 4x more than the input fails;
// PLANGRAPH_PERF_FACTOR widens the allowed ratio. NOT covered: the real clock (the -timing.test.ts files use it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scaling, factor } from './helpers/perf.ts';

/** A fake clock the measured function advances by cost(n) milliseconds per call. */
const sim = (cost: (n: number) => number) => {
  let t = 0;
  return { now: () => t, fn: (n: number) => { t += cost(n); } };
};

test('the ratio check passes under a 4x uniform slowdown', () => {
  for (const slow of [1, 4, 40]) {
    const c = sim((n) => slow * n);
    const s = scaling(c.fn, 1000, { now: c.now });
    assert.ok(Math.abs(s.ratio - 4) < 1e-9, `ratio ${s.ratio} under a ${slow}x slowdown`);
    assert.ok(s.ratio < s.maxRatio);
  }
});

test('the ratio check fails when the slow path grows 4x more than the input', () => {
  // input 4x larger, cost 16x larger (quadratic): the ratio is 16 and the check must fail, at any uniform speed
  for (const slow of [1, 4]) {
    const c = sim((n) => slow * n * n / 1000);
    const s = scaling(c.fn, 1000, { now: c.now });
    assert.ok(Math.abs(s.ratio - 16) < 1e-9, `ratio ${s.ratio}`);
    assert.ok(!(s.ratio < s.maxRatio), 'a quadratic path is rejected');
  }
});

test('PLANGRAPH_PERF_FACTOR multiplies the allowed ratio, and a bad value is ignored', () => {
  const old = process.env.PLANGRAPH_PERF_FACTOR;
  try {
    delete process.env.PLANGRAPH_PERF_FACTOR; assert.equal(factor(), 1);
    process.env.PLANGRAPH_PERF_FACTOR = 'abc'; assert.equal(factor(), 1);
    process.env.PLANGRAPH_PERF_FACTOR = '-2'; assert.equal(factor(), 1);
    process.env.PLANGRAPH_PERF_FACTOR = '2'; assert.equal(factor(), 2);
    const c = sim((n) => n * n / 1000);
    const s = scaling(c.fn, 1000, { now: c.now, maxRatio: 9 });
    assert.equal(s.maxRatio, 18);
  } finally { if (old === undefined) delete process.env.PLANGRAPH_PERF_FACTOR; else process.env.PLANGRAPH_PERF_FACTOR = old; }
});

test('the best of several attempts is reported: one noisy attempt does not fail a linear path', () => {
  let calls = 0, t = 0;
  // the first attempt's large run is inflated 10x (a GC pause), later attempts are clean
  const fn = (n: number) => { calls++; t += n * (calls === 3 ? 10 : 1); }; // call 1 warm-up, 2 and 3 the first attempt
  const s = scaling(fn, 1000, { now: () => t, reps: 1 });
  assert.ok(s.ratio < s.maxRatio, `ratio ${s.ratio}`);
});
