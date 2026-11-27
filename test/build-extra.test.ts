// Task 30: `plangraph build` keeps unknown record fields (in the `extra` column) and never takes SQL identifiers from data.
// NOT covered: learnings/refs are never rewritten from the index (export writes only FILES), so their `extra` is checked in the index only.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import * as S from '../lib/store.ts';
import { readPlanFile, writePlanFile } from './helpers/plan-dir.ts';

const BRAIN = path.join(import.meta.dirname, '../bin/plangraph');
const tmps: string[] = [];
after(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });
// a private plugin data directory: bin/plangraph keeps its compile cache there, never in the real HOME
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-extra-data-')); tmps.push(DATA);
function repo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-extra-'));
  tmps.push(d);
  execFileSync('git', ['init', '-q'], { cwd: d });
  run(d, 'init');
  return d;
}
const run = (cwd: string, ...args: string[]) => execFileSync('node', [BRAIN, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CLAUDE_PLUGIN_DATA: DATA } });
const bdir = (d: string) => path.join(d, '.plangraph');
const put = (d: string, f: string, recs: readonly unknown[]) => writePlanFile(bdir(d), f, recs.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n');
const canonTickets = (recs: readonly S.Rec[]) => S.canonFile(recs, S.SCHEMAS['tickets.jsonl']);
const tk = (key: string, more: S.Rec = {}) => ({ key, summary: 's' + key, epic: 'E', sp: 3, jira_status: 'To Do', v2_owner: 'Ana', v2_sprint: 1, verdict: 'READY', verdict_source: 'a', first_verdict: 'READY', ...more });
const count = (d: string, t: string) => { const db = new DatabaseSync(path.join(bdir(d), 'plangraph.sqlite'), { readOnly: true }); try { return (db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c; } finally { db.close(); } }; // COUNT(*) always returns one row

test('(a) unknown scalar, object and array fields build and round-trip byte-stable', () => {
  const d = repo();
  const recs = [tk('T-1', { zeta: 'z', alpha: { b: 2, a: [1, { y: 1, x: null }] }, list: [3, 1, 2], flag: true, nothing: null }), tk('T-2')];
  const text = canonTickets(recs);
  writePlanFile(bdir(d), 'tickets.jsonl', text);
  run(d, 'build'); run(d, 'export');
  const first = readPlanFile(bdir(d), 'tickets.jsonl');
  assert.equal(first, text);
  run(d, 'build'); run(d, 'export');
  assert.equal(readPlanFile(bdir(d), 'tickets.jsonl'), first);
  const db = new DatabaseSync(path.join(bdir(d), 'plangraph.sqlite'), { readOnly: true });
  const x = db.prepare("SELECT key, extra FROM ticket ORDER BY key").all();
  db.close();
  assert.equal(x[0].extra, '{"alpha":{"a":[1,{"x":null,"y":1}],"b":2},"flag":true,"list":[3,1,2],"nothing":null,"zeta":"z"}');
  assert.equal(x[1].extra, null);
});

test('(b) record keys containing SQL never reach a statement: the entity layout refuses such a field name, an SQL-looking allowed one is an unknown field', () => {
  const d = repo();
  put(d, 'edges.jsonl', [{ consumer: 'T-2', producer: 'T-1', kind: 'plan_need', note: '' }]);
  const evil = 'summary) VALUES(1,2); DROP TABLE ticket;--';
  for (const bad of [evil, "a'b", '', 'x y']) assert.throws(() => writePlanFile(bdir(d), 'tickets.jsonl', canonTickets([tk('T-1', { [bad]: 'x' })])), /field name not allowed/, bad);
  const recs = [tk('T-1', { 'summary-VALUES-DROP_TABLE-ticket': 'x', a_b: 1, 'x-y': 2 }), tk('T-2')];
  const text = canonTickets(recs);
  writePlanFile(bdir(d), 'tickets.jsonl', text);
  run(d, 'build');
  assert.equal(count(d, 'ticket'), 2);
  assert.equal(count(d, 'edge'), 1);
  assert.equal(count(d, 'schedule'), 0);
  run(d, 'export');
  assert.equal(readPlanFile(bdir(d), 'tickets.jsonl'), text);
  assert.ok(text.includes('DROP_TABLE'));
});

test('(b2) prototype keys and a field literally named extra survive as unknown fields; a __proto__ field is not stored', () => {
  const d = repo();
  writePlanFile(bdir(d), 'tickets.jsonl', '{"key":"T-1","summary":"s","__proto__":{"polluted":true}}\n'); // the entity layout cannot name that field: it is not stored, nothing is polluted
  assert.ok(!readPlanFile(bdir(d), 'tickets.jsonl').includes('__proto__'));
  const line = '{"key":"T-1","summary":"s","constructor":{"a":1},"extra":"mine","toString":5}';
  writePlanFile(bdir(d), 'tickets.jsonl', line + '\n');
  run(d, 'build'); run(d, 'export');
  const out = readPlanFile(bdir(d), 'tickets.jsonl');
  for (const frag of ['"constructor":{"a":1}', '"extra":"mine"', '"toString":5']) assert.ok(out.includes(frag), frag + ' in ' + out);
  assert.equal(({} as Record<string, unknown>).polluted, undefined); // reads a key a fresh object does not have
  run(d, 'build'); run(d, 'export');
  assert.equal(readPlanFile(bdir(d), 'tickets.jsonl'), out);
});

test('(c) a legacy file with only known fields exports byte-identical to its canonical form (no extra noise)', () => {
  const d = repo();
  const recs = [tk('T-2'), tk('T-1', { impl_status: 'done' })];
  const text = canonTickets(recs);
  writePlanFile(bdir(d), 'tickets.jsonl', text);
  put(d, 'schedule.jsonl', [{ version: 'current', key: 'T-1', owner: 'Ana', sprint: 1 }]);
  put(d, 'meta.jsonl', [{ k: 'a', v: 'b' }]);
  const sched = readPlanFile(bdir(d), 'schedule.jsonl');
  const meta = fs.readFileSync(path.join(bdir(d), 'meta.jsonl'), 'utf8'); // meta.jsonl stays a file
  run(d, 'build'); run(d, 'export');
  assert.equal(readPlanFile(bdir(d), 'tickets.jsonl'), text);
  assert.ok(!text.includes('extra'));
  assert.equal(readPlanFile(bdir(d), 'schedule.jsonl'), sched);
  assert.equal(fs.readFileSync(path.join(bdir(d), 'meta.jsonl'), 'utf8'), meta);
});

test('(d) a known text field with an object value is a data error (security review M3); other tables keep unknown fields', () => {
  const d = repo();
  put(d, 'tickets.jsonl', [tk('T-1', { summary: { not: 'a string' } })]);
  const bad = spawnSync(process.execPath, [BRAIN, 'build'], { cwd: d, encoding: 'utf8', env: { ...process.env, PLANGRAPH_DIR: '', CLAUDE_PLUGIN_DATA: DATA } });
  assert.equal(bad.status, 2); assert.equal(bad.stderr, 'error: tickets.jsonl:1: "summary" must be a string or a number\ntry: plangraph doctor\n');
  put(d, 'tickets.jsonl', [tk('T-1')]);
  put(d, 'edges.jsonl', [{ consumer: 'T-2', producer: 'T-1', kind: 'plan_need', note: '', weight: 2 }]);
  put(d, 'findings.jsonl', [{ key: 'T-1', kind: 'risk', text: 't', sev: { n: 1 } }]);
  put(d, 'evidence.jsonl', [{ key: 'T-1', source: 's', verdict: 'READY', resolution: '', needs: '', conf: 0.5 }]);
  run(d, 'build');
  const db = new DatabaseSync(path.join(bdir(d), 'plangraph.sqlite'), { readOnly: true });
  assert.equal((db.prepare('SELECT summary FROM ticket').get() as Record<string, unknown>).summary, 'sT-1'); // the query has a row
  assert.equal((db.prepare('SELECT extra FROM ticket').get() as Record<string, unknown>).extra, null); // the query has a row
  assert.equal((db.prepare('SELECT extra FROM edge').get() as Record<string, unknown>).extra, '{"weight":2}'); // the query has a row
  assert.equal((db.prepare('SELECT extra FROM finding').get() as Record<string, unknown>).extra, '{"sev":{"n":1}}'); // the query has a row
  assert.equal((db.prepare('SELECT extra FROM evidence').get() as Record<string, unknown>).extra, '{"conf":0.5}'); // the query has a row
  db.close();
  const before = ['edges', 'findings', 'evidence'].map((f) => readPlanFile(bdir(d), f + '.jsonl'));
  run(d, 'export');
  for (const f of ['edges', 'findings', 'evidence']) assert.ok(readPlanFile(bdir(d), f + '.jsonl').includes(f === 'edges' ? '"weight":2' : f === 'findings' ? '"sev":{"n":1}' : '"conf":0.5'));
  assert.equal(before.length, 3);
});

test('(d2) learnings and refs keep unknown fields in the index extra column', () => {
  const d = repo();
  put(d, 'learnings.jsonl', [{ id: 'L1', kind: 'rule', topic: 't', text: 'x', why: 'w', source: 's', tag: ['a'] }, { id: 'L2', kind: 'rule', topic: 't', text: 'y' }]);
  put(d, 'refs.jsonl', [{ key: 'T-1', plans: [], files: {}, fp_files: '', jira_updated: '', audited_at: '', note: 'n' }]);
  run(d, 'build');
  const db = new DatabaseSync(path.join(bdir(d), 'plangraph.sqlite'), { readOnly: true });
  assert.equal((db.prepare("SELECT extra FROM learning WHERE id='L1'").get() as Record<string, unknown>).extra, '{"tag":["a"]}'); // the query has a row
  assert.equal((db.prepare("SELECT extra FROM learning WHERE id='L2'").get() as Record<string, unknown>).extra, null); // the query has a row
  assert.equal((db.prepare('SELECT extra FROM ref').get() as Record<string, unknown>).extra, '{"note":"n"}'); // the query has a row
  db.close();
});

test('(f) source scan: the INSERT column lists come from constants, never from record keys', () => {
  // `plangraph build` is src/db.ts buildIndex (bin/plangraph only dispatches to src/cli.ts).
  const code = fs.readFileSync(path.join(import.meta.dirname, '../src/db.ts'), 'utf8');
  assert.match(code, /const columns(?:: [^=]+)? = Object\.freeze\((?:file === OBS_FILE \? \[\.\.\.OBS_COLUMNS\] : )?\[\.\.\.(?:SCHEMAS\[file\]|\(SCHEMAS\[file\] as \w+\))\.order\]\)/, 'columns come from the frozen SCHEMAS lists');
  assert.ok(!/Object\.keys\(r(ec)?\)\s*\.(map|join)|\bcols\b/.test(code), 'no per-record column list');
  // every template literal that builds SQL may interpolate only the table name, the verb, or the constant column list / placeholders
  const sqlTemplates = [...code.matchAll(/`([^`]*\b(INSERT|SELECT|CREATE)\b[^`]*)`/g)];
  assert.ok(sqlTemplates.length >= 2);
  for (const m of sqlTemplates) for (const i of m[1].matchAll(/\$\{([^}]*)\}/g)) {
    assert.match(i[1].trim(), /^(t\.name|t\.columnList|t\.placeholders|t\.ddl|t\.order|verb|SOURCE_FILE_DDL)$/, 'interpolation: ' + i[1]);
  }
  // insertSql takes only a table spec and a verb: no record parameter
  assert.match(code, /const insertSql = \(t(?:: [^,]+)?, verb(?:: string)? = 'INSERT'\)(?:: string)? =>/);
  assert.match(code, /h\.cached\(t\.name, insertSql\(t, t\.upsert \? 'INSERT OR REPLACE' : 'INSERT'\)\)/, 'the build prepares its INSERT through insertSql');
  // the INSERT template itself, exactly: each interpolation in its own place (a swap such as columnList for placeholders passes the scan above)
  assert.equal(code.split('`${verb} INTO ${t.name}(${t.columnList}) VALUES(${t.placeholders})`').length - 1, 1, 'insertSql builds exactly `VERB INTO name(columns) VALUES(placeholders)`');
});

test('(f) runtime: every table spec lists its schema columns plus extra, in order, with one placeholder per column', async () => {
  const { TABLES } = await import('../src/db.ts');
  assert.equal(TABLES.size, 16); // the eight tables of format 1, the seven of the graph files and `obs` (the observation cache)
  for (const t of TABLES.values()) {
    if (t.name === 'obs') { assert.deepEqual([...t.columns], ['sys', 'xid', 'type', 'fields', 'links', 'fp', 'seen']); assert.equal(t.placeholders, '?,?,?,?,?,?,?,?'); continue; } // no schema file: the cache rows have their own checker (lib/graph/obs.ts)
    const schema = S.SCHEMAS[t.file] as { order: readonly string[] }; // every table file is a SCHEMAS key (db.ts reads the same map)
    assert.deepEqual([...t.columns], [...schema.order], t.name);
    const all = [...schema.order, 'extra'];
    assert.equal(t.columnList, all.map((c) => `"${c}"`).join(','), t.name); // every column name is double-quoted (from and to are SQL keywords)
    assert.equal(t.placeholders, all.map(() => '?').join(','), t.name);
  }
});
