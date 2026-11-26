// bin/plangraph-solve input guards (load_raw), as Python unit checks (stdlib only: no OR-Tools needed). The solver reads the same index and data
// files as the CLI, so it gets the same guards: the index is opened READ-ONLY (URI mode=ro, query_only), only when it is a regular file with
// no SQLite sidecar beside it (a hot journal would be replayed by a read-write open), its sqlite_master must pass the same schema allowlist as
// src/db.ts schemaOk (the two lists are compared here), and its content digest must match (same canonical rows as contentDigest). JSONL and
// config files are read through one capped reader: lstat (a symlink is refused), open O_NOFOLLOW|O_NONBLOCK (a FIFO never blocks), fstat must
// be a regular file with the lstat's device, inode and ctime, at most 64 MiB.
// Covered: a planted VIEW over an infinite WITH RECURSIVE (used to hang the solver), a tampered row, a sidecar, a FIFO index, a FIFO, a
// symlink and an oversize JSONL file, a symlinked config.json, and that a legitimate index loads with the digest the CLI stored.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { TABLES, SIDECARS, EXPECTED_COLUMNS, EXPECTED_INDEXES, INDEX_FILE } from '../src/db.ts';
import { G_LINKS_SQL, G_NODES_SQL } from '../lib/graph/views.ts';

const BRAIN = path.join(import.meta.dirname, '../bin/plangraph');
const SOLVE = path.join(import.meta.dirname, '../bin/plangraph-solve');
const FROZEN = path.join(import.meta.dirname, 'fixtures/release-0.3.0');
const tmps: string[] = [];
after(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });
const HAVE_PY3 = spawnSync('python3', ['--version'], { stdio: 'ignore' }).status === 0;
const SKIP = HAVE_PY3 ? false : 'skipped: no python3';
const HAVE_MKFIFO = process.platform !== 'win32' && spawnSync('mkfifo', ['--help'], { stdio: 'ignore' }).error === undefined;
const jl = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

// Load bin/plangraph-solve as a module and run `body`; it prints one JSON line. A hard kill timer far above the asserted bound.
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
const py = (cwd: string, body: string, ...args: string[]) => {
  const t0 = Date.now();
  const r = spawnSync('python3', ['-I', '-c', HEAD + body, SOLVE, ...args], { encoding: 'utf8', cwd, timeout: 15000 });
  const ms = Date.now() - t0;
  assert.ok(ms < 5000, `python took ${ms} ms (signal ${r.signal}): ${r.stderr.slice(0, 300)}`);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop() as string); // split gives at least one element
};

function repo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-solve-in-')); tmps.push(d);
  execFileSync('git', ['init', '-q'], { cwd: d });
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: path.join(d, '.git', 'plangraph-data') }; // private data dir: never the real HOME
  assert.equal(spawnSync(process.execPath, [BRAIN, 'init'], { cwd: d, encoding: 'utf8', env }).status, 0);
  const b = path.join(d, '.plangraph');
  fs.writeFileSync(path.join(b, 'tickets.jsonl'), jl([{ key: 'T-1', summary: 'one', sp: 1.5, v2_owner: 'Ana', v2_sprint: 1 }, { key: 'T-2', summary: 'two x', sp: 2, v2_owner: 'Ana', v2_sprint: 1 }]));
  fs.writeFileSync(path.join(b, 'edges.jsonl'), jl([{ consumer: 'T-2', producer: 'T-1', kind: 'plan_need' }]));
  fs.writeFileSync(path.join(b, 'schedule.jsonl'), jl([{ version: 'current', key: 'T-1', owner: 'Ana', sprint: 1 }, { version: 'current', key: 'T-2', owner: 'Ana', sprint: 2 }]));
  fs.writeFileSync(path.join(b, 'learnings.jsonl'), '');
  const bl = spawnSync(process.execPath, [BRAIN, 'build'], { cwd: d, encoding: 'utf8', env }); assert.equal(bl.status, 0, bl.stderr);
  return { d, b, env, db: path.join(b, INDEX_FILE), cfg: path.join(b, 'config.json') };
}
const fromDb = (r: { db: string; cfg: string }) => `print(json.dumps(load(db=${JSON.stringify(r.db)}, config=${JSON.stringify(r.cfg)})))`;
const fromDir = (r: { b: string }) => `print(json.dumps(load(jsonl_dir=${JSON.stringify(r.b)})))`;

