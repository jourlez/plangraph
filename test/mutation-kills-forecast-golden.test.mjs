// Characterization goldens for lib/forecast.mjs (test/golden/mutation-kills/forecast.json, UPDATE_GOLDEN=1 rewrites): the forecaster is
// deterministic for a seed, so the exact output of every public function on fixed inputs is a behavior contract. Each case exercises a
// branch the statistical tests in test/forecast.test.mjs only bound loosely (class-level ticket model, plan simulation in both modes with
// a horizon that runs out, backtest at h=1 and h=2, regime cuts by team, length and config, the wide band below 10 sprints, P90/P95).
// The goldens were captured from the current code and reviewed for plausibility (monotone percentiles, probabilities in [0,1]); they
// pin the numbers, they do not prove them right: correctness is argued by test/forecast.test.mjs and test/mutation-kills-forecast.test.mjs.
import { test } from 'node:test';
import {
  rng, normal, crps, pit, pinball, normCdf, conformalQuantile, fitTicketModel, makeFactors, drawLogRatios, simulatePlan, backtest,
  assessHistory, decideState, forecast, renderForecast, predictDone, simulateFinish,
} from '../lib/forecast.mjs';
import { buildModel } from '../lib/model.mjs';
import { genPlan } from './fixtures/gen.mjs';
import { golden, outcome } from './helpers/golden-json.mjs';

const G = (/** @type {string} */ name, /** @type {() => unknown} */ fn) => golden('forecast', name, outcome(fn));
const rec = (/** @type {number} */ sprint, /** @type {number} */ planned, /** @type {number} */ done, added = 0, extra = {}) => ({ sprint, planned, done, added, carried: Math.max(0, planned + added - done), ...extra });
const series = (/** @type {number} */ n, seed = 1, base = 30, spread = 10) => { const r = rng(seed); return Array.from({ length: n }, (_, i) => rec(i + 1, base + 5, Math.round(base - spread / 2 + spread * r()), Math.round(3 * r()))); };
/** summary of a sample of sprint ends: sorted distinct values with counts */
const dist = (/** @type {number[]} */ a) => { const m = new Map(); for (const x of a) m.set(String(x), (m.get(String(x)) || 0) + 1); return [...m].sort((x, y) => (Number(x[0]) || Infinity) - (Number(y[0]) || Infinity)); };
const rows = (/** @type {number} */ n, seed = 4) => { const r = rng(seed), sps = [1, 2, 3, 5, 8, 13]; return Array.from({ length: n }, (_, i) => { const sp = sps[i % sps.length]; return { key: `K${String(i).padStart(3, '0')}`, sp, actual: sp * Math.exp(0.3 * normal(r) + 0.1), owner: ['Ana', 'Ben', 'Cleo'][i % 3], sprint: 1 + (i % 5) }; }); };

test('scores and small functions on a grid', () => {
  G('normal', () => { const r = rng(9); return Array.from({ length: 6 }, () => normal(r)); });
  G('crps', () => [crps([1, 2, 3, 4], 2.5), crps([5], 3), crps([1, 1, 4], 0), crps([2, 9, 4, 4, 1], 10)]);
  G('pit', () => [pit([1, 2, 2, 3], 2), pit([1, 2, 3], 0), pit([1, 2, 3], 9), pit([4, 4], 4)]);
  G('pinball', () => [pinball(5, 0.9, 7), pinball(5, 0.9, 3), pinball(5, 0.1, 5), pinball(2, 0.5, 2.5)]);
  G('normCdf', () => [-3, -1.5, -0.2, 0.2, 1, 2.5].map(normCdf));
  G('conformal', () => [conformalQuantile([3, 1, 2], 0.5), conformalQuantile([3, 1, 2, 5, 4], 0.1), conformalQuantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.2)]);
  G('predictDone-L1', () => predictDone(series(6), 3, 12, rng(3), 1));
  G('simulateFinish-L3', () => simulateFinish(series(7), 70, 12, rng(5), 3, 6));
});

