// The incremental index: per-file (size, mtime) change detection against source_file, hash and re-read of the changed files only, rebuild of only the
// tables built from them, and a result equal to a full rebuild. NOT covered: the solver's own reads (solver-contract.test.ts), the commands.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { genPlan } from './fixtures/gen.ts';
import { openStore } from '../lib/planstore.ts';
import type { Kind, Row } from '../lib/planstore.ts';
import { buildIndex, openIndex, builders, stampContent, TABLES, INDEX_FILE, ADVISORY_TABLES } from '../src/db.ts';
import { DatabaseSync } from 'node:sqlite';

const tmps: string[] = [];
const tmp = (): string => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-incr-'))); tmps.push(d); return d; };
test.after(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });

const plan = genPlan({ n: 12, seed: 4 });
const ROWS: Partial<Record<Kind, Row[]>> = {
  ticket: plan.tickets as unknown as Row[], edge: plan.edges, schedule: plan.schedule,
  person: [{ id: 'Ana' }, { id: 'Ben' }], capacity: [{ person: 'Ana', sprint: 1, sp: 5, review_h: 2 }], sprint: [{ n: 1 }], epic: [{ id: 'E0' }], repo: [{ id: 'api', langs: ['ts'] }],
  link: [{ from: 'T-1', from_type: 'ticket', rel: 'relates_to', to: 'T-2', to_type: 'ticket' }], xref: [{ type: 'ticket', id: 'T-1', sys: 'jira', xid: 'ABC-1' }],
  ref: [{ key: 'T-1', plans: [], files: {}, fp_files: '', jira_updated: '', audited_at: '' }], learning: [{ id: 'L-1', kind: 'rule', topic: 't', text: 'x' }],
  evidence: [{ key: 'T-1', source: 'audit', verdict: 'READY' }], finding: [{ key: 'T-1', kind: 'gap', text: 'a' }], meta: [{ k: 'a', v: '1' }],
};
const ORDER: Kind[] = ['ticket', 'edge', 'ref', 'person', 'capacity', 'sprint', 'epic', 'repo', 'link', 'xref', 'schedule', 'evidence', 'finding', 'learning', 'meta'];

function planDir(_layout: 'entity', { git = false, old = true }: { git?: boolean; old?: boolean } = {}): string {
  const d = tmp(), dir = path.join(d, '.plangraph');
  fs.mkdirSync(dir);
  if (git) execFileSync('git', ['init', '-q'], { cwd: d });
  fs.writeFileSync(path.join(dir, 'format.json'), '{"format_version":2,"min_reader":2,"storage":"entity"}\n');
  const s = openStore({ dir, root: d });
  for (const k of ORDER) if (ROWS[k]) s.writeKind(k, ROWS[k] as Row[]);
  if (old) ageFiles(dir);
  return dir;
}
/** Every file an hour old: outside the racy window of a build that follows. */
function ageFiles(dir: string): void {
  const t = new Date(Date.now() - 3600_000);
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== '.txn') walk(p); } else if (e.name !== INDEX_FILE) fs.utimesSync(p, t, t); } };
  walk(dir);
}
const dump = (file: string): Record<string, unknown[]> => {
  const db = new DatabaseSync(file, { readOnly: true }), out: Record<string, unknown[]> = {};
  for (const n of [...TABLES.keys(), 'index_meta', 'source_file']) out[n] = db.prepare(`SELECT * FROM ${n} ORDER BY rowid`).all().map((r) => JSON.stringify(r));
  db.close();
  return out;
};
/** The index the incremental build wrote must equal a full rebuild of the same directory: every table, row for row. */
function sameAsFull(dir: string): void {
  const full = path.join(tmp(), 'full.sqlite');
  buildIndex({ dir }, { file: full, incremental: false });
  assert.deepEqual(dump(path.join(dir, INDEX_FILE)), dump(full));
}
const spyRows = () => mock.method(builders, 'rows');
const built = (spy: ReturnType<typeof spyRows>): string[] => spy.mock.calls.map((c) => (c.arguments[0] as { name: string }).name).sort();
const edit = (dir: string, kind: Kind, fn: (rows: Row[]) => Row[]): void => { const s = openStore({ dir, root: path.dirname(dir) }); s.writeKind(kind, fn(s.readKind(kind, { defaults: false }))); };

