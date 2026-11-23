// A 0-SP ticket adds no load, so moving it into a person-sprint that is ALREADY over capacity adds no new violation: whatif must allow it,
// consistent with lib/verify.ts. Oracle: whatif reports CAPACITY exactly when verifyPlan of the moved plan holds a CAPACITY violation
// on a cell that was within capacity before, or a CAPACITY cell whose load the move raised, over random plans with 0-SP tickets and overloaded cells.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModel } from '../lib/model.ts';
import type { Model, Placement, Ticket } from '../lib/model.ts';
import type { Slot } from '../lib/whatif.ts';
import { verifyPlan } from '../lib/verify.ts';
import { whatif, proposeMove, applyMoves } from '../lib/whatif.ts';
import { rng } from './fixtures/gen.ts';

const T = (key: string, sp: number) => ({ key, sp, jira_status: 'To Do' });
function overloaded() { // Ben S2 holds 7 SP against a cap of 5: already over capacity before any move
  return buildModel({
    tickets: [T('B1', 4), T('B2', 3), T('Z', 0), T('O', 1)],
    edges: [],
    schedule: ([['B1', 'Ben', 2], ['B2', 'Ben', 2], ['Z', 'Ana', 2], ['O', 'Ana', 2]] as Array<[string, string, number]>).map(([key, owner, sprint]) => ({ key, owner, sprint })), // literal tuples
    config: { first_sprint: 1, end_sprint: 4, caps: { default: 10, Ben: 5 } },
  });
}
// CAPACITY violations by cell key with their load (detail "load/cap"); new = a cell over capacity that was not before, or whose load grew
// (the cell a ticket leaves may stay over capacity with a lower load: that is no new violation)
const capViolations = (m: Model, sched?: ReadonlyMap<string, Placement>) => new Map(verifyPlan(m, sched).filter((v) => v.code === 'CAPACITY').map((v): [string, number] => [v.key, Number(v.detail.split('/')[0])]));
const newCap = (m: Model, key: string, owner: string, sprint: number) => {
  const before = capViolations(m), after = capViolations(m, applyMoves(m.sched, [{ key, to: { owner, sprint } }]));
  return [...after].some(([k, load]) => !before.has(k) || load > (before.get(k) as number)); // has() was just tested
};

test('a 0-SP ticket may move into an over-capacity cell (no new violation); a 1-SP ticket may not', () => {
  const m = overloaded();
  const z = whatif(m, { key: 'Z', to: 'Ben', sprint: 2 });
  assert.equal(z.ok, true, JSON.stringify(z.reasons));
  assert.deepEqual(z.load.Ben[2], { before: 7, after: 7, cap: 5 });
  assert.equal(newCap(m, 'Z', 'Ben', 2), false);
  const pm = proposeMove(m, { key: 'Z', to: 'Ben', sprint: 2 });
  assert.equal(pm.ok, true); assert.equal(pm.moves.length, 1);
  const o = whatif(m, { key: 'O', to: 'Ben', sprint: 2 });
  assert.equal(o.ok, false);
  assert.deepEqual(o.reasons.map((r) => r.code), ['CAPACITY']);
  assert.equal(newCap(m, 'O', 'Ben', 2), true);
});

test('oracle: whatif CAPACITY <=> verifyPlan sees a new CAPACITY violation, on random plans with 0-SP tickets and overloaded cells', () => {
  const r = rng(42); let zeroIntoOver = 0, checked = 0;
  for (let it = 0; it < 300; it++) {
    const people = ['Ana', 'Ben', 'Cleo'], n = 4 + Math.floor(r() * 6);
    const tickets = [], schedule = [];
    for (let i = 0; i < n; i++) {
      tickets.push(T(`K-${i}`, r() < 0.35 ? 0 : 1 + Math.floor(r() * 4)));
      schedule.push({ key: `K-${i}`, owner: people[Math.floor(r() * 3)], sprint: 1 + Math.floor(r() * 3) });
    }
    const m = buildModel({ tickets, edges: [], schedule, config: { first_sprint: 1, end_sprint: 3, caps: { default: 2 + Math.floor(r() * 4) } } });
    const k = `K-${Math.floor(r() * n)}`, to = people[Math.floor(r() * 3)], sprint = 1 + Math.floor(r() * 3);
    const cur = m.sched.get(k) as Slot; if (cur.owner === to && cur.sprint === sprint) continue; // every K-n is placed
    const w = whatif(m, { key: k, to, sprint }, { noSuggest: true });
    const gotCap = w.reasons.some((x) => x.code === 'CAPACITY');
    assert.equal(gotCap, newCap(m, k, to, sprint), `${k} -> ${to} S${sprint}: ${JSON.stringify(w.reasons)} ${JSON.stringify(schedule)}`);
    checked++;
    if ((m.tickets.get(k) as Ticket).sp === 0 && (w.load[to]?.[sprint]?.before ?? 0) > (w.load[to]?.[sprint]?.cap ?? Infinity)) zeroIntoOver++; // k is placed, so it is a ticket
  }
  assert.ok(checked > 250, `checked ${checked}`);
  assert.ok(zeroIntoOver >= 5, `0-SP moves into an over-capacity cell exercised: ${zeroIntoOver}`); // the case under test is really hit
});
