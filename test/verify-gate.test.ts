// verify enforces the two schedule gates (lib/graph/blockers.ts blockedRow, closedSprintRow): BLOCKED (an open held_by item or a verdict other
// than READY) and SPRINT_CLOSED (a row in a closed sprint), for rows that are open, not frozen and at or after first_sprint. whatif reports the
// same codes for the same move; the Python mirror is compared in test/solver-trust.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModel } from '../lib/model.ts';
import { verifyPlan } from '../lib/verify.ts';
import { whatif } from '../lib/whatif.ts';
import { blockedRow, closedSprintRow } from '../lib/graph/blockers.ts';

const ticket = (key: string, extra: Record<string, unknown> = {}) => ({ key, sp: 1, jira_status: 'To Do', verdict: 'READY', ...extra });
const model = (tickets: ReturnType<typeof ticket>[], schedule: Array<[string, number]>, extra: Record<string, unknown> = {}) => buildModel({
  tickets: tickets as never, edges: [], config: { first_sprint: 1, end_sprint: 6, caps: { default: 9 } } as never,
  schedule: schedule.map(([key, sprint]) => ({ key, owner: 'Ana', sprint })), ...extra });
const held = [{ key: 'T-1', kind: 'decision', owner: 'Ana', due_sprint: 1, status: 'open', text: 'x' }];
const codes = (m: ReturnType<typeof model>, items: readonly Record<string, unknown>[] = []) => verifyPlan(m, m.sched, { items }).map((v) => v.code);

test('an open held_by item blocks the row of an open ticket in the current sprint', () => {
  const m = model([ticket('T-1')], [['T-1', 1]]);
  assert.deepEqual(verifyPlan(m, m.sched, { items: held }), [{ code: 'BLOCKED', key: 'T-1', detail: 'open decision' }]);
  assert.deepEqual(codes(m, [{ ...held[0], status: 'done' }]), []);
  assert.deepEqual(codes(m), []);
});

test('a verdict other than READY blocks the row', () => {
  const m = model([ticket('T-1', { verdict: 'BLOCKED_BY_DECISION' })], [['T-1', 2]]);
  assert.deepEqual(codes(m), ['BLOCKED']);
});

test('a done ticket in a closed past sprint is clean; a not-done row in a closed sprint is SPRINT_CLOSED', () => {
  const sprints = [{ n: 1, state: 'closed' }, { n: 2, state: 'closed' }];
  const done = model([ticket('T-1', { jira_status: 'Done', verdict: 'NOT_READY' })], [['T-1', 1]], { sprints });
  assert.deepEqual(codes(done, held), []);
  const open = model([ticket('T-1')], [['T-1', 2]], { sprints });
  assert.deepEqual(verifyPlan(open), [{ code: 'SPRINT_CLOSED', key: 'T-1', detail: 'S2 is closed' }]);
  assert.equal(closedSprintRow(open, 'T-1', 2), true);
  assert.equal(closedSprintRow(done, 'T-1', 1), false);
});

test('rows before first_sprint and frozen rows are not checked', () => {
  const sprints = [{ n: 1, state: 'closed' }];
  const past = buildModel({ tickets: [ticket('T-1', { verdict: 'X' })] as never, edges: [], config: { first_sprint: 3, end_sprint: 6, caps: { default: 9 } } as never, schedule: [{ key: 'T-1', owner: 'Ana', sprint: 1 }], sprints });
  assert.equal(blockedRow(past, 'T-1', 1), null);
  assert.equal(closedSprintRow(past, 'T-1', 1), false);
  const frozen = model([ticket('T-1', { verdict: 'X', jira_status: 'In Progress' })], [['T-1', 1]], { sprints });
  frozen.config.frozen_statuses = ['In Progress'];
  assert.deepEqual(codes(frozen), []);
});

test('whatif and verify give the same codes for the same move', () => {
  const sprints = [{ n: 3, state: 'closed' }];
  const m = model([ticket('T-1'), ticket('T-2')], [['T-1', 1], ['T-2', 1]], { sprints });
  for (const [sprint, want] of [[2, ['BLOCKED']], [3, ['BLOCKED', 'SPRINT_CLOSED']]] as const) {
    const w = whatif(m, { key: 'T-1', sprint }, { items: held, strict: true }).reasons.map((r) => r.code).filter((c) => c === 'BLOCKED' || c === 'SPRINT_CLOSED').sort();
    const moved = new Map(m.sched); moved.set('T-1', { owner: 'Ana', sprint });
    const v = verifyPlan(m, moved, { items: held }).map((x) => x.code).filter((c) => c === 'BLOCKED' || c === 'SPRINT_CLOSED').sort();
    assert.deepEqual(w, want);
    assert.deepEqual(v, w);
  }
  // not strict: BLOCKED stays a warning in whatif, SPRINT_CLOSED stops
  const soft = whatif(m, { key: 'T-1', sprint: 2 }, { items: held });
  assert.equal(soft.reasons.find((r) => r.code === 'BLOCKED')?.warn, true);
});