test('a first build is a full one and records every source file', () => {
  const dir = planDir('entity');
  const r = buildIndex({ dir });
  assert.deepEqual(r.rebuilt, [...TABLES.keys()]);
  const db = new DatabaseSync(path.join(dir, INDEX_FILE), { readOnly: true });
  const rows = db.prepare('SELECT path, size, mtime, hash FROM source_file ORDER BY path').all() as Array<{ path: string; hash: string }>;
  db.close();
  assert.ok(rows.some((x) => x.path.startsWith('nodes/ticket/')) && rows.some((x) => x.path === 'meta.jsonl') && rows.some((x) => x.path === 'schedules/CURRENT'));
  assert.ok(rows.every((x) => /^[0-9a-f]{64}$/.test(x.hash)));
  assert.ok(ADVISORY_TABLES.has('source_file'));
});

test('nothing changed: no table is built, no file is hashed, the index file is not touched', () => {
  const dir = planDir('entity'); buildIndex({ dir });
  const before = fs.readFileSync(path.join(dir, INDEX_FILE)), rows = spyRows(), hash = mock.method(builders, 'hash');
  try { const r = buildIndex({ dir }); assert.deepEqual(r.rebuilt, []); } finally { rows.mock.restore(); hash.mock.restore(); }
  assert.equal(rows.mock.callCount(), 0); assert.equal(hash.mock.callCount(), 0);
  assert.deepEqual(fs.readFileSync(path.join(dir, INDEX_FILE)), before);
});

test('editing one ticket node rebuilds only the tables that depend on tickets, and hashes only that file', () => {
  const dir = planDir('entity'); buildIndex({ dir });
  edit(dir, 'ticket', (r) => r.map((x) => (x.key === 'T-3' ? { ...x, summary: 'edited' } : x)));
  const rows = spyRows(), hash = mock.method(builders, 'hash');
  try { buildIndex({ dir }); } finally { rows.mock.restore(); hash.mock.restore(); }
  assert.deepEqual(built(rows), ['edge', 'link', 'ref', 'ticket', 'xref']);
  assert.equal(hash.mock.callCount(), 1, 'only the changed file is read for its hash');
  assert.match(String(hash.mock.calls[0]?.arguments[0]), /nodes\/ticket\/.*t-3~/);
  sameAsFull(dir);
  assert.equal((new DatabaseSync(path.join(dir, INDEX_FILE), { readOnly: true }).prepare("SELECT summary FROM ticket WHERE key='T-3'").get() as { summary: string }).summary, 'edited');
});

test('other dependent sets: a person, a schedule, a run, a cache file, meta', () => {
  const dir = planDir('entity'); buildIndex({ dir });
  const run = (fn: () => void): string[] => { fn(); ageFiles(dir); const rows = spyRows(); try { buildIndex({ dir }); } finally { rows.mock.restore(); } return built(rows); };
  assert.deepEqual(run(() => edit(dir, 'capacity', (r) => [...r, { person: 'Ben', sprint: 1, sp: 3 }])), ['capacity', 'link', 'person', 'xref']);
  assert.deepEqual(run(() => edit(dir, 'schedule', (r) => r.map((x, i) => (i ? x : { ...x, sprint: 9 })))), ['schedule']);
  assert.deepEqual(run(() => edit(dir, 'evidence', (r) => [...r, { key: 'T-2', source: 'audit', verdict: 'BLOCKED' }])), ['evidence']);
  assert.deepEqual(run(() => edit(dir, 'meta', () => [{ k: 'a', v: '2' }])), ['meta']);
  assert.deepEqual(run(() => { fs.mkdirSync(path.join(dir, 'cache'), { recursive: true }); fs.writeFileSync(path.join(dir, 'cache', 'jira.jsonl'), '{"sys":"jira","xid":"A-1","type":"ticket","fields":{},"links":[],"fp":"0123456789abcdef","seen":"2026-01-01"}\n'); }), ['obs']);
  sameAsFull(dir);
});

test('a deleted file is seen from the directory walk, a new file is seen, and both equal a full rebuild', () => {
  const dir = planDir('entity'); buildIndex({ dir });
  const s = openStore({ dir, root: path.dirname(dir) });
  s.writeKind('ticket', s.readKind('ticket', { defaults: false }).filter((r) => r.key !== 'T-5')); // removes a node file
  buildIndex({ dir });
  assert.equal(new DatabaseSync(path.join(dir, INDEX_FILE), { readOnly: true }).prepare("SELECT COUNT(*) c FROM ticket WHERE key='T-5'").get()?.c, 0);
  sameAsFull(dir);
  s.writeKind('ticket', [...s.readKind('ticket', { defaults: false }), { key: 'T-99', summary: 'new' }]); // adds one
  buildIndex({ dir });
  assert.equal(new DatabaseSync(path.join(dir, INDEX_FILE), { readOnly: true }).prepare("SELECT COUNT(*) c FROM ticket WHERE key='T-99'").get()?.c, 1);
  sameAsFull(dir);
});

