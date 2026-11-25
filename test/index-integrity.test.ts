// Index content integrity: `brain build` stores a sha256 digest of every table of plangraph.sqlite (canonical row order) in index_meta, and
// openIndex verifies it, so a row edited directly inside the sqlite file is refused (DATA, exit 2, hint `brain build`) instead of being
// served. The legitimate index writers (whatif --write, schedule-load, export's fingerprint stamp) re-stamp the digest.
// NOT covered: a deliberate forger who recomputes the digest after editing (the digest is unkeyed; docs/CONTRACT.md says so).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { buildIndex, openIndex, INDEX_FILE, CONTENT_KEY, TABLES } from '../src/db.ts';
import { BrainError } from '../src/errors.ts';

const BRAIN = path.join(import.meta.dirname, '../bin/brain');
const tmps: string[] = [];
after(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });
const jl = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const run = (cwd: string, args: string[]) => spawnSync(process.execPath, [BRAIN, ...args], { cwd, encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_DATA: path.join(cwd, '.data') } });

// A repo whose eight index sources each hold at least one row, so every table can be tampered with.
function repo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-integrity-')); tmps.push(d);
  execFileSync('git', ['init', '-q'], { cwd: d });
  assert.equal(run(d, ['init']).status, 0);
  const b = path.join(d, '.plangraph');
  const put = (f: string, rows: object[]) => fs.writeFileSync(path.join(b, f), jl(rows));
  put('tickets.jsonl', [{ key: 'T-1', summary: 'one', sp: 3, v2_owner: 'Ana', v2_sprint: 1 }, { key: 'T-2', summary: 'two', sp: 2, v2_owner: 'Ana', v2_sprint: 1 }]);
  put('edges.jsonl', [{ consumer: 'T-2', producer: 'T-1', kind: 'plan_need' }]);
  put('schedule.jsonl', [{ version: 'current', key: 'T-1', owner: 'Ana', sprint: 1 }, { version: 'current', key: 'T-2', owner: 'Ana', sprint: 1 }]);
  put('evidence.jsonl', [{ key: 'T-1', source: 'audit', verdict: 'READY' }]);
  put('findings.jsonl', [{ key: 'T-1', kind: 'risk', text: 'a risk' }]);
  put('meta.jsonl', [{ k: 'plan', v: 'one' }]);
  put('learnings.jsonl', [{ id: 'L-1', kind: 'rule', topic: 'x', text: 'a rule' }]);
  put('refs.jsonl', [{ key: 'T-1', plans: [], files: {} }]);
  assert.equal(run(d, ['build']).status, 0);
  return { d, b, file: path.join(b, INDEX_FILE) };
}
const edit = (file: string, sql: string) => { const db = new DatabaseSync(file); try { db.exec(sql); } finally { db.close(); } };
// One direct edit per table (the column is a TEXT column of that table; the row exists).
const EDITS = {
  ticket: "UPDATE ticket SET summary='forged' WHERE key='T-1'",
  schedule: "UPDATE schedule SET sprint=9 WHERE key='T-2'",
  edge: "UPDATE edge SET kind='forged'",
  evidence: "UPDATE evidence SET verdict='forged'",
  finding: "UPDATE finding SET text='forged'",
  meta: "UPDATE meta SET v='forged'",
  learning: "UPDATE learning SET text='forged'",
  ref: "UPDATE ref SET fp_files='forged'",
  index_meta: "UPDATE index_meta SET v='0000' WHERE k='source_fingerprint'",
};

test('every table has a direct-edit case', () => {
  for (const t of TABLES.keys()) assert.ok(Object.hasOwn(EDITS, t), t);
});

for (const [table, sql] of Object.entries(EDITS)) {
  test(`a direct UPDATE of ${table} inside plangraph.sqlite is refused on open (DATA, brain build hint), by the CLI (exit 2) and the hook (silent)`, () => {
    const { d, b, file } = repo();
    { using h = openIndex(file, { dir: b }); assert.equal(h.stale, false); }
    edit(file, sql);
    for (const opts of [{ dir: b }, {}, { readOnly: false }]) {
      assert.throws(() => openIndex(file, opts), (e) => e instanceof BrainError && e.code === 'DATA'
        && e.message === 'the index content does not match its integrity digest (it was edited outside brain)' && e.hint === 'run `brain build` to rebuild it', JSON.stringify(opts));
    }
    const r = run(d, ['ticket', 'T-1']);
    assert.equal(r.status, 2, r.stdout);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, 'error: the index content does not match its integrity digest (it was edited outside brain)\ntry: brain build\n');
    const hook = run(d, ['card', '--if-present']);
    assert.deepEqual([hook.status, hook.stdout], [0, '']);
    assert.equal(run(d, ['build']).status, 0); // the text is the truth: a rebuild repairs it
    assert.equal(run(d, ['ticket', 'T-1']).status, 0);
  });
}

