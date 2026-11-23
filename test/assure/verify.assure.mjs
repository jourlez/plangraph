// Property (a): lib/verify.mjs verifyPlan == the clean-room oracle (oracle.mjs) on EVERY instance of the families below.
// Compared: the multiset of (code, key) for every non-CYCLE violation, plus the producer for HANDOFF (taken from the detail text, which
// names it). CYCLE is compared by facts, not by representative: the spec says a loop is reported, not which rotation of which elementary
// cycle is printed. So: every reported path is a real cycle of live edges, its key is its smallest node, no path is printed twice, and
// every strongly connected component that holds a cycle (a self-link counts) has at least one reported path; no CYCLE on an acyclic graph.
// NOT covered: instances beyond the bounds in BOUNDS (exhaustive within them, not a proof beyond), first_sprint values outside the small
// domain (the +-1000000 edge is in the hand tests of test/verify.test.mjs), the MINLOAD span guard (needs a sprint 1000 apart), detail
// wording beyond the HANDOFF producer.
import assert from 'node:assert/strict';
import { buildModel } from '../../lib/model.mjs';
import { verifyPlan } from '../../lib/verify.mjs';
import { oracleViolations, cycleFacts } from './oracle.mjs';
import { product, allGraphs, slots, keysOf, PEOPLE, bag } from './enum.mjs';

const norm = (v) => (v.code === 'HANDOFF' ? `HANDOFF|${v.key}|${/^producer (\S+) /.exec(v.detail)?.[1]}` : `${v.code}|${v.key}`);
const normO = (v) => (v.code === 'HANDOFF' ? `HANDOFF|${v.key}|${v.producer}` : `${v.code}|${v.key}`);

/** Compare one instance; throws with the counterexample. Returns the library list (for CLI stratification). */
export function compareOne(inst, model) {
  model.sched = inst.sched; model.config = inst.config;
  const got = verifyPlan(model, inst.sched, { frozen: inst.frozen, enforceMin: !!inst.enforceMin });
  const lib = bag(got.filter((v) => v.code !== 'CYCLE').map(norm)), ora = bag(oracleViolations(inst).map(normO));
  if (lib.join('\n') !== ora.join('\n')) fail(inst, 'violations differ', { lib, oracle: ora });
  const cyc = got.filter((v) => v.code === 'CYCLE'), f = cycleFacts(inst), seenPaths = new Set(), covered = new Set();
  for (const c of cyc) {
    const nodes = c.detail.split(' -> ');
    if (nodes.length < 2 || nodes[0] !== nodes[nodes.length - 1]) fail(inst, 'cycle path not closed', c);
    const cycle = nodes.slice(0, -1);
    if (!f.isPath(cycle)) fail(inst, 'reported cycle is not a cycle of live edges', c);
    if (c.key !== [...cycle].sort()[0] || cycle[0] !== c.key) fail(inst, 'cycle key is not its smallest node / not rotated to it', c);
    if (seenPaths.has(c.detail)) fail(inst, 'cycle printed twice', c);
    seenPaths.add(c.detail); covered.add(f.comp.get(cycle[0]));
  }
  const comps = new Set([...f.onCycle].map((x) => f.comp.get(x)));
  if ([...comps].sort().join(',') !== [...covered].sort().join(',')) fail(inst, 'a loop is not reported', { comps: [...comps], covered: [...covered] });
  return got;
}
function fail(inst, what, extra) {
  assert.fail(`verify: ${what}\n${JSON.stringify({ ...inst, sched: [...inst.sched], frozen: inst.frozen && [...inst.frozen], extra })}`);
}
const toSched = (keys, choice) => { const m = new Map(); keys.forEach((k, i) => { if (choice[i]) m.set(k, choice[i]); }); return m; };
const ticketsOf = (keys, sps, sts) => keys.map((key, i) => ({ key, sp: sps ? sps[i] : 1, ...(sts && sts[i] ? { jira_status: sts[i] } : {}) }));
const edgesOf = (g, dup) => { const e = g.map(([consumer, producer]) => ({ consumer, producer, kind: 'plan_need' })); if (dup && e.length) e.push({ ...e[0], kind: 'dup' }); return e; };

