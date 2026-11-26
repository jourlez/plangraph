// The graph as views over the index (lib/graph/views.ts, src/db.ts): the seven graph tables, g_nodes and g_links, reach and graphReader, the
// fingerprint rule, the older (0.3.0) schema, and the exact-DDL rule for views. Each case builds a real index from files.
// NOT covered: the commands that read the views (later tasks), the timing ratio (test/graph-views-timing.test.ts), the Python mirror
// (test/plangraph-solve-input.test.ts).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { buildIndex, openIndex, sourceFingerprint, contentDigest, INDEX_FILE, FINGERPRINT_KEY, TABLES } from '../src/db.ts';
import { PlangraphError } from '../src/errors.ts';
import { G_LINKS_SQL, G_NODES_SQL, GRAPH_MAX_DEPTH, graphReader, reach } from '../lib/graph/views.ts';
import type { NodeRef, Rel } from '../lib/graph/views.ts';
import { DERIVED_RELATIONS } from '../lib/graph/files.ts';
import { genPlan, rng } from './fixtures/gen.ts';

const ROOT = path.join(import.meta.dirname, '..');
const FROZEN = path.join(import.meta.dirname, 'fixtures/release-0.3.0');
const tmps: string[] = [];
after(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (p: string) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p))); tmps.push(d); return d; };
const jl = (rows: readonly object[]) => rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
type Files = Record<string, readonly object[]>;
/** A plan directory holding the given files, with its index built; the handle is opened with the source check. */
function plan(files: Files) {
  const dir = tmp('graph-views-');
  for (const [f, rows] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), jl(rows));
  buildIndex({ dir });
  return { dir, file: path.join(dir, INDEX_FILE), open: () => openIndex(path.join(dir, INDEX_FILE), { dir }) };
}
const tk = (key: string, more: Record<string, unknown> = {}) => ({ key, summary: key, epic: '', sp: 1, jira_status: 'To Do', verdict: 'READY', ...more });
const T = (id: string): NodeRef => ({ id, type: 'ticket' });
const ids = (rs: ReadonlyArray<{ id: string; type: string }>): string[] => rs.map((r) => `${r.type}:${r.id}`);
const links = (h: ReturnType<typeof openIndex>, rel: string) => (h.all('SELECT src, src_type, dst, dst_type, version, kind FROM g_links WHERE rel = ? ORDER BY src, dst, version', rel) as Array<Record<string, unknown>>).map((r) => ({ ...r }));
const nodes = (h: ReturnType<typeof openIndex>, type: string) => (h.all('SELECT id FROM g_nodes WHERE type = ? ORDER BY id', type) as Array<{ id: string }>).map((r) => r.id);

const FULL: Files = {
  'tickets.jsonl': [tk('sp:p', { epic: '' }), tk('sp:p/1', { epic: 'sp:p' }), tk('sp:p/2', { epic: 'sp:p' }), tk('T-1', { epic: 'E1' }), tk('T-2', { epic: 'E1' })],
  'edges.jsonl': [{ consumer: 'T-2', producer: 'T-1', kind: 'plan_need' }, { consumer: 'T-1', producer: 'sp:p/1', kind: 'link' }],
  'schedule.jsonl': [{ version: 'current', key: 'T-1', owner: 'Ana', sprint: 2 }, { version: 'v2', key: 'T-1', owner: 'Ben', sprint: 3 }, { version: 'current', key: 'T-2', owner: 'Ana', sprint: 3 }],
  'refs.jsonl': [{ key: 'sp:p', plans: [], files: { 'docs/spec.md': '' } }, { key: 'sp:p/1', plans: [{ plan: 'docs/p.md', task: '1' }, 'junk', 5, { plan: 3 }, { plan: 'docs/q.md' }], files: { 'a.ts': '' } }, { key: 'sp:p/2', plans: [{ plan: 'docs/p.md', task: '2' }] }],
  'people.jsonl': [{ id: 'Ana', active: true }, { id: 'Cleo', active: false }],
  'sprints.jsonl': [{ n: 4, name: 'S4' }],
  'epics.jsonl': [{ id: 'E9', name: 'nine' }],
  'repos.jsonl': [{ id: 'repo:web', owners: ['Ana', 'team-x'], cmds: { test: 'npm test' }, paths: [{ glob: 'web/**', sub: 'web' }, { glob: 'x', sub: '' }] }],
  'capacity.jsonl': [{ person: 'Ana', sprint: 2, sp: 2.5 }, { person: 'Ana', sprint: 3, sp: 8 }],
  'links.jsonl': [{ from: 'T-1', from_type: 'ticket', rel: 'relates_to', to: 'repo:web', to_type: 'repo', attrs: { z: 1, a: 2 } }, { from: 'pr-7', from_type: 'x-github.pr', rel: 'x-github/closes', to: 'T-2', to_type: 'ticket' }],
  'xrefs.jsonl': [{ type: 'ticket', id: 'T-1', sys: 'jira:acme', xid: 'ABC-1' }, { type: 'x-github.pr', id: 'pr-7', sys: 'github:o/r', xid: 'pull/7' }],
};

