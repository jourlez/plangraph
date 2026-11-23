// Characterization goldens for lib/openitems.ts (test/golden/mutation-kills/openitems.json, UPDATE_GOLDEN=1 rewrites), written to kill
// mutants that survived scripts/mutate-all.ts: derivation from findings under every rule shape (sprint:N, n_before with and without n,
// decision-owner, a fixed owner, ignored kinds, unscheduled tickets), the canonical serialization (key order, null fields, extras),
// register/close/reopen/reconcile, effective due dates, overdue lists with lead time, ready blocking, both renderers and the findings
// parser's limits. All keys and names are invented.
// NOT covered: the CLI wiring (src/commands/openitems.ts, test/openitems.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openItemsFromFindings, serializeItems, parseItems, registerItem, closeItem, reopenItem, reconcileItems, effectiveDue, overdueItems,
  closedSet, blockingItems, blocksReady, renderOpenItems, renderCompact, parseFindings,
} from '../lib/openitems.ts';
import { buildModel } from '../lib/model.ts';
import { golden, outcome } from './helpers/golden-json.ts';

const G = (name: string, fn: () => unknown) => golden('openitems', name, outcome(fn));
const config = {
  owner_of_decisions: 'Dora',
  open_items: {
    rules: [
      { kind: 'decision', owner: 'decision-owner', due: 'sprint:4' },
      { kind: 'spike', owner: 'Ana', due: 'n_before', n: 2 },
      { kind: 'question', due: 'n_before' },
      { kind: 'fixed', owner: 'ticket-owner', due: 'sprint:9' },
    ],
    ignore_kinds: ['noise'],
    lead_time: 1,
  },
};
const model = () => buildModel({
  tickets: ['A-1', 'A-2', 'B-1', 'C-9'].map((key) => ({ key, sp: 1 })),
  schedule: [{ key: 'A-1', owner: 'Ana', sprint: 3 }, { key: 'A-2', owner: 'Ben', sprint: 6 }, { key: 'B-1', owner: 'Cleo', sprint: 2 }],
  findings: [
    { key: 'A-1', kind: 'decision', text: 'pick  a\tdatabase' }, { key: 'A-1', kind: 'decision', text: 'pick a database' }, { key: 'A-1', kind: 'decision', text: 'also the cache' },
    { key: 'A-2', kind: 'spike', text: 'try the parser' }, { key: 'B-1', kind: 'question', text: 'who signs off?' }, { key: 'C-9', kind: 'question', text: 'unscheduled' },
    { key: 'C-9', kind: 'spike', text: 'unscheduled spike' }, { key: 'B-1', kind: 'noise', text: 'ignored' }, { key: 'A-2', kind: 'other' }, { key: 'A-2', kind: 'fixed', text: 'x'.repeat(400) },
    { key: 'A-1', kind: 'b|c', text: 'pipe kind' }, { key: 'A-1|b', kind: 'c', text: 'pipe key' }, { key: 'ab', kind: 'cd', text: 'one' }, { key: 'abc', kind: 'd', text: 'two' },
  ],
  config,
});

test('derivation from findings under every rule shape', () => {
  G('derived', () => openItemsFromFindings(model()));
  G('derived-default-config', () => openItemsFromFindings(model(), {}));
  G('derived-default-rule', () => openItemsFromFindings(model(), { open_items: { default_rule: { owner: 'Eve', due: 'sprint:7' } } }));
  G('derived-extra', () => openItemsFromFindings(buildModel({}), {}, { extraFindings: [null, { key: 'Z-1', kind: 'k', text: 't' }] }));
});

test('canonical serialization, parse, register, close, reopen', () => {
  const items = [
    { key: 'B', kind: 'k', owner: null, due_sprint: null, status: 'open', text: 't', alpha: 1, zeta: 2, source: 'manual', close_note: 'n', closed_by: 'x', closed_at: '2026-01-01', undef: undefined },
    { key: 'A', kind: 'k', owner: 'Ana', status: 'open', text: 'u' },
  ];
  G('serialized', () => serializeItems(items));
  G('serialized-empty', () => serializeItems([]));
  G('parsed', () => parseItems(serializeItems(items)));
  G('parse-error', () => parseItems('{"key":"A"}\n'));
  const reg = registerItem([], { key: 'K-1', kind: 'manual', text: '  spaced \n text ' });
  G('registered', () => reg);
  G('registered-defaults', () => registerItem(reg, { key: 'K-0', kind: 'manual', owner: 'Ana', due_sprint: 3 }));
  G('register-errors', () => [outcome(() => registerItem([], { key: '', kind: 'x' })), outcome(() => registerItem(reg, { key: 'K-1', kind: 'manual' }))]);
  const closed = closeItem(reg, 'K-1', 'manual', { by: 'Ben', note: 'done it', at: '2026-02-02' });
  G('closed', () => closed);
  G('closed-now', () => closeItem(reg, 'K-1', 'manual', { now: () => new Date(Date.UTC(2026, 2, 3)) }));
  G('close-errors', () => [outcome(() => closeItem(closed, 'K-1', 'manual')), outcome(() => reopenItem(reg, 'K-1', 'manual'))]);
  G('reopened', () => reopenItem(closed, 'K-1', 'manual'));
});

