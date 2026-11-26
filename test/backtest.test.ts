import test from 'node:test';
import assert from 'node:assert/strict';
import { replay, monteCarlo, throughputOf, rng32 } from '../lib/backtest.ts';
import type { Done } from '../lib/backtest.ts';

const mk = (n: number): Done[] => Array.from({ length: n }, (_, i) => ({ key: `K-${i}`, sprint: 1 + Math.floor(i / 2), sp: 2, owner: 'x', deps: i % 2 ? [`K-${i - 1}`] : [] }));

test('replay reports a short history instead of inventing data', () => {
  const r = replay(mk(4)); assert.equal(r.ok, false);
});

test('replay scores each window with an injected planner', () => {
  const done = mk(12); // sprints 1..6
  const r = replay(done, { minTrain: 3, planner: (_k, open) => new Map(open.map((t) => [t.key, t.sprint])) });
  assert.ok(r.ok); if (r.ok) { assert.equal(r.windows.length, 3); assert.equal(r.hitRate, 1); assert.equal(r.windows[0].from, 4); }
});

test('replay default planner gives rates in range', () => {
  const r = replay(mk(12));
  assert.ok(r.ok); if (r.ok) { assert.ok(r.n > 0); assert.ok(r.hitRate >= 0 && r.hitRate <= r.within1Rate && r.within1Rate <= 1); }
});

test('monteCarlo is seeded, ordered and refuses empty or zero history', () => {
  const a = monteCarlo([4, 6, 5], 30, { seed: 3 }), b = monteCarlo([4, 6, 5], 30, { seed: 3 });
  assert.deepEqual(a, b);
  assert.ok(a.ok); if (a.ok) { assert.ok(a.p10 <= a.p50 && a.p50 <= a.p90); assert.ok(a.p50 >= 5 && a.p50 <= 8); }
  assert.equal(monteCarlo([], 5).ok, false); assert.equal(monteCarlo([0, 0], 5).ok, false);
});

test('monteCarlo counts runs that never finish within the horizon', () => {
  const r = monteCarlo([1], 100, { horizon: 10, runs: 20 });
  assert.ok(r.ok); if (r.ok) { assert.equal(r.neverDone, 20); assert.equal(r.p50, Infinity); }
});

test('throughputOf fills empty sprints with 0', () => {
  assert.deepEqual(throughputOf([{ key: 'a', sprint: 2, sp: 3, owner: 'x', deps: [] }, { key: 'b', sprint: 4, sp: 1, owner: 'x', deps: [] }]), [3, 0, 1]);
  assert.deepEqual(throughputOf([]), []);
});

test('rng32 is deterministic', () => { assert.equal(rng32(5)(), rng32(5)()); });
