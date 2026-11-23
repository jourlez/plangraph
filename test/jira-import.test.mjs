// Import of issue JSON that another tool already fetched (for example the Atlassian connector's saved result), no credentials, no network.
// Not covered: the exact connector response variants beyond the shapes below, which were observed once on one ticket.
import test from 'node:test';
import assert from 'node:assert/strict';
import { importIssues, snapshotToJsonl, parseSnapshotJsonl, normalizeIssue } from '../lib/jira.mjs';

const issue = (key, over = {}, links) => ({ key, fields: { summary: `s ${key}`, status: { name: 'To Do' }, assignee: { displayName: 'Ana Diaz', emailAddress: 'ana@example.invalid' }, updated: '2026-11-20T10:00:00.000+0000', reporter: { displayName: 'Zed', emailAddress: 'zed@example.invalid' }, description: 'x'.repeat(5000), ...(links ? { issuelinks: links } : {}), ...over } });
const clock = () => new Date('2026-11-22T00:00:00Z');

test('accepts the connector shape, REST search shape, a bare array and a single issue', () => {
  for (const input of [{ issues: { nodes: [issue('T-1'), issue('T-2')] } }, { issues: [issue('T-1'), issue('T-2')] }, [issue('T-1'), issue('T-2')]]) {
    assert.deepEqual(importIssues(null, input, { now: clock }).snapshot.issues.map((i) => i.key), ['T-1', 'T-2']);
  }
  assert.deepEqual(importIssues(null, issue('T-9'), { now: clock }).snapshot.issues.map((i) => i.key), ['T-9']);
});

test('keeps only needed fields: no description, no emails', () => {
  const text = snapshotToJsonl(importIssues(null, [issue('T-1')], { now: clock }).snapshot);
  assert.ok(!/example\.invalid|xxxxx/.test(text));
  assert.ok(text.length < 600, `snapshot line should be small, got ${text.length}`);
});

test('an issue without issuelinks (compact view) keeps the links already known; one with links replaces them', () => {
  const link = [{ type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }, inwardIssue: { key: 'T-5' } }];
  const first = importIssues(null, [issue('T-1', {}, link)], { now: clock }).snapshot;
  assert.equal(first.issues[0].issuelinks.length, 1);
  const second = importIssues(first, [issue('T-1', { status: { name: 'Done' }, updated: '2026-11-21T10:00:00.000+0000' })], { now: clock });
  assert.equal(second.snapshot.issues[0].status, 'Done');
  assert.equal(second.snapshot.issues[0].issuelinks.length, 1, 'links not in the input must not be erased');
  const third = importIssues(second.snapshot, [issue('T-1', { updated: '2026-11-22T10:00:00.000+0000' }, [])], { now: clock });
  assert.equal(third.snapshot.issues[0].issuelinks.length, 0, 'explicit empty links replace');
});

test('an older copy never overwrites a newer one; invalid keys are dropped and counted', () => {
  const base = importIssues(null, [issue('T-1', { updated: '2026-11-21T10:00:00.000+0000', status: { name: 'Done' } })], { now: clock }).snapshot;
  const r = importIssues(base, [issue('T-1', { updated: '2026-11-20T10:00:00.000+0000', status: { name: 'To Do' } }), { key: 'bad key', fields: {} }], { now: clock });
  assert.equal(r.snapshot.issues[0].status, 'Done');
  assert.equal(r.dropped, 1);
  assert.deepEqual(r.changedKeys, []);
});

test('merge is deterministic and idempotent; result is marked partial', () => {
  const a = importIssues(null, [issue('T-2'), issue('T-1')], { now: clock });
  const b = importIssues(a.snapshot, [issue('T-2'), issue('T-1')], { now: clock });
  assert.equal(snapshotToJsonl(a.snapshot), snapshotToJsonl(b.snapshot));
  assert.equal(a.snapshot.meta.complete, false);
  assert.equal(parseSnapshotJsonl(snapshotToJsonl(a.snapshot)).issues.length, 2);
  assert.match(a.summary, /imported 2/);
});

test('garbage input throws a clear error', () => {
  assert.throws(() => importIssues(null, 42), /no issues/);
  assert.throws(() => importIssues(null, { foo: 1 }), /no issues/);
});
void normalizeIssue;
