// whatif gate (BLOCKED), slot (SPRINT_CLOSED) and the bounded `touches` line (amendment section 3.7, Task 11).
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModel } from '../lib/model.ts';
import { whatif, proposeMove, findSlots, renderWhatif, touchesLine, estTokens, TOUCHES_TOKENS } from '../lib/whatif.ts';
import type { NodeRef, Rel, Reached } from '../lib/graph/views.ts';

const base = (over: Record<string, unknown> = {}) => buildModel({
  tickets: [{ key: 'A', sp: 1, jira_status: 'To Do' }, { key: 'B', sp: 1, jira_status: 'To Do', verdict: 'READY' }],
  schedule: [{ key: 'A', owner: 'Ana', sprint: 1 }, { key: 'B', owner: 'Ana', sprint: 1 }],
  config: { first_sprint: 1, end_sprint: 4, caps: { default: 10 } },
  sprints: [{ n: 1, state: 'active' }, { n: 2, state: 'closed' }, { n: 3, state: 'active', end: '2026-01-10' }, { n: 4, state: 'future', end: '2099-01-01' }],
  ...over,
});

test('a READY ticket with no open item passes the gate', () => {
  assert.equal(whatif(base(), { key: 'B', sprint: 4 }).ok, true);
});

test('a verdict other than READY gives BLOCKED as a warning, a stop under strict', () => {
  const m = base({ tickets: [{ key: 'A', sp: 1, jira_status: 'To Do', verdict: 'NEEDS_INFO' }, { key: 'B', sp: 1 }] });
  const w = whatif(m, { key: 'A', sprint: 4 });
  assert.equal(w.ok, true);
  assert.deepEqual(w.reasons.map((r) => [r.code, r.warn]), [['BLOCKED', true]]);
  assert.match(w.reasons[0]!.detail, /verdict NEEDS_INFO/);
  const s = whatif(m, { key: 'A', sprint: 4 }, { strict: true });
  assert.equal(s.ok, false);
  assert.deepEqual(s.reasons.map((r) => [r.code, r.warn]), [['BLOCKED', undefined]]);
  assert.equal(s.suggestion, null, 'a move cannot repair a gate');
  assert.equal(proposeMove(m, { key: 'A', sprint: 4 }, { strict: true }).ok, false);
});

test('an open held_by item gives BLOCKED; a closed one does not', () => {
  const m = base();
  const open = [{ key: 'A', kind: 'decision', status: 'open', owner: 'Ana', text: 'pick a vendor' }];
  const w = whatif(m, { key: 'A', sprint: 4 }, { items: open });
  assert.deepEqual(w.reasons.map((r) => r.code), ['BLOCKED']);
  assert.match(w.reasons[0]!.detail, /open decision/);
  assert.deepEqual(whatif(m, { key: 'A', sprint: 4 }, { items: [] }).reasons, []);
});

test('a producer that is still waiting is not BLOCKED (order is PRODUCER_LATE)', () => {
  const m = base({ edges: [{ consumer: 'A', producer: 'B' }] });
  assert.ok(!whatif(m, { key: 'A', sprint: 4 }).reasons.some((r) => r.code === 'BLOCKED'));
});

test('a closed target sprint gives SPRINT_CLOSED, a hard stop with no suggestion', () => {
  const w = whatif(base(), { key: 'A', sprint: 2 });
  assert.equal(w.ok, false);
  assert.deepEqual(w.reasons.map((r) => r.code), ['SPRINT_CLOSED']);
  assert.equal(w.suggestion, null);
  assert.equal(proposeMove(base(), { key: 'A', sprint: 2 }).ok, false);
});

test('a sprint whose end is before the as-of day gives SPRINT_CLOSED; with no as-of it does not', () => {
  assert.deepEqual(whatif(base(), { key: 'A', sprint: 3 }, { asOf: '2026-02-01' }).reasons.map((r) => r.code), ['SPRINT_CLOSED']);
  assert.equal(whatif(base(), { key: 'A', sprint: 3 }, { asOf: '2026-01-10' }).ok, true, 'the end day itself is still open');
  assert.equal(whatif(base(), { key: 'A', sprint: 3 }).ok, true);
  assert.equal(whatif(base(), { key: 'A', sprint: 4 }, { asOf: '2026-02-01' }).ok, true);
});

