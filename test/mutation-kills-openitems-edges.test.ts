// Behavior tests for lib/openitems.ts written to kill mutants that survived scripts/mutate-all.ts and its goldens: tie order of items
// without a due sprint, a stored due date kept when the rule names a fixed sprint, a manual item's source kept by reconcile, the default
// lead time of 0, the width caps of rendered keys, kinds, owners and closed rows, the sprint-group order (numeric, "No sprint" last),
// the compact view's exact 480-character budget, and the findings parser's exact size limits.
// NOT covered: rendering details already pinned by test/mutation-kills-openitems.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderOpenItems, renderCompact, effectiveDue, reconcileItems, overdueItems, parseFindings, MAX_FINDINGS_BYTES } from '../lib/openitems.ts';
import { buildModel } from '../lib/model.ts';
import type { OpenItem } from '../lib/openitems.ts';

const open = (o: Partial<OpenItem> & { key: string }): OpenItem => ({ kind: 'k', status: 'open', owner: 'Ana', text: 't', due_sprint: null, ...o });

test('items without a due sprint are ordered by key, after the dated ones', () => {
  const md = renderOpenItems([open({ key: 'B' }), open({ key: 'A' }), open({ key: 'C', due_sprint: 2 })]);
  assert.ok(md.indexOf('| S2 | C |') < md.indexOf('| - | A |') && md.indexOf('| - | A |') < md.indexOf('| - | B |'), md);
});

test('effectiveDue: a fixed-sprint rule keeps the stored due date; reconcile keeps a manual source', () => {
  const m = buildModel({ tickets: [{ key: 'A' }], schedule: [{ key: 'A', owner: 'Ana', sprint: 9 }], config: { open_items: { rules: [{ kind: 'k', due: 'sprint:5' }] } } });
  assert.equal(effectiveDue(m, open({ key: 'A', due_sprint: 3 })), 3);
  const out = reconcileItems([open({ key: 'A', source: 'manual', status: 'done' })], [open({ key: 'A', due_sprint: 5 })]);
  assert.deepEqual(out.map((i) => [i.key, i.source, i.status, i.due_sprint]), [['A', 'manual', 'done', 5]]);
});

test('overdue: the default lead time is 0', () => {
  const m = buildModel({}), items = [open({ key: 'A', due_sprint: 4, source: 'manual' })];
  assert.deepEqual(overdueItems(m, items, { currentSprint: 3, config: {} }), []);
  assert.equal(overdueItems(m, items, { currentSprint: 4, config: {} }).length, 1);
});

test('rendering caps: keys at 120, kinds at 60, group owners at 80, closed dates at 40 characters', () => {
  const key = 'K'.repeat(130), kind = 'q'.repeat(70), owner = 'O'.repeat(90);
  const md = renderOpenItems([open({ key, kind, owner }), { key: 'D', kind, status: 'done', owner: 'x', closed_at: 'd'.repeat(50) }]);
  assert.ok(md.includes(`| - | ${'K'.repeat(120)}…[+10 chars] | ${'q'.repeat(60)}…[+10 chars] |`), md);
  assert.ok(md.includes(`## ${'O'.repeat(80)}…[+10 chars] (1 open)`), md);
  assert.ok(md.includes(`| D | ${'q'.repeat(60)}…[+10 chars] | x | ${'d'.repeat(40)}…[+10 chars] |  |  |`), md);
  const compact = renderCompact([open({ key, kind, owner, due_sprint: 1 })], { maxChars: 10000 }) as string; // limit >= 0: always a string
  assert.equal(compact.split('\n')[1], `- ${'K'.repeat(120)}…[+10 chars] ${'q'.repeat(60)}…[+10 chars] S1 ${'O'.repeat(60)}…[+30 chars]: t`);
});

test('grouping by due sprint: numeric order, "No sprint" last', () => {
  const md = renderOpenItems([open({ key: 'A', due_sprint: 10 }), open({ key: 'B' }), open({ key: 'C', due_sprint: 2 }), open({ key: 'D', due_sprint: 10 })], { byOwner: false });
  const heads = md.split('\n').filter((l) => l.startsWith('## '));
  assert.deepEqual(heads, ['## S2 (1 open)', '## S10 (2 open)', '## No sprint (1 open)']);
});

test('compact view: nothing open is one fixed line; the 480-character budget is inclusive', () => {
  assert.equal(renderCompact([], { currentSprint: 3 }), 'open items: 0');
  // the key grows one character at a time (keys are shown up to 120 characters), so some length gives exactly 480 characters
  const items = (L: number) => Array.from({ length: 8 }, (_, i) => open({ key: `K${i}${'k'.repeat(L)}`, due_sprint: 1, text: 'x' }));
  let L = 1; while (L < 100 && (renderCompact(items(L), { maxChars: Infinity, limit: 5 }) as string).length < 480) L++; // limit >= 0: always a string
  assert.ok(L < 100, 'the search found a length at or above 480');
  const full = renderCompact(items(L), { maxChars: Infinity, limit: 5 }) as string; // limit >= 0: always a string
  if (full.length === 480) assert.equal(renderCompact(items(L)), full, 'exactly 480 characters fit');
  else assert.notEqual(renderCompact(items(L)), full, 'over 480 characters drop a line');
  const exact = items(L - 1), shown = renderCompact(exact, { maxChars: Infinity, limit: 5 }) as string; // limit >= 0: always a string
  assert.ok(shown.length < 480);
  assert.equal(renderCompact(exact), shown);
  assert.equal(renderCompact(exact, { maxChars: shown.length }), shown, 'a budget equal to the length is enough');
  assert.notEqual(renderCompact(exact, { maxChars: shown.length - 1 }), shown);
});

test('findings parser: the exact size limits and the summary threshold', () => {
  const big = parseFindings('x'.repeat(MAX_FINDINGS_BYTES + 1));
  assert.deepEqual(big, { findings: [], errors: [`findings: input larger than ${MAX_FINDINGS_BYTES} bytes, refused`], total: 1 });
  assert.equal(parseFindings(' '.repeat(MAX_FINDINGS_BYTES)).total, 0, 'exactly the limit is read');
  const pad = (n: number) => { const head = '{"key":"A","kind":"k","text":"', tail = '"}'; return head + 'y'.repeat(n - head.length - tail.length) + tail; };
  assert.equal(parseFindings(pad(1 << 20)).findings.length, 1, 'a line of exactly 1 MiB is read');
  assert.deepEqual(parseFindings(pad((1 << 20) + 1)).errors, ['findings:1: line too long']);
  assert.deepEqual(parseFindings(Array.from({ length: 10 }, () => 'x').join('\n')).errors.length, 10, 'exactly 10 errors: no summary line');
  const many = parseFindings(Array.from({ length: 100001 }, (_, i) => `{"key":"K-${i}","kind":"k","text":"t"}`).join('\n'));
  assert.equal(many.findings.length, 100000);
  assert.deepEqual(many.errors, ['findings:100001: more than 100000 findings, rest ignored']);
});
