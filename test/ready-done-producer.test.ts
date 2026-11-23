// Review M3: producer-done is decided by doneOf(producer) for ANY consumer: an sp: producer by its impl_status, a Jira producer by its
// status (the snapshot's when given). A Jira ticket that needs an sp: task whose impl_status is done is ready.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModel } from '../lib/model.ts';
import type { ImplStatus } from '../lib/model.ts';
import { readiness, readySet } from '../lib/ready.ts';

const model = (impl: ImplStatus) => buildModel({
  tickets: [{ key: 'J-1', sp: 1, jira_status: 'To Do', verdict: 'READY' }, { key: 'sp:p/1', sp: 1, impl_status: impl }, { key: 'sp:p/2', sp: 1, impl_status: 'todo' }, { key: 'J-0', sp: 1, jira_status: 'Done' }],
  edges: [{ consumer: 'J-1', producer: 'sp:p/1', kind: 'sp_needs' }, { consumer: 'sp:p/2', producer: 'J-0', kind: 'sp_needs' }],
  schedule: [{ key: 'J-1', owner: 'Ana', sprint: 2 }, { key: 'sp:p/1', owner: 'Ben', sprint: 1 }],
});

test('a Jira ticket that needs a done sp: task is ready; a todo sp: task still blocks it', () => {
  assert.equal(readiness(model('done'), 'J-1').ready, true);
  assert.deepEqual(readySet(model('done')).ready, ['J-1', 'sp:p/2']);
  const r = readiness(model('todo'), 'J-1');
  assert.equal(r.ready, false);
  assert.deepEqual(r.reasons, [{ code: 'WAITS', key: 'sp:p/1', status: 'todo', impl: true, place: { sprint: 1, owner: 'Ben' } }]);
});

test('an sp: task that needs a Done Jira ticket is ready (the Jira producer is read by its status)', () => {
  assert.equal(readiness(model('done'), 'sp:p/2').ready, true);
  assert.equal(readiness(model('done'), 'sp:p/2', { statuses: { 'J-0': { status: 'In Progress' } } }).ready, false);
});
