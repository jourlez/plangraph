// Differential test: verifyPlan accepts exactly the schedules the brute-force oracle accepts (links, capacity, first sprint), on small
// random plans (at most 6 tickets, 3 people, 4 sprints). Small plans are enumerated whole; larger ones are sampled with a seeded rng.
// The hand-written cases of each rule stay in test/verify.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { genPlan, rng } from '../fixtures/gen.ts';
import { verifyPlan } from '../../lib/verify.ts';
import { buildModel } from '../../lib/model.ts';
import { eachAssign, modelWith, oracleValid, peopleOf, schedOf, slots } from '../helpers/oracle.ts';
import type { Assign } from '../helpers/oracle.ts';

const SPRINTS = 4;
const codes = (m: ReturnType<typeof modelWith>, a: Assign) => [...new Set(verifyPlan(m, schedOf(a)).map((v) => v.code))];

test('verifyPlan equals the oracle on every schedule of small plans', () => {
  let valid = 0, invalid = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const plan = genPlan({ n: 2 + (seed % 3), people: 1 + (seed % 3), density: 0.6, seed, cap: 4, maxSp: 3 });
    eachAssign(plan, SPRINTS, (a) => {
      const want = oracleValid(plan, a), got = verifyPlan(modelWith(plan, a), schedOf(a));
      assert.equal(got.length === 0, want, `seed ${seed}: ${JSON.stringify([...a])} -> ${JSON.stringify(got)}`);
      if (want) valid++; else invalid++;
    });
  }
  assert.ok(valid > 100 && invalid > 100, `both outcomes are exercised (${valid} valid, ${invalid} invalid)`);
});

test('verifyPlan equals the oracle on sampled schedules of plans with 6 tickets and 3 people', () => {
  let valid = 0;
  for (let seed = 1; seed <= 10; seed++) {
    const plan = genPlan({ n: 6, people: 3, density: 0.3, seed: seed + 100, cap: 5, maxSp: 3 }), r = rng(seed), all = slots(peopleOf(plan), SPRINTS);
    for (let i = 0; i < 400; i++) {
      // a mix of random placements and the plan's own schedule with one ticket moved, so valid schedules occur
      const a = new Map(plan.schedule.map((s) => [s.key, { owner: s.owner, sprint: s.sprint }]));
      const flips = i % 2 ? 1 : 6;
      for (let f = 0; f < flips; f++) a.set(`T-${1 + Math.floor(r() * 6)}`, all[Math.floor(r() * all.length)] as (typeof all)[number]);
      const want = oracleValid(plan, a);
      assert.equal(verifyPlan(modelWith(plan, a), schedOf(a)).length === 0, want, `seed ${seed}: ${JSON.stringify([...a])}`);
      if (want) valid++;
    }
  }
  assert.ok(valid > 20, `valid schedules are sampled (${valid})`);
});

test('hand cases: one violation code each, matching the oracle', () => {
  const plan = genPlan({ n: 2, people: 2, density: 1, seed: 1, cap: 3, maxSp: 1 }); // T-2 needs T-1
  const p1 = { owner: 'Ana', sprint: 1 }, p2 = { owner: 'Ben', sprint: 1 };
  const same = new Map([['T-1', p1], ['T-2', { owner: 'Ana', sprint: 1 }]]);
  assert.deepEqual(codes(modelWith(plan, same), same), []); assert.ok(oracleValid(plan, same));
  const handoff = new Map([['T-1', p1], ['T-2', p2]]);
  assert.deepEqual(codes(modelWith(plan, handoff), handoff), ['HANDOFF']); assert.ok(!oracleValid(plan, handoff));
  const early = new Map([['T-1', { owner: 'Ana', sprint: 2 }], ['T-2', p1]]);
  assert.deepEqual(codes(modelWith(plan, early), early), ['HANDOFF']); assert.ok(!oracleValid(plan, early));
  const tight = genPlan({ n: 2, people: 1, density: 0, seed: 1, cap: 1, maxSp: 1 }), both = new Map([['T-1', p1], ['T-2', p1]]);
  assert.deepEqual(codes(modelWith(tight, both), both), ['CAPACITY']); assert.ok(!oracleValid(tight, both));
  const before = new Map([['T-1', { owner: 'Ana', sprint: 0 }], ['T-2', p1]]);
  assert.deepEqual(codes(modelWith(tight, before), before), ['BEFORE_FIRST']); assert.ok(!oracleValid(tight, before));
});

test('the oracle and verifyPlan reject the same blocked and closed-sprint rows', () => {
  const plan = genPlan({ n: 2, people: 1, density: 0, seed: 1, cap: 9, maxSp: 1 });
  const rows = (a: Assign, verdict: string | null, closed: number[]) => buildModel({ tickets: plan.tickets.map((t) => (t.key === 'T-1' && verdict ? { ...t, verdict } : t)), edges: plan.edges, config: plan.config,
    schedule: [...a].map(([key, s]) => ({ key, owner: s.owner, sprint: s.sprint })), sprints: closed.map((n) => ({ n, state: 'closed' })) });
  for (const [verdict, closed] of [[null, []], ['NOT_READY', []], [null, [2]], ['NOT_READY', [2]]] as const) {
    eachAssign(plan, SPRINTS, (a) => {
      const gate = { blocked: new Set(verdict ? ['T-1'] : []), closed: new Set(closed) };
      assert.equal(verifyPlan(rows(a, verdict, [...closed]), schedOf(a)).length === 0, oracleValid(plan, a, 1, gate), `${verdict} ${closed} ${JSON.stringify([...a])}`);
    });
  }
});
