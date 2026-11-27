// EntityStore: the entity backend of the PlanStore (the only one). The mapping (every old file to one home, every column kept), the rows every kind
// reads back in canonical order, and idempotent writes. NOT covered: the commands on it (test/storage-mapping.test.ts), the index (index-incremental.test.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { genPlan } from './fixtures/gen.ts';
import { openStore, KINDS, kindFile } from '../lib/planstore.ts';
import * as S from '../lib/store.ts';
import type { Kind, Row } from '../lib/planstore.ts';
import { EntityStore } from '../lib/store2/entitystore.ts';
import { listKinds, listNodeFiles, readNodes } from '../lib/store2/nodes.ts';
import { checkStore } from '../lib/store2/check.ts';
import { adoptPlanDir } from './helpers/plan-dir.ts';

const tmps: string[] = [];
const tmp = (): string => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-entity-'))); tmps.push(d); return d; };
test.after(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });
const entityDir = (): string => { const d = tmp(); fs.writeFileSync(path.join(d, 'format.json'), '{"format_version":2,"min_reader":2,"storage":"entity"}\n'); return d; };
/** What a kind reads back as: the canonical text of the rows, parsed again (canonical order), with the schema defaults when asked. */
const expected = (k: Kind, rows: readonly Row[], defaults: boolean): Row[] => { const f = kindFile(k), sch = S.SCHEMAS[f] as S.Schema, out = S.parseJsonlText(S.canonFile(rows, sch), f); return defaults ? out.map((r) => S.withDefaults(sch, r)) : out; };

const plan = genPlan({ n: 14, seed: 5 });
// one hand-made row set per kind, unsorted on purpose; every optional column is present at least once, unknown columns too
const ROWS: Record<Kind, Row[]> = {
  ticket: [...plan.tickets as unknown as Row[], { key: 'sp:plan-a/1', summary: 'plan task', sp: 2, impl_status: 'done', extra_col: { a: [1, 2] } }],
  edge: [...plan.edges, { consumer: 'T-2', producer: 'sp:plan-a/1', kind: 'jira_link', note: 'why', conf: 3 }],
  schedule: [...plan.schedule, { version: 'v0', key: 'T-1', owner: 'Ben', sprint: 1 }],
  evidence: [{ key: 'T-2', source: 'audit', verdict: 'BLOCKED', resolution: 'wait', needs: 'T-1' }, { key: 'T-1', source: 'audit', verdict: 'READY', resolution: '', needs: '' }],
  finding: [{ key: 'T-2', kind: 'gap', text: 'b' }, { key: 'T-1', kind: 'gap', text: 'a' }],
  meta: [{ k: 'z', v: '1' }, { k: 'a', v: '2' }],
  learning: [{ id: 'L-2', kind: 'rule', topic: 't', text: 'x', why: '', source: '' }, { id: 'L-1', kind: 'rule', topic: 't', text: 'y', why: 'w', source: 's' }],
  ref: [
    { key: 'T-1', plans: [{ plan: 'p.md', task: '1' }, { plan: 'a.md', task: '2' }], files: { 'a.ts': 'h1' }, fp_files: 'f1', jira_updated: '2026-01-01', audited_at: '2026-01-02', fp_links: 'x', rules: 1 },
    { key: 'sp:plan-a', plans: [], files: { 'docs/p.md': 'h' }, fp_files: '', jira_updated: '', audited_at: '' }, // a plan row: not a ticket
    { key: 'T-77', plans: [], files: {}, fp_files: '', jira_updated: '', audited_at: '' }, // a ref with no ticket row
  ],
  openitem: [{ key: 'T-1', kind: 'followup', status: 'open' }, { key: 'T-1', kind: 'decision', status: 'closed', note: 'n' }],
  person: [{ id: 'Ben' }, { id: 'Ana', name: 'Ana A', active: true }],
  sprint: [{ n: 2 }, { n: 1, name: 'one', start: '2026-01-01', end: '2026-01-14', state: 'closed' }],
  epic: [{ id: 'E1' }, { id: 'E0', name: 'zero' }],
  repo: [{ id: 'api', langs: ['ts', 'go'], cmds: { test: 't' }, owners: ['Ana'] }, { id: 'web' }],
  capacity: [{ person: 'Ben', sprint: 1, sp: 8 }, { person: 'Ana', sprint: 1, sp: 5, review_h: 2 }, { person: 'Ana', sprint: 2, sp: 4.5, review_h: 0.5 }],
  link: [
    { from: 'T-1', from_type: 'ticket', rel: 'relates_to', to: 'T-2', to_type: 'ticket', attrs: { why: 'x' }, conf: 2 },
    { from: 'sp:plan-a#1', from_type: 'plantask', rel: 'touches', to: 'api', to_type: 'repo' }, // a source type with no node file
    { from: 'pr-1', from_type: 'x-github.pr', rel: 'x-github/closes', to: 'T-2', to_type: 'ticket' },
    { from: 'api', from_type: 'repo', rel: 'depends_on', to: 'web', to_type: 'repo' },
    { from: 'Ana', from_type: 'person', rel: 'relates_to', to: 'Ben', to_type: 'person' },
  ],
  xref: [
    { type: 'ticket', id: 'T-1', sys: 'jira:acme', xid: 'ABC-1', src: 'import', seen: '2026-02-01', note: 'n' },
    { type: 'ticket', id: 'T-1', sys: 'github', xid: 'o/r#1' },
    { type: 'plan', id: 'plans/a.md', sys: 'local', xid: 'x' }, // file-less source
  ],
};
// the order tests write in: a node that holds parts of several kinds is built up kind by kind
const ORDER: Kind[] = ['ticket', 'edge', 'ref', 'person', 'capacity', 'sprint', 'epic', 'repo', 'openitem', 'link', 'xref', 'schedule', 'evidence', 'finding', 'learning', 'meta'];
const writeAll = (s: { writeKind(k: Kind, r: readonly Row[]): unknown }, rows: Partial<Record<Kind, Row[]>> = ROWS): void => { for (const k of ORDER) if (rows[k]) s.writeKind(k, rows[k] as Row[]); };
const snapshot = (dir: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.name === '.txn') continue; if (e.isDirectory()) walk(p); else out[path.relative(dir, p)] = `${fs.statSync(p).mtimeMs}:${fs.readFileSync(p, 'utf8')}`; } };
  walk(dir);
  return out;
};