test('ticket model: class level, pooled at >= 15, pooled below 15, factors and log-ratio draws', () => {
  G('fit-class-24', () => fitTicketModel(rows(24)));
  G('fit-class-18', () => fitTicketModel(rows(18, 7)));
  G('fit-pooled-16-missing-class-count', () => fitTicketModel(rows(16).filter((r) => r.sp !== 13).concat(rows(2, 9).map((r) => ({ ...r, key: `Z${r.key}`, sp: 13 })))));
  G('fit-pooled-9', () => fitTicketModel(rows(9)));
  G('fit-one-person-one-sprint-20', () => fitTicketModel(rows(20).map((r) => ({ ...r, owner: 'Ana', sprint: 1 }))));
  const par = fitTicketModel(rows(24));
  G('factors', () => { const f = makeFactors(par, rng(2)); return [f.person('Ana'), f.person('Ben'), f.person('Ana'), f.sprint(1), f.sprint(2), f.sprint(1)]; });
  const tickets = [{ sp: 1, owner: 'Ana', sprint: 1 }, { sp: 5, owner: 'Ana', sprint: 2 }, { sp: 13, owner: 'Ben', sprint: 1 }];
  G('draws-correlated', () => drawLogRatios(par, tickets, rng(6)));
  G('draws-independent', () => drawLogRatios(par, tickets, rng(6), { independent: true }));
  G('draws-scalar-mu', () => drawLogRatios({ ...par, mu: 0.2 }, tickets, rng(6)));
});

const plan = () => {
  const p = genPlan({ n: 18, people: 3, seed: 11, cap: 12 });
  /** @type {any} */ (p.tickets[2]).sp = undefined; p.tickets[5].jira_status = 'Done'; p.tickets[7].sp = 0;
  return buildModel(p);
};

test('plan simulation: capacity and ticket modes, done keys, a horizon that runs out, default start after the history', () => {
  const m = plan(), h = series(8, 2);
  const sum = (/** @type {Record<string, any>} */ s) => ({ ...s, ends: dist(s.ends) });
  G('plan-capacity', () => sum(simulatePlan(m, h, { runs: 2000, seed: 3 })));
  G('plan-capacity-start1', () => sum(simulatePlan(m, h, { runs: 2000, seed: 3, start: 1, doneKeys: ['T-1', 'T-2'] })));
  G('plan-ticket', () => sum(simulatePlan(m, h, { runs: 2000, seed: 4, start: 1, mode: 'ticket', noise: fitTicketModel(rows(24)) })));
  G('plan-horizon-2', () => sum(simulatePlan(m, series(8, 3, 6, 2), { runs: 2000, seed: 5, start: 1, horizon: 2 })));
  G('plan-L1-default-noise-ticket', () => sum(simulatePlan(m, h, { runs: 2000, seed: 6, start: 1, L: 1, mode: 'ticket' })));
});

test('backtest at h=1 and h=2, and with a configured block', () => {
  const h = series(16, 8);
  const slim = (/** @type {Record<string, any>} */ b) => ({ ...b, methods: Object.fromEntries(Object.entries(b.methods).map(([k, v]) => [k, { ...v, pit: v.pit.slice(0, 6) }])) });
  G('backtest-h1', () => slim(backtest(h, { runs: 300, seed: 2 })));
  G('backtest-h2-block1', () => slim(backtest(h, { runs: 300, seed: 2, horizon: 2, block: 1, minTrain: 4, lastN: 3 })));
  G('backtest-empty', () => slim(backtest(series(3), { runs: 100 })));
});