for (const git of [true, false]) {
  test(`unstaged edits and untracked new files are seen (${git ? 'inside' : 'outside'} a git repository)`, () => {
    const dir = planDir('entity', { git }), root = path.dirname(dir);
    if (git) { execFileSync('git', ['add', '-A'], { cwd: root }); execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x'], { cwd: root }); }
    buildIndex({ dir });
    edit(dir, 'ticket', (r) => r.map((x) => (x.key === 'T-2' ? { ...x, summary: 'unstaged' } : x))); // tracked file, edited, not staged
    edit(dir, 'ticket', (r) => [...r, { key: 'T-50', summary: 'untracked' }]); // a new file git does not know
    if (git) assert.match(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }), /\?\?|^ M/m);
    const r = buildIndex({ dir });
    assert.ok(r.rebuilt.includes('ticket'));
    const db = new DatabaseSync(path.join(dir, INDEX_FILE), { readOnly: true });
    assert.equal((db.prepare("SELECT summary FROM ticket WHERE key='T-2'").get() as { summary: string }).summary, 'unstaged');
    assert.equal((db.prepare("SELECT summary FROM ticket WHERE key='T-50'").get() as { summary: string }).summary, 'untracked');
    db.close();
    sameAsFull(dir);
  });
}

test('an edit inside the racy window (same size, same second) is still seen', () => {
  const dir = planDir('entity', { old: false }); buildIndex({ dir });
  edit(dir, 'ticket', (r) => r.map((x) => (x.key === 'T-4' ? { ...x, summary: 'tikket 4' } : x))); // same length as 'ticket 4'
  const r = buildIndex({ dir });
  assert.ok(r.rebuilt.includes('ticket'));
  sameAsFull(dir);
});

test('freshness: openIndex is stale after an edit and fresh after the build (entity)', () => {
  const dir = planDir('entity'); buildIndex({ dir });
  { using h = openIndex(path.join(dir, INDEX_FILE), { dir }); assert.equal(h.stale, false); }
  edit(dir, 'ticket', (r) => r.map((x) => (x.key === 'T-1' ? { ...x, sp: 9 } : x)));
  { using h = openIndex(path.join(dir, INDEX_FILE), { dir }); assert.equal(h.stale, true); }
  buildIndex({ dir });
  { using h = openIndex(path.join(dir, INDEX_FILE), { dir }); assert.equal(h.stale, false); }
});

test('an index changed without the text (a writer re-stamped it) is rebuilt in full on the next build', () => {
  const dir = planDir('entity'); buildIndex({ dir });
  { using h = openIndex(path.join(dir, INDEX_FILE), { readOnly: false }); h.exec('BEGIN'); h.exec("UPDATE schedule SET sprint = 7 WHERE key = 'T-1'"); stampContent(h); h.exec('COMMIT'); }
  const r = buildIndex({ dir });
  assert.deepEqual(r.rebuilt, [...TABLES.keys()]);
  sameAsFull(dir);
});

test('a tampered or missing index is rebuilt in full', () => {
  const dir = planDir('entity'); buildIndex({ dir });
  { const db = new DatabaseSync(path.join(dir, INDEX_FILE)); db.exec("UPDATE ticket SET sp = 99 WHERE key = 'T-1'"); db.close(); }
  assert.deepEqual(buildIndex({ dir }).rebuilt, [...TABLES.keys()]);
  fs.rmSync(path.join(dir, INDEX_FILE));
  assert.deepEqual(buildIndex({ dir }).rebuilt, [...TABLES.keys()]);
  sameAsFull(dir);
});

test('openIndex accepts an advisory table of any shape and refuses an unknown one', () => {
  const dir = planDir('entity'); buildIndex({ dir });
  const file = path.join(dir, INDEX_FILE);
  { const db = new DatabaseSync(file); db.exec('CREATE TABLE identity(a, b); CREATE TABLE module(x PRIMARY KEY)'); db.close(); }
  { using h = openIndex(file, { dir }); assert.equal(h.stale, false); }
  assert.equal(buildIndex({ dir }).rebuilt.length, 0, 'and an incremental build still works on it');
  { const db = new DatabaseSync(file); db.exec('CREATE TABLE sneaky(a)'); db.close(); }
  assert.throws(() => openIndex(file), /unexpected schema/);
});
