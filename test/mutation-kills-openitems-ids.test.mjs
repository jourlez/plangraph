// Regression test for a defect found while killing mutants of lib/openitems.mjs (the `key + '|' + kind` grouping id survived being
// changed to `key + '' + kind`): a findings key or kind containing '|' made two different (key, kind) pairs share one id, so two findings
// were merged into one open item under the first pair's key and kind, and reconcileItems copied the status of one to the other.
// findings.jsonl only requires key, kind and text to be strings, so '|' can reach the model. Fixed with a collision-free id.
// NOT covered: closedSet()/blocksReady() and src/commands/queries.mjs still compare `key|kind` strings (shared format with the CLI);
// a closed item whose key or kind contains '|' can still mask another pair there (reported as a residual gap).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openItemsFromFindings, reconcileItems } from '../lib/openitems.mjs';
import { buildModel } from '../lib/model.mjs';

const findings = [{ key: 'A-1', kind: 'b|c', text: 'pipe in the kind' }, { key: 'A-1|b', kind: 'c', text: 'pipe in the key' }];

test('findings whose key or kind contains | stay separate items', () => {
  const items = openItemsFromFindings(buildModel({ findings }), {});
  assert.deepEqual(items.map((i) => [i.key, i.kind, i.text]), [['A-1', 'b|c', 'pipe in the kind'], ['A-1|b', 'c', 'pipe in the key']]);
});

test('reconcile does not copy the status of one pair to the other', () => {
  const derived = openItemsFromFindings(buildModel({ findings }), {});
  const existing = [{ key: 'A-1|b', kind: 'c', status: 'done', closed_at: '2026-01-01', text: 'x' }];
  const out = reconcileItems(existing, derived);
  assert.deepEqual(out.map((i) => [i.key, i.kind, i.status]), [['A-1', 'b|c', 'open'], ['A-1|b', 'c', 'done']]);
});