test('the order list names every kind', () => { assert.deepEqual([...ORDER].sort(), [...KINDS].sort()); assert.deepEqual(Object.keys(ROWS).sort(), [...KINDS].sort()); });

test('openStore always returns the entity backend, whatever format.json says (or does not)', () => {
  const a = tmp(), c = tmp();
  fs.writeFileSync(path.join(a, 'format.json'), '{"format_version":1,"min_reader":1}\n');
  fs.writeFileSync(path.join(c, 'format.json'), 'not json');
  for (const d of [a, c, entityDir(), tmp()]) { const st = openStore({ dir: d, root: d }); assert.equal(st.describe().backend, 'entity'); assert.ok(st instanceof EntityStore); }
});

test('every kind reads back the canonical rows of what was written (with and without defaults)', () => {
  const e = entityDir(), es = openStore({ dir: e, root: e });
  writeAll(es);
  for (const k of KINDS) for (const defaults of [true, false]) assert.deepEqual(es.readKind(k, { defaults }), expected(k, ROWS[k], defaults), `${k} defaults=${defaults}`);
  for (const k of KINDS) assert.equal(es.exists(k), true, k);
  assert.equal(es.readSource('ticket', 1 << 20), S.canonFile(ROWS.ticket, S.SCHEMAS['tickets.jsonl'] as S.Schema), 'the canonical text of a kind');
});

test('the same on genPlan alone, at a larger size', () => {
  const big = genPlan({ n: 60, people: 4, density: 0.2, seed: 11 });
  const e = entityDir(), es = openStore({ dir: e, root: e });
  const rows: Partial<Record<Kind, Row[]>> = { ticket: big.tickets as unknown as Row[], edge: big.edges, schedule: big.schedule };
  writeAll(es, rows);
  for (const k of ['ticket', 'edge', 'schedule'] as Kind[]) assert.deepEqual(es.readKind(k), expected(k, rows[k] as Row[], true), k);
  assert.equal(es.readKind('ticket').length, 60);
});

