// Regression tests for defects found by the exhaustive small-scope suite (test/assure/). Each test is the smallest counterexample the
// enumeration produced, frozen here so the default `node --test` run keeps it even if the suite's bounds change.
// NOT covered: anything beyond these exact instances (the suite itself is the general check: npm run assure).
import test from 'node:test';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { buildModel } from '../lib/model.mjs';
import { whatif, proposeMove, renderWhatif } from '../lib/whatif.mjs';
import { SCHEMAS, canonFile, parseJsonlText } from '../lib/store.mjs';

test('whatif: a self-link compares the moved ticket with its NEW slot on both ends (no phantom PRODUCER_LATE / CONSUMER_EARLY)', () => {
  const m = buildModel({ tickets: [{ key: 'T1', sp: 1, jira_status: 'To Do' }], edges: [{ consumer: 'T1', producer: 'T1', kind: 'plan_need' }], schedule: [{ key: 'T1', owner: 'Ana', sprint: 2 }], config: { caps: { default: 5, Ben: 5 }, end_sprint: 3 } });
  const earlier = whatif(m, { key: 'T1', sprint: 1 }), later = whatif(m, { key: 'T1', sprint: 3 }), other = whatif(m, { key: 'T1', to: 'Ben' });
  for (const r of [earlier, later, other]) { assert.deepEqual(r.reasons.map((x) => x.code), []); assert.equal(r.ok, true); }
});

test('whatif ripple: a link back to the requested ticket never re-places it (ripple[0] and proposeMove keep the request)', () => {
  const m = buildModel({ tickets: [{ key: 'T1', sp: 1, jira_status: 'To Do' }, { key: 'T2', sp: 1, jira_status: 'To Do' }], edges: [{ consumer: 'T1', producer: 'T1', kind: 'plan_need' }], schedule: [{ key: 'T1', owner: 'Ana', sprint: 1 }, { key: 'T2', owner: 'Ben', sprint: 1 }], config: { caps: { default: 2 }, end_sprint: 4 } });
  const r = whatif(m, { key: 'T1', to: 'Ben' });
  assert.deepEqual(r.ripple[0].to, { owner: 'Ben', sprint: 1 });
  assert.match(renderWhatif(r), /^OK: T1 -> Ben S1\./);
  const pm = proposeMove(m, { key: 'T1', to: 'Ben' });
  assert.equal(pm.ok, true); assert.deepEqual(pm.moves[0].to, { owner: 'Ben', sprint: 1 });
});

test('whatif ripple: a cross-owner loop downstream stops at the acyclic bound instead of running to the 100000-step guard', () => {
  const m = buildModel({ tickets: ['T1', 'T2', 'T3'].map((key) => ({ key, sp: 1 })), edges: [['T2', 'T1'], ['T3', 'T2'], ['T2', 'T3']].map(([consumer, producer]) => ({ consumer, producer, kind: 'plan_need' })),
    schedule: [{ key: 'T1', owner: 'Ana', sprint: 1 }, { key: 'T2', owner: 'Ana', sprint: 2 }, { key: 'T3', owner: 'Ben', sprint: 3 }], config: { caps: { default: 9 }, end_sprint: 4 } });
  const r = whatif(m, { key: 'T1', sprint: 3 });
  assert.ok(Math.max(...r.ripple.map((x) => x.to.sprint)) <= 3 + m.tickets.size, JSON.stringify(r.ripple.map((x) => x.to)));
  assert.deepEqual(r.ripple.map((x) => x.key), ['T1', 'T2', 'T3']);
});

test('canonFile(evidence): the identity hash reads values canonically, so canon(parse(canon(x))) === canon(x) with object values', () => {
  const s = SCHEMAS['evidence.jsonl'];
  const t1 = canonFile([{ key: 'K', verdict: { b: 1, a: 1 } }, { key: 'K', verdict: { a: 2, b: 0 } }], s);
  assert.equal(canonFile(parseJsonlText(t1, 'evidence.jsonl'), s), t1);
  // scalar values hash exactly as before (no churn in existing files): the id of a plain record is unchanged
  assert.equal(s.id({ key: 'K', source: 'audit', verdict: 'READY' }), crypto.createHash('sha256').update(JSON.stringify(['K', 'audit', 'READY', null, null])).digest('hex').slice(0, 32));
});