test('a deleted row, an inserted row and a changed INTEGER column are refused too', () => {
  for (const sql of ["DELETE FROM learning WHERE id='L-1'", "INSERT INTO finding(key,kind,text) VALUES('T-2','risk','planted')", "UPDATE ticket SET sp=4 WHERE key='T-1'", "UPDATE ticket SET sp='three' WHERE key='T-1'"]) {
    const { b, file } = repo();
    edit(file, sql);
    assert.throws(() => openIndex(file, { dir: b }), (e) => e instanceof BrainError && e.code === 'DATA', sql);
  }
});

test('the digest is stored at build under index_meta content_digest and is independent of physical row order (VACUUM keeps it)', () => {
  const { b, file } = repo();
  const r = buildIndex({ dir: b });
  const db = new DatabaseSync(file);
  const v = db.prepare('SELECT v FROM index_meta WHERE k=?').get(CONTENT_KEY)?.v;
  db.exec('VACUUM'); db.close();
  assert.match(String(v), /^[0-9a-f]{64}$/);
  assert.equal(r.digest, v);
  using h = openIndex(file, { dir: b });
  assert.equal(h.stale, false);
});

test('an index without a digest (an older build) is flagged stale and query-only, and index writes refuse it', () => {
  const { d, b, file } = repo();
  edit(file, `DELETE FROM index_meta WHERE k='${CONTENT_KEY}'`);
  { using h = openIndex(file, { dir: b }); assert.equal(h.stale, true); assert.equal((h.get('PRAGMA query_only') as { query_only: unknown }).query_only, 1); } // the pragma returns one row
  assert.throws(() => openIndex(file, { readOnly: false }), (e) => e instanceof BrainError && e.code === 'DATA' && /no integrity digest/.test(e.message));
  const r = run(d, ['ticket', 'T-1']);
  assert.equal(r.status, 0); assert.match(r.stderr, /STALE/);
});

test('legitimate index writes re-stamp the digest: whatif --write, schedule-load and export leave a verifiable index', () => {
  const { d, b, file } = repo();
  let r = run(d, ['whatif', 'T-2', '--sprint', '2', '--write', '--apply-plan']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  { using h = openIndex(file, { dir: b }); assert.equal((h.get("SELECT sprint FROM schedule WHERE key='T-2' AND version='current'") as { sprint: unknown }).sprint, 2); } // T-2 is scheduled in the fixture
  fs.writeFileSync(path.join(d, 's.json'), JSON.stringify([{ item: 'T-1', owner: 'Ana', sprint: 1 }, { item: 'T-2', owner: 'Ana', sprint: 3 }]));
  r = run(d, ['schedule-load', 's.json', 'old']); assert.equal(r.status, 0, r.stderr);
  { using h = openIndex(file, { dir: b }); assert.equal(h.stale, false); }
  r = run(d, ['export']); assert.equal(r.status, 0, r.stderr);
  { using h = openIndex(file, { dir: b }); assert.equal(h.stale, false); }
  assert.equal(run(d, ['ticket', 'T-2']).status, 0);
});

test('cost: the digest of a 1,400-ticket index is computed in well under the open budget (full digest, no sampling)', async () => {
  const { budget } = await import('./helpers/perf.ts');
  const { contentDigest } = await import('../src/db.ts');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-integrity-')); tmps.push(d);
  const b = path.join(d, '.plangraph'); fs.mkdirSync(b);
  const t = [], sc = [], e = [];
  for (let i = 0; i < 1400; i++) {
    t.push({ key: `T-${i}`, summary: `ticket ${i}`, sp: 1 + (i % 5), v2_owner: 'Ana', v2_sprint: 1 + (i % 30) });
    sc.push({ version: 'current', key: `T-${i}`, owner: 'Ana', sprint: 1 + (i % 30) });
    if (i) e.push({ consumer: `T-${i}`, producer: `T-${(i * 7919) % i}`, kind: 'plan_need' });
  }
  fs.writeFileSync(path.join(b, 'tickets.jsonl'), jl(t)); fs.writeFileSync(path.join(b, 'schedule.jsonl'), jl(sc)); fs.writeFileSync(path.join(b, 'edges.jsonl'), jl(e));
  const r = buildIndex({ dir: b });
  using h = openIndex(r.file, { dir: b });
  let best = Infinity;
  for (let k = 0; k < 3; k++) { const t0 = performance.now(); assert.equal(contentDigest(h), r.digest); best = Math.min(best, performance.now() - t0); }
  assert.ok(best < budget(150), `digest took ${best.toFixed(1)} ms`); // measured about 5 ms on the dev machine
});