test('reconcile, effective due, overdue, ready blocking', () => {
  const m = model(), derived = openItemsFromFindings(m);
  const existing = [
    { ...derived[0], status: 'done', closed_at: '2026-01-01', closed_by: 'Ana', owner: 'Old', text: 'old text' },
    { key: 'GONE', kind: 'question', status: 'open', due_sprint: 1, owner: 'x', text: 'vanished' },
    { key: 'GONE', kind: 'decision', status: 'done', closed_at: '2026-01-02', owner: 'x', text: 'history' },
    { key: 'M-1', kind: 'manual', status: 'open', source: 'manual', due_sprint: 2, owner: 'Ana', text: 'mine' },
  ];
  G('reconciled', () => reconcileItems(existing, derived));
  G('reconciled-prune', () => reconcileItems(existing, derived, { pruneClosed: true }));
  const all = reconcileItems(existing, derived);
  G('effective-due', () => all.map((i) => [i.key, i.kind, effectiveDue(m, i)]));
  for (const s of [1, 2, 3, 4, 5, 8]) G(`overdue-S${s}`, () => overdueItems(m, all, { currentSprint: s }));
  G('overdue-lead0', () => overdueItems(m, all, { currentSprint: 3, leadTime: 0 }));
  G('overdue-nulls', () => overdueItems(buildModel({}), [{ key: 'Q', kind: 'k', status: 'open', due_sprint: 1, source: 'manual' }, { key: 'P', kind: 'k', status: 'open', due_sprint: 1, source: 'manual' }, { key: 'N', kind: 'k', status: 'open', due_sprint: null, source: 'manual' }], { currentSprint: 2, config: {} }));
  G('closed-set', () => [...closedSet(all)].sort());
  G('blocking', () => [blockingItems(all, 'A-2'), blocksReady(all, 'A-2'), blocksReady(all, 'A-1'), blocksReady(all, 'A-1', /** @type {any} */ ({ findings: [{ key: 'A-1', kind: 'decision' }] })), blocksReady(all, 'A-1', /** @type {any} */ ({ findings: [{ key: 'A-1', kind: 'other' }] })), blocksReady([], 'Z')]);
});

test('renderers', () => {
  const m = model(), all = reconcileItems([], openItemsFromFindings(m));
  const withClosed = closeItem(all, 'A-2', 'spike', { by: 'Ben | Co', note: 'n<o>te', at: '2026-04-04' });
  G('render-by-owner', () => renderOpenItems(withClosed));
  G('render-by-due', () => renderOpenItems(withClosed, { byOwner: false }));
  G('render-empty', () => renderOpenItems([]));
  G('compact', () => renderCompact(withClosed));
  G('compact-me', () => renderCompact(withClosed, { me: 'Ana', currentSprint: 4 }));
  G('compact-limit', () => renderCompact(withClosed, { limit: 2, maxChars: 200 }));
  G('compact-tiny', () => renderCompact(withClosed, { maxChars: 10 }));
  G('compact-none', () => renderCompact([{ key: 'A', kind: 'k', status: 'done' }]));
  G('compact-no-dues', () => renderCompact([{ key: 'A', kind: 'k', status: 'open', owner: 'x', due_sprint: null, text: 't' }]));
  assert.ok((renderCompact(withClosed) as string).length <= 480); // limit >= 0: always a string
});

test('findings parser: every error, the caps and the summary line', () => {
  const lines = ['', '{"key":"A-1","kind":"risk","text":"ok <b>"}', 'not json', '[1]', '{"key":"A-1","kind":"risk"}', '{"key":"-bad","kind":"risk","text":"t"}', '{"key":"a..b","kind":"risk","text":"t"}', '{"key":"A-1","kind":"Bad","text":"t"}', `{"key":"${'K'.repeat(121)}","kind":"risk","text":"t"}`];
  G('parse-mixed', () => parseFindings(lines.join('\n'), 'f.jsonl'));
  G('parse-bom-default-name', () => parseFindings('﻿{"key":"A","kind":"k","text":"t"}\nx'));
  G('parse-12-errors', () => parseFindings(Array.from({ length: 12 }, () => 'x').join('\n')));
  G('parse-1001-errors', () => { const r = parseFindings(Array.from({ length: 1001 }, () => 'x').join('\n')); return { total: r.total, errors: r.errors.slice(-2), n: r.errors.length }; });
  G('parse-undefined', () => parseFindings(undefined));
});