test('g_nodes lists every node once per (id, type), derived ones included', () => {
  using h = plan(FULL).open();
  assert.equal(h.stale, false);
  assert.deepEqual(nodes(h, 'ticket'), ['T-1', 'T-2', 'sp:p', 'sp:p/1', 'sp:p/2']);
  assert.deepEqual(nodes(h, 'person'), ['Ana', 'Ben', 'Cleo']); // person rows and schedule owners
  assert.deepEqual(nodes(h, 'sprint'), ['S2', 'S3', 'S4']); // the sprint row and the integer schedule sprints
  assert.deepEqual(nodes(h, 'epic'), ['E1', 'E9', 'sp:p']);
  assert.deepEqual(nodes(h, 'repo'), ['repo:web', 'repo:web#web']); // a sub-unit is a repo node `<repo>#<sub>`; an empty sub gives none
  assert.deepEqual(nodes(h, 'plan'), ['docs/p.md', 'docs/q.md']); // an entry with a string plan; the others (junk, 5, {plan: 3}) give nothing
  assert.deepEqual(nodes(h, 'plantask'), ['docs/p.md#1', 'docs/p.md#2']); // a string plan and a string task
  assert.deepEqual(nodes(h, 'doc'), ['docs/spec.md']); // the epic row's files, not a task row's
  const dup = h.all('SELECT id, type, COUNT(*) n FROM g_nodes GROUP BY id, type HAVING n > 1');
  assert.deepEqual(dup, []);
});

test('g_links derives the ten relations from the v1 tables and the graph tables, and passes stored links through', () => {
  using h = plan(FULL).open();
  assert.deepEqual(links(h, 'needs'), [
    { src: 'T-1', src_type: 'ticket', dst: 'sp:p/1', dst_type: 'ticket', version: null, kind: 'link' },
    { src: 'T-2', src_type: 'ticket', dst: 'T-1', dst_type: 'ticket', version: null, kind: 'plan_need' }]);
  assert.deepEqual(links(h, 'assigned_to').map((r) => [r.src, r.dst, r.version]), [['T-1', 'Ana', 'current'], ['T-1', 'Ben', 'v2'], ['T-2', 'Ana', 'current']]);
  assert.deepEqual(links(h, 'scheduled_in').map((r) => [r.src, r.dst, r.version]), [['T-1', 'S2', 'current'], ['T-1', 'S3', 'v2'], ['T-2', 'S3', 'current']]);
  assert.deepEqual(links(h, 'belongs_to').map((r) => [r.src, r.dst, r.dst_type]), [['T-1', 'E1', 'epic'], ['T-2', 'E1', 'epic'], ['sp:p/1', 'sp:p', 'epic'], ['sp:p/2', 'sp:p', 'epic']]);
  assert.deepEqual(links(h, 'implements').map((r) => [r.src, r.src_type, r.dst]), [['docs/p.md#1', 'plantask', 'sp:p/1'], ['docs/p.md#2', 'plantask', 'sp:p/2']]);
  assert.deepEqual(links(h, 'part_of').map((r) => [r.src, r.src_type, r.dst, r.dst_type]), [
    ['docs/p.md#1', 'plantask', 'docs/p.md', 'plan'], ['docs/p.md#2', 'plantask', 'docs/p.md', 'plan'], ['repo:web#web', 'repo', 'repo:web', 'repo']]);
  assert.deepEqual(links(h, 'specified_by').map((r) => [r.src, r.src_type, r.dst, r.dst_type]), [['docs/p.md', 'plan', 'docs/spec.md', 'doc'], ['docs/q.md', 'plan', 'docs/spec.md', 'doc']]); // every plan of the epic's tasks, the doc of the epic row
  assert.deepEqual(links(h, 'tracked_by').map((r) => [r.src, r.src_type, r.dst, r.dst_type]), [['T-1', 'ticket', 'jira:acme:ABC-1', 'x-jira.ref'], ['pr-7', 'x-github.pr', 'github:o/r:pull/7', 'x-github.ref']]);
  assert.deepEqual(links(h, 'owned_by').map((r) => [r.src, r.dst, r.dst_type]), [['repo:web', 'Ana', 'person'], ['repo:web', 'team-x', 'person']]);
  assert.deepEqual(links(h, 'relates_to').map((r) => [r.src, r.dst, r.dst_type]), [['T-1', 'repo:web', 'repo']]);
  assert.deepEqual(links(h, 'x-github/closes').map((r) => [r.src, r.src_type, r.dst]), [['pr-7', 'x-github.pr', 'T-2']]); // an extension type and relation pass through
  assert.deepEqual(h.all('SELECT DISTINCT rel FROM g_links ORDER BY rel').map((r) => (r as { rel: string }).rel),
    ['assigned_to', 'belongs_to', 'implements', 'needs', 'owned_by', 'part_of', 'relates_to', 'scheduled_in', 'specified_by', 'tracked_by', 'x-github/closes']); // held_by is added in TypeScript
});

test('an epic id equal to a ticket key gives two g_nodes rows, one per type, and belongs_to resolves to the epic', () => {
  using h = plan(FULL).open();
  assert.deepEqual(h.all("SELECT type FROM g_nodes WHERE id = 'sp:p' ORDER BY type").map((r) => (r as { type: string }).type), ['epic', 'ticket']);
  const r = reach(h, T('sp:p/1'), ['belongs_to'], 1, false);
  assert.deepEqual(r.map((x) => [x.id, x.type]), [['sp:p', 'epic']]);
  assert.deepEqual(reach(h, T('sp:p'), ['belongs_to'], 1, false), []); // the epic's own ticket row is a different node
  assert.deepEqual(graphReader(h, []).node('sp:p').map((n) => n.type), ['epic', 'ticket']);
  assert.deepEqual(graphReader(h, []).node('sp:p', 'epic'), [{ id: 'sp:p', type: 'epic' }]);
});

