// Behavior tests for lib/verify.mjs written to kill mutants that survived scripts/mutate-all.mjs and the plan goldens: MINLOAD only for
// people with a minimum (a default or their own), a minimum of exactly 1, sprints at or below 0, cycles whose keys would collide if
// joined without a separator, and the exact cycle set of a dense graph (found by a random search against a mutant).
// NOT covered: the verifier's equivalence with the solver (test/verify.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyPlan } from '../lib/verify.mjs';
import { buildModel } from '../lib/model.mjs';

const codes = (/** @type {any[]} */ vs, /** @type {string} */ code) => vs.filter((v) => v.code === code).map((v) => `${v.key} ${v.detail}`);

test('MINLOAD: only people with a minimum, a minimum of exactly 1 counts, sprints at or below 0', () => {
  const m = buildModel({ tickets: [{ key: 'A', sp: 1 }, { key: 'B', sp: 1 }], schedule: [{ key: 'A', owner: 'Ana', sprint: 1 }, { key: 'B', owner: 'Ben', sprint: 3 }], config: { min_per_sprint: { Ana: 1 } } });
  assert.deepEqual(codes(verifyPlan(m, m.sched, { enforceMin: true }), 'MINLOAD'), ['Ana S2 0/1', 'Ana S3 0/1'], 'Ben has no minimum and no default');
  const low = buildModel({ tickets: [{ key: 'A', sp: 1 }], schedule: [{ key: 'A', owner: 'Ana', sprint: -1 }], config: { first_sprint: -1, min_per_sprint: { default: 1 } } });
  // the scan runs from first_sprint to max(0, last placed sprint): a plan that ends below 0 is still checked through sprint 0, not 1
  assert.deepEqual(codes(verifyPlan(low, low.sched, { enforceMin: true }), 'MINLOAD'), ['Ana S0 0/1']);
});

test('cycles: keys that would collide when joined without a separator are two cycles', () => {
  const m = buildModel({ tickets: ['A', 'BC', 'AB', 'C'].map((key) => ({ key })), edges: [['A', 'BC'], ['BC', 'A'], ['AB', 'C'], ['C', 'AB']].map(([consumer, producer]) => ({ consumer, producer })), schedule: ['A', 'BC', 'AB', 'C'].map((key) => ({ key, owner: 'x', sprint: 1 })) });
  assert.deepEqual(codes(verifyPlan(m), 'CYCLE'), ['A A -> BC -> A', 'AB AB -> C -> AB']);
});

test('cycles: the exact set for a dense graph (one report per back edge of the depth-first search)', () => {
  const pairs = ['K0<K0', 'K0<K1', 'K0<K2', 'K0<K3', 'K1<K0', 'K1<K2', 'K1<K3', 'K1<K4', 'K3<K0', 'K3<K4', 'K4<K1'];
  const keys = ['K0', 'K1', 'K2', 'K3', 'K4'];
  const m = buildModel({ tickets: keys.map((key) => ({ key })), edges: pairs.map((p) => { const [consumer, producer] = p.split('<'); return { consumer, producer }; }), schedule: keys.map((key) => ({ key, owner: 'a', sprint: 1 })) });
  assert.deepEqual(codes(verifyPlan(m), 'CYCLE'), ['K0 K0 -> K0', 'K0 K0 -> K1 -> K0', 'K0 K0 -> K1 -> K3 -> K0', 'K1 K1 -> K3 -> K4 -> K1']);
});

test('summarize: an empty plan ends at sprint 0; negative sprints are listed in ascending order', async () => {
  const { summarize } = await import('../lib/verify.mjs');
  assert.deepEqual(summarize(buildModel({})), { end_sprint: 0, owner_changes_vs_baseline: 0, load: {} });
  const m = buildModel({ tickets: [{ key: 'A', sp: 1 }, { key: 'B', sp: 2 }, { key: 'C', sp: 3 }], schedule: [{ key: 'A', owner: 'Ana', sprint: -1 }, { key: 'B', owner: 'Ana', sprint: -3 }, { key: 'C', owner: 'Ana', sprint: 2 }] });
  assert.equal(JSON.stringify(summarize(m).load), '{"Ana":{"2":3,"-3":2,"-1":1}}');
});
