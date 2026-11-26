import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModel } from '../lib/model.ts';
import { actions } from '../lib/flow/actions.ts';

const model = buildModel({ tickets: [{ key: 'sp:a', summary: 'Login', sp: 2 }, { key: 'sp:b', summary: 'Logout' }, { key: 'ABC-1', summary: 'tracker ticket' }] });
const xrefs = [{ type: 'ticket' as const, id: 'sp:b', sys: 'jira:acme', xid: 'ABC-9' }];
const ev = (task: string, to: string, evidence: string[] = [], seq = 2) => ({ at: '2026-01-01T00:00:00Z', seq, actor: 'x', task, to, by: 'x', evidence });

const dn = (task: string, evidence: string[]) => [ev(task, 'in_progress', [], 1), ev(task, 'done', evidence, 2)];

test('create_ticket for a plan task with no tracked_by xref; tracker tickets are not tasks', () => {
  const a = actions(model, [], { xrefs });
  assert.deepEqual(a, [{ op: 'create_ticket', sys: 'jira', task: 'sp:a', fields: { summary: 'Login', sp: 2 } }]);
});
test('transition_ticket when plan says done and the tracker is open', () => {
  const obs = [{ sys: 'jira:acme', xid: 'ABC-9', type: 'ticket', fields: JSON.stringify({ status: 'In Progress' }) }];
  const a = actions(model, obs, { xrefs, events: [...dn('sp:b', ['pr:o/r#1'])] });
  assert.deepEqual(a.filter((x) => x.op === 'transition_ticket'), [{ op: 'transition_ticket', sys: 'jira:acme', task: 'sp:b', fields: { xid: 'ABC-9', from: 'In Progress', to: 'Done' } }]);
});
test('no transition when the tracker is already closed, unobserved, or the plan is not done', () => {
  const closed = [{ sys: 'jira:acme', xid: 'ABC-9', type: 'ticket', fields: { status: 'Done' } }];
  assert.equal(actions(model, closed, { xrefs, events: [...dn('sp:b', ['pr:x'])] }).filter((x) => x.op === 'transition_ticket').length, 0);
  assert.equal(actions(model, [], { xrefs, events: [...dn('sp:b', ['pr:x'])] }).filter((x) => x.op === 'transition_ticket').length, 0);
  const open = [{ sys: 'jira:acme', xid: 'ABC-9', type: 'ticket', fields: { status: 'To Do' } }];
  assert.equal(actions(model, open, { xrefs }).filter((x) => x.op === 'transition_ticket').length, 0);
});
test('link when an observation names the task but no xref exists', () => {
  const obs = [{ sys: 'jira:acme', xid: 'ABC-7', type: 'ticket', fields: { task: 'sp:a', status: 'To Do' } }];
  assert.deepEqual(actions(model, obs, { xrefs }), [{ op: 'link', sys: 'jira:acme', task: 'sp:a', fields: { xid: 'ABC-7' } }]);
});
