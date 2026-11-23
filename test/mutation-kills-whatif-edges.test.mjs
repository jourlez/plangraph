// Behavior tests for lib/whatif.mjs edges written to kill mutants that survived scripts/mutate-all.mjs and the whatif goldens: the
// token estimate, the default overflow limit, a capacity alternative in the last sprint and in an empty cell, last names and names that
// differ only by case, a plan that ends at sprint 0, consumers that are scheduled without a ticket or have a ticket without a slot, a
// ripple that stops at a consumer already late enough, the owner-change count of a repair, the NO_REPAIR texts, zero-point tickets in a
// full cell, and the safety net's message and baseline rule. Names and keys are invented.
// NOT covered: the search order on large plans (test/whatif.test.mjs, test/mutation-kills-whatif.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { whatif, proposeMove, renderWhatif, assertPlanValid, estTokens } from '../lib/whatif.mjs';
import { buildModel } from '../lib/model.mjs';
import { summarize } from '../lib/verify.mjs';

const codes = (/** @type {any} */ r) => r.reasons.map((/** @type {any} */ x) => x.code);

test('estTokens is a quarter of the length, rounded up', () => {
  assert.deepEqual([estTokens('abcd'), estTokens('abcde')], [1, 2]);
});

test('capacity: the default overflow limit is 12 sprints; an empty cell in the last sprint is a valid alternative', () => {
  const over = buildModel({ tickets: [{ key: 'A', sp: 4 }, { key: 'B', sp: 3 }], schedule: [{ key: 'A', owner: 'x', sprint: 1 }, { key: 'B', owner: 'x', sprint: 2 }], config: { caps: { x: 3 }, end_sprint: 2 } });
  assert.deepEqual(whatif(over, { key: 'A', sprint: 2 }, { allowOverflow: true, noSuggest: true }).reasons, [{ code: 'CAPACITY', key: 'x S2', detail: '7/3', fix: 'x has no room through S14' }]);
  const last = buildModel({ tickets: [{ key: 'A', sp: 2 }, { key: 'B', sp: 2 }, { key: 'C', sp: 2 }], schedule: [{ key: 'A', owner: 'x', sprint: 1 }, { key: 'B', owner: 'x', sprint: 2 }, { key: 'C', owner: 'y', sprint: 1 }], config: { caps: { x: 2, y: 2 }, end_sprint: 3 } });
  assert.deepEqual(whatif(last, { key: 'C', to: 'x', sprint: 2 }, { noSuggest: true }).reasons, [{ code: 'CAPACITY', key: 'x S2', detail: '4/2', fix: 'x has room in S3' }]);
});

test('people: a last name alone is not a person; an exact name wins over a case-insensitive twin', () => {
  const full = buildModel({ tickets: [{ key: 'A', sp: 1 }, { key: 'B', sp: 1 }], schedule: [{ key: 'A', owner: 'Ana Diaz', sprint: 1 }, { key: 'B', owner: 'Ben Ruiz', sprint: 1 }], config: { end_sprint: 2 } });
  assert.deepEqual(codes(whatif(full, { key: 'A', to: 'diaz' })), ['UNKNOWN_PERSON']);
  assert.equal(whatif(full, { key: 'A', to: 'ben' }).ok, true);
  const twins = buildModel({ tickets: [{ key: 'A', sp: 1 }, { key: 'B', sp: 1 }], schedule: [{ key: 'A', owner: 'Ana', sprint: 1 }, { key: 'B', owner: 'ana', sprint: 1 }], config: { end_sprint: 2 } });
  assert.equal(whatif(twins, { key: 'A', to: 'ana' }).ok, true);
  assert.equal(whatif(twins, { key: 'B', to: 'Ana' }).ok, true);
});

