// Integrity of the graph files in build, check and doctor (lib/graph/integrity.ts): one fixture and one exact message line per code, exit codes,
// and a v1-only directory without new output. NOT covered: the parse errors themselves (test/graph-files.test.ts).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { integrity, renderViolation } from '../lib/graph/integrity.ts';
import type { GraphFiles } from '../lib/graph/files.ts';
import { made, state, fixture, copy, run, jl } from './helpers/cli-fixture.ts';
import { adoptPlanDir } from './helpers/plan-dir.ts';

before(async () => { state.FIX = await fixture(); });
after(() => { for (const d of [state.FIX, ...made]) fs.rmSync(d, { recursive: true, force: true }); });

const EMPTY: GraphFiles = { people: [], sprints: [], epics: [], repos: [], capacity: [], links: [], xrefs: [], ext: 0, warnings: [] };
const g = (more: Partial<GraphFiles>): GraphFiles => ({ ...EMPTY, ...more });
const V1 = { tickets: [{ key: 'T-1' }, { key: 'sp:a/1', epic: 'sp:a' }, { key: 'J-1' }], schedule: [{ key: 'sp:a/1', owner: 'Ana', sprint: 2 }, { key: 'J-1', owner: 'Ana', sprint: 2 }] };
const lines = (f: Partial<GraphFiles>, items: Array<{ key: string; kind: string }> = []) => integrity(g(f), V1, items).map(renderViolation);
const link = (to: string, to_type: string, from = 'T-1', from_type = 'ticket') => ({ from, from_type, rel: 'relates_to', to, to_type }) as GraphFiles['links'][number];

test('no graph file gives no violation', () => assert.deepEqual(lines({}), []));

test('LINK_MISSING_NODE: a link endpoint that is no node; implicit nodes, open items and extension types are fine', () => {
  assert.deepEqual(lines({ links: [link('Zed', 'person')] }), ['error: LINK_MISSING_NODE links.jsonl: person Zed is not a node (link T-1 relates_to Zed)']);
  assert.deepEqual(lines({ links: [link('Ana', 'person'), link('S2', 'sprint'), link('sp:a', 'epic'), link('x', 'x-gh.pr')] }), []); // v1 owners, sprints and epics are implicit nodes
  const items = [{ key: 'T-1', kind: 'risk' }];
  assert.deepEqual(lines({ links: [link('T-1|risk', 'openitem')] }, items), []);
  assert.equal(lines({ links: [link('T-1|gone', 'openitem')] }, items).length, 1);
});

test('XREF_MISSING_NODE and XREF_DUPLICATE', () => {
  const x = (id: string, xid = 'ABC-1') => ({ type: 'ticket', id, sys: 'jira:acme', xid }) as GraphFiles['xrefs'][number];
  assert.deepEqual(lines({ xrefs: [x('T-9')] }), ['error: XREF_MISSING_NODE xrefs.jsonl: ticket T-9 is not a node (xref jira:acme ABC-1)']);
  assert.deepEqual(lines({ xrefs: [x('T-1'), x('J-1')] }), ['error: XREF_DUPLICATE xrefs.jsonl: jira:acme ABC-1 is on 2 ticket nodes (J-1, T-1); keep one row, then run plangraph build']);
  assert.deepEqual(lines({ xrefs: [x('T-1'), x('T-1', 'ABC-2')] }), []);
});

test('UNDATED_SPRINT is a warning and only when some sprints are dated', () => {
  const d = { n: 1, start: '2026-01-05', end: '2026-01-16' };
  assert.deepEqual(lines({ sprints: [d, { n: 2 }] }), ['warning: UNDATED_SPRINT sprints.jsonl: 1 of 2 sprints have no start and end date; give every sprint both, or none']);
  assert.deepEqual(lines({ sprints: [{ n: 1 }, { n: 2 }] }), []);
  assert.deepEqual(lines({ sprints: [d] }), []);
});

