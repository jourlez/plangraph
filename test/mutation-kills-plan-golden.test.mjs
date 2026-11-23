// Characterization goldens for lib/verify.mjs and lib/whatif.mjs (test/golden/mutation-kills/plan.json, UPDATE_GOLDEN=1 rewrites),
// written to kill mutants that survived scripts/mutate-all.mjs: verifyPlan and summarize on generated plans perturbed into every
// violation kind (with frozen tickets, a bad first_sprint, MINLOAD on and off, a huge sprint span, cycles, sp: keys), and an exhaustive
// sweep of whatif moves (every ticket to every person and sprint in range, plus overflow) on small capacity-tight plans with started
// tickets, rendered with renderWhatif, and proposeMove under each repair option. Plans come from test/fixtures/gen.mjs (invented names).
// The goldens pin today's answers; their correctness is argued by test/verify.test.mjs (independent of the solver) and
// test/whatif.test.mjs (oracle checks), not by these files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyPlan, summarize } from '../lib/verify.mjs';
import { whatif, proposeMove, renderWhatif, applyMoves } from '../lib/whatif.mjs';
import { buildModel } from '../lib/model.mjs';
import { genPlan } from './fixtures/gen.mjs';
import { golden, outcome } from './helpers/golden-json.mjs';

const G = (/** @type {string} */ name, /** @type {() => unknown} */ fn) => golden('plan', name, outcome(fn));
/** @param {number} seed @param {number} cap @param {(p: any) => void} [tweak] */
const plan = (seed, cap, tweak) => { const p = genPlan({ n: 12, people: 3, seed, cap, density: 0.2 }); if (tweak) tweak(p); return buildModel(p); };
const short = (/** @type {any[]} */ vs) => vs.map((v) => `${v.code} ${v.key} ${v.detail}`);

test('verifyPlan and summarize across violation kinds and options', () => {
  const m = plan(3, 6, (p) => {
    p.schedule[4].sprint = 0; p.schedule[5].owner = ''; p.schedule.push({ version: 'current', key: 'GHOST', owner: 'Ana', sprint: 1 });
    p.tickets.push({ key: 'sp:plan/1', sp: 2 }, { key: 'sp:plan/2', sp: 1 }); p.schedule.push({ version: 'current', key: 'sp:plan/2', owner: 'Ben', sprint: 2 });
    p.edges.push({ consumer: 'T-1', producer: 'T-12', kind: 'plan_need' }, { consumer: 'T-12', producer: 'T-1', kind: 'plan_need' });
    p.tickets[2].jira_status = 'Done'; p.tickets[3].jira_status = 'Closed'; p.tickets[6].sp = 'x';
    p.config.closed_statuses = ['Closed']; p.config.min_per_sprint = { default: 3, Cleo: 4 }; p.config.caps = { default: 6, Ana: 4 };
  });
  G('verify-plain', () => short(verifyPlan(m)));
  G('verify-min', () => short(verifyPlan(m, m.sched, { enforceMin: true })));
  const frozen = new Map([['T-2', { owner: 'Zed', sprint: 9 }], ['T-3', { ...m.sched.get('T-3') }], ['NOPE', { owner: 'x', sprint: 1 }]]);
  G('verify-frozen', () => short(verifyPlan(m, m.sched, { frozen })));
  for (const fs of [0, 2, 1.5, 2e6, -3]) G(`verify-first-${fs}`, () => short(verifyPlan({ ...m, config: { ...m.config, first_sprint: fs } }, m.sched, { enforceMin: true })));
  G('verify-frozen-before', () => short(verifyPlan({ ...m, config: { ...m.config, first_sprint: 3, frozen_before_sprint: 2, frozen_statuses: ['Blocked'] } })));
  const far = new Map(m.sched); far.set('T-1', { owner: 'Ana', sprint: 5000 });
  G('verify-span', () => short(verifyPlan(m, far, { enforceMin: true })));
  G('verify-cycles', () => short(verifyPlan(buildModel({ tickets: ['A', 'B', 'C', 'D'].map((key) => ({ key })), edges: [['A', 'B'], ['B', 'C'], ['C', 'A'], ['C', 'D'], ['D', 'C'], ['B', 'A']].map(([consumer, producer]) => ({ consumer, producer })), schedule: ['A', 'B', 'C', 'D'].map((key) => ({ key, owner: 'x', sprint: 5 })) }))));
  G('summary', () => [summarize(m), summarize(m, m.sched, { baseline: new Map([['T-1', 'Zed'], ['T-2', null]]) })]);
  G('verify-valid', () => verifyPlan(plan(5, 1000)));
});