test('range: a plan placed only in sprint 0, without end_sprint, ends at sprint 0', () => {
  const m = buildModel({ tickets: [{ key: 'A', sp: 1 }], schedule: [{ key: 'A', owner: 'x', sprint: 0 }], config: { first_sprint: 0 } });
  assert.deepEqual(whatif(m, { key: 'A', sprint: 1 }).reasons, [{ code: 'OUT_OF_RANGE', key: 'A', detail: 'S1 outside S0..S0', fix: 'use S0..S0' }]);
});

test('consumers scheduled without a ticket, or with a ticket but no slot, are ignored by checks, ripple and repair', () => {
  const m = buildModel({ tickets: [{ key: 'A', sp: 2 }, { key: 'B', sp: 2 }, { key: 'E', sp: 1 }], edges: [{ producer: 'A', consumer: 'C' }, { producer: 'A', consumer: 'E' }], schedule: [{ key: 'A', owner: 'x', sprint: 1 }, { key: 'B', owner: 'x', sprint: 2 }, { key: 'C', owner: 'x', sprint: 1 }], config: { caps: { x: 2 }, end_sprint: 4 } });
  const r = whatif(m, { key: 'A', sprint: 3 });
  assert.deepEqual([r.ok, r.ripple.map((/** @type {any} */ x) => x.key)], [true, ['A']]);
  const p = proposeMove(m, { key: 'A', sprint: 2 }, { allowSlip: true });
  assert.deepEqual([p.ok, p.moves.map((x) => `${x.key}>${x.to.owner}${x.to.sprint}`), p.nodes], [true, ['A>x2', 'B>x3'], 2]);
});

test('ripple: a consumer that is already late enough is not listed', () => {
  const m = buildModel({ tickets: [{ key: 'A', sp: 1 }, { key: 'C', sp: 1 }], edges: [{ producer: 'A', consumer: 'C' }], schedule: [{ key: 'A', owner: 'x', sprint: 1 }, { key: 'C', owner: 'x', sprint: 2 }], config: { end_sprint: 3 } });
  assert.deepEqual(whatif(m, { key: 'A', sprint: 2 }).ripple.map((/** @type {any} */ x) => x.key), ['A']);
});

test('proposeMove: a shifted ticket that keeps its owner is no owner change; the NO_REPAIR texts', () => {
  const m = buildModel({ tickets: [{ key: 'A', sp: 1 }, { key: 'C', sp: 1 }], edges: [{ producer: 'A', consumer: 'C' }], schedule: [{ key: 'A', owner: 'x', sprint: 1 }, { key: 'C', owner: 'y', sprint: 2 }], config: { end_sprint: 3 } });
  const r = proposeMove(m, { key: 'A', sprint: 2 });
  assert.deepEqual([r.ok, r.shifted, r.ownerChanges, r.slipped], [true, 1, 0, 0]);
  const stuck = buildModel({ tickets: [{ key: 'A', sp: 1 }, { key: 'C', sp: 1, jira_status: 'In Progress' }], edges: [{ producer: 'A', consumer: 'C' }], schedule: [{ key: 'A', owner: 'x', sprint: 1 }, { key: 'C', owner: 'y', sprint: 2 }], config: { end_sprint: 3, frozen_statuses: ['In Progress'] } });
  const n = proposeMove(stuck, { key: 'A', sprint: 2 });
  assert.deepEqual(n.reasons.at(-1), { code: 'NO_REPAIR', key: 'A', detail: 'no repair exists under the move rules', fix: 'allow earlier moves, owner changes, slip or overflow' });
});