test('findSlots skips closed sprints and does not mark a gate warning as started', () => {
  const m = base({ tickets: [{ key: 'A', sp: 1, verdict: 'NO' }, { key: 'B', sp: 1 }] });
  const r = findSlots(m, 'A', {});
  assert.ok(!r.slots.some((x) => x.sprint === 2));
  assert.ok(r.slots.length > 0 && r.slots.every((x) => x.warn === false));
});

test('renderWhatif appends the touches line', () => {
  const w = whatif(base(), { key: 'B', sprint: 4 });
  assert.ok(!renderWhatif(w).includes('touches'));
  assert.ok(renderWhatif({ ...w, touches: 'touches: repo web' }).endsWith(' touches: repo web'));
});

// a fake reader over a small list of directed relations
type L = [string, string, string, string, string]; // src, srcType, rel, dst, dstType
function reader(links: L[]) {
  const seen: string[] = [];
  return { seen, reach(start: NodeRef, rels: readonly Rel[], depth: number, reverse: boolean): Reached[] {
    assert.equal(depth, 1);
    for (const r of rels) seen.push(r);
    return links.filter((l) => rels.includes(l[2] as Rel) && (reverse ? l[3] === start.id && l[4] === start.type : l[0] === start.id && l[1] === start.type))
      .map((l) => ({ id: reverse ? l[0] : l[3], type: (reverse ? l[1] : l[4]) as NodeRef['type'], path: [] }));
  } };
}
const LINKS: L[] = [
  ['docs/p.md#3', 'plantask', 'implements', 'T-1', 'ticket'], ['docs/p.md#3', 'plantask', 'part_of', 'docs/p.md', 'plan'],
  ['docs/p.md#4', 'plantask', 'part_of', 'docs/p.md', 'plan'],
  ['T-1', 'ticket', 'tracked_by', 'jira:ABC-123', 'x-jira.ref'], ['T-1', 'ticket', 'touches', 'web', 'repo'],
  ['T-1', 'ticket', 'belongs_to', 'E-1', 'epic'], ['T-1', 'ticket', 'relates_to', 'T-9', 'ticket'],
];

test('touchesLine: trace and identity relations only, depth 2, the plan named once', () => {
  const g = reader(LINKS);
  assert.equal(touchesLine(g, 'T-1'), 'touches: plan docs/p.md#3, repo web, jira ABC-123');
  for (const bad of ['belongs_to', 'relates_to', 'depends_on', 'owned_by', 'needs', 'held_by']) assert.ok(!g.seen.includes(bad), bad);
  for (const ok of ['implements', 'part_of', 'specified_by', 'touches', 'tracked_by']) assert.ok(g.seen.includes(ok), ok);
});

test('touchesLine: nothing traced gives null; note adds a parenthetical', () => {
  assert.equal(touchesLine(reader([]), 'T-1'), null);
  assert.match(touchesLine(reader(LINKS), 'T-1', { note: (n) => (n.id === 'jira:ABC-123' ? 'assignee Ben' : null) }) as string, /jira ABC-123 \(assignee Ben\)/);
});

test('touchesLine: at most 40 estimated tokens, the rest counted', () => {
  const many: L[] = Array.from({ length: 30 }, (_, i): L => ['T-1', 'ticket', 'touches', `service-number-${i}`, 'repo']);
  const line = touchesLine(reader(many), 'T-1') as string;
  assert.ok(estTokens(line) <= TOUCHES_TOKENS, line);
  assert.match(line, / \+\d+$/);
});

test('touchesLine: control characters in an id never reach the line', () => {
  const line = touchesLine(reader([['T-1', 'ticket', 'touches', 'a\u0007b\nc', 'repo']]), 'T-1') as string;
  assert.ok(!/[\u0000-\u001f]/.test(line));
});