test('the Python schema allowlist, table order and sidecar list are the same as src/db.ts', { skip: SKIP }, () => {
  const r = spawnSync('python3', ['-I', '-c', `${HEAD}
print(json.dumps({'cols': m.EXPECTED_COLUMNS, 'idx': m.EXPECTED_INDEXES, 'order': [[t, m.index_order(t)] for t in m.INDEX_TABLES], 'side': list(m.SIDECARS), 'views': m.GRAPH_VIEWS, 'v1': list(m.V1_TABLES)}))`, SOLVE], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout);
  assert.deepEqual(got.cols, Object.fromEntries(EXPECTED_COLUMNS));
  assert.deepEqual(got.idx, Object.fromEntries(EXPECTED_INDEXES));
  assert.deepEqual(got.order, [...TABLES.values()].map((t) => [t.name, t.order]));
  assert.deepEqual(got.side, [...SIDECARS]);
  assert.deepEqual(got.views, { g_nodes: G_NODES_SQL, g_links: G_LINKS_SQL }, 'the Python view SQL equals src/db.ts');
  assert.deepEqual(got.v1, [...TABLES.keys()].slice(0, 8), 'the 0.3.0 table list');
});

test('the solver loads an index built by this tree with graph files present (seven graph tables, two views, digest verified)', { skip: SKIP }, () => {
  const r = repo();
  fs.writeFileSync(path.join(r.b, 'people.jsonl'), jl([{ id: 'Ana', active: true }]));
  fs.writeFileSync(path.join(r.b, 'repos.jsonl'), jl([{ id: 'repo:web', cmds: { test: 't' }, owners: ['Ana'] }]));
  fs.writeFileSync(path.join(r.b, 'links.jsonl'), jl([{ from: 'T-1', from_type: 'ticket', rel: 'relates_to', to: 'repo:web', to_type: 'repo', attrs: { why: 'x' } }, { from: 'pr-1', from_type: 'x-github.pr', rel: 'x-github/closes', to: 'T-2', to_type: 'ticket' }]));
  fs.writeFileSync(path.join(r.b, 'xrefs.jsonl'), jl([{ type: 'ticket', id: 'T-1', sys: 'jira:acme', xid: 'ABC-1' }]));
  fs.writeFileSync(path.join(r.b, 'capacity.jsonl'), jl([{ person: 'Ana', sprint: 1, sp: 2.5 }]));
  const bl = spawnSync(process.execPath, [BRAIN, 'build'], { cwd: r.d, encoding: 'utf8', env: r.env }); assert.equal(bl.status, 0, bl.stderr);
  assert.deepEqual(py(r.d, fromDb(r)), { ok: true, tickets: ['T-1', 'T-2'], edges: 1 });
});

test('the solver refuses an index built by the frozen 0.3.0 tree with the older-plangraph message, not the tampering message', { skip: SKIP }, () => {
  const r = repo();
  const old = spawnSync(process.execPath, [path.join(FROZEN, 'bin/plangraph'), 'build'], { cwd: r.d, encoding: 'utf8', env: r.env }); assert.equal(old.status, 0, old.stderr);
  assert.deepEqual(py(r.d, fromDb(r)), { ok: false, status: 'MODEL_INVALID', msg: 'the index was built by an older plangraph: run `plangraph build`', code: 2 });
  assert.equal(spawnSync(process.execPath, [BRAIN, 'build'], { cwd: r.d, encoding: 'utf8', env: r.env }).status, 0);
  assert.equal(py(r.d, fromDb(r)).ok, true);
});

