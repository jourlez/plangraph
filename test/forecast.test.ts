// Tests for lib/forecast.ts. Run: node --test test/forecast.test.ts
// NOT covered: real-world data (everything is synthetic with known truth, so coverage numbers describe the model under the
// generator's assumptions only); heavy-tailed or multimodal throughput; ticket partial progress/carry-over inside the plan
// graph; non-stationary trends other than the regime gate; the conformal layer is tested for its Beta law but not wired into
// the result; the leave-one-sprint-out band of PRIOR-ONLY is not validated for coverage; thresholds below are tuned to the
// synthetic runs reported in docs/FORECAST.md and are recommendations, not proofs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  rng, normal, parseHistory, parseActuals, regIncBeta, betaQuantile, clopperPearson, lgamma, normCdf, quantile, pinball, crps, pit,
  conformalQuantile, makeSeq, lag1, chooseBlock, predictDone, simulateFinish, varianceComponents, fitTicketModel, drawLogRatios, sizeClass,
  simulatePlan, backtest, assessHistory, decideState, forecast, renderForecast,
} from '../lib/forecast.ts';
import { buildModel } from '../lib/model.ts';
import type { Edge } from '../lib/model.ts';
import type { NoiseParams } from '../lib/forecast.ts';
import { genPlan } from './fixtures/gen.ts';