export const BOUNDS = {
  full: {
    graph: [{ n: 1, people: 3, sprints: [1, 2, 3], dup: true }, { n: 2, people: 3, sprints: [1, 2, 3], dup: true }, { n: 3, people: 3, sprints: [1, 2, 3], dup: true }, { n: 4, people: 2, sprints: [1, 2], dup: false, unplaced: false }],
    load: [{ n: 1, people: 3, sprints: [1, 2, 3] }, { n: 2, people: 3, sprints: [1, 2, 3] }, { n: 3, people: 3, sprints: [1, 2, 3] }, { n: 4, people: 2, sprints: [1, 2] }],
    window: [{ n: 1 }, { n: 2 }, { n: 3, reduced: true }],
    mixed: [{ n: 1 }, { n: 2 }],
  },
  quick: {
    graph: [{ n: 1, people: 3, sprints: [1, 2, 3], dup: true }, { n: 2, people: 2, sprints: [1, 2], dup: true }, { n: 3, people: 2, sprints: [1, 2], dup: false, unplaced: false }],
    load: [{ n: 1, people: 3, sprints: [1, 2, 3] }, { n: 2, people: 2, sprints: [1, 2] }],
    window: [{ n: 1 }, { n: 2, reduced: true }],
    mixed: [{ n: 1 }],
  },
};
export const SP = [0, 1, 2, 3, 1.5], CAPS = [0, 1, 2, 3, 5];

