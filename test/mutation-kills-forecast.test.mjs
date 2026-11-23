// Behavior tests for lib/forecast.mjs written to kill mutants that survived scripts/mutate-all.mjs: exact parse errors and their line
// numbers, the error cap, validation boundaries (0 allowed or not), special functions outside the ranges the main tests use (reflection,
// guards at 0 and 1), variance components and the ticket-model prior on hand-computed inputs, block choice at n=20, the simulators on
// degenerate histories whose answer is known exactly, and the backtest with tiny training windows.
// NOT covered: statistical quality (test/forecast.test.mjs); mutants listed in scripts/mutate/equivalent.json (convergence-only changes).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rng, parseHistory, parseActuals, lgamma, regIncBeta, betaQuantile, clopperPearson, quantile, makeSeq, lag1, chooseBlock, predictDone,
  simulateFinish, sizeClass, varianceComponents, fitTicketModel, backtest, simulatePlan,
} from '../lib/forecast.mjs';
import { buildModel } from '../lib/model.mjs';
import { rng as fixtureRng } from './fixtures/gen.mjs';

/** @param {number} a @param {number} b @param {number} tol @param {string} [msg] */
const near = (a, b, tol, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} ${a} vs ${b} (tol ${tol})`);
const J = (/** @type {unknown} */ o) => JSON.stringify(o);

test('rng: the forecast generator is the fixture generator, default seed 1, for several seeds', () => {
  for (const seed of [0, 1, 7, 123456789, 2 ** 32 - 1]) {
    const a = rng(seed), b = fixtureRng(seed);
    for (let k = 0; k < 50; k++) assert.equal(a(), b(), `seed ${seed} draw ${k}`);
  }
  const d = rng(), one = fixtureRng(1);
  for (let k = 0; k < 5; k++) assert.equal(d(), one());
  const r = rng(1);
  assert.deepEqual([r(), r(), r()], [0.6270739405881613, 0.002735721180215478, 0.5274470399599522]);
});

test('parseHistory: errors carry 1-based line numbers counted over blank lines too', () => {
  assert.deepEqual(parseHistory('\n\nnot json\n').errors, ['line 3: invalid JSON']);
  assert.deepEqual(parseHistory('').records, []);
  assert.deepEqual(parseHistory(undefined).errors, []);
});

test('parseHistory: the error list keeps 10 messages and counts the rest', () => {
  const bad = (/** @type {number} */ n) => Array.from({ length: n }, () => 'x').join('\n');
  assert.equal(parseHistory(bad(10)).errors.length, 10);
  assert.equal(parseHistory(bad(10)).errors.at(-1), 'line 10: invalid JSON');
  assert.deepEqual(parseHistory(bad(11)).errors.slice(9), ['line 10: invalid JSON', '... and 1 more']);
  assert.deepEqual(parseHistory(bad(13)).errors.slice(9), ['line 10: invalid JSON', '... and 3 more']);
  assert.deepEqual(parseActuals(bad(12)).errors.slice(10), ['... and 2 more']);
});

test('parseHistory: object checks and the 0 boundaries of each number field', () => {
  const one = (/** @type {unknown} */ r) => parseHistory(J(r));
  for (const r of [null, [1], 'text', 3]) assert.deepEqual(one(r).errors, ['line 1: not an object'], J(r));
  assert.deepEqual(one({ sprint: 1, planned: 0 }).errors, ['line 1: planned must be a number > 0']);
  assert.equal(one({ sprint: 1, planned: 0.5, done: 0, added: 0, carried: 0 }).errors.length, 0, 'planned 0.5 and zero done/added/carried are valid');
  assert.deepEqual(one({ sprint: 1, planned: 0.5, done: 0, added: 0, carried: 0 }).records, [{ sprint: 1, planned: 0.5, done: 0, added: 0, carried: 0 }]);
  assert.deepEqual(one({ sprint: 1, planned: 5, done: 0.5 }).records[0].done, 0.5);
  assert.deepEqual(one({ sprint: 1, planned: 5, done: -1 }).errors, ['line 1: done must be a number >= 0 or null']);
  assert.deepEqual(one({ sprint: 1, planned: 5, done: '3' }).errors, ['line 1: done must be a number >= 0 or null']);
  assert.deepEqual(one({ sprint: 1, planned: 5, done: 3, added: 0.5 }).records[0].added, 0.5);
  assert.deepEqual(one({ sprint: 1, planned: 5, done: 3, added: '1' }).errors, ['line 1: added must be a number >= 0']);
  assert.deepEqual(one({ sprint: 1, planned: 5, done: 3, added: -0.5 }).errors, ['line 1: added must be a number >= 0']);
  assert.deepEqual(one({ sprint: 1, planned: 5, done: 3, carried: 0.5 }).records[0].carried, 0.5);
  assert.deepEqual(one({ sprint: 1, planned: 5, done: 3, carried: '1' }).errors, ['line 1: carried must be a number >= 0']);
  assert.deepEqual(one({ sprint: 1, planned: 5, done: 3, carried: 2 }).records[0].carried, 2, 'a valid carried is kept, not recomputed');
  assert.deepEqual(one({ sprint: 1, planned: 5, done: 3, carried: -1 }).errors, ['line 1: carried must be a number >= 0']);
});

test('parseHistory: defaults (added 0, carried = planned + added - done floored at 0) and optional team/length', () => {
  const { records, warnings } = parseHistory([J({ sprint: 2, planned: 10, done: 4 }), J({ sprint: 1, planned: 10, done: 15, added: 2 }), J({ sprint: 3, planned: 10, done: null, added: 1 })].join('\n'));
  assert.deepEqual(records, [
    { sprint: 1, planned: 10, done: 15, added: 2, carried: 0 },
    { sprint: 2, planned: 10, done: 4, added: 0, carried: 6 },
    { sprint: 3, planned: 10, done: null, added: 1, carried: null },
  ]);
  assert.deepEqual(warnings, ['sprint 2: no "added", scope creep treated as 0']);
  const t = /** @type {any} */ (parseHistory(J({ sprint: 1, planned: 10, done: 9, added: 0, carried: 1, team: 4, length: 10 })).records[0]);
  assert.deepEqual([t.team, t.length], [4, 10]);
  const u = parseHistory(J({ sprint: 1, planned: 10, done: 9, added: 0, carried: 1, team: '4', length: null })).records[0];
  assert.equal('team' in u || 'length' in u, false);
});

test('parseActuals: every required field is checked on its own, boundaries at 0, sort by key keeps input order for equal keys', () => {
  const ok = { key: 'A', sp: 0.5, actual: 0.5, owner: 'Ana', sprint: 1 };
  assert.deepEqual(parseActuals(J(ok)).rows, [ok]);
  for (const [k, v] of /** @type {Array<[string, unknown]>} */ ([['key', 1], ['sp', 0], ['sp', '2'], ['actual', 0], ['actual', -1], ['actual', '1'], ['owner', 3], ['sprint', 1.5]])) {
    assert.deepEqual(parseActuals(J({ ...ok, [k]: v })).errors, ['line 1: need key, sp>0, actual>0, owner, integer sprint'], `${k}=${J(v)}`);
  }
  assert.deepEqual(parseActuals('null').errors, ['line 1: need key, sp>0, actual>0, owner, integer sprint']);
  const rows = parseActuals([J({ ...ok, key: 'B', sprint: 1 }), J({ ...ok, key: 'A', sprint: 2 }), J({ ...ok, key: 'B', sprint: 3 }), J({ ...ok, key: 'A', sprint: 4 })].join('\n')).rows;
  assert.deepEqual(rows.map((r) => `${r.key}${r.sprint}`), ['A2', 'A4', 'B1', 'B3']);
});

test('lgamma: reflection branch for x < 0.5 against known values', () => {
  near(lgamma(0.25), Math.log(3.625609908221908), 1e-12);
  near(lgamma(0.1), 2.252712651734206, 1e-12);
  near(lgamma(-0.5), Math.log(2 * Math.sqrt(Math.PI)), 1e-12);
  near(lgamma(-1.5), Math.log((4 * Math.sqrt(Math.PI)) / 3), 1e-12);
  near(lgamma(0.5), Math.log(Math.sqrt(Math.PI)), 1e-12);
});

test('regIncBeta, betaQuantile, clopperPearson: exact values at and beyond the guards, a < 1 parameters', () => {
  assert.equal(regIncBeta(-0.1, 2, 3), 0);
  assert.equal(regIncBeta(1.5, 2, 3), 1);
  near(regIncBeta(0.2, 0.5, 0.5), (2 / Math.PI) * Math.asin(Math.sqrt(0.2)), 1e-12, 'arcsine law');
  assert.equal(betaQuantile(0, 2, 3), 0);
  assert.equal(betaQuantile(-1, 2, 3), 0);
  assert.equal(betaQuantile(1, 2, 3), 1);
  assert.equal(betaQuantile(2, 2, 3), 1);
  near(betaQuantile(0.3, 1, 1), 0.3, 1e-12);
  assert.deepEqual(clopperPearson(0, 0), [0, 1]);
  assert.deepEqual(clopperPearson(0, -2), [0, 1]);
  assert.deepEqual(clopperPearson(0, NaN), [0, 1]);
  const [lo1, hi1] = clopperPearson(0, 1), [lo2, hi2] = clopperPearson(1, 1);
  assert.equal(lo1, 0); near(hi1, 0.975, 1e-12); near(lo2, 0.025, 1e-12); assert.equal(hi2, 1);
});

test('quantile clamps p above 1 to the largest sample and below 0 to the smallest', () => {
  assert.equal(quantile([1, 2, 3], 2), 3);
  assert.equal(quantile([1, 2, 3], -1), 1);
  assert.equal(quantile([1, 2, 3], 1), 3);
});

test('makeSeq: L is clamped to [1, n]; with L=n the block is the whole history in order from the drawn start', () => {
  const seq = makeSeq(3, 0, () => 0), got = [seq(), seq(), seq(), seq()];
  assert.deepEqual(got, [0, 0, 0, 0], 'L=0 behaves like L=1 with every block restarting at the drawn index');
  const whole = makeSeq(3, 9, () => 0.5);
  assert.deepEqual([whole(), whole(), whole(), whole()], [1, 2, 0, 1]);
});

test('lag1: constant series is 0, a known series gives the hand value, a small-variance series is not clipped', () => {
  assert.equal(lag1([5, 5, 5]), 0);
  assert.equal(lag1([1, 2, 3, 4]), 0.25);
  near(lag1([0, 0.1, 0.2, 0.3]), 0.25, 1e-12, 'den < 1 still divides');
});

test('chooseBlock: configured block, the n >= 20 rule exactly at 20, and every reason string', () => {
  assert.deepEqual(chooseBlock([1, 2], { block: 3 }), { L: 3, r1: null, why: 'configured' });
  assert.deepEqual(chooseBlock(Array.from({ length: 19 }, (_, i) => i)), { L: 2, r1: null, why: 'default (n<20, lag-1 not estimable)' });
  const alt = Array.from({ length: 20 }, (_, i) => (i % 2 ? 10 : 20));
  assert.deepEqual(chooseBlock(alt), { L: 2, r1: -0.95, why: 'lag-1 significant' });
  const c = chooseBlock(Array.from({ length: 20 }, (_, i) => [7, 7, 5, 5][i % 4]));
  assert.equal(c.r1, 0.05);
  assert.deepEqual([c.L, c.why], [1, 'lag-1 negligible']);
});

test('predictDone and simulateFinish on degenerate histories with known answers', () => {
  const s = predictDone([{ done: 3 }, { done: 5 }], 1, 200, rng(2));
  assert.deepEqual([...new Set(s)].sort(), [3, 5], 'one sprint ahead draws a single sprint, no offset');
  assert.deepEqual(predictDone([{ done: 3 }, { done: 5 }], 2, 4, rng(2)), [8, 8, 8, 8], 'default block 2 covers both sprints');
  assert.deepEqual(simulateFinish([{ done: 10, added: 0 }], 25, 3, rng(1)), [3, 3, 3]);
  assert.deepEqual(simulateFinish([{ done: 10, added: 0 }], 0.5, 2, rng(1)), [1, 1], 'any work left above 0 takes a sprint');
  assert.deepEqual(simulateFinish([{ done: 1, added: 0 }], 60, 1, rng(1)), [60], 'finishing in exactly H sprints counts');
  assert.deepEqual(simulateFinish([{ done: 1, added: 0 }], 61, 1, rng(1)), [Infinity]);
  assert.deepEqual(simulateFinish([{ done: 1, added: 1 }], 5, 2, rng(1)), [Infinity, Infinity]);
  assert.equal(simulateFinish([{ done: 1, added: 0 }], 1, 5, rng(1)).length, 5);
  const blocks = simulateFinish([{ done: 1, added: 0 }, { done: 100, added: 0 }], 2, 300, rng(5));
  assert.deepEqual([...new Set(blocks)].sort(), [1, 2], 'with the default block of 2 a slow sprint is always followed by the fast one');
});

test('sizeClass boundaries', () => {
  assert.deepEqual([1, 2, 2.5, 5, 5.5, 6, 8].map(sizeClass), ['S', 'S', 'M', 'M', 'L', 'L', 'L']);
});

test('varianceComponents on a hand-computed 2x2 design', () => {
  const v = varianceComponents([1, 2, 3, 4], ['a', 'a', 'b', 'b'], [1, 2, 1, 2]);
  assert.deepEqual(v, { total: 7.5, vp: 7, vs: 5.5, ve: 1e-6, nPersonPairs: 2, nSprintPairs: 2 });
  assert.deepEqual(varianceComponents([2], ['a'], [1]), { total: 4, vp: 0, vs: 0, ve: 4, nPersonPairs: 0, nSprintPairs: 0 });
  assert.deepEqual(varianceComponents([1, -1, 2], ['a', 'a', 'b'], [1, 2, 2]), { total: 2, vp: 0, vs: 0, ve: 2, nPersonPairs: 1, nSprintPairs: 1 }, 'negative products floor at 0');
  const same = varianceComponents([1, 2], ['a', 'a'], [1, 1]);
  assert.deepEqual([same.nPersonPairs, same.nSprintPairs], [0, 0], 'a pair sharing both labels counts for neither');
});

test('fitTicketModel: the prior below 5 rows and the pooled level at exactly 5 rows, hand-computed', () => {
  const prior = fitTicketModel([{ key: 'A', sp: 1, actual: 1, owner: 'a', sprint: 1 }]);
  assert.equal(prior.source, 'prior');
  near(prior.se, Math.sqrt(0.4 ** 2 - 0.1 ** 2 - 0.1 ** 2), 1e-15);
  assert.equal(fitTicketModel(Array.from({ length: 4 }, (_, i) => ({ key: `K${i}`, sp: 1, actual: 1, owner: 'a', sprint: 1 }))).source, 'prior');
  const rows = [1, 2, 3, 5, 8].map((sp, i) => ({ key: `K${i}`, sp, actual: sp * (1 + i / 10), owner: i % 2 ? 'a' : 'b', sprint: 1 + (i % 2) }));
  const m = /** @type {any} */ (fitTicketModel(rows)), yb = rows.reduce((s, r) => s + Math.log(r.actual / r.sp), 0) / 5;
  assert.equal(m.source, 'pooled');
  near(m.mu.S, (5 * yb + 5 * 0.1) / 10, 1e-12, 'mu_pool shrunk to the prior mean with weight 5');
  assert.equal(m.sigma, 0.25, 'sigma floored at 0.25 below 15 rows');
  near(m.se, Math.sqrt(0.25 ** 2 - 0.01 - 0.01), 1e-12);
});

test('backtest with minTrain 1 and 2: the Gaussian baseline stays finite (sd of one sprint is 0, of two is the sample sd)', () => {
  const h = [10, 14, 9, 13, 11, 12].map((d, i) => ({ sprint: i + 1, planned: 12, done: d, added: 0, carried: Math.max(0, 12 - d) }));
  for (const minTrain of [1, 2]) {
    const bt = /** @type {any} */ (backtest(h, { minTrain, runs: 400, seed: 3 }));
    assert.equal(bt.n, h.length - minTrain);
    for (const k of ['model', 'iid', 'gauss', 'naive']) assert.ok(Number.isFinite(bt.methods[k].crps), `${k} crps finite at minTrain ${minTrain}`);
  }
  // with one training sprint the Gaussian baseline has sd 0: every sample is that sprint's done
  const one = /** @type {any} */ (backtest(h.slice(0, 2), { minTrain: 1, runs: 50, seed: 1 }));
  assert.equal(one.methods.gauss.crps, Math.abs(10 - 14));
  // with two training sprints the sd is |a-b|/sqrt(2): its spread shows in a CRPS below the point-mass error
  const two = /** @type {any} */ (backtest(h.slice(0, 3), { minTrain: 2, runs: 4000, seed: 1 }));
  assert.ok(two.methods.gauss.crps < Math.abs(12 - 9) && two.methods.gauss.crps > 0.5, `gauss crps ${two.methods.gauss.crps}`);
});

test('documented defaults: block 2 in predictDone and simulateFinish, 4000 runs, seed 1, horizon 60 in simulatePlan, 1000 runs and seed 1 in backtest', () => {
  const recs = [{ done: 3, added: 0 }, { done: 5, added: 0 }, { done: 11, added: 0 }];
  assert.deepEqual(predictDone(recs, 3, 300, rng(4)), predictDone(recs, 3, 300, rng(4), 2));
  assert.notDeepEqual(predictDone(recs, 3, 300, rng(4)), predictDone(recs, 3, 300, rng(4), 3), 'the default block differs from 3 on this history');
  assert.deepEqual(simulateFinish(recs, 30, 300, rng(4)), simulateFinish(recs, 30, 300, rng(4), 2, 60));
  assert.notDeepEqual(simulateFinish(recs, 30, 300, rng(4)), simulateFinish(recs, 30, 300, rng(4), 3, 60));
  // one person with capacity 1: the k-th of 61 one-point tickets lands in sprint k; the 61st needs sprint 61 = start + 60, past the horizon
  const keys = Array.from({ length: 61 }, (_, i) => `K${String(i).padStart(2, '0')}`);
  const model = buildModel({ tickets: keys.map((key) => ({ key, sp: 1 })), schedule: keys.map((key) => ({ key, owner: 'Ana', sprint: 1 })), config: { caps: { default: 1 } } });
  const flat = [1, 2, 3].map((s) => ({ sprint: s, planned: 10, done: 10, added: 0, carried: 0 }));
  const def = simulatePlan(model, flat, { start: 1 });
  assert.equal(def.ends.length, 4000);
  assert.ok(def.ends.every((e) => e === Infinity), 'the 61st sprint is beyond the default horizon of 60');
  assert.ok(simulatePlan(model, flat, { start: 1, horizon: 61 }).ends.every((e) => e === 61));
  assert.deepEqual(simulatePlan(model, flat, { start: 1, runs: 2000 }).ends.length, 2000);
  const noisy = series3(), bt = (/** @type {any} */ o) => /** @type {any} */ (backtest(noisy, o)).methods.model;
  assert.deepEqual(bt(undefined), bt({ runs: 1000, seed: 1 }));
  assert.notDeepEqual(bt(undefined), bt({ runs: 1000, seed: 2 }));
  assert.notDeepEqual(bt(undefined).crps, bt({ runs: 1001, seed: 1 }).crps);
});

/** a short noisy history for the backtest defaults */
function series3() { const r = rng(12); return Array.from({ length: 8 }, (_, i) => ({ sprint: i + 1, planned: 30, done: Math.round(20 + 15 * r()), added: Math.round(3 * r()), carried: 0 })); }

test('plan simulation edge cases: nothing left to plan, no history, an exact capacity fit, a tiny planned sprint, Infinity story points', () => {
  const done = buildModel({ tickets: [{ key: 'A', sp: 1, jira_status: 'Done' }], schedule: [{ key: 'A', owner: 'Ana', sprint: 3 }] });
  const r = simulatePlan(done, [{ sprint: 1, planned: 5, done: 5, added: 0, carried: 0 }], { runs: 2000 });
  assert.deepEqual([r.planned, r.tickets, r.points, r.start], [0, 0, 0, 2]);
  const two = buildModel({ tickets: [{ key: 'A', sp: 1 }, { key: 'B', sp: 1 }], schedule: [{ key: 'A', owner: 'Ana', sprint: 1 }, { key: 'B', owner: 'Ana', sprint: 1 }], config: { caps: { default: 2 } } });
  const exact = simulatePlan(two, [{ sprint: 1, planned: 4, done: 4, added: 0, carried: 0 }], { runs: 2000, start: 1 });
  assert.ok(exact.ends.every((e) => e === 1), 'two 1-point tickets fit a capacity of exactly 2 in the same sprint');
  assert.equal(simulatePlan(two, [], { runs: 2000 }).start, 1, 'no history: the simulation starts at sprint 1');
  const roomy = buildModel({ tickets: two.tickets.values().toArray(), schedule: [{ key: 'A', owner: 'Ana', sprint: 1 }, { key: 'B', owner: 'Ana', sprint: 1 }], config: { caps: { default: 10 } } });
  const tiny = simulatePlan(roomy, [{ sprint: 1, planned: 5, done: 0, added: 0, carried: 5 }], { runs: 2000, start: 1 });
  assert.ok(tiny.ends.every((e) => e === 2), 'a sprint that delivered nothing counts at the 0.1 floor: each 1-point ticket costs 10 of a cap of 10, so the second waits a sprint');
  const inf = buildModel({ tickets: [{ key: 'A', sp: Infinity }, { key: 'B', sp: 3 }], schedule: [{ key: 'A', owner: 'Ana', sprint: 1 }, { key: 'B', owner: 'Ben', sprint: 1 }] });
  const ri = simulatePlan(inf, [{ sprint: 1, planned: 5, done: 5, added: 0, carried: 0 }], { runs: 2000, start: 1 });
  assert.deepEqual([ri.points, ri.missingSp], [6, 0], 'a non-finite story point count is replaced by the median of the known ones');
});

test('more edges: an impossible k over n, story-point medians, the default seed, a start at sprint 0', () => {
  assert.deepEqual(clopperPearson(2, 0), [0, 1], 'n = 0 is "no data" whatever k says');
  const pts = (/** @type {any[]} */ sps) => simulatePlan(buildModel({ tickets: sps.map((sp, i) => ({ key: `K${i}`, sp })), schedule: sps.map((_, i) => ({ key: `K${i}`, owner: 'Ana', sprint: 1 })) }), [{ sprint: 1, planned: 50, done: 50, added: 0, carried: 0 }], { runs: 2000, start: 1 });
  assert.deepEqual([pts(['9', 2, undefined]).points, pts(['9', 2, undefined]).missingSp], [6, 1], 'a numeric string is not a story point count: the median of the real ones (2) stands in for it and for the missing one');
  assert.equal(pts([0, 2, 4, undefined]).points, 14, 'a zero is not a known size: the median of [2, 4] (upper middle) is 4, used for both the 0 and the missing one');
  assert.equal(pts([undefined, null]).points, 2, 'with no known size every ticket counts 1');
  const keys = ['A', 'B', 'C'], noisyModel = buildModel({ tickets: keys.map((key) => ({ key, sp: 2 })), schedule: keys.map((key) => ({ key, owner: 'Ana', sprint: 1 })), config: { caps: { default: 8 } } });
  const hist = [10, 4, 7].map((d, i) => ({ sprint: i + 1, planned: 10, done: d, added: 1, carried: 0 }));
  assert.deepEqual(simulatePlan(noisyModel, hist, { start: 1, runs: 2000 }).ends, simulatePlan(noisyModel, hist, { start: 1, runs: 2000, seed: 1 }).ends);
  assert.notDeepEqual(simulatePlan(noisyModel, hist, { start: 1, runs: 2000 }).ends, simulatePlan(noisyModel, hist, { start: 1, runs: 2000, seed: 2 }).ends);
  const zero = buildModel({ tickets: [{ key: 'A', sp: 1 }], schedule: [{ key: 'A', owner: 'Ana', sprint: 0 }] });
  assert.ok(simulatePlan(zero, [{ sprint: 1, planned: 5, done: 5, added: 0, carried: 0 }], { start: 0, runs: 2000 }).ends.every((e) => e === 0), 'a plan that ends in sprint 0 ends in sprint 0');
});