test('history assessment and the state gate', () => {
  G('assess-team-change', () => assessHistory(series(12).map((r, i) => ({ ...r, team: i < 9 ? 5 : 6 }))));
  G('assess-length-change', () => assessHistory(series(12).map((r, i) => ({ ...r, length: i < 4 ? 10 : 14 }))));
  G('assess-config-cuts', () => assessHistory(series(12), { regime_changes: [3, { sprint: 6 }, 'x', { sprint: 99 }] }));
  G('assess-shift', () => assessHistory([...series(9), rec(10, 35, 60), rec(11, 35, 62), rec(12, 35, 61)]));
  G('assess-shift-zero-se', () => assessHistory([...Array.from({ length: 6 }, (_, i) => rec(i + 1, 35, 30)), rec(7, 35, 50), rec(8, 35, 50), rec(9, 35, 50)]));
  G('assess-lacking', () => assessHistory(series(10).map((r, i) => (i % 2 ? { ...r, done: null } : r))));
  G('assess-unsorted-and-cut-before-start', () => assessHistory([...series(6)].reverse(), { regime_changes: [0] }));
  G('decide', () => [0, 4, 5, 9, 10, 19, 20, 40].flatMap((n) => [
    decideState({ n, lackFrac: 0, shift: false }, { passed: true }), decideState({ n, lackFrac: 0.31, shift: false }, { passed: true }),
    decideState({ n, lackFrac: 0.3, shift: true }, null), decideState({ n, lackFrac: 0, shift: false }, { passed: false }),
  ]));
});

test('forecast(): flat backlog, plan graph, wide band, P90/P95, targets, refusals', () => {
  const trim = (/** @type {Record<string, any>} */ r) => r;
  G('fc-flat-7', () => trim(forecast({ history: series(7), remaining: 120, runs: 2000, targets: [11, 12] })));
  G('fc-flat-12', () => trim(forecast({ history: series(12), remaining: 150, runs: 2000, seed: 2 })));
  G('fc-flat-32-targets', () => trim(forecast({ history: series(32, 3), remaining: 200, runs: 2000, targets: [38, 39, 40] })));
  G('fc-plan-22', () => trim(forecast({ history: series(22, 5), model: plan(), runs: 2000, start: 1 })));
  G('fc-plan-ticket-actuals', () => trim(forecast({ history: series(11, 6), model: plan(), actuals: rows(20), runs: 2000, seed: 3, start: 1, targets: [5, 6, 7] })));
  G('fc-plan-mode-capacity-with-actuals', () => trim(forecast({ history: series(11, 6), model: plan(), actuals: rows(20), mode: 'capacity', runs: 2000, seed: 3, start: 1, targets: [5, 6, 7] })));
  G('fc-refuse-short', () => forecast({ history: series(4), remaining: 10 }));
  G('fc-refuse-loop', () => forecast({ history: series(8), model: buildModel({ tickets: [{ key: 'A', sp: 1 }, { key: 'B', sp: 1 }], edges: [{ consumer: 'A', producer: 'B' }, { consumer: 'B', producer: 'A' }], schedule: [{ key: 'A', owner: 'x', sprint: 1 }, { key: 'B', owner: 'x', sprint: 1 }] }) }));
  G('fc-refuse-nothing-left', () => forecast({ history: series(8), model: buildModel({ tickets: [{ key: 'A', sp: 1, jira_status: 'Done' }], schedule: [{ key: 'A', owner: 'x', sprint: 1 }] }) }));
  G('fc-defaults', () => forecast());
});

test('renderForecast on hand-built results', () => {
  const base = { n: 12, probs: [{ sprint: 5, p: 0.04 }, { sprint: 6, p: 0.5 }, { sprint: 7, p: 0.97 }], percentiles: { P50: 6, P80: 7, P90: Infinity }, lastDone: 3, reasons: [], backtest: { n: 0, k: 0, ci: [0, 1], beats: false } };
  G('render-provisional', () => renderForecast({ ...base, state: 'PROVISIONAL' }));
  G('render-calibrated-25', () => renderForecast({ ...base, state: 'CALIBRATED', n: 25, backtest: { n: 20, k: 16, ci: [0.563, 0.943], beats: true }, reasons: ['a', 'b'] }));
  G('render-no-beat', () => renderForecast({ ...base, state: 'PROVISIONAL', backtest: { n: 9, k: 3, ci: [0.07, 0.7], beats: false } }));
  G('render-prior-only', () => renderForecast({ ...base, state: 'PRIOR-ONLY', n: 6, probs: [{ sprint: 5, p: 0.4, lo: 0.13, hi: 0.66 }] }));
  G('render-refused', () => [renderForecast({ state: 'REFUSED', n: 2, planPoints: null }), renderForecast({ state: 'REFUSED', n: 2, planPoints: 30, reasons: ['x', 'y'] })]);
});