// visit(inst, model) is called for every instance (the CLI property reuses the enumeration to pick strata).
export function enumerate(lvl, visit) {
  const B = BOUNDS[lvl], counts = {};
  const tick = (fam) => { counts[fam] = (counts[fam] || 0) + 1; };
  // graph x placement: HANDOFF, CYCLE, UNPLACED under every link set (self-links and a duplicated link included).
  for (const b of B.graph) {
    const keys = keysOf(b.n), sl = slots(PEOPLE.slice(0, b.people), b.sprints, b.unplaced !== false);
    for (const g of allGraphs(keys)) for (const dup of b.dup && g.length ? [false, true] : [false]) {
      const edges = edgesOf(g, dup), config = { caps: { default: 5 } };
      const model = buildModel({ tickets: ticketsOf(keys), edges, config });
      product(keys.map(() => sl), (ch) => { const inst = { tickets: ticketsOf(keys), edges, sched: toSched(keys, ch), config }; visit(inst, model); tick('graph'); });
    }
  }
  // load: CAPACITY (exact boundary: caps 0..3 against sums of {0,1,2,3,1.5}) and MINLOAD, per-person caps and minimums.
  for (const b of B.load) {
    const keys = keysOf(b.n), sl = slots(PEOPLE.slice(0, b.people), b.sprints, false);
    const capCfgs = [...CAPS.map((c) => ({ default: c })), { default: 1, Ana: 3 }, { Ana: 2 }]; // the last: no default -> 140
    const minCfgs = [null, { default: 1 }, { Ana: 2 }, { default: 2, Ben: 0 }];
    product([capCfgs, minCfgs], ([caps, min]) => {
      const config = { caps, ...(min ? { min_per_sprint: min } : {}) };
      product(keys.map(() => SP), (sps) => {
        const tickets = ticketsOf(keys, sps), model = buildModel({ tickets, edges: [], config });
        product(keys.map(() => sl), (ch) => { const inst = { tickets, edges: [], sched: toSched(keys, ch), config, enforceMin: !!min }; visit(inst, model); tick('load'); });
      });
    });
  }
  // window: BEFORE_FIRST and FROZEN_MOVED: first_sprint (and a bad one), frozen/closed statuses, frozen_before_sprint, opts.frozen.
  for (const b of B.window) {
    const keys = keysOf(b.n), sprints = b.reduced ? [0, 2] : [0, 1, 2, 3];
    const sl = slots(['Ana', 'Ben'].slice(0, b.reduced ? 1 : 2), sprints, false);
    const statuses = b.reduced ? ['To Do', 'Done', 'In Progress'] : ['To Do', 'Done', 'In Progress', 'Closed'];
    const firsts = b.reduced ? [undefined, 1, 2, 1.5] : [undefined, 0, 1, 2, 3, 1.5, 2000000];
    const cfgs = [];
    for (const fs of b.reduced ? [undefined, ['In Progress']] : [undefined, [], ['In Progress']]) for (const cs of b.reduced ? [undefined] : [undefined, ['Closed']]) for (const fb of [undefined, 2]) for (const first of firsts) cfgs.push({ caps: { default: 99 }, ...(fs ? { frozen_statuses: fs } : {}), ...(cs ? { closed_statuses: cs } : {}), ...(fb !== undefined ? { frozen_before_sprint: fb } : {}), ...(first !== undefined ? { first_sprint: first } : {}) });
    for (const config of cfgs) product(keys.map(() => statuses), (sts) => {
      const tickets = ticketsOf(keys, null, sts), model = buildModel({ tickets, edges: [], config });
      product(keys.map(() => sl), (ch) => {
        const sched = toSched(keys, ch);
        // opts.frozen per ticket: absent, recorded at its slot, or recorded one sprint later (so it counts as moved)
        product(keys.map(() => [0, 1, 2]), (fz) => {
          const frozen = new Map();
          keys.forEach((k, i) => { if (fz[i] === 1) frozen.set(k, { ...sched.get(k) }); if (fz[i] === 2) frozen.set(k, { owner: sched.get(k).owner, sprint: sched.get(k).sprint + 1 }); });
          visit({ tickets, edges: [], sched, config, frozen: frozen.size ? frozen : undefined }, model); tick('window');
        });
      });
    });
  }
  // mixed: every dimension at once on low values, plus the odd shapes: a schedule row for a key that is not a ticket, invalid placements
  // (empty owner, fractional sprint), an sp: key, an ignored link kind, a non-number sp and a person named like a prototype member.
  for (const b of B.mixed) {
    const keys = b.n === 1 ? ['T1'] : ['T1', 'sp:x'];
    const sl = [null, { owner: 'Ana', sprint: 0 }, { owner: 'Ana', sprint: 1 }, { owner: 'constructor', sprint: 1 }, { owner: 'Ana', sprint: 2 }, { owner: '', sprint: 1 }, { owner: 'Ana', sprint: 1.5 }];
    const ghosts = [null, { owner: 'Ana', sprint: 1 }];
    for (const g of allGraphs(keys)) for (const kind of g.length ? ['plan_need', 'ignored'] : ['plan_need']) {
      const edges = g.map(([consumer, producer], i) => ({ consumer, producer, kind: i === 0 ? kind : 'plan_need' }));
      product([[0, 1, 1.5, '2'], ['To Do', 'Done'], [0, 1, 3], [undefined, 0, 2], [false, true], ghosts], ([sp, st, cap, first, em, ghost]) => {
        const config = { caps: { default: cap }, ignore_link_kinds: ['ignored'], min_per_sprint: { default: 1 }, ...(first !== undefined ? { first_sprint: first } : {}) };
        const tickets = keys.map((key) => ({ key, sp, jira_status: st })), model = buildModel({ tickets, edges, config });
        product(keys.map(() => sl), (ch) => {
          const sched = toSched(keys, ch); if (ghost) sched.set('GHOST', ghost);
          visit({ tickets, edges, sched, config, enforceMin: em }, model); tick('mixed');
        });
      });
    }
  }
  return counts;
}

export function assureVerify(lvl) {
  const counts = enumerate(lvl, (inst, model) => { compareOne(inst, model); });
  return { counts, total: Object.values(counts).reduce((a, b) => a + b, 0) };
}