test('whatif sweep: every ticket to every person and sprint, rendered', () => {
  for (const [seed, cap] of [[7, 5], [11, 8]]) {
    const m = plan(seed, cap, (p) => { p.tickets[1].jira_status = 'In Progress'; p.tickets[4].jira_status = 'Done'; p.config.end_sprint = 5; });
    /** @type {string[]} */ const out = [];
    for (const key of [...m.sched.keys()].sort()) {
      for (const to of [null, 'Ana', 'ben', 'Cleo', 'Nobody']) for (const sprint of [null, 0, 1, 2, 3, 4, 5, 6]) {
        if (to === null && sprint === null) continue;
        const mv = { key, ...(to ? { to } : {}), ...(sprint !== null ? { sprint } : {}) };
        const r = whatif(m, mv);
        out.push(`${key}>${to}@${sprint}: ${renderWhatif(r)}`);
      }
    }
    G(`sweep-${seed}`, () => out);
  }
});

test('whatif options and proposeMove under each repair option', () => {
  const m = plan(7, 5, (p) => { p.tickets[1].jira_status = 'In Progress'; Object.assign(p.config, { frozen_statuses: ['In Progress'] }); p.config.end_sprint = 5; p.config.caps.Ben = 3; p.config.caps.Dora = 9; });
  const keys = [...m.sched.keys()].sort();
  G('whatif-strict', () => renderWhatif(whatif(m, { key: 'T-2', sprint: 4 }, { strict: true })));
  G('whatif-overflow', () => [whatif(m, { key: keys[0], sprint: 9 }, { allowOverflow: true }), whatif(m, { key: keys[0], sprint: 30 }, { allowOverflow: true, overflowLimit: 3 })].map((r) => renderWhatif(r)));
  G('whatif-people', () => renderWhatif(whatif(m, { key: keys[0], to: 'dora' }, { people: ['Eve Long'] })));
  G('whatif-unknown', () => [renderWhatif(whatif(m, { key: 'NOPE', sprint: 1 })), renderWhatif(whatif(m, { key: keys[0], to: 'e' }, { people: ['Eve Long', 'Eve Short'] }))]);
  G('whatif-raw', () => whatif(m, { key: keys[3], sprint: 1 }));
  const opts = [{}, { allowSlip: true }, { allowEarlier: true }, { allowOwnerChange: true }, { allowSlip: true, allowOwnerChange: true, allowEarlier: true }, { allowSlip: true, budget: 2 }, { allowOwnerChange: true, workLimit: 50 }];
  /** @type {string[]} */ const res = [];
  for (const key of keys.slice(0, 8)) for (const sprint of [1, 3, 5]) for (const o of opts) {
    const r = proposeMove(m, { key, sprint }, o);
    res.push(`${key}@${sprint} ${JSON.stringify(o)}: ${r.ok} ${JSON.stringify(r.moves)} ${JSON.stringify({ shifted: r.shifted, ownerChanges: r.ownerChanges, slipped: r.slipped, complete: r.searchComplete, nodes: r.nodes })} ${short(r.reasons || []).join('; ')}`);
    if (r.ok) assert.deepEqual(verifyPlan(m, applyMoves(m.sched, r.moves)).filter((v) => v.code === 'HANDOFF' && v.key === key), [], 'a repair never leaves the moved ticket behind its producers');
  }
  G('propose', () => res);
});

test('renderWhatif on hand-built results', () => {
  const base = { ripple: [{ key: 'K', to: { owner: 'Ana', sprint: 3 } }], load: { Ana: { 3: { before: 2, after: 5, cap: 8 } }, Ben: { 2: { before: 4, after: 1, cap: 8 } } }, freed: { owner: 'Ben', sprint: 2, sp: 3 } };
  G('render', () => [
    renderWhatif({ ...base, ok: true, reasons: [] }),
    renderWhatif({ ...base, ok: true, reasons: [{ code: 'STARTED', key: 'K', detail: 'status In Progress', warn: true }], freed: { owner: 'Ben', sprint: 2, sp: 0 } }),
    renderWhatif({ ...base, ok: false, reasons: Array.from({ length: 10 }, (_, i) => ({ code: 'X', key: `K${i}`, detail: 'd', fix: 'f' })) }, { limit: 3 }),
    renderWhatif({ ...base, ok: false, reasons: [{ code: 'CAPACITY', key: 'Ana S3', detail: '9/8' }], suggestion: { sprint: 4, owner: 'Ana', shifts: 1, ownerChanges: 0, flags: ['slip'] } }),
    renderWhatif({ ...base, ok: false, reasons: [{ code: 'CAPACITY', key: 'Ana S3', detail: '9/8' }], suggestion: { sprint: 3, owner: 'Ana', shifts: 2, ownerChanges: 1, flags: [] } }),
    renderWhatif({ ...base, ok: false, reasons: [{ code: 'CAPACITY', key: 'Ana S3', detail: '9/8' }], suggestion: { none: true } }),
    renderWhatif({ ripple: [], load: {}, ok: false, reasons: [{ code: 'UNKNOWN_TICKET', key: 'Q', detail: 'not in plan', fix: 'check the key' }] }),
    renderWhatif({ ripple: [], load: {}, ok: false, reasons: [] }),
  ]);
});