test('ticket model boundaries: exactly 15 rows, a class with exactly 3, with 1, with none; exactly 14 rows with no spread', () => {
  const exact = (/** @type {number[]} */ sps, f = 1.1) => sps.map((sp, i) => ({ key: `E${String(i).padStart(3, '0')}`, sp, actual: sp * f * (1 + (i % 3) * 0.01), owner: ['Ana', 'Ben'][i % 2], sprint: 1 + (i % 4) }));
  const sm = (/** @type {number} */ n) => Array.from({ length: n }, (_, i) => [1, 2, 3, 5][i % 4]);
  G('fit-15-low-spread', () => fitTicketModel(exact([...sm(9), 8, 8, 13, 13, 8, 13])));
  G('fit-15-L3', () => fitTicketModel(exact([...sm(12), 8, 13, 8])));
  G('fit-15-L1', () => fitTicketModel(exact([...sm(14), 13])));
  G('fit-15-noL', () => fitTicketModel(exact(sm(15))));
  G('fit-14-low-spread', () => fitTicketModel(exact([...sm(8), 8, 8, 13, 13, 8, 13])));
  G('fit-16-wide', () => fitTicketModel(exact([...sm(10), 8, 8, 13, 13, 8, 13], 2).map((r, i) => ({ ...r, actual: r.actual * (i % 2 ? 3 : 0.4) }))));
});

test('backtest and assessment boundaries: exactly 10 and 11 origins, a passing gate, exactly 8 records, cuts at the edges', () => {
  const steady = (/** @type {number} */ n) => Array.from({ length: n }, (_, i) => rec(i + 1, 30, 30 + ((i * 7) % 5) - 2, i % 3 === 0 ? 1 : 0));
  const slim = (/** @type {Record<string, any>} */ b) => ({ ...b, methods: Object.fromEntries(Object.entries(b.methods).map(([k, v]) => [k, { ...v, pit: v.pit.length }])), origins: b.origins.length });
  G('backtest-13', () => slim(backtest(steady(13), { runs: 400, seed: 4 })));
  G('backtest-14', () => slim(backtest(steady(14), { runs: 400, seed: 4 })));
  G('backtest-30', () => slim(backtest(steady(30), { runs: 400, seed: 5 })));
  G('assess-8', () => assessHistory([...Array.from({ length: 5 }, (_, i) => rec(i + 1, 35, 20 + i)), rec(6, 35, 40), rec(7, 35, 41), rec(8, 35, 42)]));
  G('assess-7', () => assessHistory([...Array.from({ length: 4 }, (_, i) => rec(i + 1, 35, 20 + i)), rec(5, 35, 40), rec(6, 35, 41), rec(7, 35, 42)]));
  G('assess-cut-last', () => assessHistory(series(10), { regime_changes: [10] }));
  G('assess-cut-last-minus-3', () => assessHistory(series(10), { regime_changes: [7] }));
  G('assess-cut-last-minus-2', () => assessHistory(series(10), { regime_changes: [8] }));
  G('assess-two-cuts', () => assessHistory(series(12), { regime_changes: [9, 4] }));
});

