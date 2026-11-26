// One blocker definition (lib/graph/blockers.ts): blockersOf over the index (graphReader) answers exactly what readiness answers over the
// model, and a relation that is not gate or order (REL_SEMANTICS) changes nothing. Plus the commands that now read the views.
// NOT covered: the timing ratio of readySet, the CLI text of `ready` (test/ready*.test.ts) and the frozen 0.3.0 outputs (test/golden.test.ts).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildIndex, openIndex, INDEX_FILE } from '../src/db.ts';
import { buildModel } from '../lib/model.ts';
import type { Edge, PlanRecord, ScheduleRow, Ticket } from '../lib/model.ts';
import { readiness, readySet, closedStatuses } from '../lib/ready.ts';
import { blockersOf, modelSource } from '../lib/graph/blockers.ts';
import { graphReader } from '../lib/graph/views.ts';
import { REL_SEMANTICS, RELATIONS, DERIVED_RELATIONS } from '../lib/graph/files.ts';
import type { OpenItem } from '../lib/openitems.ts';
import { adoptPlanDir } from './helpers/plan-dir.ts';

const tmps: string[] = [];
after(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });
const jl = (rows: readonly object[]) => rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
const tk = (key: string, more: Record<string, unknown> = {}) => ({ key, summary: key, epic: '', sp: 1, jira_status: 'To Do', verdict: 'READY', ...more });

const TICKETS = [tk('D-1', { jira_status: 'Done' }), tk('R-1'), tk('B-1', { verdict: 'BLOCKED' }), tk('W-1'), tk('F-1'), tk('I-1'), tk('X-1'), tk('sp:a', { impl_status: 'done' }), tk('sp:b', { impl_status: 'todo' }), tk('sp:c')];
const EDGES = [{ consumer: 'W-1', producer: 'R-1', kind: 'code' }, { consumer: 'R-1', producer: 'D-1', kind: 'code' }, { consumer: 'X-1', producer: 'ghost', kind: 'code' }, { consumer: 'sp:c', producer: 'sp:a', kind: 'link' }, { consumer: 'sp:c', producer: 'sp:b', kind: 'link' }, { consumer: 'W-1', producer: 'B-1', kind: 'soft' }];
const SCHED = [{ version: 'current', key: 'R-1', owner: 'Ana', sprint: 1 }, { version: 'v2', key: 'B-1', owner: 'Ben', sprint: 2 }, { version: 'current', key: 'sp:b', owner: 'Ben', sprint: 2 }];
const FINDINGS = [{ key: 'F-1', kind: 'scope', text: 'unclear' }, { key: 'F-1', kind: 'dep', text: 'late' }, { key: 'I-1', kind: 'scope', text: 'x' }];
const ITEMS = [{ key: 'F-1', kind: 'dep', status: 'done', owner: 'Ana', text: 'done' }, { key: 'I-1', kind: 'scope', status: 'open', owner: 'Ana', text: 'dup of finding' }, { key: 'I-1', kind: 'extra', status: 'open', owner: 'Ben', text: 'more' }] as OpenItem[];
const CONFIG = { closed_statuses: ['Closed'], ignore_link_kinds: ['soft'] };

function fixture(extra: Record<string, readonly object[]> = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'blockers-one-'))); tmps.push(dir);
  const files: Record<string, readonly object[]> = { 'tickets.jsonl': TICKETS, 'edges.jsonl': EDGES, 'schedule.jsonl': SCHED, 'findings.jsonl': FINDINGS, ...extra };
  for (const [f, rows] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), jl(rows));
  adoptPlanDir(dir);
  buildIndex({ dir });
  const h = openIndex(path.join(dir, INDEX_FILE), { dir });
  const model = buildModel({ tickets: TICKETS as Ticket[], edges: EDGES as Edge[], schedule: SCHED as ScheduleRow[], config: CONFIG, findings: FINDINGS as PlanRecord[], evidence: [], learnings: [] });
  return { h, model };
}
const ign = new Set(CONFIG.ignore_link_kinds);