test('DOUBLE_PLACED_WORK fires on an explicit xref when both tickets are placed', () => {
  const x = { type: 'ticket', id: 'sp:a/1', sys: 'jira:acme', xid: 'J-1' } as GraphFiles['xrefs'][number];
  assert.deepEqual(lines({ xrefs: [x] }), ['warning: DOUBLE_PLACED_WORK xrefs.jsonl: sp:a/1 and J-1 are one work item and both are placed, so capacity counts it twice; keep one of the two placed (`sp-link --track` records the link, it does not unplace either)']);
  assert.deepEqual(integrity(g({ xrefs: [x] }), { ...V1, schedule: V1.schedule.slice(0, 1) }, []), []);
});

const flat = (r: { out: string[] }) => r.out.join('\n').split('\n');
const put = (d: string, f: string, rows: readonly object[]) => { fs.writeFileSync(path.join(d, '.plangraph', f), jl([...rows])); adoptPlanDir(path.join(d, '.plangraph')); };
const sprints = [{ n: 1, start: '2026-01-05', end: '2026-01-16' }, { n: 2 }];

test('build prints violations on stderr and exits 0; check exits 1 on an error and 0 on a warning alone', async () => {
  const d = copy();
  put(d, 'links.jsonl', [link('Zed', 'person')]);
  const b = await run(d, ['build']);
  assert.equal(b.code, 0);
  assert.ok(b.err.includes('error: LINK_MISSING_NODE links.jsonl: person Zed is not a node (link T-1 relates_to Zed)'), b.err.join('\n'));
  const base = (await run(copy(), ['check'])).code;
  const c = await run(d, ['check']); assert.equal(c.code, 1);
  assert.ok(c.err.concat(c.out).some((l) => l.startsWith('error: LINK_MISSING_NODE ')));
  const w = copy();
  put(w, 'sprints.jsonl', sprints);
  const wb = await run(w, ['build']);
  assert.equal(wb.code, 0); assert.ok(wb.err.some((l) => l.startsWith('warning: UNDATED_SPRINT sprints.jsonl: ')));
  assert.equal((await run(w, ['check'])).code, base);
});

test('build exits 2 on XREF_BAD_ID and LINK_DERIVED_REL (a duplicate id cannot be written in the entity layout: check reports DUPLICATE_ID)', async () => {
  for (const [f, rows, code] of [
    ['xrefs.jsonl', [{ type: 'ticket', id: 'T-1', sys: 'jira', xid: 'a..b' }], 'XREF_BAD_ID'],
    ['links.jsonl', [{ from: 'T-1', from_type: 'ticket', rel: 'needs', to: 'T-2', to_type: 'ticket' }], 'LINK_DERIVED_REL'],
  ] as const) {
    const d = copy(); put(d, f, rows);
    assert.equal((await run(d, ['build'])).code, 2, code);
  }
});

test('doctor: count and check hint only above 0, ext ignored, capacity warning; v1-only unchanged', async () => {
  const base = await run(copy(), ['doctor']);
  assert.ok(!flat(base).some((l) => /integrity|ext ignored|capacity/.test(l)));
  const v = copy(); put(v, 'sprints.jsonl', sprints); put(v, 'links.jsonl', [link('Zed', 'person'), { from: 'a', from_type: 'x-gh.pr', rel: 'x-gh/closes', to: 'T-1', to_type: 'ticket' }]);
  const rv = await run(v, ['doctor']);
  assert.ok(flat(rv).includes('graph integrity: 2 violations; run `plangraph check` to list them'));
  assert.ok(flat(rv).includes('ext ignored 1'));
  const cap = copy(); put(cap, 'capacity.jsonl', [{ person: 'Ana', sprint: 1, sp: 99 }]);
  assert.ok(flat(await run(cap, ['doctor'])).some((l) => l.startsWith('warning: capacity.jsonl: Ana sprint 1 has 99 sp')));
});

test('the baseline probes integrity-missing-node and integrity-undated-sprint print the expected lines', async () => {
  const { PROBES } = await import('../scripts/baseline.ts');
  const run1 = (id: string) => (PROBES.find((p: { id: string }) => p.id === id) as { run: () => Promise<unknown> }).run();
  assert.deepEqual(await run1('integrity-missing-node'), ['error: LINK_MISSING_NODE links.jsonl: person Zed is not a node (link T-1 relates_to Zed)']);
  assert.deepEqual(await run1('integrity-undated-sprint'), ['warning: UNDATED_SPRINT sprints.jsonl: 1 of 2 sprints have no start and end date; give every sprint both, or none']);
});