test('property: g_links agrees with the v1 tables on every needs, owner and sprint (300 random plans)', () => {
  const r = rng(11);
  for (let i = 0; i < 300; i++) {
    const p = genPlan({ n: 3 + Math.floor(r() * 12), people: 1 + Math.floor(r() * 3), density: 0.3, seed: i + 1 });
    const sched = [...p.schedule, ...p.schedule.filter(() => r() < 0.3).map((s) => ({ ...s, version: 'v2', sprint: s.sprint + 1 }))];
    using h = plan({ 'tickets.jsonl': p.tickets, 'edges.jsonl': p.edges, 'schedule.jsonl': sched }).open();
    const want = (rows: string[]) => rows.toSorted();
    assert.deepEqual(want(h.all("SELECT src || '>' || dst x FROM g_links WHERE rel = 'needs'").map((x) => (x as { x: string }).x)), want(p.edges.map((e) => `${e.consumer}>${e.producer}`)));
    assert.deepEqual(want(h.all("SELECT version || ':' || src || '>' || dst x FROM g_links WHERE rel = 'assigned_to'").map((x) => (x as { x: string }).x)), want(sched.map((s) => `${s.version}:${s.key}>${s.owner}`)));
    assert.deepEqual(want(h.all("SELECT version || ':' || src || '>' || dst x FROM g_links WHERE rel = 'scheduled_in'").map((x) => (x as { x: string }).x)), want(sched.map((s) => `${s.version}:${s.key}>S${s.sprint}`)));
    // every ticket's depth-1 needs and assigned_to through reach is what the tables say (current version)
    const rd = reach(h, T(p.tickets[0]?.key as string), ['needs', 'assigned_to'], 1, false);
    const wantN = p.edges.filter((e) => e.consumer === p.tickets[0]?.key).map((e) => `ticket:${e.producer}`);
    assert.deepEqual(ids(rd).filter((x) => x.startsWith('ticket:')).toSorted(), wantN.toSorted());
  }
});

test('derived and stored rows never share a relation: a derived relation in links.jsonl is refused at build, the view also leaves it out', () => {
  for (const rel of DERIVED_RELATIONS) {
    const dir = tmp('graph-derived-');
    fs.writeFileSync(path.join(dir, 'links.jsonl'), jl([{ from: 'T-1', from_type: 'ticket', rel, to: 'T-2', to_type: 'ticket' }]));
    assert.throws(() => buildIndex({ dir }), (e) => e instanceof Error && e.message.startsWith(`LINK_DERIVED_REL links.jsonl:1: `), rel);
  }
  assert.ok(DERIVED_RELATIONS.every((rel) => G_LINKS_SQL.includes(`'${rel}'`)), 'the view names every derived relation (the stored branch excludes them)');
  using h = plan(FULL).open();
  const stored = h.all('SELECT DISTINCT rel FROM link').map((x) => (x as { rel: string }).rel);
  assert.ok(stored.every((rel) => !(DERIVED_RELATIONS as readonly string[]).includes(rel)));
});

test('property: g_links agrees with tickets.epic and refs.plans on every belongs_to and implements, and the reader agrees with open-items on every held_by', () => {
  const r = rng(5);
  for (let i = 0; i < 100; i++) {
    const n = 2 + Math.floor(r() * 8), epics = ['', 'E1', 'E2', 'sp:x'];
    const tickets = Array.from({ length: n }, (_, k) => tk(`K-${k}`, { epic: epics[Math.floor(r() * epics.length)] }));
    const refs = tickets.filter(() => r() < 0.7).map((t) => ({ key: t.key, plans: Array.from({ length: Math.floor(r() * 3) }, (_, k) => ({ plan: `p${Math.floor(r() * 3)}.md`, task: String(k) })), files: {} }));
    const items = tickets.filter(() => r() < 0.5).flatMap((t) => ['decision', 'fix'].filter(() => r() < 0.6).map((kind) => ({ key: t.key, kind, status: r() < 0.5 ? 'open' : 'done', owner: 'Ana', text: 't' })));
    using h = plan({ 'tickets.jsonl': tickets, 'refs.jsonl': refs }).open();
    const rd = graphReader(h, items);
    assert.deepEqual(links(h, 'belongs_to').map((x) => `${x.src}>${x.dst}`), tickets.filter((t) => t.epic).map((t) => `${t.key}>${t.epic}`).toSorted());
    const impl = new Set(refs.flatMap((x) => x.plans.map((p) => `${p.plan}#${p.task}>${x.key}`)));
    assert.deepEqual(links(h, 'implements').map((x) => `${x.src}>${x.dst}`), [...impl].toSorted());
    for (const t of tickets) {
      const want = items.filter((x) => x.key === t.key && x.status !== 'done').map((x) => `openitem:${x.key}|${x.kind}`).toSorted();
      assert.deepEqual(ids(rd.reach(T(t.key), ['held_by'], 1, false)).toSorted(), want);
    }
  }
});