const mean = (a: readonly number[]) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a: readonly number[]) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const near = (a: number, b: number, tol: number, msg?: string) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} ${a} vs ${b} (tol ${tol})`);
const rec = (sprint: number, planned: number, done: number, added = 0, extra = {}) => ({ sprint, planned, done, added, carried: Math.max(0, planned + added - done), ...extra });
const hist = (dones: number[], planned = 40, added = 0) => dones.map((d, i) => rec(i + 1, planned, d, added));

// ---------- (7) scoring unit tests on hand-computed values ----------
test('regularized incomplete beta matches closed forms and a binomial-tail oracle', () => {
  near(regIncBeta(0.5, 1, 1), 0.5, 1e-12); near(regIncBeta(0.3, 1, 4), 1 - 0.7 ** 4, 1e-12); near(regIncBeta(0.3, 3, 1), 0.027, 1e-12); near(regIncBeta(0.5, 2, 2), 0.5, 1e-12);
  assert.equal(regIncBeta(0, 2, 3), 0); assert.equal(regIncBeta(1, 2, 3), 1);
  // I_x(a,b) = P(Bin(a+b-1, x) >= a) for integer a, b
  const binTail = (n: number, x: number, a: number) => { let s = 0, c = 1; for (let k = 0; k <= n; k++) { if (k > 0) c = (c * (n - k + 1)) / k; if (k >= a) s += c * x ** k * (1 - x) ** (n - k); } return s; };
  for (const [a, b] of [[2, 3], [5, 5], [1, 9], [8, 3], [12, 20]]) for (const x of [0.05, 0.3, 0.5, 0.77, 0.95]) near(regIncBeta(x, a, b), binTail(a + b - 1, x, a), 1e-10, `a=${a} b=${b} x=${x}`);
  near(regIncBeta(0.3, 2, 3), 0.3483, 1e-12);
  near(lgamma(5), Math.log(24), 1e-12); near(lgamma(0.5), Math.log(Math.sqrt(Math.PI)), 1e-12);
  near(betaQuantile(0.3483, 2, 3), 0.3, 1e-9);
});
test('Clopper-Pearson against hand-derived values', () => {
  const [l0, u0] = clopperPearson(0, 10); assert.equal(l0, 0); near(u0, 1 - 0.025 ** (1 / 10), 1e-9);
  const [l1, u1] = clopperPearson(10, 10); assert.equal(u1, 1); near(l1, 0.025 ** (1 / 10), 1e-9);
  const [l, u] = clopperPearson(7, 9); near(l, 0.3999, 5e-4); near(u, 0.9719, 5e-4);   // published exact interval for 7/9
  const [a, b] = clopperPearson(5, 10); near(a, 0.1871, 5e-4); near(b, 0.8129, 5e-4);
  // defining property: P(Bin(n,lo) >= k) = alpha/2 and P(Bin(n,hi) <= k) = alpha/2
  near(1 - regIncBeta(1 - l, 9 - 7 + 1, 7), 0.025, 1e-9);
});
test('pinball, CRPS, PIT, quantile on hand-computed values', () => {
  near(pinball(10, 0.9, 12), 1.8, 1e-12); near(pinball(10, 0.9, 7), 0.3, 1e-12); assert.equal(pinball(10, 0.5, 10), 0);
  near(crps([0, 1], 0.5), 0.25, 1e-12); near(crps([0, 2, 4], 1), 7 / 9, 1e-12); near(crps([3, 3, 3], 5), 2, 1e-12);
  assert.equal(pit([1, 2, 3, 4], 2.5), 0.5); assert.equal(pit([1, 2, 2, 4], 2), 0.5);   // (1 below + 0.5*2 equal)/4
  const s = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(quantile(s, 0.5), 5); assert.equal(quantile(s, 0.8), 8); assert.equal(quantile(s, 0.9), 9); assert.equal(quantile(s, 0.95), 10); assert.equal(quantile(s, 0.1), 1);
});
test('conformal index is ceil((n+1)(1-alpha))', () => {
  const sc = [1, 2, 3, 4, 5, 6, 7, 8, 9]; // n=9, alpha=.1 -> ceil(10*.9)=9 -> the max
  assert.deepEqual(conformalQuantile(sc, 0.1), { n: 9, index: 9, q: 9, infinite: false });
  assert.equal(conformalQuantile([1, 2, 3, 4, 5, 6, 7, 8], 0.1).infinite, true);   // n=8: index 9 > 8
  assert.equal(conformalQuantile([5, 1, 4, 2, 3, 9, 8, 7, 6, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19], 0.2).q, 16); // n=19: ceil(20*.8)=16
});

// ---------- parsing ----------
test('parseHistory validates and canonicalises', () => {
  const t = '{"sprint":2,"planned":30,"done":28,"added":4}\n\n{"sprint":1,"planned":30,"done":null}\n{"sprint":2,"planned":1,"done":1}\nnot json\n{"sprint":3,"planned":0,"done":1}\n{"sprint":4,"planned":20,"done":-1}\n';
  const r = parseHistory(t);
  assert.deepEqual(r.records.map((x) => x.sprint), [1, 2]); assert.equal(r.records[1].carried, 6); assert.equal(r.records[0].done, null); assert.equal(r.errors.length, 4);
  assert.ok(r.warnings.some((w) => w.includes('sprint 1')));
  const a = parseActuals('{"key":"B-2","sp":3,"actual":4,"owner":"Ana","sprint":1}\n{"key":"A-1","sp":0,"actual":4,"owner":"Ana","sprint":1}\n{"key":"A-3","sp":2,"actual":1,"owner":"Ben","sprint":2}');
  assert.deepEqual(a.rows.map((x) => x.key), ['A-3', 'B-2']); assert.equal(a.errors.length, 1);
});
test('deterministic seeded RNG and Box-Muller moments', () => {
  assert.equal(rng(5)(), rng(5)()); const r = rng(9), z = Array.from({ length: 40000 }, () => normal(r));
  near(mean(z), 0, 0.02); near(sd(z), 1, 0.02);
});

// ---------- (1) iid throughput: coverage across replicate datasets; the small-n gap table ----------
function iidCoverage(n: number, reps: number, runs: number, seed0: number) {
  const mu = 40, s = 6; let cov = 0, lag = 0;
  for (let r = 0; r < reps; r++) {
    const g = rng(seed0 + r), h = Array.from({ length: n }, () => ({ done: mu + s * normal(g) })), sm = predictDone(h, 1, runs, rng(777 + r), 1).sort((a, b) => a - b);
    cov += normCdf((quantile(sm, 0.9) - mu) / s) - normCdf((quantile(sm, 0.1) - mu) / s); lag++;
  }
  return cov / lag;
}
test('iid throughput: nominal 80% interval coverage vs n (300 replicate datasets); gap shrinks with n and is large at small n', () => {
  const table: Record<number, number> = {}; for (const n of [5, 8, 10, 15, 20, 30, 50]) table[n] = iidCoverage(n, 300, 1000, 1000 * n);
  console.log('# iid coverage of nominal 80% (10-90) next-sprint interval, 300 replicates:', JSON.stringify(Object.fromEntries(Object.entries(table).map(([k, v]) => [k, +v.toFixed(3)]))));
  // Not monotone: with n points the type-1 empirical q10/q90 are the sample min/max for n<=10, so coverage is exactly (n-1)/(n+1)
  // (n=5: 0.667, n=8: 0.778, n=10: 0.727 in expectation) -- the discreteness, not noise, makes the table jagged.
  near(table[5], 4 / 6, 0.03, 'n=5 interval is [min,max]: coverage (n-1)/(n+1)'); near(table[10], 8 / 11, 0.03, 'n=10 likewise');
  assert.ok(0.8 - table[5] > 0.1, 'gap at n=5 over 10 points');
  assert.ok(0.8 - table[10] > 0.05, 'gap at n=10 stays material: tail percentiles are not trustworthy below 20 sprints');
  assert.ok(table[50] > 0.74 && table[50] < 0.82, `n=50 near nominal, got ${table[50]}`);
  assert.ok(mean([table[5], table[8], table[10]]) < mean([table[30], table[50]]) - 0.04, 'small n under-covers more than large n');
});

// ---------- (2) AR(1) throughput ----------
function ar1(n: number, phi: number, g: () => number, mu = 40, s = 6) { const e = s * Math.sqrt(1 - phi * phi), x = [mu + s * normal(g)]; for (let i = 1; i < n; i++) x.push(mu + phi * (x[i - 1] - mu) + e * normal(g)); return x; }
function ar1Crps(phi: number, L: number, reps: number, n = 30, h = 4) {
  let tot = 0;
  for (let r = 0; r < reps; r++) { const x = ar1(n + h, phi, rng(50 + r)), tr = x.slice(0, n).map((d) => ({ done: d })), y = x.slice(n).reduce((a, b) => a + b, 0); tot += crps(predictDone(tr, h, 800, rng(9 + r), L), y); }
  return tot / reps;
}
test('AR(1) throughput: block bootstrap beats iid at phi=0.6 on 4-sprint totals, costs little at phi=0', () => {
  const res: Record<number, { iid: number; block2: number }> = {}; for (const phi of [0, 0.3, 0.6]) res[phi] = { iid: ar1Crps(phi, 1, 300), block2: ar1Crps(phi, 2, 300) };
  console.log('# AR(1) mean CRPS of 4-sprint total, n=30, 300 reps:', JSON.stringify(res));
  assert.ok(res[0.6].block2 < res[0.6].iid, 'phi=0.6: block 2 better than iid');
  assert.ok(res[0.6].block2 < res[0].block2 * 3, 'sanity'); assert.ok(res[0].block2 < res[0].iid * 1.06, 'phi=0: block 2 within 6% of iid');
});
test('block length: lag-1 rule only with n>=20; makeSeq blocks are consecutive and wrap', () => {
  assert.equal(chooseBlock(Array.from({ length: 19 }, (_, i) => i % 2)).L, 2);
  const g = rng(7), white = Array.from({ length: 60 }, () => normal(g)), ar = ar1(60, 0.7, rng(4));
  assert.equal(chooseBlock(white).L, 1); assert.equal(chooseBlock(ar).L, 2); assert.equal(chooseBlock(white, { block: 3 }).L, 3);
  near(lag1([1, 2, 3, 4, 5, 6]), 8.75 / 17.5, 1e-12);   // hand: consecutive products 3.75+.75-.25+.75+3.75 = 8.75; sum of squares 17.5
  const nx = makeSeq(5, 3, () => 0.99), got = Array.from({ length: 6 }, nx); assert.deepEqual(got, [4, 0, 1, 4, 0, 1]);
});

// ---------- (3) ticket noise: parameter recovery and correlation ----------
function synthTickets(n: number, P: number, S: number, par: NoiseParams, g: () => number) {
  return Array.from({ length: n }, (_, i) => ({ sp: [1, 2, 3, 5, 8][Math.floor(g() * 5)], owner: 'P' + Math.floor(g() * P), sprint: Math.floor(g() * S) }));
}
test('variance components: recovery bias/RMSE vs n for known (s_p, s_s, s_e)', () => {
  const par = { mu: 0.2, sp: 0.2, ss: 0.15, se: 0.3 }, out: Record<number, Record<string, { bias: number; rmse: number }>> = {};
  for (const n of [40, 100, 300]) {
    const e: { vp: number[]; vs: number[]; ve: number[] } = { vp: [], vs: [], ve: [] };
    for (let r = 0; r < 120; r++) {
      const g = rng(r * 31 + n), t = synthTickets(n, 8, 10, par, g), y = drawLogRatios(par, t, g), m = mean(y), v = varianceComponents(y.map((x) => x - m), t.map((x) => x.owner), t.map((x) => x.sprint));
      e.vp.push(v.vp); e.vs.push(v.vs); e.ve.push(v.ve);
    }
    const st = (a: number[], truth: number) => ({ bias: +(mean(a) - truth).toFixed(4), rmse: +Math.sqrt(mean(a.map((x) => (x - truth) ** 2))).toFixed(4) });
    out[n] = { vp: st(e.vp, 0.04), vs: st(e.vs, 0.0225), ve: st(e.ve, 0.09) };
  }
  console.log('# variance component recovery (truth vp .04, vs .0225, ve .09):', JSON.stringify(out));
  assert.ok(out[300].ve.rmse < out[40].ve.rmse && out[300].vp.rmse < out[40].vp.rmse, 'RMSE falls with n');
  for (const k of ['vp', 'vs', 've']) assert.ok(Math.abs(out[300][k].bias) < 0.02, `${k} bias at n=300 small: ${out[300][k].bias}`);
  assert.ok(out[300].ve.rmse < 0.03);
});
test('correlated model reproduces total variance; independent model underestimates by the derived factor', () => {
  // N tickets, balanced over P persons and S sprints. Var(sum y) = N sig2 + N(N/P-1) sp2 + N(N/S-1) ss2 (correlated);  N sig2 (independent).
  const par = { mu: 0, sp: 0.2, ss: 0.15, se: 0.25 }, N = 60, P = 5, S = 6, sig2 = par.sp ** 2 + par.ss ** 2 + par.se ** 2;
  const items = Array.from({ length: N }, (_, i) => ({ sp: 3, owner: 'P' + (i % P), sprint: i % S }));
  const factor = 1 + ((N / P - 1) * par.sp ** 2 + (N / S - 1) * par.ss ** 2) / sig2, runs = 20000, g = rng(11);
  const sums = (ind: boolean) => Array.from({ length: runs }, () => drawLogRatios(par, items, g, { independent: ind }).reduce((a, b) => a + b, 0));
  const vc = sd(sums(false)) ** 2, vi = sd(sums(true)) ** 2;
  near(vc / (N * sig2), factor, 0.05 * factor, 'correlated total variance'); near(vi / (N * sig2), 1, 0.05, 'independent total variance');
  assert.ok(vc / vi > 3, `independent understates by ~${factor.toFixed(2)}x, observed ${(vc / vi).toFixed(2)}`);
  // exp scale (what the plan sees): total points sum 3*exp(y); independent understates variance too
  const tot = (ind: boolean) => Array.from({ length: 6000 }, () => drawLogRatios(par, items, g, { independent: ind }).reduce((a, y) => a + 3 * Math.exp(y), 0));
  assert.ok(sd(tot(false)) / sd(tot(true)) > 1.7);
});
test('fitTicketModel: levels, floors, prior label, no -sigma^2/2 shift', () => {
  const g = rng(2), par = { mu: 0.3, sp: 0.15, ss: 0.1, se: 0.5 };   // sigma^2/2 = 0.14: a mean-preserving shift would be visible
  const mk = (n: number) => { const t = synthTickets(n, 40, 40, par, g), y = drawLogRatios(par, t, g); return t.map((x, i) => ({ key: 'K' + i, sp: x.sp, owner: x.owner, sprint: x.sprint, actual: x.sp * Math.exp(y[i]) })); };
  const none = fitTicketModel([]); assert.equal(none.source, 'prior'); assert.match(none.label, /PRIOR/); assert.equal(none.mu.M, 0.1);
  const few = fitTicketModel(mk(8)); assert.equal(few.source, 'pooled'); assert.ok((few.sigma as number) >= 0.25, 'sigma floor under 15 observations'); // a fitted model (n >= 5) has a sigma
  const big = fitTicketModel(mk(400)); assert.equal(big.source, 'class');
  near(big.mu.M, 0.3, 0.07); near(big.mu.S, 0.3, 0.07); assert.ok(big.mu.M > 0.2, 'mean log-ratio is not shifted down by sigma^2/2');
  const c8 = Array.from({ length: 8 }, (_, i) => ({ key: 'C' + i, sp: 3, owner: 'P' + (i % 2), sprint: i % 3, actual: 3 * Math.exp(0.5) }));
  near(fitTicketModel(c8).mu.M, (8 * 0.5 + 5 * 0.1) / 13, 1e-12, 'pooled mean shrunk to the 0.1 prior with weight 5');
  const thin = mk(20).map((r) => ({ ...r, sp: 8, actual: r.actual * 8 / r.sp })).map((r, i) => (i < 2 ? { ...r, sp: 1 } : r)); // class S has 2 obs -> not ticket-level
  assert.equal(fitTicketModel(thin).source, 'pooled');
  assert.equal(sizeClass(2), 'S'); assert.equal(sizeClass(3), 'M'); assert.equal(sizeClass(5), 'M'); assert.equal(sizeClass(8), 'L');
});

// ---------- (4) scope creep / carry-over compound process vs analytic ----------
test('deterministic scope creep: finish = ceil(R/(done-added))', () => {
  const h = Array.from({ length: 8 }, (_, i) => rec(i + 1, 40, 30, 10)), ends = simulateFinish(h, 100, 2000, rng(1), 2);
  assert.ok(ends.every((e) => e === 5)); // net 20 per sprint
  assert.ok(simulateFinish(h, 101, 100, rng(1), 2).every((e) => e === 6));
  const stuck = simulateFinish(Array.from({ length: 6 }, (_, i) => rec(i + 1, 40, 10, 10)), 50, 50, rng(1), 2, 30); assert.ok(stuck.every((e) => e === Infinity)); // zero net drift never finishes
  assert.ok(simulateFinish(h, 0, 10, rng(1)).every((e) => e === 0));
  // whole sprints are resampled jointly: done and added move together here (net always 30), so finish is exactly 3 for R=90.
  // Resampling done and added independently (e.g. treating tickets/fields as separate draws) would spread this out.
  const joint = [0, 10, 20, 0, 10, 20, 10, 0].map((a, i) => rec(i + 1, 40, 30 + a, a));
  for (const L of [1, 2]) assert.ok(simulateFinish(joint, 90, 2000, rng(2), L).every((e) => e === 3), `block ${L}`);
});
test('stochastic scope creep: mean and sd of finish time match Wald/renewal approximations for the empirical distribution', () => {
  const g = rng(8), h = Array.from({ length: 400 }, (_, i) => { const d = Math.max(0, 40 + 6 * normal(g)), a = g() < 0.5 ? 10 : 0; return { sprint: i + 1, planned: 40, done: d, added: a, carried: 0 }; });
  const net = h.map((r) => r.done - r.added), m = mean(net), v = sd(net) ** 2, R = 600;
  const ends = simulateFinish(h, R, 6000, rng(5), 1), mu = mean(ends), s = sd(ends);
  near(mu, R / m, 1.0, 'E[tau] ~ R/m'); near(s, Math.sqrt((R * v) / m ** 3), 0.2 * Math.sqrt((R * v) / m ** 3), 'sd[tau] ~ sqrt(R v / m^3)');
  const noCreep = simulateFinish(h.map((r) => ({ ...r, added: 0 })), R, 3000, rng(5), 1); assert.ok(mean(noCreep) < mu - 1.5, 'ignoring scope creep finishes earlier');
});

// ---------- (5) regime change, gate ----------
test('regime changes truncate history and refuse; mean shift downgrades; missing actuals downgrade', () => {
  const g = rng(1), base = Array.from({ length: 12 }, (_, i) => rec(i + 1, 40, 38 + 4 * normal(g)));
  assert.equal(assessHistory(base, {}).n, 12);
  const cfg = assessHistory(base, { regime_changes: [10] }); assert.equal(cfg.n, 3); assert.equal(decideState(cfg, null), 'REFUSED'); assert.match(cfg.reasons[0], /within last 3 sprints/);
  const team = base.map((r, i) => ({ ...r, team: i < 9 ? 5 : 4 })); assert.equal(assessHistory(team, {}).n, 3);
  const len = base.map((r, i) => ({ ...r, length: i < 6 ? 14 : 10 })); assert.equal(assessHistory(len, {}).n, 6); assert.equal(decideState(assessHistory(len, {}), null), 'PRIOR-ONLY');
  const shifted = base.map((r, i) => (i >= 9 ? { ...r, done: 20 + i * 0 } : r)); const sh = assessHistory(shifted, {}); assert.equal(sh.shift, true);
  assert.equal(decideState(sh, null), 'PRIOR-ONLY'); // 12 sprints would be PROVISIONAL, one level down
  assert.equal(decideState(assessHistory(base, {}), null), 'PROVISIONAL');
  const lacking = base.map((r, i) => (i % 3 === 0 ? { ...r, done: null } : r)); const lk = assessHistory(lacking, {}); assert.ok(lk.lackFrac > 0.3); assert.equal(lk.n, 8); assert.equal(decideState(lk, null), 'REFUSED'); // n=8 is PRIOR-ONLY, one level down is REFUSED
  assert.equal(decideState({ n: 4, lackFrac: 0, shift: false }, null), 'REFUSED'); assert.equal(decideState({ n: 7, lackFrac: 0, shift: false }, null), 'PRIOR-ONLY');
  assert.equal(decideState({ n: 25, lackFrac: 0, shift: false }, { passed: true }), 'CALIBRATED'); assert.equal(decideState({ n: 25, lackFrac: 0, shift: false }, { passed: false }), 'PROVISIONAL');
  assert.equal(decideState({ n: 25, lackFrac: 0.4, shift: false }, { passed: true }), 'PROVISIONAL'); assert.equal(decideState({ n: 6, lackFrac: 0.4, shift: false }, null), 'REFUSED');
  assert.equal(decideState({ n: 19, lackFrac: 0, shift: false }, { passed: true }), 'PROVISIONAL'); // never CALIBRATED below 20
});
test('gate in forecast(): refuses below 5 sprints with no probability, never prints probabilities', () => {
  const r = forecast({ history: hist([30, 35, 38, 33]), remaining: 120 });
  assert.equal(r.state, 'REFUSED'); assert.equal(r.probs, undefined); assert.match(r.text, /^FORECAST \[REFUSED n=4\] plan 120 pts: no probability: insufficient history/); assert.doesNotMatch(r.text, /%/);
  const r2 = forecast({ history: hist([30, 35, 38, 33, 36, 31, 34]), remaining: 120 });
  assert.equal(r2.state, 'PRIOR-ONLY'); assert.equal(r2.percentiles.P90, undefined); assert.equal(r2.percentiles.P95, undefined); assert.match(r2.text, /by S\d+: \d+-\d+%/);
});

// ---------- (6) split conformal follows the Beta law ----------
test('conformal: coverage across calibration sets has mean index/(n+1) and Beta spread', () => {
  const n = 19, alpha = 0.1, reps = 3000, cov = [], g = rng(21);
  for (let r = 0; r < reps; r++) { const sc = Array.from({ length: n }, () => Math.abs(normal(g))), { q } = conformalQuantile(sc, alpha); cov.push(2 * normCdf(q) - 1); }
  const idx = Math.ceil((n + 1) * (1 - alpha)), a = idx, b = n + 1 - idx, bmean = a / (a + b), bsd = Math.sqrt((a * b) / ((a + b) ** 2 * (a + b + 1)));
  near(mean(cov), bmean, 0.01, 'mean conditional coverage'); near(sd(cov), bsd, 0.2 * bsd, 'spread');
  assert.ok(mean(cov) >= 1 - alpha - 0.01, 'marginal coverage at least 1-alpha');
});

// ---------- backtest ----------
test('backtest: no look-ahead (trainN equals origin index) and a late outlier is surprising', () => {
  const h = hist([40, 41, 39, 40, 42, 38, 40, 41, 39, 40, 41, 1000]);
  const b = backtest(h, { runs: 400 });
  assert.ok(b.origins.every((o) => o.trainN === o.t)); assert.equal(b.origins[0].t, 3); assert.equal((b.origins.at(-1) as { t: number }).t, 11); assert.equal((b.origins.at(-1) as { y: number }).y, 1000); // origins is not empty
  const lastPit = b.methods.model.pit.at(-1); assert.equal(lastPit, 1, 'unseen outlier lies above every training-only sample');
  assert.ok(b.methods.model.crps > 50, 'training-only forecasts cannot know the outlier');
  assert.equal(b.methods.model.cover.n, 9);
});
test('backtest metrics are sane and computed on all baselines; naive plan==done gets worse with a biased plan', () => {
  const g = rng(4), h = Array.from({ length: 30 }, (_, i) => rec(i + 1, 60, 40 + 5 * normal(g)));
  const b = backtest(h, { runs: 500 }); for (const m of ['model', 'iid', 'gauss', 'naive']) assert.ok(Number.isFinite(b.methods[m].crps) && b.methods[m].crps >= 0 && b.methods[m].pit.length === 27);
  assert.ok(b.methods.model.crps < b.methods.naive.crps * 0.5, 'planned 60 vs done 40: naive is far worse');
  assert.ok(b.commit && b.commit.n === 27 && b.commit.brier >= 0);
});
test('backtest calibration on iid data: coverage CI contains 80% most of the time; gate can pass or not, but only via the rule', () => {
  let ok = 0, pass = 0; const reps = 30;
  for (let r = 0; r < reps; r++) { const g = rng(300 + r), h = Array.from({ length: 40 }, (_, i) => rec(i + 1, 40, 40 + 6 * normal(g))); const b = backtest(h, { runs: 400, seed: r + 1 }); if (b.consistent) ok++; if (b.passed) pass++; assert.equal(b.passed, b.n >= 10 && b.consistent && b.beats); }
  console.log(`# iid n=40: backtest coverage consistent in ${ok}/${reps}, gate passed in ${pass}/${reps}`);
  assert.ok(ok >= reps * 0.8);
});