test('backtest edge histories: one origin, Gaussian samples below zero, a planned size of 1, and the gate over autocorrelated series', () => {
  const slim = (/** @type {Record<string, any>} */ b) => ({ ...b, methods: Object.fromEntries(Object.entries(b.methods).map(([k, v]) => [k, { ...v, pit: v.pit.length }])), origins: b.origins.length });
  G('backtest-one-origin', () => slim(backtest(series(4), { runs: 200, seed: 3 })));
  G('backtest-negative-gauss', () => slim(backtest([0, 20, 0, 20, 0, 20, 0, 20].map((d, i) => rec(i + 1, 10, d)), { runs: 300, seed: 3 })));
  G('backtest-planned-1', () => slim(backtest([0, 1, 0, 2, 1, 0, 1].map((d, i) => rec(i + 1, 1, d)), { runs: 200, seed: 3 })));
  G('backtest-ar-gate', () => Array.from({ length: 30 }, (_, i) => i + 1).map((seed) => {
    const r = rng(seed); let x = 0;
    const h = Array.from({ length: 24 }, (_, i) => { x = 0.8 * x + 6 * normal(r); return rec(i + 1, 30, Math.max(0, Math.round(30 + x))); });
    const b = /** @type {any} */ (backtest(h, { runs: 300, seed }));
    return [b.n, b.beats, b.consistent, b.passed, b.methods.model.crps < Math.min(b.methods.iid.crps, b.methods.gauss.crps, b.methods.naive.crps), b.methods.model.pinball < Math.min(b.methods.iid.pinball, b.methods.gauss.pinball, b.methods.naive.pinball)];
  }));
});

test('forecast boundaries: history sizes 5, 6, 10, 11, 20, 21, 30, 31; 15 and 16 actuals; probabilities at the clip edges', () => {
  for (const n of [5, 6, 10, 11, 20, 21, 30, 31]) G(`fc-n${n}`, () => forecast({ history: series(n, n), remaining: 40 + 3 * n, runs: 2000 }).text);
  G('fc-actuals-15-16', () => [15, 16].map((k) => forecast({ history: series(11, 6), model: plan(), actuals: rows(k), runs: 2000, start: 1 }).mode));
  G('fc-plan-loop-other-error', () => outcome(() => forecast({ history: series(8), model: /** @type {any} */ ({ sched: { keys: () => { throw new TypeError('broken model'); } } }) })));
  const base = { n: 12, percentiles: { P50: 6 }, lastDone: 3, reasons: [], backtest: { n: 0, k: 0, ci: [0, 1], beats: false } };
  G('render-edges', () => [0.1, 0.0999, 0.9, 0.9001, 0.05, 0.95, 0.951, 0.049, 0.5049, 0.555].map((p) => renderForecast({ ...base, state: 'PROVISIONAL', probs: [{ sprint: 5, p }] })).concat([20, 21].map((n) => renderForecast({ ...base, n, state: 'PROVISIONAL', probs: [{ sprint: 5, p: 0.07 }] }))).concat([renderForecast({ ...base, state: 'PRIOR-ONLY', n: 6, probs: [{ sprint: 5, p: 0.4, lo: 0.1, hi: 0.905 }] })]));
  G('assess-shift-edges', () => [
    assessHistory([...Array.from({ length: 5 }, (_, i) => rec(i + 1, 35, 30 + (i % 2))), rec(6, 35, 39), rec(7, 35, 40), rec(8, 35, 39)]),
    assessHistory([...Array.from({ length: 5 }, (_, i) => rec(i + 1, 35, 0)), rec(6, 35, 5), rec(7, 35, 5), rec(8, 35, 5)]),
    assessHistory([...Array.from({ length: 6 }, (_, i) => rec(i + 1, 35, 10 + 4 * (i % 2))), rec(7, 35, 16), rec(8, 35, 15), rec(9, 35, 17)]),
    assessHistory(series(10).map((r, i) => (i % 10 < 3 ? { ...r, done: null } : r))),
  ]);
  G('decide-lack-edge', () => [decideState({ n: 12, lackFrac: 0.3, shift: false }, null), decideState({ n: 12, lackFrac: 0.30001, shift: false }, null)]);
});