test('every column survives: capacity review_h, xref src and seen, a plan row of refs, unknown columns', () => {
  const e = entityDir(), s = openStore({ dir: e, root: e });
  writeAll(s);
  assert.deepEqual(s.readKind('capacity').find((r) => r.person === 'Ana' && r.sprint === 1), { person: 'Ana', sprint: 1, sp: 5, review_h: 2 });
  assert.equal(s.readKind('capacity').find((r) => r.person === 'Ana' && r.sprint === 2)?.review_h, 0.5);
  assert.deepEqual(s.readKind('xref').find((r) => r.xid === 'ABC-1'), ROWS.xref[0]);
  const planRef = s.readKind('ref').find((r) => r.key === 'sp:plan-a') as Row;
  assert.deepEqual(planRef.files, { 'docs/p.md': 'h' });
  assert.deepEqual(s.readKind('ref').find((r) => r.key === 'T-1'), { key: 'T-1', ...ROWS.ref[0], plans: [{ plan: 'a.md', task: '2' }, { plan: 'p.md', task: '1' }] }); // plans is a set: sorted
  assert.equal(s.readKind('ticket').find((r) => r.key === 'sp:plan-a/1')?.extra_col && JSON.stringify(s.readKind('ticket').find((r) => r.key === 'sp:plan-a/1')?.extra_col), '{"a":[1,2]}');
  assert.deepEqual(s.readKind('edge').find((r) => r.producer === 'sp:plan-a/1'), { consumer: 'T-2', producer: 'sp:plan-a/1', kind: 'jira_link', note: 'why', conf: 3 });
  assert.deepEqual(s.readKind('link').find((r) => r.from === 'T-1'), ROWS.link[0]);
  assert.deepEqual(s.readKind('openitem').find((r) => r.kind === 'decision'), ROWS.openitem[1]);
});

test('the mapping: where each kind lives on disk', () => {
  const e = entityDir(), s = openStore({ dir: e, root: e });
  writeAll(s);
  const kinds = listKinds(e);
  assert.deepEqual(kinds, ['epic', 'ext', 'openitem', 'person', 'repo', 'sprint', 'ticket']);
  const node = (kind: string, id: string) => readNodes(e, kind).nodes.find((n) => n.id === id) as Record<string, unknown>;
  // edges are `needs` lines of the consumer, with kind and note in attrs
  assert.deepEqual((node('ticket', 'T-2').links as Array<Record<string, unknown>>).filter((l) => l.to === 'sp:plan-a/1'), [{ rel: 'needs', to: 'sp:plan-a/1', attrs: { kind: 'jira_link', note: 'why', conf: 3 } }]);
  // capacity is a repeated line of the person
  assert.deepEqual(node('person', 'Ana').capacity, [{ sprint: 2, sp: 4.5, review_h: 0.5 }, { sprint: 1, sp: 5, review_h: 2 }]); // elements sorted by canonical JSON
  assert.match(fs.readFileSync(listNodeFiles(e, 'person').find((f) => f.includes('ana~')) as string, 'utf8'), /^capacity \{"review_h":2,"sp":5,"sprint":1\}$/m);
  // a plan row of refs is an epic node; a ref with no ticket row is a ticket node that is not a ticket row
  assert.deepEqual(node('epic', 'sp:plan-a').refcols, ['audited_at', 'files', 'fp_files', 'jira_updated', 'plans']);
  assert.equal(node('ticket', 'T-77').primary, false);
  assert.ok(!s.readKind('ticket').some((r) => r.key === 'T-77'));
  // links and xrefs of a type with no node file live in nodes/ext/, keyed by a pg: URI
  assert.deepEqual(readNodes(e, 'ext').nodes.map((n) => n.id).sort(), ['pg:plan/plans/a.md', 'pg:plantask/sp:plan-a#1', 'pg:x-github.pr/pr-1']);
  // the schedule is a version file with CURRENT; evidence, findings and learnings are sealed run files
  assert.match(fs.readFileSync(path.join(e, 'schedules', 'CURRENT'), 'utf8'), /^v1-[0-9a-f]{8}\n$/);
  for (const r of ['evidence', 'findings', 'learnings']) assert.equal(fs.readdirSync(path.join(e, 'runs', r)).length, 1);
  assert.ok(!fs.existsSync(path.join(e, 'tickets.jsonl')));
  assert.ok(fs.existsSync(path.join(e, 'meta.jsonl')), 'meta stays a single file');
  assert.deepEqual(checkStore(e).filter((v) => v.code !== 'DANGLING_LINK'), [], 'the store passes check apart from links to ids the fixture does not define');
});

