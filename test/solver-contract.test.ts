// The contract between src/db.ts and bin/plangraph-solve: the table list, the two view SQL strings, the content-digest table list and the advisory-table
// allowlist are written twice (TypeScript and Python), so a test reads them from both sources and asserts they are equal. NOT covered: the solver's model.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { genPlan } from './fixtures/gen.ts';
import { writePlanDir } from './helpers/plan-dir.ts';
import { TABLES, ADVISORY_TABLES, contentDigest, buildIndex, INDEX_FILE, IndexHandle } from '../src/db.ts';
import { GRAPH_VIEWS } from '../lib/graph/views.ts';

const ROOT = path.join(import.meta.dirname, '..');
const SOLVE = path.join(ROOT, 'bin/plangraph-solve');
const HAVE_PY3 = spawnSync('python3', ['--version'], { stdio: 'ignore' }).status === 0;
const SKIP = HAVE_PY3 ? false : 'skipped: no python3';
const tmps: string[] = [];
after(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });

const HEAD = `
import importlib.machinery, importlib.util, json, sys, types
loader = importlib.machinery.SourceFileLoader('brain_solve', sys.argv[1]); spec = importlib.util.spec_from_loader('brain_solve', loader)
m = importlib.util.module_from_spec(spec); loader.exec_module(m)
def load(**kw):
    a = types.SimpleNamespace(jsonl_dir=None, config=None, db=None); a.__dict__.update(kw)
    try:
        t, e, s, c = m.load_raw(a); return {'ok': True, 'tickets': [x['key'] for x in t], 'edges': len(e)}
    except m.Fail as f: return {'ok': False, 'status': f.status, 'msg': f.msg, 'code': f.code}
`;
const py = (body: string): unknown => {
  const r = spawnSync('python3', ['-I', '-c', HEAD + body, SOLVE], { encoding: 'utf8', timeout: 15000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop() as string); // split gives at least one element
};
const quoted = (s: string): string[] => [...s.matchAll(/'([a-z_]+)'/g)].map((m) => m[1] as string);

test('ADVISORY_TABLES is the same list in src/db.ts and bin/plangraph-solve, read from both sources', { skip: SKIP }, () => {
  const ts = /export const ADVISORY_TABLES[^=]*=\s*new Set\(\[([^\]]*)\]\)/.exec(fs.readFileSync(path.join(ROOT, 'src/db.ts'), 'utf8'));
  const pyText = /^ADVISORY_TABLES = frozenset\(\(([^)]*)\)\)/m.exec(fs.readFileSync(SOLVE, 'utf8'));
  assert.ok(ts && pyText, 'both constants are found by their source text');
  assert.deepEqual(quoted(ts[1] as string).sort(), quoted(pyText[1] as string).sort());
  assert.deepEqual(quoted(ts[1] as string).sort(), [...ADVISORY_TABLES].sort(), 'and the text is what the module exports');
  assert.deepEqual(py("print(json.dumps(sorted(m.ADVISORY_TABLES)))"), [...ADVISORY_TABLES].sort());
  for (const t of ['source_file', 'identity', 'module', 'requirement', 'decision', 'team', 'event']) assert.ok(ADVISORY_TABLES.has(t), t);
  for (const t of ADVISORY_TABLES) assert.ok(!TABLES.has(t), `${t} is not a solver table`);
});

test('INDEX_TABLES (columns, primary keys, order) and the digest order are the same in both', { skip: SKIP }, () => {
  const got = py("print(json.dumps({'tables': [[t, list(c), list(p)] for t, (c, p) in m.INDEX_TABLES.items()], 'order': [[t, m.index_order(t)] for t in m.INDEX_TABLES]}))") as { tables: Array<[string, string[], string[]]>; order: Array<[string, string]> };
  assert.deepEqual(got.tables.map(([t, c]) => [t, c]), [...TABLES.values()].map((t) => [t.name, [...t.columns]]));
  assert.deepEqual(got.order, [...TABLES.values()].map((t) => [t.name, t.order]));
  assert.ok(got.tables.every(([t]) => !ADVISORY_TABLES.has(t)), 'no advisory table in INDEX_TABLES');
});