test('held_by holds open items only, forward and reverse; every register item is a node', () => {
  const items = [{ key: 'T-1', kind: 'decision', status: 'open', owner: 'Ana', text: 'x' }, { key: 'T-1', kind: 'fix', status: 'done', owner: 'Ana', text: 'y' }];
  using h = plan(FULL).open();
  const rd = graphReader(h, items);
  assert.deepEqual(rd.reach(T('T-1'), ['held_by'], 1, false), [{ id: 'T-1|decision', type: 'openitem', path: [{ rel: 'held_by', id: 'T-1|decision', type: 'openitem' }] }]);
  assert.deepEqual(rd.reach({ id: 'T-1|decision', type: 'openitem' }, ['held_by'], 1, true).map((x) => x.id), ['T-1']);
  assert.deepEqual(rd.reach({ id: 'T-1|fix', type: 'openitem' }, ['held_by'], 1, true), []);
  assert.deepEqual(rd.node('T-1|fix'), [{ id: 'T-1|fix', type: 'openitem' }]);
  assert.deepEqual(rd.node('T-1|fix', 'ticket'), []);
  assert.deepEqual(reach(h, T('T-1'), ['held_by'], 1, false), []); // the module reach reads the index only
});

test('the reader gives the blocker facts of a ticket: verdict, findings in file order, open items, producers', () => {
  const tickets = [tk('A', { verdict: 'BLOCKED', impl_status: 'todo' }), tk('B', { verdict: '', jira_status: 'Done' })];
  using h = plan({ 'tickets.jsonl': tickets, 'edges.jsonl': [{ consumer: 'A', producer: 'B', kind: 'x' }, { consumer: 'A', producer: 'C' }], 'findings.jsonl': [{ key: 'A', kind: 'risk', text: 't1' }, { key: 'A', kind: 'gap', text: 't2' }, { key: 'B', kind: 'x', text: 'o' }] }).open();
  const rd = graphReader(h, [{ key: 'A', kind: 'decision', status: 'open', owner: 'Ana', text: 'tx' }, { key: 'A', kind: 'fix', status: 'done', owner: 'Ana', text: 'ty' }]);
  assert.deepEqual(rd.ticket('A'), { verdict: 'BLOCKED', jira_status: 'To Do', impl_status: 'todo' });
  assert.deepEqual(rd.ticket('B'), { verdict: '', jira_status: 'Done', impl_status: null });
  assert.equal(rd.ticket('nope'), null);
  assert.deepEqual(rd.findings('A'), [{ kind: 'risk', text: 't1' }, { kind: 'gap', text: 't2' }]);
  assert.deepEqual(rd.openItems('A'), [{ key: 'A', kind: 'decision', status: 'open', owner: 'Ana', text: 'tx' }]);
  assert.deepEqual(rd.producers('A'), [{ key: 'B', kind: 'x' }, { key: 'C', kind: null }]);
});

test('reach is bounded by depth, stops at cycles, keeps the shortest path, and orders its answer', () => {
  const edges = [['A', 'B'], ['B', 'C'], ['C', 'A'], ['A', 'C'], ['C', 'D']].map(([consumer, producer]) => ({ consumer, producer }));
  using h = plan({ 'tickets.jsonl': ['A', 'B', 'C', 'D'].map((k) => tk(k)), 'edges.jsonl': edges }).open();
  assert.deepEqual(ids(reach(h, T('A'), ['needs'], 1, false)), ['ticket:B', 'ticket:C']);
  const two = reach(h, T('A'), ['needs'], 2, false);
  assert.deepEqual(ids(two), ['ticket:B', 'ticket:C', 'ticket:D']);
  assert.deepEqual(two.find((x) => x.id === 'C')?.path.map((p) => p.id), ['C']); // A -> C directly, not through B
  assert.deepEqual(two.find((x) => x.id === 'D')?.path.map((p) => p.id), ['C', 'D']);
  assert.deepEqual(ids(reach(h, T('A'), ['needs'], GRAPH_MAX_DEPTH, false)), ['ticket:B', 'ticket:C', 'ticket:D']); // the cycle back to A adds nothing
  assert.deepEqual(ids(reach(h, T('D'), ['needs'], 5, true)), ['ticket:C', 'ticket:A', 'ticket:B']); // reverse: who needs D, breadth first
  assert.deepEqual(reach(h, T('A'), [], 3, false), []);
  assert.deepEqual(reach(h, T('nobody'), ['needs'], 3, false), []);
});

test('depth 0, 21 and a fraction are refused; 1 and 20 are accepted', () => {
  using h = plan({ 'tickets.jsonl': [tk('A')] }).open();
  assert.equal(GRAPH_MAX_DEPTH, 20);
  for (const d of [0, 21, 1.5, -1, NaN]) assert.throws(() => reach(h, T('A'), ['needs'], d, false), RangeError, String(d));
  for (const d of [1, 20]) assert.deepEqual(reach(h, T('A'), ['needs'], d, false), []);
});

