// Task 30: `brain build` keeps unknown record fields (in the `extra` column) and never takes SQL identifiers from data.
// NOT covered: learnings/refs are never rewritten from the index (export writes only FILES), so their `extra` is checked in the index only.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import * as S from '../lib/store.mjs';
import { budget } from './helpers/perf.mjs';

const BRAIN = path.join(import.meta.dirname, '../bin/brain');
const tmps = [];
after(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });
function repo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-extra-'));
  tmps.push(d);
  execFileSync('git', ['init', '-q'], { cwd: d });
  run(d, 'init');
  return d;
}
const run = (cwd, ...args) => execFileSync('node', [BRAIN, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const bdir = (d) => path.join(d, '.brain');
const put = (d, f, recs) => fs.writeFileSync(path.join(bdir(d), f), recs.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n');
const canonTickets = (recs) => S.canonFile(recs, S.SCHEMAS['tickets.jsonl']);
const tk = (key, more = {}) => ({ key, summary: 's' + key, epic: 'E', sp: 3, jira_status: 'To Do', v2_owner: 'Ana', v2_sprint: 1, verdict: 'READY', verdict_source: 'a', first_verdict: 'READY', ...more });
const count = (d, t) => { const db = new DatabaseSync(path.join(bdir(d), 'brain.sqlite'), { readOnly: true }); try { return db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c; } finally { db.close(); } };

test('(a) unknown scalar, object and array fields build and round-trip byte-stable', () => {
  const d = repo();
  const recs = [tk('T-1', { zeta: 'z', alpha: { b: 2, a: [1, { y: 1, x: null }] }, list: [3, 1, 2], flag: true, nothing: null }), tk('T-2')];
  const text = canonTickets(recs);
  fs.writeFileSync(path.join(bdir(d), 'tickets.jsonl'), text);
  run(d, 'build'); run(d, 'export');
  const first = fs.readFileSync(path.join(bdir(d), 'tickets.jsonl'), 'utf8');
  assert.equal(first, text);
  run(d, 'build'); run(d, 'export');
  assert.equal(fs.readFileSync(path.join(bdir(d), 'tickets.jsonl'), 'utf8'), first);
  const db = new DatabaseSync(path.join(bdir(d), 'brain.sqlite'), { readOnly: true });
  const x = db.prepare("SELECT key, extra FROM ticket ORDER BY key").all();
  db.close();
  assert.equal(x[0].extra, '{"alpha":{"a":[1,{"x":null,"y":1}],"b":2},"flag":true,"list":[3,1,2],"nothing":null,"zeta":"z"}');
  assert.equal(x[1].extra, null);
});

test('(b) record keys containing SQL never reach a statement; the odd key round-trips as an unknown field', () => {
  const d = repo();
  put(d, 'edges.jsonl', [{ consumer: 'T-2', producer: 'T-1', kind: 'plan_need', note: '' }]);
  const evil = 'summary) VALUES(1,2); DROP TABLE ticket;--';
  const recs = [tk('T-1', { [evil]: 'x', "a'b": 1, '': 'empty', 'x y': 2 }), tk('T-2')];
  const text = canonTickets(recs);
  fs.writeFileSync(path.join(bdir(d), 'tickets.jsonl'), text);
  run(d, 'build');
  assert.equal(count(d, 'ticket'), 2);
  assert.equal(count(d, 'edge'), 1);
  assert.equal(count(d, 'schedule'), 0);
  run(d, 'export');
  assert.equal(fs.readFileSync(path.join(bdir(d), 'tickets.jsonl'), 'utf8'), text);
  assert.ok(text.includes('DROP TABLE'));
});

test('(b2) prototype keys and a field literally named extra survive as unknown fields', () => {
  const d = repo();
  const line = '{"key":"T-1","summary":"s","constructor":{"a":1},"extra":"mine","__proto__":{"polluted":true},"toString":5}';
  fs.writeFileSync(path.join(bdir(d), 'tickets.jsonl'), line + '\n');
  run(d, 'build'); run(d, 'export');
  const out = fs.readFileSync(path.join(bdir(d), 'tickets.jsonl'), 'utf8');
  for (const frag of ['"__proto__":{"polluted":true}', '"constructor":{"a":1}', '"extra":"mine"', '"toString":5']) assert.ok(out.includes(frag), frag + ' in ' + out);
  assert.equal({}.polluted, undefined);
  run(d, 'build'); run(d, 'export');
  assert.equal(fs.readFileSync(path.join(bdir(d), 'tickets.jsonl'), 'utf8'), out);
});

test('(c) a legacy file with only known fields exports byte-identical to its canonical form (no extra noise)', () => {
  const d = repo();
  const recs = [tk('T-2'), tk('T-1', { impl_status: 'done' })];
  const text = canonTickets(recs);
  fs.writeFileSync(path.join(bdir(d), 'tickets.jsonl'), text);
  put(d, 'schedule.jsonl', [{ version: 'current', key: 'T-1', owner: 'Ana', sprint: 1 }]);
  put(d, 'meta.jsonl', [{ k: 'a', v: 'b' }]);
  const sched = fs.readFileSync(path.join(bdir(d), 'schedule.jsonl'), 'utf8');
  const meta = fs.readFileSync(path.join(bdir(d), 'meta.jsonl'), 'utf8');
  run(d, 'build'); run(d, 'export');
  assert.equal(fs.readFileSync(path.join(bdir(d), 'tickets.jsonl'), 'utf8'), text);
  assert.ok(!text.includes('extra'));
  assert.equal(fs.readFileSync(path.join(bdir(d), 'schedule.jsonl'), 'utf8'), sched);
  assert.equal(fs.readFileSync(path.join(bdir(d), 'meta.jsonl'), 'utf8'), meta);
});

test('(d) a known text field with an object value is a data error (security review M3); other tables keep unknown fields', () => {
  const d = repo();
  put(d, 'tickets.jsonl', [tk('T-1', { summary: { not: 'a string' } })]);
  const bad = spawnSync(process.execPath, [BRAIN, 'build'], { cwd: d, encoding: 'utf8', env: { ...process.env, BRAIN_DIR: '' } });
  assert.equal(bad.status, 2); assert.equal(bad.stderr, 'error: tickets.jsonl:1: "summary" must be a string or a number\ntry: brain doctor\n');
  put(d, 'tickets.jsonl', [tk('T-1')]);
  put(d, 'edges.jsonl', [{ consumer: 'T-2', producer: 'T-1', kind: 'plan_need', note: '', weight: 2 }]);
  put(d, 'findings.jsonl', [{ key: 'T-1', kind: 'risk', text: 't', sev: { n: 1 } }]);
  put(d, 'evidence.jsonl', [{ key: 'T-1', source: 's', verdict: 'READY', resolution: '', needs: '', conf: 0.5 }]);
  run(d, 'build');
  const db = new DatabaseSync(path.join(bdir(d), 'brain.sqlite'), { readOnly: true });
  assert.equal(db.prepare('SELECT summary FROM ticket').get().summary, 'sT-1');
  assert.equal(db.prepare('SELECT extra FROM ticket').get().extra, null);
  assert.equal(db.prepare('SELECT extra FROM edge').get().extra, '{"weight":2}');
  assert.equal(db.prepare('SELECT extra FROM finding').get().extra, '{"sev":{"n":1}}');
  assert.equal(db.prepare('SELECT extra FROM evidence').get().extra, '{"conf":0.5}');
  db.close();
  const before = ['edges', 'findings', 'evidence'].map((f) => fs.readFileSync(path.join(bdir(d), f + '.jsonl'), 'utf8'));
  run(d, 'export');
  for (const f of ['edges', 'findings', 'evidence']) assert.ok(fs.readFileSync(path.join(bdir(d), f + '.jsonl'), 'utf8').includes(f === 'edges' ? '"weight":2' : f === 'findings' ? '"sev":{"n":1}' : '"conf":0.5'));
  assert.equal(before.length, 3);
});

test('(d2) learnings and refs keep unknown fields in the index extra column', () => {
  const d = repo();
  put(d, 'learnings.jsonl', [{ id: 'L1', kind: 'rule', topic: 't', text: 'x', why: 'w', source: 's', tag: ['a'] }, { id: 'L2', kind: 'rule', topic: 't', text: 'y' }]);
  put(d, 'refs.jsonl', [{ key: 'T-1', plans: [], files: {}, fp_files: '', jira_updated: '', audited_at: '', note: 'n' }]);
  run(d, 'build');
  const db = new DatabaseSync(path.join(bdir(d), 'brain.sqlite'), { readOnly: true });
  assert.equal(db.prepare("SELECT extra FROM learning WHERE id='L1'").get().extra, '{"tag":["a"]}');
  assert.equal(db.prepare("SELECT extra FROM learning WHERE id='L2'").get().extra, null);
  assert.equal(db.prepare('SELECT extra FROM ref').get().extra, '{"note":"n"}');
  db.close();
});

test('(e) 100k ticket records build quickly', () => {
  const d = repo();
  // build N records, min of `reps` runs; returns ms. Relative check (N vs 4N must stay near-linear) plus a load-scaled absolute ceiling.
  const timeBuild = (n, reps) => {
    const lines = [];
    for (let i = 0; i < n; i++) lines.push(JSON.stringify(tk('K-' + i, i % 10 === 0 ? { extra_x: i } : {})));
    fs.writeFileSync(path.join(bdir(d), 'tickets.jsonl'), lines.join('\n') + '\n');
    let best = Infinity;
    for (let k = 0; k < reps; k++) { const t0 = performance.now(); run(d, 'build'); best = Math.min(best, performance.now() - t0); }
    assert.equal(count(d, 'ticket'), n);
    return best;
  };
  const small = timeBuild(25000, 3), large = timeBuild(100000, 3);
  // linear => about 4x (node start-up only lowers it), quadratic => about 16x; prepared-once statements, no per-record prepare.
  assert.ok(large / small < 9, `build is not linear: 25k took ${small.toFixed(0)} ms, 100k took ${large.toFixed(0)} ms`);
  assert.ok(large < budget(30000), `build took ${large} ms`); // about 3.5 s alone since the index digest (it was about 1 s before); the n-vs-4n ratio above is the linearity check, this ceiling only catches a hang
});

test('(f) source scan: the INSERT column lists come from constants, never from record keys', () => {
  // `brain build` is src/db.mjs buildIndex (bin/brain only dispatches to src/cli.mjs).
  const code = fs.readFileSync(path.join(import.meta.dirname, '../src/db.mjs'), 'utf8');
  assert.match(code, /const columns = Object\.freeze\(\[\.\.\.SCHEMAS\[file\]\.order\]\)/, 'columns come from the frozen SCHEMAS lists');
  assert.ok(!/Object\.keys\(r(ec)?\)\s*\.(map|join)|\bcols\b/.test(code), 'no per-record column list');
  // every template literal that builds SQL may interpolate only the table name, the verb, or the constant column list / placeholders
  const sqlTemplates = [...code.matchAll(/`([^`]*\b(INSERT|SELECT|CREATE)\b[^`]*)`/g)];
  assert.ok(sqlTemplates.length >= 2);
  for (const m of sqlTemplates) for (const i of m[1].matchAll(/\$\{([^}]*)\}/g)) {
    assert.match(i[1].trim(), /^(t\.name|t\.columnList|t\.placeholders|t\.ddl|t\.order|verb)$/, 'interpolation: ' + i[1]);
  }
  // insertSql takes only a table spec and a verb: no record parameter
  assert.match(code, /const insertSql = \(t, verb = 'INSERT'\) =>/);
  assert.match(code, /h\.cached\(t\.name, insertSql\(t, t\.upsert \? 'INSERT OR REPLACE' : 'INSERT'\)\)/, 'the build prepares its INSERT through insertSql');
});
