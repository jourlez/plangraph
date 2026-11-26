// Offline checks for evals/graph-format: question set integrity, ground-truth recomputation, golden queries, Wilson and token budget. No model call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TICKETS, PEOPLE, SPRINTS } from '../evals/graph-format/plan.ts';
import { questions } from '../evals/graph-format/questions.ts';
import { wilson, estTokens, ANSWER_BUDGET_TOKENS, summarize } from '../evals/graph-format/report.ts';

const qs = questions();

test('question set: size, unique ids, non-empty fields, known golden commands', () => {
  assert.ok(qs.length >= 100 && qs.length <= 200, String(qs.length));
  assert.equal(new Set(qs.map((q) => q.id)).size, qs.length);
  assert.deepEqual(questions(), qs); // deterministic
  for (const q of qs) {
    assert.ok(q.text && q.answer !== undefined, q.id);
    assert.ok(['ticket', 'graph'].includes(q.golden[0] as string), q.id);
    assert.ok(TICKETS.some((t) => t.key === q.golden[1]), q.id);
  }
});

test('plan: every ticket has a known owner and sprint, and deps point backwards (acyclic)', () => {
  const idx = new Map(TICKETS.map((t, i) => [t.key, i]));
  for (const [i, t] of TICKETS.entries()) {
    assert.ok(PEOPLE.includes(t.owner) && SPRINTS.includes(t.sprint));
    for (const d of t.deps) assert.ok((idx.get(d) ?? Infinity) < i);
  }
});

test('ground truth recomputed independently (path counting over reverse edges)', () => {
  const kids = new Map<string, string[]>();
  for (const t of TICKETS) for (const d of t.deps) kids.set(d, [...(kids.get(d) ?? []), t.key]);
  const reach = (k: string, seen = new Set<string>()): Set<string> => { for (const c of kids.get(k) ?? []) if (!seen.has(c)) { seen.add(c); reach(c, seen); } return seen; };
  for (const q of qs) {
    const t = TICKETS.find((x) => x.key === q.golden[1]);
    assert.ok(t);
    if (q.kind === 'owner') assert.equal(q.answer, t.owner);
    else if (q.kind === 'sprint') assert.equal(q.answer, t.sprint);
    else if (q.kind === 'deps') assert.equal(q.answer, t.deps.join(','));
    else assert.equal(q.answer, String(reach(t.key).size));
  }
  assert.ok(qs.filter((q) => q.kind === 'downstream').some((q) => Number(q.answer) > 3)); // the closure is not trivial
});

test('wilson interval and summary', () => {
  const [lo, hi] = wilson(8, 10);
  assert.ok(Math.abs(lo - 0.4902) < 1e-3 && Math.abs(hi - 0.9433) < 1e-3, `${lo} ${hi}`);
  assert.deepEqual(wilson(0, 0), [0, 1]);
  const [l1, h1] = wilson(10, 10);
  assert.ok(h1 > 0.999 && l1 > 0.71 && l1 < 0.73);
  assert.match(summarize([{ id: 'a', format: 'text', correct: true, tokens: 10, toolCalls: 1 }]), /text: 1\/1 correct/);
});

test('per-answer token budget: golden answers fit', () => {
  for (const q of qs) assert.ok(estTokens(q.answer) <= ANSWER_BUDGET_TOKENS, q.id);
  assert.equal(estTokens('a'.repeat(1000)), 250);
});