test('a relation outside the grammar is refused before any statement is built (names are written as literals)', () => {
  using h = plan({ 'tickets.jsonl': [tk('A')] }).open();
  for (const rel of ["needs'", "x-a/b'; DROP TABLE ticket; --", 'NEEDS', 'x-a', '']) assert.throws(() => reach(h, T('A'), [rel as Rel], 1, false), RangeError, rel);
  assert.deepEqual(reach(h, { id: 'A', type: "ticket' OR '1'='1" as NodeRef['type'] }, ['needs'], 1, false), []); // a type outside the grammar reaches nothing
  assert.equal((h.get('SELECT COUNT(*) n FROM ticket') as { n: number }).n, 1);
});

test('a diamond chain of 40 tickets (2^20 paths) lists each node once and reads each (id, type) at most once', () => {
  const tickets: object[] = [], edges: object[] = [];
  const name = (l: number, s: string) => `D${l}${s}`;
  tickets.push(tk('D0'));
  for (let l = 1; l <= 20; l++) {
    for (const s of ['a', 'b']) { tickets.push(tk(name(l, s))); for (const prev of l === 1 ? ['D0'] : [name(l - 1, 'a'), name(l - 1, 'b')]) edges.push({ consumer: name(l, s), producer: prev }); }
  }
  using h = plan({ 'tickets.jsonl': tickets, 'edges.jsonl': edges }).open();
  let rows = 0;
  const counted = { all: (sql: string, ...a: unknown[]) => { const r = h.all(sql, ...a); rows += r.length; return r; } };
  const out = reach(counted, T('D20a'), ['needs'], GRAPH_MAX_DEPTH, false);
  assert.equal(out.length, 39); // D0 and the 19 lower levels of two (the other D20 ticket is a sibling, not reachable), once each
  assert.equal(new Set(ids(out)).size, 39);
  assert.ok(rows <= 2 * 41, `edge rows read: ${rows}`); // each node's two edges at most once (a path walk would read 2^20)
});

test('reach follows assigned_to and scheduled_in of one schedule version only', () => {
  using h = plan({ 'tickets.jsonl': [tk('T-1')], 'schedule.jsonl': [{ version: 'current', key: 'T-1', owner: 'Ana', sprint: 2 }, { version: 'v2', key: 'T-1', owner: 'Ben', sprint: 5 }] }).open();
  const rels: Rel[] = ['assigned_to', 'scheduled_in'];
  assert.deepEqual(ids(reach(h, T('T-1'), rels, 1, false)), ['person:Ana', 'sprint:S2']);
  assert.deepEqual(ids(reach(h, T('T-1'), rels, 1, false, 'v2')), ['person:Ben', 'sprint:S5']);
  assert.deepEqual(reach(h, T('T-1'), rels, 1, false, 'nope'), []);
  assert.deepEqual(ids(reach(h, { id: 'Ana', type: 'person' }, ['assigned_to'], 1, true)), ['ticket:T-1']);
});

test('a links.jsonl row is stored with its from and to columns (keyword names), attrs as canonical JSON, and two equal lines give one reach result', () => {
  const row = { from: 'T-1', from_type: 'ticket', rel: 'relates_to', to: 'E-1', to_type: 'epic', attrs: { z: 1, a: { y: 2, x: 3 } } };
  const dir = tmp('graph-links-'); fs.writeFileSync(path.join(dir, 'links.jsonl'), jl([row, row]));
  buildIndex({ dir });
  using h = openIndex(path.join(dir, INDEX_FILE), { dir });
  assert.deepEqual(h.all('SELECT "from", "to", attrs, extra FROM link').map((r) => ({ ...(r as object) })), [{ from: 'T-1', to: 'E-1', attrs: '{"a":{"x":3,"y":2},"z":1}', extra: null }, { from: 'T-1', to: 'E-1', attrs: '{"a":{"x":3,"y":2},"z":1}', extra: null }]);
  assert.equal(reach(h, T('T-1'), ['relates_to'], 1, false).length, 1);
});

test('a people row with active true and false builds, and build then open verifies the digest; unknown fields and schema_version are kept in extra', () => {
  using h = plan({ 'people.jsonl': [{ id: 'A', active: true }, { id: 'B', active: false, schema_version: 2, zz: { b: 1, a: 2 } }, { id: 'C', name: 'Cleo' }] }).open();
  assert.deepEqual(h.all('SELECT id, name, active, extra FROM person ORDER BY id').map((r) => ({ ...(r as object) })), [
    { id: 'A', name: null, active: 'true', extra: null }, { id: 'B', name: null, active: 'false', extra: '{"schema_version":2,"zz":{"a":2,"b":1}}' }, { id: 'C', name: 'Cleo', active: null, extra: null }]);
  assert.equal(h.stale, false);
});

test('a capacity row with sp 2.5 and sp 8 builds with numeric affinity, and a sprint row keeps n as an integer', () => {
  using h = plan({ 'capacity.jsonl': [{ person: 'Ana', sprint: 2, sp: 2.5, review_h: 1 }, { person: 'Ana', sprint: 3, sp: 8 }], 'sprints.jsonl': [{ n: -1 }, { n: 4, start: '2026-01-05', end: '2026-01-16' }] }).open();
  assert.deepEqual(h.all('SELECT typeof(sprint) ts, typeof(sp) tp, sp, extra FROM capacity ORDER BY sprint').map((r) => ({ ...(r as object) })), [{ ts: 'integer', tp: 'real', sp: 2.5, extra: null }, { ts: 'integer', tp: 'integer', sp: 8, extra: null }]);
  assert.deepEqual(h.all('SELECT typeof(n) t FROM sprint ORDER BY n').map((r) => (r as { t: string }).t), ['integer', 'integer']);
  assert.deepEqual(nodes(h, 'sprint'), ['S-1', 'S4']);
});

