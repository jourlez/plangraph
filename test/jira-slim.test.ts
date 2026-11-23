// `brain jira-import` on the SLIM connector shape documented in docs/JIRA.md (UNVERIFIED: the call was not made). The fixture is built from
// the real payload shape verified once (custom fields under fields.customFields keyed by DISPLAY NAME as { id, value }; Sprint value an
// array of { id, name, state, boardId, goal, startDate, endDate }) with only the requested fields kept. Invented keys and names.
// A field the slim response leaves out keeps the value already in the snapshot (as issuelinks already did); a field present but empty
// or null replaces it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { importIssues, snapshotToJsonl } from '../lib/jira.ts';

const clock = () => new Date('2026-11-22T00:00:00Z');
const sprint = (id: number, state: string) => ({ id, name: `Demo Sprint ${id}`, state, boardId: 7, goal: 'GOAL-TEXT-NOT-STORED', startDate: '2026-11-01T00:00:00.000Z', endDate: '2026-11-14T00:00:00.000Z' });
const link = (dir: string, key: string) => ({ type: { id: '10000', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }, [dir === 'in' ? 'inwardIssue' : 'outwardIssue']: { key } });
const slim = (over: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  key: 'DEMO-1',
  fields: {
    summary: 'Build the demo widget', status: { name: 'In Progress' }, assignee: { displayName: 'Demo Person' },
    issuelinks: [link('in', 'DEMO-2'), link('out', 'DEMO-3'), ...Array.from({ length: 20 }, (_, i) => link('out', `DEMO-${10 + i}`))],
    customFields: { 'Story Points': { id: 'customfield_90016', value: 5 }, Sprint: { id: 'customfield_90020', value: [sprint(41, 'closed'), sprint(42, 'active')] } },
    ...over,
  },
  ...extra,
});

test('the slim shape imports: summary, status, assignee, 22 links, sprints; nothing the snapshot drops leaks in', () => {
  const r = importIssues(null, { issues: { nodes: [slim()] } }, { now: clock });
  const it = r.snapshot.issues[0];
  assert.equal(r.imported, 1); assert.equal(r.dropped, 0);
  assert.equal(it.summary, 'Build the demo widget'); assert.equal(it.status, 'In Progress'); assert.equal(it.assignee, 'Demo Person');
  assert.equal(it.issuelinks.length, 22);
  assert.deepEqual(it.issuelinks.slice(0, 2), [{ key: 'DEMO-10', type: 'Blocks', dir: 'out', rel: 'blocks' }, { key: 'DEMO-11', type: 'Blocks', dir: 'out', rel: 'blocks' }]);
  assert.deepEqual(it.issuelinks.find((l) => l.key === 'DEMO-2'), { key: 'DEMO-2', type: 'Blocks', dir: 'in', rel: 'is blocked by' });
  assert.deepEqual(it.sprint, [{ id: 41, name: 'Demo Sprint 41', state: 'closed' }, { id: 42, name: 'Demo Sprint 42', state: 'active' }]);
  assert.doesNotMatch(snapshotToJsonl(r.snapshot), /GOAL-TEXT|boardId|startDate|customfield_|Story Points/);
  // a link whose type was trimmed to the name only still imports (rel empty)
  const t = importIssues(null, [slim({ issuelinks: [{ type: { name: 'Relates' }, outwardIssue: { key: 'DEMO-5' } }] })], { now: clock });
  assert.deepEqual(t.snapshot.issues[0].issuelinks, [{ key: 'DEMO-5', type: 'Relates', dir: 'out', rel: '' }]);
  // the single-issue form (getJiraIssue result) is accepted too
  assert.equal(importIssues(null, slim(), { now: clock }).snapshot.issues[0].issuelinks.length, 22);
});

test('fields the slim response leaves out keep the snapshot values; present-but-empty values replace them', () => {
  const full = importIssues(null, [slim({ updated: '2026-11-21T10:00:00.000+0000', resolutiondate: '2026-11-21T09:00:00.000+0000' })], { now: clock }).snapshot;
  const s: Record<string, unknown> = { ...slim().fields }; delete s.summary; delete s.assignee; delete s.customFields;
  const r = importIssues(full, [{ key: 'DEMO-1', fields: { ...s, status: { name: 'Done' } } }], { now: clock });
  const it = r.snapshot.issues[0];
  assert.equal(it.status, 'Done', 'a present field replaces');
  assert.equal(it.summary, 'Build the demo widget', 'summary not requested: kept');
  assert.equal(it.assignee, 'Demo Person', 'assignee not requested: kept');
  assert.equal(it.updated, '2026-11-21T10:00:00.000+0000', 'updated not requested: kept (so an older copy still never wins later)');
  assert.equal(it.resolutiondate, '2026-11-21T09:00:00.000+0000', 'resolutiondate not requested: kept');
  assert.deepEqual(it.sprint, [{ id: 41, name: 'Demo Sprint 41', state: 'closed' }, { id: 42, name: 'Demo Sprint 42', state: 'active' }], 'no Sprint entry: kept');
  assert.deepEqual(r.changedKeys, ['DEMO-1']);
  // present but empty: an unassigned issue (assignee null) and an empty sprint list replace the old values
  const e = importIssues(full, [slim({ assignee: null, customFields: { Sprint: { id: 'customfield_90020', value: [] } } })], { now: clock }).snapshot.issues[0];
  assert.equal(e.assignee, ''); assert.deepEqual(e.sprint, []);
  // with no previous snapshot nothing is invented
  const n = importIssues(null, [{ key: 'DEMO-9', fields: { status: { name: 'To Do' } } }], { now: clock }).snapshot.issues[0];
  assert.equal(n.summary, ''); assert.equal(n.updated, ''); assert.equal(n.sprint, undefined);
  // prototype-ish names in fields are not treated as present fields
  const p = importIssues(full, [{ key: 'DEMO-1', fields: JSON.parse('{"__proto__":{"summary":"x"},"status":{"name":"Done"}}') }], { now: clock }).snapshot.issues[0];
  assert.equal(p.summary, 'Build the demo widget');
});

test('the documented slim fixture is a fraction of the measured baseline (synthetic, chars only)', () => {
  const bytes = JSON.stringify({ issues: { nodes: [slim()] } }).length;
  assert.ok(bytes < 5000, String(bytes)); // docs/JIRA.md quotes this size against the ~15,000-character baseline
});
