// Characterization goldens for lib/whatif.mjs search and edge models (test/golden/mutation-kills/whatif.json, UPDATE_GOLDEN=1 rewrites),
// kept apart from test/mutation-kills-plan-golden.test.mjs so each file stays fast: proposeMove over small capacity-tight plans for every
// ticket, two target sprints and each repair option (moves, search size, slip, completeness pinned), and whatif on edge models (no
// first/end sprint in config, a ghost producer, a 0-point ticket, people differing only by case or in multi-word names, capacity
// alternatives at the exact limits, a diamond ripple). Plans come from test/fixtures/gen.mjs (invented names).
import { test } from 'node:test';
import { whatif, proposeMove, renderWhatif } from '../lib/whatif.mjs';
import { buildModel } from '../lib/model.mjs';
import { genPlan } from './fixtures/gen.mjs';
import { golden, outcome } from './helpers/golden-json.mjs';

const G = (/** @type {string} */ name, /** @type {() => unknown} */ fn) => golden('whatif', name, outcome(fn));

test('proposeMove sweep over small tight plans (every ticket, sprint and repair option), and whatif edge models', () => {
  const opts = [{ allowSlip: true }, { allowEarlier: true }, { allowOwnerChange: true }, { allowSlip: true, allowOwnerChange: true, allowEarlier: true }];
  for (const seed of [21, 24, 28, 30]) {
    const m = buildModel((() => { const p = genPlan({ n: 8, people: 3, seed, cap: 4, density: 0.3 }); p.tickets[2].jira_status = 'In Progress'; p.config.end_sprint = 4; return { ...p, config: { ...p.config, frozen_statuses: ['In Progress'] } }; })());
    /** @type {string[]} */ const res = [];
    for (const key of [...m.sched.keys()].sort()) for (const sprint of [1, 3]) for (const o of opts) {
      const r = proposeMove(m, { key, sprint }, o);
      res.push(`${key}@${sprint}${Object.keys(o).map((k) => k[5]).join('')}: ${r.ok ? r.moves.map((x) => `${x.key}>${x.to.owner}${x.to.sprint}`).join(',') : r.reasons.map((x) => x.code).join(',')} n${r.nodes ?? '-'} s${r.slipped ?? '-'} c${r.searchComplete ?? '-'}`);
    }
    G(`propose-sweep-${seed}`, () => res);
  }
  // small search limits: the exhausted search falls back to the greedy order (searchComplete false) or gives up
  const tight = buildModel((() => { const p = genPlan({ n: 8, people: 3, seed: 30, cap: 4, density: 0.3 }); p.tickets[2].jira_status = 'In Progress'; p.config.end_sprint = 4; return { ...p, config: { ...p.config, frozen_statuses: ['In Progress'] } }; })());
  G('propose-limits', () => [...tight.sched.keys()].sort().flatMap((key) => [{ budget: 1 }, { budget: 3 }, { workLimit: 2 }, { workLimit: 20 }].map((o) => { const r = proposeMove(tight, { key, sprint: 3 }, { allowSlip: true, allowOwnerChange: true, ...o }); return `${key} ${JSON.stringify(o)}: ${r.ok} ${r.searchComplete} ${r.nodes} ${r.reasons.map((x) => `${x.code} ${x.detail}`).join('; ')}`; })));
  // models without first_sprint / end_sprint, a ghost producer, a 0-point ticket, people differing only by case, multi-word names
  const edge = buildModel({
    tickets: [{ key: 'A', sp: 2 }, { key: 'B', sp: 0 }, { key: 'C', sp: 2 }, { key: 'D' }, { key: 'E', sp: 2 }],
    edges: [{ consumer: 'C', producer: 'A' }, { consumer: 'C', producer: 'GHOST' }, { consumer: 'E', producer: 'A' }, { consumer: 'E', producer: 'C' }, { consumer: 'A', producer: 'MISSING' }],
    schedule: [{ key: 'A', owner: 'Ana', sprint: 2 }, { key: 'B', owner: 'ana', sprint: 1 }, { key: 'C', owner: 'Van Der Berg', sprint: 3 }, { key: 'D', owner: 'Ana\tDiaz', sprint: 3 }, { key: 'E', owner: 'Van Derk', sprint: 4 }, { key: 'GHOST', owner: 'Zed', sprint: 5 }, { key: 'NOT-A-TICKET', owner: 'Ana', sprint: 2 }],
    config: { caps: { default: 4 } },
  });
  G('whatif-edges', () => [
    ...[['A', 'ana'], ['A', 'Ana'], ['A', 'ANA'], ['A', 'van der'], ['A', 'van derk'], ['A', 'ana diaz'], ['A', 'Ana\tDiaz']].map(([key, to]) => /** @type {any} */ (whatif(edge, { key, to })).ripple[0]?.to ?? null),
    whatif(edge, { key: 'B', sprint: 2 }), whatif(edge, { key: 'D', sprint: 1 }), whatif(edge, { key: 'A', sprint: 0 }), whatif(edge, { key: 'A', sprint: 9 }), whatif(edge, { key: 'A', sprint: 4 }), whatif(edge, { key: 'C', sprint: 2 }),
    whatif(edge, { key: 'NOT-A-TICKET', sprint: 1 }), proposeMove(edge, { key: 'NOPE', sprint: 1 }), proposeMove(edge, { key: 'A', sprint: 9 }, { allowOverflow: true }), whatif(edge, { key: 'A', sprint: 20 }, { allowOverflow: true }),
  ]);
  // capacity alternatives: S1 full, S2 without room, S3 exactly enough, then an empty cell with a cap equal to the size
  const cap = buildModel({ tickets: [{ key: 'M', sp: 2 }, { key: 'F1', sp: 5 }, { key: 'F2', sp: 4 }, { key: 'F3', sp: 3 }], schedule: [{ key: 'M', owner: 'Bo', sprint: 4 }, { key: 'F1', owner: 'Ana', sprint: 1 }, { key: 'F2', owner: 'Ana', sprint: 2 }, { key: 'F3', owner: 'Ana', sprint: 3 }], config: { caps: { default: 5 }, end_sprint: 4 } });
  const cap2 = buildModel({ tickets: [{ key: 'M', sp: 2 }, { key: 'F1', sp: 3 }], schedule: [{ key: 'M', owner: 'Bo', sprint: 1 }, { key: 'F1', owner: 'Ana', sprint: 1 }], config: { caps: { default: 2 }, end_sprint: 2 } });
  G('whatif-capacity-alt', () => [renderWhatif(whatif(cap, { key: 'M', to: 'Ana', sprint: 1 })), renderWhatif(whatif(cap2, { key: 'M', to: 'Ana', sprint: 1 })), whatif(cap, { key: 'M', to: 'Ana', sprint: 1 }).reasons]);
  // a diamond: E needs A and C, C needs A; moving A later ripples to C and E with one reason per consumer
  G('whatif-diamond', () => whatif(edge, { key: 'A', sprint: 3 }).ripple);
});