// ---------- plan graph ----------
test('plan graph: delivery ratio 1 reproduces the plan; scope creep and slow delivery push it later; deterministic', () => {
  const model = buildModel(genPlan({ n: 25, people: 3, density: 0.12, seed: 3, cap: 12 }));
  const plan = Math.max(...[...model.sched.values()].map((s) => s.sprint as number)), perfect = hist(Array(8).fill(40)); // genPlan places every ticket in a sprint
  const a = simulatePlan(model, perfect, { runs: 2000, seed: 1, start: 1 }); assert.ok(a.ends.every((e) => e >= plan));
  const exact = buildModel(genPlan({ n: 25, people: 3, density: 0.12, seed: 3, cap: 1000 })), planE = Math.max(...[...exact.sched.values()].map((s) => s.sprint as number)); // genPlan places every ticket in a sprint
  assert.ok(simulatePlan(exact, perfect, { runs: 2000, seed: 1, start: 1 }).ends.every((e) => e === planE), 'no noise + unlimited capacity = planned end');
  const slow = hist(Array(8).fill(30)), s = simulatePlan(model, slow, { runs: 2000, seed: 1, start: 1 }), c = simulatePlan(model, hist(Array(8).fill(40), 40, 12), { runs: 2000, seed: 1, start: 1 });
  assert.ok(mean(s.ends) > mean(a.ends) && mean(c.ends) > mean(a.ends));
  assert.deepEqual(simulatePlan(model, slow, { runs: 2000, seed: 1, start: 1 }).ends, s.ends);
  assert.ok(simulatePlan(model, slow, { runs: 10, seed: 1 }).ends.length >= 2000, 'at least 2000 runs enforced');
});
test('plan graph ticket mode: correlated noise widens the end-sprint distribution vs independent noise at equal marginal variance', () => {
  const model = buildModel(genPlan({ n: 30, people: 3, density: 0.1, seed: 5, cap: 14 })), h = hist(Array(8).fill(40));
  const withB = { mu: { S: 0, M: 0, L: 0 }, sp: 0.4, ss: 0.3, se: 0.1 }, indep = { mu: { S: 0, M: 0, L: 0 }, sp: 0.01, ss: 0.01, se: Math.sqrt(0.4 ** 2 + 0.3 ** 2 + 0.1 ** 2) };
  const a = simulatePlan(model, h, { runs: 3000, seed: 2, start: 1, mode: 'ticket', noise: withB }).ends, b = simulatePlan(model, h, { runs: 3000, seed: 2, start: 1, mode: 'ticket', noise: indep }).ends;
  assert.ok(sd(a) > sd(b) * 1.15, `correlated sd ${sd(a)} vs independent ${sd(b)}`);
});
test('plan graph treats done tickets and unknown story points sanely, rejects loops', () => {
  const m = buildModel({ tickets: [{ key: 'A', sp: 3, jira_status: 'Done' }, { key: 'B', sp: null }, { key: 'C', sp: 4 }], edges: [{ consumer: 'B', producer: 'A', kind: 'x' }, { consumer: 'C', producer: 'B', kind: 'x' }], schedule: [{ key: 'A', owner: 'Ana', sprint: 1 }, { key: 'B', owner: 'Ben', sprint: 2 }, { key: 'C', owner: 'Cleo', sprint: 3 }], config: { caps: { default: 20 } } });
  const r = simulatePlan(m, hist(Array(6).fill(40)), { runs: 2000, start: 5 }); assert.equal(r.tickets, 2); assert.equal(r.missingSp, 1); assert.ok(r.ends.every((e) => e >= 6));
  const loop = buildModel({ tickets: [{ key: 'A', sp: 1 }, { key: 'B', sp: 1 }], edges: [{ consumer: 'A', producer: 'B', kind: 'x' }, { consumer: 'B', producer: 'A', kind: 'x' }], schedule: [{ key: 'A', owner: 'x', sprint: 1 }, { key: 'B', owner: 'x', sprint: 1 }], config: {} });
  assert.throws(() => simulatePlan(loop, hist(Array(6).fill(40)), { runs: 2000 }), /loop/);
});