test('GRAPH_VIEWS: the view SQL strings are equal byte for byte', { skip: SKIP }, () => {
  assert.deepEqual(py('print(json.dumps(m.GRAPH_VIEWS))'), Object.fromEntries(GRAPH_VIEWS));
});

test('the content digest hashes the same tables in the same order: the SQL each side runs is equal, and advisory tables are not in it', { skip: SKIP }, () => {
  const seen: string[] = [];
  const stub = { prepare(sql: string) { seen.push(sql); return { setReturnArrays() { /* nothing */ }, iterate: () => [] }; } };
  contentDigest(stub as unknown as IndexHandle);
  const pySql = py("class R:\n    def __init__(s): s.sql = []\n    def execute(s, sql, args=()):\n        s.sql.append(sql); return []\nr = R(); m.content_digest(r); print(json.dumps(r.sql))") as string[];
  assert.deepEqual(pySql, seen);
  assert.equal(seen.length, TABLES.size + 1, 'every solver table, then index_meta');
  for (const t of ADVISORY_TABLES) assert.ok(!seen.some((q) => new RegExp(`FROM ${t}\\b`).test(q)), `${t} is not hashed`);
});

function index(): { db: string; cfg: string } {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-contract-')); tmps.push(d);
  writePlanDir(d, genPlan({ n: 5, seed: 2 }));
  buildIndex({ dir: d });
  return { db: path.join(d, INDEX_FILE), cfg: path.join(d, 'config.json') };
}
const load = (r: { db: string; cfg: string }): { ok: boolean; msg?: string } => py(`print(json.dumps(load(db=${JSON.stringify(r.db)}, config=${JSON.stringify(r.cfg)})))`) as { ok: boolean; msg?: string };

test('the solver accepts an index with advisory tables, whatever their shape, and still refuses an unknown table', { skip: SKIP }, () => {
  const r = index();
  assert.equal(load(r).ok, true, 'source_file is there already');
  { const db = new DatabaseSync(r.db); db.exec(['identity', 'module', 'requirement', 'decision', 'team', 'event'].map((t) => `DROP TABLE ${t}`).join(';')); db.exec('CREATE TABLE identity(a, b, c); CREATE TABLE module(x PRIMARY KEY); CREATE TABLE requirement(q); CREATE TABLE decision(d); CREATE TABLE team(z, z2); CREATE TABLE event(e); INSERT INTO identity VALUES(1, 2, 3)'); db.close(); }
  assert.equal(load(r).ok, true, 'advisory rows are not in the digest');
  { const db = new DatabaseSync(r.db); db.exec("UPDATE source_file SET hash = 'changed'"); db.close(); }
  assert.equal(load(r).ok, true, 'a change inside an advisory table is not a digest mismatch');
  { const db = new DatabaseSync(r.db); db.exec('CREATE TABLE sneaky(a)'); db.close(); }
  const bad = load(r);
  assert.equal(bad.ok, false);
  assert.match(bad.msg as string, /unexpected schema/);
});

test('an index built here carries every advisory table, and the solver reads it', { skip: SKIP }, () => {
  const r = index(), db = new DatabaseSync(r.db), have = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((x) => x.name);
  db.close();
  for (const t of ADVISORY_TABLES) assert.ok(have.includes(t), `${t} is built`);
  assert.equal(load(r).ok, true);
  assert.equal(fs.statSync(r.db).mode & 0o777, 0o600, 'the index file is 0600 (it embeds identity refs)');
});

test('an index without source_file (an earlier build) is still a current one, and a planted trigger is still refused', { skip: SKIP }, () => {
  const r = index();
  { const db = new DatabaseSync(r.db); db.exec('DROP TABLE source_file'); db.close(); }
  assert.equal(load(r).ok, true, 'an index of an earlier build has no source_file and is still a current one');
  { const db = new DatabaseSync(r.db); db.exec('CREATE TRIGGER trg AFTER INSERT ON meta BEGIN SELECT 1; END'); db.close(); }
  assert.equal(load(r).ok, false);
});
