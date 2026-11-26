import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModel } from '../lib/model.ts';
import { rtm } from '../lib/flow/rtm.ts';
import type { FlowLink } from '../lib/flow/brief.ts';

const model = buildModel({ tickets: [{ key: 'sp:a' }, { key: 'sp:b' }, { key: 'sp:c' }] });
const S = (from: string, to: string): FlowLink => ({ from, rel: 'satisfies', to, to_type: 'requirement' });
const ev = (task: string, to: string, evidence: string[] = [], seq = 2) => ({ at: '2026-01-01T00:00:00Z', seq, actor: 'x', task, to, by: 'x', evidence });
const dn = (task: string, evidence: string[], to = 'done') => [ev(task, 'in_progress', [], 1), ev(task, to, evidence, 2)];
const requirements = [{ id: 'R1' }, { id: 'R2' }, { id: 'R3' }, { id: 'R4' }];
const links = [S('sp:a', 'R1'), S('sp:b', 'R1'), S('sp:c', 'R2')];
const status = (events: Parameters<typeof rtm>[1]) => Object.fromEntries(rtm(model, events, { requirements, links }).map((r) => [r.requirement, r.status]));

test('orphan when no task satisfies the requirement; proposed when nothing is done', () => {
  assert.deepEqual(status([]), { R1: 'proposed', R2: 'proposed', R3: 'orphan', R4: 'orphan' });
});
test('implemented only when all satisfying tasks are done', () => {
  assert.equal(status([...dn('sp:a', ['note:x'])]).R1, 'proposed');
  assert.equal(status([...dn('sp:a', ['note:x']), ...dn('sp:b', ['note:y'])]).R1, 'implemented');
});
test('verified when each done task also has pr or test evidence', () => {
  assert.equal(status([...dn('sp:a', ['pr:o/r#1']), ...dn('sp:b', ['note:y'])]).R1, 'implemented');
  assert.equal(status([...dn('sp:a', ['pr:o/r#1']), ...dn('sp:b', ['test:unit'])]).R1, 'verified');
});
test('rows list tasks with state, sorted; skipped tasks do not hold a requirement back', () => {
  const rows = rtm(model, [...dn('sp:a', ['test:t']), ...dn('sp:b', [], 'skipped')], { requirements, links });
  assert.deepEqual(rows[0], { requirement: 'R1', tasks: [{ key: 'sp:a', state: 'done' }, { key: 'sp:b', state: 'skipped' }], status: 'verified' });
});