test('a planted g_links with a different body, a planted g_nodes, an extra view, a trigger and a dropped view are each refused by the solver', { skip: SKIP }, () => {
  const refuse = { ok: false, status: 'MODEL_INVALID', msg: 'the index has an unexpected schema (not built by plangraph build): run `plangraph build`', code: 2 };
  for (const sql of [
    "DROP VIEW g_links; CREATE VIEW g_links(src, src_type, rel, dst, dst_type, version, kind) AS SELECT 'T-2', 'ticket', 'needs', 'T-1', 'ticket', NULL, NULL",
    "DROP VIEW g_nodes; CREATE VIEW g_nodes(id, type) AS SELECT 'T-1', 'ticket'",
    'CREATE VIEW extra_v AS SELECT 1 x',
    'CREATE TRIGGER trg AFTER INSERT ON meta BEGIN SELECT 1; END',
    'DROP VIEW g_nodes',
  ]) {
    const r = repo();
    { const h = new DatabaseSync(r.db); h.exec(sql); h.close(); }
    assert.deepEqual(py(r.d, fromDb(r)), refuse, sql);
  }
});

test('a legitimate index loads read-only (digest verified like the CLI) and is left byte-identical with no sidecar', { skip: SKIP }, () => {
  const r = repo(); const before = fs.readFileSync(r.db);
  assert.deepEqual(py(r.d, fromDb(r)), { ok: true, tickets: ['T-1', 'T-2'], edges: 1 });
  assert.deepEqual(py(r.d, fromDir(r)), { ok: true, tickets: ['T-1', 'T-2'], edges: 1 });
  assert.deepEqual(fs.readFileSync(r.db), before);
  assert.deepEqual(fs.readdirSync(r.b).filter((f) => SIDECARS.some((s) => f.endsWith(s))), []);
});

test('a planted VIEW over an infinite WITH RECURSIVE is refused by the schema check before any query (it used to hang the solver)', { skip: SKIP }, () => {
  const r = repo();
  { const h = new DatabaseSync(r.db); h.exec("DROP TABLE edge; CREATE VIEW edge(consumer, producer, kind, note, extra) AS WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n) SELECT 'T-2', 'T-1', '', NULL, NULL FROM n"); h.close(); }
  assert.deepEqual(py(r.d, fromDb(r)), { ok: false, status: 'MODEL_INVALID', msg: 'the index has an unexpected schema (not built by plangraph build): run `plangraph build`', code: 2 });
});

test('a row edited inside the index is refused (content digest mismatch)', { skip: SKIP }, () => {
  const r = repo();
  { const h = new DatabaseSync(r.db); h.exec("UPDATE schedule SET sprint = 9 WHERE key = 'T-2'"); h.close(); }
  assert.deepEqual(py(r.d, fromDb(r)), { ok: false, status: 'MODEL_INVALID', msg: 'the index content does not match its integrity digest (it was edited outside plangraph): run `plangraph build`', code: 2 });
  { const h = new DatabaseSync(r.db); h.exec("DELETE FROM index_meta WHERE k = 'content_digest'"); h.close(); }
  assert.deepEqual(py(r.d, fromDb(r)), { ok: false, status: 'MODEL_INVALID', msg: 'the index has no integrity digest (built by an older plangraph): run `plangraph build`', code: 2 });
});

test('a sidecar beside the index is refused and never replayed', { skip: SKIP }, () => {
  for (const s of SIDECARS) {
    const r = repo(); fs.writeFileSync(`${r.db}${s}`, 'x'); const before = fs.readFileSync(r.db);
    assert.deepEqual(py(r.d, fromDb(r)), { ok: false, status: 'MODEL_INVALID', msg: `the index has a SQLite journal file beside it (${INDEX_FILE}${s}); it is never replayed: run \`plangraph build\``, code: 2 });
    assert.deepEqual(fs.readFileSync(r.db), before); assert.equal(fs.readFileSync(`${r.db}${s}`, 'utf8'), 'x');
  }
});

test('a FIFO index and a FIFO JSONL file are refused at once (no blocking open)', { skip: SKIP || (HAVE_MKFIFO ? false : 'skipped: no mkfifo') }, () => {
  const r = repo(); fs.rmSync(r.db); execFileSync('mkfifo', [r.db]);
  assert.deepEqual(py(r.d, fromDb(r)), { ok: false, status: 'MODEL_INVALID', msg: 'the index is not a regular file: run `plangraph build`', code: 2 });
  fs.rmSync(path.join(r.b, 'edges.jsonl')); execFileSync('mkfifo', [path.join(r.b, 'edges.jsonl')]);
  assert.deepEqual(py(r.d, fromDir(r)), { ok: false, status: 'MODEL_INVALID', msg: 'edges.jsonl: not a regular file', code: 2 });
});