test('the repo table stores sets and objects as canonical JSON text', () => {
  using h = plan({ 'repos.jsonl': [{ id: 'r', langs: ['ts'], cmds: { test: 't', build: 'b' }, paths: [{ sub: 's', glob: 'g' }], entry: ['bin/x'], owners: ['a'], frameworks: [], role: 'lib' }] }).open();
  assert.deepEqual(h.all('SELECT langs, cmds, paths, entry, owners, frameworks, role FROM repo').map((r) => ({ ...(r as object) })), [{ langs: '["ts"]', cmds: '{"build":"b","test":"t"}', paths: '[{"glob":"g","sub":"s"}]', entry: '["bin/x"]', owners: '["a"]', frameworks: '[]', role: 'lib' }]);
});

test('an x-github.pr node and an x-github/closes link build, and the v1 answers are byte-identical with and without the graph files', () => {
  const cli = (cwd: string, ...a: string[]) => spawnSync(process.execPath, [path.join(ROOT, 'bin/plangraph'), ...a], { cwd, encoding: 'utf8', env: { ...process.env, PLANGRAPH_DIR: '', CLAUDE_PLUGIN_DATA: path.join(cwd, '.data') } });
  const p = genPlan({ n: 8, people: 2, seed: 4, cap: 50 });
  const make = (graph: boolean) => {
    const d = tmp('graph-v1same-'); execFileSync('git', ['init', '-q'], { cwd: d });
    assert.equal(cli(d, 'init').status, 0);
    const b = path.join(d, '.plangraph');
    fs.writeFileSync(path.join(b, 'tickets.jsonl'), jl(p.tickets)); fs.writeFileSync(path.join(b, 'edges.jsonl'), jl(p.edges)); fs.writeFileSync(path.join(b, 'schedule.jsonl'), jl(p.schedule));
    if (graph) for (const [f, rows] of Object.entries(FULL)) if (!['tickets.jsonl', 'edges.jsonl', 'schedule.jsonl', 'refs.jsonl'].includes(f)) fs.writeFileSync(path.join(b, f), jl(rows));
    const bl = cli(d, 'build'); assert.equal(bl.status, 0, bl.stderr);
    return d;
  };
  const [plain, graph] = [make(false), make(true)];
  for (const a of [['ticket', 'T-3'], ['ready', '--person', 'Ana'], ['check'], ['person', 'Ana'], ['sprint', '1'], ['chain', 'T-5']]) {
    const x = cli(plain, ...a), y = cli(graph, ...a);
    assert.deepEqual([y.status, y.stdout, y.stderr], [x.status, x.stdout, x.stderr], a.join(' '));
  }
  using h = openIndex(path.join(graph, '.plangraph', INDEX_FILE), { dir: path.join(graph, '.plangraph') });
  assert.deepEqual(nodes(h, 'x-github.pr'), []); // nodes of an extension type come from links and xrefs, not from a node file
  assert.deepEqual(links(h, 'x-github/closes').map((r) => r.src), ['pr-7']);
});

test('a links row without from_type or to_type, or with a type outside the grammar, is a data error naming the field', () => {
  for (const [row, field] of [[{ from: 'a', rel: 'relates_to', to: 'b', to_type: 'ticket' }, 'from_type'], [{ from: 'a', from_type: 'ticket', rel: 'relates_to', to: 'b' }, 'to_type'], [{ from: 'a', from_type: 'Ticket', rel: 'relates_to', to: 'b', to_type: 'ticket' }, 'from_type'], [{ from: 'a', from_type: 'ticket', rel: 'relates_to', to: 'b', to_type: 'x-a' }, 'to_type']] as const) {
    const dir = tmp('graph-badlink-'); fs.writeFileSync(path.join(dir, 'links.jsonl'), jl([row]));
    assert.throws(() => buildIndex({ dir }), (e) => e instanceof Error && e.message.includes('links.jsonl:1:') && e.message.includes(`"${field}"`), field);
  }
});

test('a relates_to row from the epic sp:<slug> (from_type epic) reaches nothing from the ticket sp:<slug>', () => {
  using h = plan({ 'tickets.jsonl': [tk('sp:s')], 'links.jsonl': [{ from: 'sp:s', from_type: 'epic', rel: 'relates_to', to: 'X', to_type: 'ticket' }] }).open();
  assert.deepEqual(reach(h, T('sp:s'), ['relates_to'], 1, false), []);
  assert.deepEqual(ids(reach(h, { id: 'sp:s', type: 'epic' }, ['relates_to'], 1, false)), ['ticket:X']);
});

