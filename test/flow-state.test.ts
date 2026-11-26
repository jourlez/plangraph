// Tests for lib/flow/state.ts (spec 5.3): the pure task state machine. NOT covered: reading events from disk (flow-state-merge.test.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveState, deriveAll, canTransition, type TaskState, type Deps } from '../lib/flow/state.ts';

const NONE: Deps = { openDeps: () => [], gated: () => false };
let n = 0;
const ev = (task: string, to: string, over: Record<string, unknown> = {}) => ({ at: '2026-01-01T00:00:00Z', seq: n++, actor: 'a', task, to, by: 'ann', evidence: [] as string[], ...over });

const STATES: TaskState[] = ['proposed', 'ready', 'claimed', 'in_progress', 'in_review', 'done', 'blocked', 'needs_input', 'failed', 'skipped', 'removed'];
test('canTransition table', () => {
  const yes: [TaskState, TaskState][] = [['ready', 'claimed'], ['claimed', 'in_progress'], ['in_progress', 'in_review'], ['in_review', 'done'], ['claimed', 'ready'], ['done', 'in_progress'], ['proposed', 'ready'], ['in_progress', 'in_progress']];
  const no: [TaskState, TaskState][] = [['ready', 'done'], ['proposed', 'claimed'], ['done', 'claimed'], ['claimed', 'blocked'], ['in_review', 'proposed'], ['removed', 'done'], ['ready', 'blocked']];
  for (const [a, b] of yes) assert.equal(canTransition(a, b), true, `${a}->${b}`);
  for (const [a, b] of no) assert.equal(canTransition(a, b), false, `${a}->${b}`);
  for (const s of STATES) assert.equal(typeof canTransition(s, 'done'), 'boolean');
  assert.equal(canTransition('ready', 'nonsense' as TaskState), false);
});

test('no events: ready, or blocked by an open dependency or a gate', () => {
  assert.equal(deriveState('t', [], NONE).state, 'ready');
  assert.equal(deriveState('t', [], { openDeps: () => ['p'], gated: () => false }).state, 'blocked');
  assert.equal(deriveState('t', [], { openDeps: () => [], gated: () => true }).state, 'blocked');
});

test('blocked becomes ready when the producer reaches done', () => {
  const deps: Deps = { openDeps: (k) => (k === 'c' ? ['p'] : []), gated: () => false };
  const evs = [ev('p', 'claimed', { at: '2026-01-01T00:00:01Z' })];
  assert.equal(deriveAll(['p', 'c'], evs, deps).get('c')?.state, 'blocked');
  const evs2 = [...evs, ev('p', 'in_progress', { at: '2026-01-01T00:00:02Z' }), ev('p', 'done', { at: '2026-01-01T00:00:03Z', evidence: ['test:x'] })];
  const m = deriveAll(['p', 'c'], evs2, deps);
  assert.equal(m.get('p')?.state, 'done');
  assert.equal(m.get('c')?.state, 'ready');
});

test('done with empty evidence is not done', () => {
  const evs = [ev('t', 'claimed', { at: '2026-01-01T00:00:01Z' }), ev('t', 'in_progress', { at: '2026-01-01T00:00:02Z' }), ev('t', 'done', { at: '2026-01-01T00:00:03Z' })];
  const d = deriveState('t', evs, NONE);
  assert.equal(d.state, 'in_review');
  assert.deepEqual(d.findings.map((f) => f.code), ['DONE_WITHOUT_EVIDENCE']);
});

test('merged pr verifies done, absent gives UNVERIFIED_DONE', () => {
  const evs = [ev('t', 'claimed', { at: '2026-01-01T00:00:01Z' }), ev('t', 'done', { at: '2026-01-01T00:00:03Z', evidence: ['pr:o/r#1'] })];
  const good = deriveState('t', evs, NONE, { merged: (r) => r === 'pr:o/r#1' });
  assert.equal(good.state, 'done'); assert.equal(good.verified, true); assert.deepEqual(good.findings, []);
  const bad = deriveState('t', evs, NONE, { merged: () => false });
  assert.equal(bad.state, 'done'); assert.equal(bad.verified, false); assert.deepEqual(bad.findings.map((f) => f.code), ['UNVERIFIED_DONE']);
  assert.deepEqual(bad.evidence, ['pr:o/r#1']);
});