test('blockersOf over the index equals readiness over the model for every ticket', () => {
  const { h, model } = fixture();
  const closed = closedStatuses(CONFIG), src = graphReader(h, ITEMS), snap = { 'R-1': { status: 'Closed' }, 'B-1': { status: 9 } };
  for (const statuses of [null, snap]) {
    for (const key of [...TICKETS.map((t) => t.key), 'nope']) {
      assert.deepEqual(blockersOf(src, key, { statuses, closed, ignore: ign }), readiness(model, key, { items: ITEMS, statuses, closed }), `${key} ${statuses ? 'snapshot' : 'stored'}`);
    }
  }
  const w = readiness(model, 'W-1', { items: ITEMS });
  assert.deepEqual(w.reasons, [{ code: 'WAITS', key: 'R-1', status: 'To Do', impl: false, place: { sprint: 1, owner: 'Ana' } }], 'an ignored kind (soft) and a done producer block nothing');
  assert.equal(readiness(model, 'X-1').ready, true, 'a producer that is not in the plan blocks nothing');
  const fi = readiness(model, 'F-1', { items: ITEMS }).reasons;
  assert.deepEqual(fi.map((r) => (r.code === 'OPEN_ITEM' ? `${r.from}:${r.kind}` : r.code)), ['finding:scope'], 'a closed item closes its finding; an item of a finding kind is not named twice');
  h.close();
});

test('readiness and readySet take an explicit source and give the same answers', () => {
  const { h, model } = fixture();
  const src = modelSource(model, { items: ITEMS });
  for (const t of TICKETS) assert.deepEqual(readiness(model, t.key, { source: src }), readiness(model, t.key, { items: ITEMS }));
  const rs = readySet(model, ITEMS);
  assert.deepEqual(rs.ready.concat(rs.done, rs.blocked.map((b) => b.key), rs.waiting, rs.verdict).sort().filter((k, i, a) => a.indexOf(k) === i).length, TICKETS.length);
  h.close();
});

test('REL_SEMANTICS: only gate and order relations block; no other relation or xref changes an answer', () => {
  assert.ok(Object.isFrozen(REL_SEMANTICS));
  assert.deepEqual(Object.keys(REL_SEMANTICS).sort(), [...RELATIONS, ...DERIVED_RELATIONS].sort());
  assert.deepEqual(Object.entries(REL_SEMANTICS).filter(([, s]) => s === 'gate' || s === 'order').map(([r]) => r).sort(), ['held_by', 'needs']);
  const base = fixture(), closed = closedStatuses(CONFIG);
  const noise = [
    ...(['relates_to', 'depends_on', 'touches'] as const).map((rel) => ({ from: 'W-1', from_type: 'ticket', rel, to: 'B-1', to_type: 'ticket' })),
    { from: 'pr-7', from_type: 'x-github.pr', rel: 'x-github/closes', to: 'W-1', to_type: 'ticket' },
    { from: 'W-1', from_type: 'ticket', rel: 'x-github/closes', to: 'B-1', to_type: 'ticket' },
    { from: 'repo:web', from_type: 'repo', rel: 'relates_to', to: 'W-1', to_type: 'ticket' },
  ];
  const more = fixture({ 'links.jsonl': noise, 'xrefs.jsonl': [{ type: 'ticket', id: 'W-1', sys: 'jira:acme', xid: 'ABC-1' }], 'repos.jsonl': [{ id: 'repo:web', owners: ['Ana'], paths: [{ glob: 'w/**', sub: 'w' }] }], 'people.jsonl': [{ id: 'Ana' }] });
  assert.ok((more.h.all("SELECT 1 FROM g_links WHERE rel LIKE 'x-github/%'") as unknown[]).length >= 2, 'the noise is in the view');
  for (const t of TICKETS) assert.deepEqual(blockersOf(graphReader(more.h, ITEMS), t.key, { closed, ignore: ign }), blockersOf(graphReader(base.h, ITEMS), t.key, { closed, ignore: ign }), t.key);
  assert.equal(blockersOf(graphReader(more.h, ITEMS), 'W-1', { closed, ignore: ign }).reasons.length, 1);
  base.h.close(); more.h.close();
});