test('re-running a write changes nothing, byte for byte and mtime for mtime', async () => {
  const e = entityDir(), s = openStore({ dir: e, root: e });
  writeAll(s);
  const before = snapshot(e);
  await new Promise((r) => setTimeout(r, 15));
  writeAll(s);
  assert.deepEqual(snapshot(e), before);
  assert.equal(s.writeChanged(KINDS.map((kind) => ({ kind, rows: ROWS[kind], old: s.readKind(kind, { defaults: false }) }))), 0);
});

test('a write replaces the kind: a removed row is gone, the other parts of the node stay', () => {
  const e = entityDir(), s = openStore({ dir: e, root: e });
  writeAll(s);
  s.writeKind('ticket', ROWS.ticket.filter((r) => r.key !== 'T-3' && r.key !== 'T-1'));
  assert.ok(!s.readKind('ticket').some((r) => r.key === 'T-3'));
  assert.equal(s.readKind('ref').find((r) => r.key === 'T-1')?.fp_files, 'f1', 'the ref of a removed ticket stays');
  assert.ok(s.readKind('xref').some((r) => r.id === 'T-1'), 'its xrefs stay');
  s.writeKind('xref', []);
  s.writeKind('ref', ROWS.ref.filter((r) => r.key !== 'T-1' && r.key !== 'T-77'));
  assert.ok(!listNodeFiles(e, 'ticket').some((f) => f.includes('t-77~')), 'a node that holds nothing any more is removed');
  assert.ok(listNodeFiles(e, 'ticket').some((f) => f.includes('t-1~')), 'a node that still holds links stays');
  s.writeKind('evidence', [ROWS.evidence[0] as Row]);
  assert.equal(s.readKind('evidence').length, 1);
  assert.equal(fs.readdirSync(path.join(e, 'runs', 'evidence')).flatMap((m) => fs.readdirSync(path.join(e, 'runs', 'evidence', m))).length, 1, 'the old run file is gone');
  s.writeKind('evidence', []);
  assert.deepEqual(s.readKind('evidence'), []);
  assert.equal(s.exists('evidence'), false);
});

test('ids that differ only in case stay two nodes; a damaged file is skipped, not fatal', () => {
  const e = entityDir(), s = openStore({ dir: e, root: e });
  s.writeKind('ticket', [{ key: 'ABC-1', summary: 'a' }, { key: 'abc-1', summary: 'b' }]);
  assert.deepEqual(s.readKind('ticket').map((r) => r.key), ['ABC-1', 'abc-1']);
  fs.appendFileSync(listNodeFiles(e, 'ticket')[0] as string, '<<<<<<< ours\n');
  assert.equal(s.readKind('ticket').length, 1);
});

test('a write is refused when the node directory leaves the repository', () => {
  const e = entityDir(), out = tmp(), s = openStore({ dir: e, root: e });
  fs.mkdirSync(path.join(e, 'nodes'));
  fs.symlinkSync(out, path.join(e, 'nodes', 'ticket'));
  assert.throws(() => s.precheck(['ticket']), /REFUSED|refusing|outside|symlink/i);
});

test('adoptPlanDir converts old-layout files into the entity layout and removes them', () => {
  const d = tmp();
  for (const k of KINDS) fs.writeFileSync(path.join(d, kindFile(k)), S.canonFile(ROWS[k], S.SCHEMAS[kindFile(k)] as S.Schema)); // the old layout: one canonical file per kind
  fs.writeFileSync(path.join(d, 'config.json'), '{}\n');
  adoptPlanDir(d);
  for (const k of KINDS) if (k !== 'meta') assert.ok(!fs.existsSync(path.join(d, kindFile(k))), `${kindFile(k)} is gone`);
  assert.ok(fs.existsSync(path.join(d, 'meta.jsonl')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(d, 'format.json'), 'utf8')).storage, 'entity');
  const s2 = openStore({ dir: d, root: d });
  assert.equal(s2.describe().backend, 'entity');
  for (const k of KINDS) assert.deepEqual(s2.readKind(k), expected(k, ROWS[k], true), k);
  assert.ok(fs.existsSync(path.join(d, 'config.json')));
  adoptPlanDir(d); // again: nothing left to convert
  for (const k of KINDS) assert.deepEqual(s2.readKind(k), expected(k, ROWS[k], true), k);
});