test('two actors claiming give DOUBLE_CLAIM and the earlier holds', () => {
  const evs = [ev('t', 'claimed', { at: '2026-01-01T00:00:02Z', by: 'bob', actor: 'b' }), ev('t', 'claimed', { at: '2026-01-01T00:00:01Z', by: 'ann', actor: 'a' })];
  const d = deriveState('t', evs, NONE);
  assert.equal(d.state, 'claimed');
  assert.deepEqual(d.findings.map((f) => f.code), ['DOUBLE_CLAIM']);
  assert.equal(deriveState('t', evs.slice(1), NONE).findings.length, 0);
  // a release between the claims makes the second one legal
  const rel = [evs[1]!, ev('t', 'ready', { at: '2026-01-01T00:00:01Z', seq: 99 }), evs[0]!];
  assert.deepEqual(deriveState('t', rel, NONE).findings, []);
});

test('an illegal event is ignored and changes nothing', () => {
  const base = [ev('t', 'claimed', { at: '2026-01-01T00:00:01Z' })];
  const a = deriveState('t', base, NONE);
  const b = deriveState('t', [...base, ev('t', 'blocked', { at: '2026-01-01T00:00:05Z' }), ev('t', 'proposed', { at: '2026-01-01T00:00:06Z' }), ev('t', 'bogus', { at: '2026-01-01T00:00:07Z' })], NONE);
  assert.equal(b.state, a.state); assert.deepEqual(b.evidence, a.evidence);
  assert.deepEqual(b.findings.map((f) => f.code), ['BAD_TRANSITION', 'BAD_TRANSITION', 'BAD_TRANSITION']);
});

test('stale claim after claim_days with no later event', () => {
  const evs = [ev('t', 'claimed', { at: '2026-01-01T00:00:00Z' })];
  assert.deepEqual(deriveState('t', evs, NONE, { now: new Date('2026-01-07T00:00:00Z') }).findings, []);
  assert.deepEqual(deriveState('t', evs, NONE, { now: new Date('2026-01-09T00:00:00Z') }).findings.map((f) => f.code), ['STALE_CLAIM']);
  assert.deepEqual(deriveState('t', evs, NONE, { now: new Date('2026-01-03T00:00:00Z'), claimDays: 1 }).findings.map((f) => f.code), ['STALE_CLAIM']);
});

test('last event by (at, seq, actor) wins; other tasks ignored', () => {
  const evs = [ev('t', 'claimed', { at: '2026-01-01T00:00:01Z', seq: 0 }), ev('t', 'in_progress', { at: '2026-01-01T00:00:01Z', seq: 1 }), ev('u', 'removed', { at: '2026-01-01T00:00:09Z' })];
  assert.equal(deriveState('t', evs, NONE).state, 'in_progress');
  const tie = [ev('t', 'claimed', { at: '2026-01-01T00:00:01Z', seq: 0, actor: 'a' }), ev('t', 'needs_input', { at: '2026-01-01T00:00:01Z', seq: 0, actor: 'b' })];
  assert.equal(deriveState('t', tie, NONE).state, 'needs_input');
});

test('tracker status map', async () => {
  const { mapTrackerStatus } = await import('../lib/flow/state.ts');
  assert.equal(mapTrackerStatus('In Review'), 'in_review');
  assert.equal(mapTrackerStatus('To Do'), 'ready');
  assert.equal(mapTrackerStatus('Weird'), null);
  assert.equal(mapTrackerStatus('Weird', { Weird: 'failed' }), 'failed');
});