// ---------- end to end output ----------
test('forecast output: tags, rounding, tail suppression, tokens, MC standard error', () => {
  const g = rng(12), h = Array.from({ length: 14 }, (_, i) => rec(i + 1, 40, 36 + 5 * normal(g), 4));
  const f = forecast({ history: h, remaining: 150, seed: 3 });
  assert.equal(f.state, 'PROVISIONAL'); assert.ok(f.runs >= 2000); assert.ok(f.tokens <= 100, `${f.tokens} tokens: ${f.text}`);
  assert.match(f.text, /^FORECAST \[PROVISIONAL n=14, model-conditional, not a prediction\]/); assert.ok(Object.keys(f.percentiles).join() === 'P50,P80,P90');
  for (const p of f.probs) { assert.ok(p.se >= 0 && p.se <= 0.5 / Math.sqrt(f.runs) + 1e-9); }
  for (const m of f.text.matchAll(/~(\d+)%/g)) assert.equal(+m[1] % 10, 0, 'rounded to 10 below n=20');
  assert.deepEqual(forecast({ history: h, remaining: 150, seed: 3 }).text, f.text, 'deterministic');
  const long = forecast({ history: Array.from({ length: 32 }, (_, i) => rec(i + 1, 40, 38 + 3 * normal(g), 3)), remaining: 150, seed: 3 });
  assert.ok('P95' in (long.percentiles as Record<string, number>) === (long.n >= 30)); for (const m of long.text.matchAll(/~(\d+)%/g)) assert.equal(+m[1] % 5, 0); // not refused: percentiles are set
});
test('renderForecast: tail probabilities are clipped, REFUSED carries no numbers', () => {
  const base = { state: 'PROVISIONAL' as const, n: 12, probs: [{ sprint: 5, p: 0.01 }, { sprint: 6, p: 0.99 }], percentiles: { P50: 6 }, lastDone: 3, backtest: { n: 0 } as { n: number; k: number; ci: number[]; beats: boolean }, reasons: [] }; // with n = 0 no other backtest field is read
  assert.match(renderForecast(base), /by S5: <10% \| by S6: >90%/);
  assert.match(renderForecast({ ...base, n: 25, state: 'CALIBRATED' }), /by S5: <5% \| by S6: >95%/);
  assert.match(renderForecast({ ...base, backtest: { k: 7, n: 9, ci: [0.4, 0.97], beats: true } }), /\(backtest 7\/9 inside, CI 40-97%\)/);
});