test('a graph file adds its bytes to the fingerprint only when it is present; a v1-only directory equals the frozen 0.3.0 fingerprint', () => {
  const p = genPlan({ n: 6, people: 2, seed: 3 });
  const d = tmp('graph-fp-'); execFileSync('git', ['init', '-q'], { cwd: d });
  const env = { ...process.env, PLANGRAPH_DIR: '', CLAUDE_PLUGIN_DATA: path.join(d, '.data') };
  assert.equal(spawnSync(process.execPath, [path.join(FROZEN, 'bin/plangraph'), 'init'], { cwd: d, env }).status, 0);
  const b = path.join(d, '.plangraph');
  fs.writeFileSync(path.join(b, 'tickets.jsonl'), jl(p.tickets)); fs.writeFileSync(path.join(b, 'edges.jsonl'), jl(p.edges)); fs.writeFileSync(path.join(b, 'schedule.jsonl'), jl(p.schedule));
  const old = spawnSync(process.execPath, [path.join(FROZEN, 'bin/plangraph'), 'build'], { cwd: d, env, encoding: 'utf8' });
  assert.equal(old.status, 0, old.stderr);
  const stored = (new DatabaseSync(path.join(b, INDEX_FILE), { readOnly: true }).prepare('SELECT v FROM index_meta WHERE k = ?').get(FINGERPRINT_KEY) as { v: string }).v;
  assert.equal(sourceFingerprint(b), stored, 'the fingerprint of a v1-only directory is the one 0.3.0 stored');
  fs.writeFileSync(path.join(b, 'people.jsonl'), jl([{ id: 'Ana' }]));
  const one = sourceFingerprint(b);
  assert.notEqual(one, stored);
  fs.writeFileSync(path.join(b, 'people.jsonl'), jl([{ id: 'Ana', name: 'A' }]));
  assert.notEqual(sourceFingerprint(b), one);
  fs.rmSync(path.join(b, 'people.jsonl'));
  assert.equal(sourceFingerprint(b), stored);
});

// ---------- the older (0.3.0) schema ----------
/** A directory built by the frozen 0.3.0 tree: its index is the eight v1 tables with no view. */
function frozenRepo() {
  const d = tmp('graph-old-'); execFileSync('git', ['init', '-q'], { cwd: d });
  const env = { ...process.env, PLANGRAPH_DIR: '', CLAUDE_PLUGIN_DATA: path.join(d, '.data') };
  const old = (...a: string[]) => spawnSync(process.execPath, [path.join(FROZEN, 'bin/plangraph'), ...a], { cwd: d, env, encoding: 'utf8' });
  const now = (...a: string[]) => spawnSync(process.execPath, [path.join(ROOT, 'bin/plangraph'), ...a], { cwd: d, env, encoding: 'utf8' });
  assert.equal(old('init').status, 0);
  const p = genPlan({ n: 6, people: 2, seed: 3 }), b = path.join(d, '.plangraph');
  fs.writeFileSync(path.join(b, 'tickets.jsonl'), jl(p.tickets)); fs.writeFileSync(path.join(b, 'edges.jsonl'), jl(p.edges)); fs.writeFileSync(path.join(b, 'schedule.jsonl'), jl(p.schedule));
  assert.equal(old('build').status, 0);
  return { d, b, old, now, file: path.join(b, INDEX_FILE) };
}

test('an index built by the frozen 0.3.0 tree passes its digest check and opens as an older schema: stale, query-only, graph readers refuse it with STALE', () => {
  const { b, file } = frozenRepo();
  using h = openIndex(file, { dir: b });
  assert.equal(h.older, true);
  assert.equal(h.stale, true);
  assert.equal(h.fingerprint, h.builtFingerprint, 'the text is unchanged: the index is stale for its schema, not for its text');
  assert.equal((h.get('SELECT COUNT(*) n FROM ticket') as { n: number }).n, 6); // v1 questions answer
  assert.throws(() => h.exec("INSERT INTO meta(k, v) VALUES('a', 'b')"), /readonly|read-only/i); // query_only
  assert.equal(contentDigest(h, [...TABLES.values()].slice(0, 8)), (h.get('SELECT v FROM index_meta WHERE k = ?', 'content_digest') as { v: string }).v);
  const stale = (e: unknown) => e instanceof PlangraphError && e.code === 'STALE' && e.exitCode === 2 && e.hint === 'run `plangraph build`';
  assert.throws(() => reach(h, T('T-1'), ['needs'], 1, false), stale);
  assert.throws(() => graphReader(h, []), stale);
  assert.throws(() => openIndex(file, { readOnly: false }), stale);
  { using g = openIndex(file); assert.equal(g.older, true); assert.equal(g.stale, true, 'without dir too'); }
});