test('a symlinked index, JSONL file or default config.json is refused; an oversize JSONL file is refused at the cap', { skip: SKIP || (process.platform === 'win32' ? 'symlinks' : false) }, () => {
  const r = repo(), outside = fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-solve-out-')); tmps.push(outside);
  fs.writeFileSync(path.join(outside, 'secret.jsonl'), jl([{ key: 'SECRET-1', summary: 'outside', sp: 1 }]));
  fs.renameSync(path.join(r.b, 'tickets.jsonl'), path.join(outside, 't.jsonl'));
  fs.symlinkSync(path.join(outside, 'secret.jsonl'), path.join(r.b, 'tickets.jsonl'));
  assert.deepEqual(py(r.d, fromDir(r)), { ok: false, status: 'MODEL_INVALID', msg: 'tickets.jsonl: is a symlink, not a regular file', code: 2 });
  fs.rmSync(path.join(r.b, 'tickets.jsonl')); fs.renameSync(path.join(outside, 't.jsonl'), path.join(r.b, 'tickets.jsonl'));
  fs.renameSync(r.cfg, path.join(outside, 'config.json')); fs.symlinkSync(path.join(outside, 'config.json'), r.cfg);
  assert.deepEqual(py(r.d, fromDir(r)), { ok: false, status: 'MODEL_INVALID', msg: 'config.json: is a symlink, not a regular file', code: 2 });
  fs.rmSync(r.cfg); fs.renameSync(path.join(outside, 'config.json'), r.cfg);
  fs.renameSync(r.db, path.join(outside, 'i.sqlite')); fs.symlinkSync(path.join(outside, 'i.sqlite'), r.db);
  assert.deepEqual(py(r.d, fromDb(r)), { ok: false, status: 'MODEL_INVALID', msg: 'the index is a symlink, not a regular file: run `plangraph build`', code: 2 });
  // the cap, lowered for the test (64 MiB in production): one byte over is refused before parsing
  const big = py(r.d, `m.DATA_CAP = 40\nprint(json.dumps(load(jsonl_dir=${JSON.stringify(r.b)})))`);
  assert.deepEqual(big, { ok: false, status: 'MODEL_INVALID', msg: 'tickets.jsonl: file too large (limit 40 bytes)', code: 2 });
});

// A done sp: task is closed history for the solver (frozen, never moved): load_raw must hand its impl_status over in index mode too, as it does
// in --jsonl-dir mode (the merge of the frozen-history work and the input-guard work once dropped the column from the index SELECT).
test('index mode keeps impl_status, so a done sp: task is closed history for the solver', { skip: SKIP }, () => {
  const r = repo();
  fs.writeFileSync(path.join(r.b, 'tickets.jsonl'), jl([
    { key: 'T-1', summary: 'one', sp: 1, v2_owner: 'Ana', v2_sprint: 1 },
    { key: 'sp:plan/1', summary: 'a task', sp: 1, v2_owner: 'Ana', v2_sprint: 1, impl_status: 'done' },
  ]));
  fs.writeFileSync(path.join(r.b, 'edges.jsonl'), '');
  fs.writeFileSync(path.join(r.b, 'schedule.jsonl'), jl([{ version: 'current', key: 'T-1', owner: 'Ana', sprint: 1 }, { version: 'current', key: 'sp:plan/1', owner: 'Ana', sprint: 1 }]));
  const bl = spawnSync(process.execPath, [BRAIN, 'build'], { cwd: r.d, encoding: 'utf8', env: r.env }); assert.equal(bl.status, 0, bl.stderr);
  const body = `a = types.SimpleNamespace(jsonl_dir=None, config=${JSON.stringify(r.cfg)}, db=${JSON.stringify(r.db)})
t, e, s, c = m.load_raw(a)
print(json.dumps({x['key']: x.get('impl_status') for x in t}))`;
  assert.deepEqual(py(r.d, body), { 'T-1': null, 'sp:plan/1': 'done' });
});