// Review M5/M6: a plan whose links contain a loop crashed forecast (internal error, exit 5); a plan with every ticket Done printed
// "done by S0: >90% ... P50 S0". Both are REFUSED with a plain reason and no numbers.
test('forecast refuses a plan with a loop and a plan with nothing left, without numbers', () => {
  const h = hist([30, 34, 31, 36, 33, 35, 32, 34, 30, 33, 35, 31]);
  const mk = (status: string, edges: Edge[]) => buildModel({ tickets: [{ key: 'A', sp: 3, jira_status: status }, { key: 'B', sp: 2, jira_status: status }], edges,
    schedule: [{ key: 'A', owner: 'Ana', sprint: 13 }, { key: 'B', owner: 'Ana', sprint: 14 }], config: { caps: { default: 40 } } });
  const loop = forecast({ history: h, model: mk('To Do', [{ consumer: 'A', producer: 'B', kind: 'x' }, { consumer: 'B', producer: 'A', kind: 'x' }]), seed: 1 });
  assert.equal(loop.state, 'REFUSED'); assert.equal(loop.text, 'FORECAST [REFUSED n=12] plan ? pts: no probability: the links contain a loop (run `brain check`)');
  const done = forecast({ history: h, model: mk('Done', []), seed: 1 });
  assert.equal(done.state, 'REFUSED'); assert.equal(done.text, 'FORECAST [REFUSED n=12] plan 0 pts: no probability: nothing left to forecast: every planned ticket is done');
  assert.doesNotMatch(done.text, /S0|%/);
  // with no history, the plan-shape reason still comes first
  assert.match(forecast({ history: [], model: mk('Done', []) }).text, /no probability: nothing left to forecast/);
});