test('proposeMove: a zero-point ticket in a full cell is never offered as a move', () => {
  const m = buildModel({ tickets: [{ key: 'A', sp: 2 }, { key: 'Z', sp: 0 }, { key: 'Y', sp: 0 }, { key: 'B', sp: 2 }], schedule: [{ key: 'A', owner: 'x', sprint: 1 }, { key: 'Z', owner: 'x', sprint: 1 }, { key: 'Y', owner: 'x', sprint: 1 }, { key: 'B', owner: 'x', sprint: 2 }], config: { caps: { x: 2 }, end_sprint: 4 } });
  for (const o of [{}, { allowSlip: true, allowOwnerChange: true }]) {
    const r = proposeMove(m, { key: 'B', sprint: 1 }, o);
    assert.deepEqual([r.moves.map((x) => `${x.key}>${x.to.owner}${x.to.sprint}`), r.nodes], [['B>x1', 'A>x2'], 1]);
  }
  const spent = proposeMove(m, { key: 'B', sprint: 1 }, { budget: 0 });
  assert.deepEqual([spent.ok, spent.reasons.at(-1), spent.searchComplete], [false, { code: 'NO_REPAIR', key: 'B', detail: 'search budget 0 exhausted', fix: 'raise opts.budget' }, false]);
});

test('assertPlanValid: names the first three new violations; a capacity cell worse than the baseline is new', () => {
  const cap = buildModel({ tickets: [{ key: 'A', sp: 10 }, { key: 'B', sp: 1 }], schedule: [{ key: 'A', owner: 'x', sprint: 1 }, { key: 'B', owner: 'x', sprint: 2 }], config: { caps: { x: 9 }, end_sprint: 2 } });
  assert.doesNotThrow(() => assertPlanValid(cap, cap.sched, {}, () => false));
  assert.throws(() => assertPlanValid(cap, new Map([...cap.sched, ['B', { owner: 'x', sprint: 1 }]]), {}, () => false), { message: 'proposeMove produced an invalid plan: CAPACITY|x S1|11/9' });
  const cs = ['C1', 'C2', 'C3', 'C4'];
  const fan = buildModel({ tickets: ['P', ...cs].map((key) => ({ key, sp: 1 })), edges: cs.map((c) => ({ producer: 'P', consumer: c })), schedule: [{ key: 'P', owner: 'x', sprint: 1 }, ...cs.map((key) => ({ key, owner: 'x', sprint: 2 }))], config: { end_sprint: 3 } });
  const msg = cs.slice(0, 3).map((c) => `HANDOFF|${c}|producer P S3 x, consumer ${c} S2 x, consumer needs >=S3`).join('; ');
  assert.throws(() => assertPlanValid(fan, new Map([...fan.sched, ['P', { owner: 'x', sprint: 3 }]]), {}, () => false), { message: `proposeMove produced an invalid plan: ${msg}` });
});

test('renderWhatif: exactly the limit shows no tail, an unchanged load is not listed, flags are space separated', () => {
  const reasons = [{ code: 'X', key: 'a', detail: 'd' }, { code: 'Y', key: 'b', detail: 'e' }];
  assert.equal(renderWhatif({ ok: false, reasons, ripple: [] }, { limit: 2 }), 'NO: a. X a (d) | Y b (e).');
  assert.equal(renderWhatif({ ok: true, reasons: [], ripple: [{ key: 'K', to: { owner: 'o', sprint: 2 } }], load: /** @type {any} */ ({ o: { 2: { before: 3, after: 3, cap: 4 } } }) }), 'OK: K -> o S2.');
  const g = renderWhatif({ ok: false, reasons, ripple: [{ key: 'K', to: { owner: 'o', sprint: 2 } }], suggestion: { sprint: 3, shifts: 1, ownerChanges: 0, flags: ['slip', 'owner-change'] } });
  assert.ok(g.endsWith('Fix: move to S3 (1 other shifts, 0 owner changes; apply with --slip --owner-change).'), g);
});

test('summarize: negative sprints in ascending order', () => {
  const m = buildModel({ tickets: ['A', 'B', 'C', 'D'].map((key) => ({ key, sp: 1 })), schedule: [{ key: 'A', owner: 'o', sprint: -1 }, { key: 'B', owner: 'o', sprint: -2 }, { key: 'C', owner: 'o', sprint: -5 }, { key: 'D', owner: 'o', sprint: -3 }] });
  assert.deepEqual(Object.keys(/** @type {any} */ (summarize(m).load).o), ['-5', '-3', '-2', '-1']);
});