test('whatif --write, schedule-load and export on a 0.3.0-built index exit 2 with STALE and leave plangraph.sqlite byte-identical; v1 commands still answer', () => {
  const { d, b, now, file } = frozenRepo();
  const before = fs.readFileSync(file);
  const tk1 = now('ticket', 'T-1');
  assert.equal(tk1.status, 0, tk1.stderr);
  assert.match(tk1.stderr, /^STALE: /m, 'the existing STALE line, although the fingerprints match');
  fs.writeFileSync(path.join(d, 'sched.json'), JSON.stringify([{ item: 'T-1', owner: 'Ana', sprint: 3 }]));
  const sl = now('schedule-load', path.join(d, 'sched.json'), 'old');
  assert.equal(sl.status, 2, sl.stdout + sl.stderr);
  assert.match(sl.stderr, /older plangraph/);
  assert.match(sl.stderr, /try: plangraph build\n$/);
  const ex = now('export');
  assert.equal(ex.status, 2, ex.stdout + ex.stderr);
  assert.match(ex.stderr, /try: plangraph build\n$/);
  let move: string[] | undefined;
  for (const k of ['T-1', 'T-2', 'T-3', 'T-4', 'T-5', 'T-6']) for (const sp of ['1', '2', '3', '4', '5', '6', '7']) if (!move && now('whatif', k, '--sprint', sp, '--apply-plan').status === 0) move = [k, '--sprint', sp];
  assert.ok(move, 'one feasible move exists in the fixture');
  const wi = now('whatif', ...(move as string[]), '--apply-plan', '--write');
  assert.equal(wi.status, 2, wi.stdout + wi.stderr);
  assert.match(wi.stderr, /older plangraph/);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(now('build').status, 0); // one build repairs it
  assert.equal(now('ticket', 'T-1').stderr.includes('STALE'), false);
  assert.equal(openIndex(file, { dir: b }).older, false);
  assert.ok(d);
});

test('an index with the v1 tables and no index_meta (the old bin/plangraph) opens stale and query-only, and an index writer refuses it', () => {
  const dir = tmp('graph-nometa-');
  const file = path.join(dir, INDEX_FILE);
  const db = new DatabaseSync(file);
  for (const t of [...TABLES.values()].slice(0, 8)) db.exec(`CREATE TABLE ${t.name}(${[...t.columns, 'extra'].map((c) => `"${c}" TEXT`).join(',')})`);
  db.exec('CREATE INDEX edge_p ON edge(producer); CREATE INDEX ev_k ON evidence(key);'); db.close();
  using h = openIndex(file, { dir });
  assert.deepEqual([h.older, h.stale], [true, true]);
  assert.throws(() => openIndex(file, { readOnly: false }), (e) => e instanceof PlangraphError);
  assert.throws(() => reach(h, T('A'), ['needs'], 1, false), (e) => e instanceof PlangraphError && e.code === 'STALE');
});

// ---------- the exact views ----------
const edit = (file: string, sql: string) => { const db = new DatabaseSync(file); try { db.exec(sql); } finally { db.close(); } };
const refused = (file: string, dir: string) => assert.throws(() => openIndex(file, { dir }), (e) => e instanceof PlangraphError && e.code === 'DATA' && e.message === 'the index has an unexpected schema (not built by plangraph build)');

test('the views are stored exactly as the constants say, and a changed g_links body, a changed g_nodes body, an extra view, a trigger, a dropped view and a graph table without views are each refused', () => {
  {
    const { file, dir } = plan(FULL);
    const db = new DatabaseSync(file, { readOnly: true });
    const sql = Object.fromEntries((db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'view'").all() as Array<{ name: string; sql: string }>).map((r) => [r.name, r.sql]));
    db.close();
    assert.deepEqual(sql, { g_nodes: G_NODES_SQL, g_links: G_LINKS_SQL });
    assert.ok(G_NODES_SQL.startsWith('CREATE VIEW g_nodes') && !/;\s*$/.test(G_NODES_SQL) && G_NODES_SQL === G_NODES_SQL.trim());
    openIndex(file, { dir }).close();
  }
  const cases: Array<[string, string]> = [
    ['changed g_links body', "DROP VIEW g_links; CREATE VIEW g_links(src, src_type, rel, dst, dst_type, version, kind) AS SELECT 'a', 'ticket', 'needs', 'b', 'ticket', NULL, NULL"],
    ['changed g_nodes body', "DROP VIEW g_nodes; CREATE VIEW g_nodes(id, type) AS SELECT 'a', 'ticket'"],
    ['an extra view', 'CREATE VIEW extra_v AS SELECT 1 x'],
    ['a recursive view', 'CREATE VIEW loop_v(n) AS WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r) SELECT n FROM r'],
    ['a trigger', "CREATE TRIGGER trg AFTER INSERT ON meta BEGIN SELECT 1; END"],
    ['a dropped view', 'DROP VIEW g_nodes'],
    ['an extra table', 'CREATE TABLE extra_t(x TEXT)'],
  ];
  for (const [what, sql] of cases) {
    const { file, dir } = plan(FULL);
    edit(file, sql);
    try { refused(file, dir); } catch (e) { throw new Error(`${what}: ${(e as Error).message}`); }
  }
  { // a graph table with no views (a half-built schema) is not the older schema
    const { file, dir } = plan(FULL);
    edit(file, 'DROP VIEW g_nodes; DROP VIEW g_links');
    refused(file, dir);
  }
  { // an older schema with a view added
    const { b, file } = frozenRepo();
    edit(file, 'CREATE VIEW g_nodes(id, type) AS SELECT 1, 2');
    assert.throws(() => openIndex(file, { dir: b }), (e) => e instanceof PlangraphError && e.code === 'DATA');
  }
});

test('a direct edit of a graph table is refused by the content digest; the stored fingerprint row is covered too', () => {
  const { file, dir } = plan(FULL);
  edit(file, "UPDATE person SET name = 'forged' WHERE id = 'Ana'");
  assert.throws(() => openIndex(file, { dir }), (e) => e instanceof PlangraphError && e.code === 'DATA' && /integrity digest/.test(e.message));
});
