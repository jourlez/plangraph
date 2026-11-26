// Differential test: on a valid plan, whatif accepts a single move exactly when the brute-force oracle accepts the moved schedule
// (links, capacity, sprint within first_sprint..end_sprint), and every move proposeMove returns leaves a plan the oracle accepts.
// Small random plans: at most 6 tickets, 3 people, 4 sprints of room (end_sprint is the last sprint of the plan's own schedule plus 2).
// The hand-written cases of whatif and proposeMove stay in test/whatif*.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { genPlan } from '../fixtures/gen.ts';
import { whatif, proposeMove } from '../../lib/whatif.ts';
import { assignOf, modelWith, oracleValid, peopleOf } from '../helpers/oracle.ts';
import type { Slot } from '../helpers/oracle.ts';

test('whatif accepts exactly the single moves the oracle accepts', () => {
  let ok = 0, no = 0, plans = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const plan = genPlan({ n: 3 + (seed % 4), people: 1 + (seed % 3), density: 0.4, seed, cap: 4, maxSp: 3 });
    const base = assignOf(plan); if (!oracleValid(plan, base)) continue;
    plans++;
    const model = modelWith(plan, base), end = plan.config.end_sprint;
    for (const t of plan.tickets) for (const owner of peopleOf(plan)) for (let sprint = 0; sprint <= end + 1; sprint++) {
      const cur = base.get(t.key) as Slot; if (cur.owner === owner && cur.sprint === sprint) continue;
      const moved = new Map(base).set(t.key, { owner, sprint });
      const want = sprint >= 1 && sprint <= end && oracleValid(plan, moved);
      const got = whatif(model, { key: t.key, to: owner, sprint }, { noSuggest: true });
      assert.equal(got.ok, want, `seed ${seed}: ${t.key} -> ${owner} S${sprint}: ${JSON.stringify(got.reasons.map((r) => r.code))}`);
      if (want) ok++; else no++;
    }
  }
  assert.ok(plans >= 10 && ok > 50 && no > 50, `both outcomes are exercised (${plans} plans, ${ok} accepted, ${no} rejected)`);
});

test('every move set proposeMove returns leaves a plan the oracle accepts', () => {
  let proposed = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const plan = genPlan({ n: 3 + (seed % 4), people: 2 + (seed % 2), density: 0.5, seed: seed + 200, cap: 4, maxSp: 3 });
    const base = assignOf(plan); if (!oracleValid(plan, base)) continue;
    const model = modelWith(plan, base), end = plan.config.end_sprint;
    for (const t of plan.tickets) for (const owner of peopleOf(plan)) for (const sprint of [1, 2, end]) {
      const cur = base.get(t.key) as Slot; if (cur.owner === owner && cur.sprint === sprint) continue;
      const r = proposeMove(model, { key: t.key, to: owner, sprint }, { allowSlip: true, allowEarlier: true, allowOwnerChange: true });
      if (!r.ok) continue;
      const after = new Map(base); for (const m of r.moves) after.set(m.key, { owner: m.to.owner, sprint: m.to.sprint });
      assert.ok(oracleValid(plan, after), `seed ${seed}: ${t.key} -> ${owner} S${sprint}: ${JSON.stringify(r.moves)}`);
      proposed++;
    }
  }
  assert.ok(proposed > 20, `proposals are exercised (${proposed})`);
});
