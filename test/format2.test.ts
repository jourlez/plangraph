// The requirement, decision and team node kinds (task 12): each round-trips through the .pg format and the store, the new relations are stored with the
// right class, a satisfies link to a missing requirement is DANGLING_LINK (node check) and LINK_MISSING_NODE (graph check), a requirement source is a repo
// path or <sys>:<xid> and never a URL, the index carries the advisory tables and the views, and a plan without the new kinds gives the same answers.
// NOT covered: the loader that feeds the libraries (test/extras.test.ts), the generic store check (test/store2-check.test.ts).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { openStore, type KINDS, kindFile } from '../lib/planstore.ts';
import type { Row } from '../lib/planstore.ts';
import { appendEvent } from '../lib/store2/batches.ts';
import { formatPg, parsePg } from '../lib/store2/pg.ts';
import { nodePath } from '../lib/store2/layout.ts';
import { checkStore } from '../lib/store2/check.ts';
import { CORE_NODE_TYPES, RELATIONS, REL_SEMANTICS } from '../lib/graph/files.ts';
import { nodeUri, parseNodeUri } from '../lib/graph/uri.ts';
import { sourceProblem, validators } from '../lib/schema.ts';
import { ADVISORY_TABLES, INDEX_FILE } from '../src/db.ts';

const BRAIN = path.join(import.meta.dirname, '../bin/plangraph');
const GIT = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
let BASE = '', n = 0;
const env = () => ({ PATH: process.env.PATH as string, HOME: path.join(BASE, 'home'), CLAUDE_PLUGIN_DATA: path.join(BASE, 'data'), LC_ALL: 'C', TZ: 'UTC', PLANGRAPH_DIR: '', ...GIT });
const run = (cwd: string, args: string[]) => spawnSync(process.execPath, [BRAIN, ...args], { cwd, env: env(), encoding: 'utf8', timeout: 60000 });
const tk = (key: string, more: Record<string, unknown> = {}) => ({ key, summary: key, epic: '', sp: 1, jira_status: 'To Do', verdict: 'READY', ...more });
before(() => { BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-format2-'))); for (const d of ['home', 'data']) fs.mkdirSync(path.join(BASE, d)); });
after(() => { if (BASE) fs.rmSync(BASE, { recursive: true, force: true }); });

const REQ: Row[] = [{ id: 'R-1', text: 'The system shall log in', kind: 'ears', status: 'accepted', source: 'docs/spec.md#login', acceptance: ['b second', 'a first'], priority: 'high' }, { id: 'R-2', source: 'confluence:12345', status: 'proposed' }];
const DEC: Row[] = [{ id: 'D-1', title: 'Use SQLite', status: 'accepted', date: '2026-02-03', affects: ['src/**', 'api'], source: 'docs/adr.md', derivation: 'human' }];
const TEAM: Row[] = [{ id: 'TEAM-1', name: 'core', members: ['Ben', 'Ana'], owns: ['api', 'web'] }];

/** A plan directory in a git repository with the given extra rows written through the store; returns the repo root. */
function plan(rows: Partial<Record<(typeof KINDS)[number], Row[]>> = {}, { build = true }: { build?: boolean } = {}): string {
  const d = path.join(BASE, `p-${n++}`); fs.mkdirSync(d); execFileSync('git', ['init', '-q'], { cwd: d, env: env() });
  assert.equal(run(d, ['init']).status, 0);
  const dir = path.join(d, '.plangraph'), st = openStore({ dir, root: d });
  st.writeKind('ticket', [tk('T-1'), tk('T-2')]);
  st.writeKind('edge', [{ consumer: 'T-2', producer: 'T-1', kind: 'plan_need' }]);
  st.writeKind('schedule', [{ version: 'current', key: 'T-1', owner: 'Ana', sprint: 1 }, { version: 'current', key: 'T-2', owner: 'Ben', sprint: 2 }]);
  st.writeKind('person', [{ id: 'Ana' }, { id: 'Ben' }]);
  st.writeKind('repo', [{ id: 'api' }]);
  for (const k of ['requirement', 'decision', 'team'] as const) if (rows[k]) st.writeKind(k, rows[k]);
  if (rows.link) st.writeKind('link', rows.link);
  if (build) assert.equal(run(d, ['build']).status, 0);
  return d;
}

test('each new kind round-trips: rows, the .pg text and the node check', () => {
  const d = plan({ requirement: REQ, decision: DEC, team: TEAM }, { build: false }), dir = path.join(d, '.plangraph'), st = openStore({ dir, root: d });
  for (const [k, rows] of [['requirement', REQ], ['decision', DEC], ['team', TEAM]] as const) {
    const back = st.readKind(k, { defaults: false });
    assert.equal(back.length, rows.length, k);
    for (const r of rows) {
      const got = back.find((b) => b.id === r.id) as Row;
      for (const [f, v] of Object.entries(r)) assert.deepEqual(got[f], Array.isArray(v) ? [...v].sort() : v, `${k} ${String(r.id)} ${f}`);
      const file = nodePath(dir, k, String(r.id)), text = fs.readFileSync(file, 'utf8'), parsed = parsePg(text, file);
      assert.ok('node' in parsed, `${k} parses`);
      assert.equal(formatPg((parsed as { node: { id: string } }).node), text, `${k} is canonical`);
    }
    assert.ok(fs.existsSync(path.join(dir, 'nodes', k)), `nodes/${k}/`);
  }
  assert.match(fs.readFileSync(nodePath(dir, 'requirement', 'R-1'), 'utf8'), /^acceptance "a first"\nacceptance "b second"$/m, 'one line per acceptance');
  assert.match(fs.readFileSync(nodePath(dir, 'team', 'TEAM-1'), 'utf8'), /^members "Ana"\nmembers "Ben"$/m);
  assert.deepEqual(checkStore(dir), []);
  assert.equal(kindFile('requirement'), 'requirements.jsonl');
});

test('the new relations are stored with the right class, and every node type has a URI', () => {
  for (const r of ['satisfies', 'affects', 'supersedes', 'member_of', 'alias_of']) assert.ok((RELATIONS as readonly string[]).includes(r), r);
  assert.equal(REL_SEMANTICS.satisfies, 'trace');
  for (const r of ['affects', 'supersedes', 'member_of', 'alias_of'] as const) assert.equal(REL_SEMANTICS[r], 'info', r);
  assert.ok(!(RELATIONS as readonly string[]).some((r) => ['memberOf', 'partOf', 'ownedBy', 'dependsOn'].includes(r)), 'Backstage names are a documented mapping, not relations');
  for (const t of ['requirement', 'decision', 'team']) {
    assert.ok((CORE_NODE_TYPES as readonly string[]).includes(t), t);
    const u = nodeUri(t, 'X-1');
    assert.equal(u, `pg:${t}/X-1`);
    assert.deepEqual(parseNodeUri(u), { type: t, id: 'X-1' });
  }
});

test('satisfies to a missing requirement is DANGLING_LINK and LINK_MISSING_NODE; to a present one it is clean', () => {
  const link = (to: string): Row => ({ from: 'T-1', from_type: 'ticket', rel: 'satisfies', to, to_type: 'requirement' });
  const ok = plan({ requirement: REQ, link: [link('R-1')] });
  const c1 = run(ok, ['check']);
  assert.equal(c1.status, 0, c1.stdout + c1.stderr);
  const d = plan({ requirement: REQ, link: [link('R-404')] }, { build: false });
  run(d, ['build']); // reports the same violations; check needs an index to read
  const c = run(d, ['check']);
  assert.notEqual(c.status, 0);
  assert.match(c.stdout + c.stderr, /DANGLING_LINK/);
  assert.match(c.stdout + c.stderr, /LINK_MISSING_NODE/);
});

test('a requirement source is a repo path or <sys>:<xid>: a URL is BAD_SCHEMA', () => {
  for (const ok of ['docs/spec.md', 'docs/spec.md#login', 'confluence:12345', 'jira:ABC-1', 'github:o/r#12']) assert.equal(sourceProblem(ok), null, ok);
  for (const bad of ['https://x.example/doc', 'http://x', '//x.example/a', 'ftp://h/f', 'confluence:https://x/y', '../secret', '/etc/passwd', 'a/../b', 'mailto:a@b.example', '']) assert.notEqual(sourceProblem(bad), null, bad);
  assert.equal(validators['requirements.jsonl']?.({ id: 'R', source: 'https://x.example/doc' }) !== null, true);
  assert.equal(validators['requirements.jsonl']?.({ id: 'R', source: 'confluence:12345' }), null);
  const d = plan({ requirement: [{ id: 'R-9', source: 'https://x.example/doc' }] }, { build: false });
  const v = checkStore(path.join(d, '.plangraph')).filter((x) => x.code === 'BAD_SCHEMA');
  assert.equal(v.length, 1);
  assert.match(v[0]?.fix ?? '', /URL/);
  const e = plan({ requirement: [{ id: 'R-9', source: 'confluence:12345' }] }, { build: false });
  assert.deepEqual(checkStore(path.join(e, '.plangraph')), []);
  const bk = plan({ requirement: [{ id: 'R-9', kind: 'prose' }] }, { build: false }), bs = checkStore(path.join(bk, '.plangraph'));
  assert.equal(bs[0]?.code, 'BAD_SCHEMA');
});

test('the index holds the advisory tables, the views list the new nodes, and a build changes no verdict answer', () => {
  const base = plan(), withNew = plan({ requirement: REQ, decision: DEC, team: TEAM, link: [{ from: 'T-1', from_type: 'ticket', rel: 'satisfies', to: 'R-1', to_type: 'requirement' }, { from: 'Ana', from_type: 'person', rel: 'member_of', to: 'TEAM-1', to_type: 'team' }] });
  const db = new DatabaseSync(path.join(withNew, '.plangraph', INDEX_FILE), { readOnly: true });
  const all = (sql: string): Array<Record<string, unknown>> => (db.prepare(sql).all() as Array<Record<string, unknown>>).map((r) => ({ ...r }));
  for (const t of ADVISORY_TABLES) assert.equal(all(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${t}'`).length, 1, t);
  assert.deepEqual(all('SELECT id, status FROM requirement ORDER BY id'), [{ id: 'R-1', status: 'accepted' }, { id: 'R-2', status: 'proposed' }]);
  assert.deepEqual(all("SELECT id, type FROM g_nodes WHERE type IN ('requirement', 'decision', 'team') ORDER BY id"), [{ id: 'D-1', type: 'decision' }, { id: 'R-1', type: 'requirement' }, { id: 'R-2', type: 'requirement' }, { id: 'TEAM-1', type: 'team' }]);
  assert.deepEqual(all("SELECT src, rel, dst, dst_type FROM g_links WHERE rel IN ('satisfies', 'member_of') ORDER BY rel"), [{ src: 'Ana', rel: 'member_of', dst: 'TEAM-1', dst_type: 'team' }, { src: 'T-1', rel: 'satisfies', dst: 'R-1', dst_type: 'requirement' }]);
  db.close();
  for (const args of [['blockers', 'T-2'], ['blockers', 'T-1'], ['verify']]) {
    const a = run(base, args), b = run(withNew, args);
    assert.equal(a.status, b.status, args.join(' '));
    assert.equal(a.stdout, b.stdout, `${args.join(' ')}: same answer with the new kinds`);
  }
  const g = run(withNew, ['graph', 'T-1', '--rel', 'satisfies']);
  assert.equal(g.status, 0, g.stderr);
  assert.match(g.stdout, /R-1/);
  const t = run(withNew, ['graph', 'R-1', '--reverse', '--type', 'requirement']);
  assert.equal(t.status, 0, t.stderr);
  assert.match(t.stdout, /T-1/);
  assert.equal(run(withNew, ['graph', 'R-1', '--type', 'nosuch']).status, 2);
});

test('the index file is mode 0600, and a rebuild keeps the advisory tables current', () => {
  const d = plan({ requirement: REQ }), idx = path.join(d, '.plangraph', INDEX_FILE);
  assert.equal(fs.statSync(idx).mode & 0o777, 0o600);
  openStore({ dir: path.join(d, '.plangraph'), root: d }).writeKind('requirement', [...REQ, { id: 'R-3', text: 'new' }]);
  assert.equal(run(d, ['build']).status, 0);
  const db = new DatabaseSync(idx, { readOnly: true });
  assert.equal((db.prepare('SELECT COUNT(*) c FROM requirement').get() as { c: number }).c, 3);
  db.close();
  assert.equal(fs.statSync(idx).mode & 0o777, 0o600);
});

test('module and identity rows come from cache/git.jsonl and cache/identities.json; a bad module line is a data error', () => {
  const d = plan(), dir = path.join(d, '.plangraph');
  fs.mkdirSync(path.join(dir, 'cache'), { recursive: true });
  const m = { repo: 'api', path: 'src/a.ts', commits: 3, churn: 40, authors: [{ person: 'Ana', share: 1 }], last: '2026-03-01', coupled: ['src/b.ts'], hotspot: true, bus1: true, window: 365, min_cochange: 5, hot_percentile: 90 };
  fs.writeFileSync(path.join(dir, 'cache', 'git.jsonl'), `${JSON.stringify(m)}\n`);
  fs.writeFileSync(path.join(dir, 'cache', 'identities.json'), JSON.stringify({ version: 1, byRef: { 'jira:Ann L': 'Ana' } }));
  assert.equal(run(d, ['build']).status, 0);
  const db = new DatabaseSync(path.join(dir, INDEX_FILE), { readOnly: true });
  assert.deepEqual((db.prepare('SELECT repo, path, commits, hotspot, bus1, authors FROM module').all() as object[]).map((r) => ({ ...r })), [{ repo: 'api', path: 'src/a.ts', commits: 3, hotspot: 1, bus1: 1, authors: '[{"person":"Ana","share":1}]' }]);
  assert.deepEqual((db.prepare('SELECT ref, person FROM identity').all() as object[]).map((r) => ({ ...r })), [{ ref: 'jira:Ann L', person: 'Ana' }]);
  db.close();
  const obs = new DatabaseSync(path.join(dir, INDEX_FILE), { readOnly: true });
  assert.equal((obs.prepare('SELECT COUNT(*) c FROM obs').get() as { c: number }).c, 0, 'git.jsonl is not an observation cache');
  obs.close();
  fs.writeFileSync(path.join(dir, 'cache', 'git.jsonl'), `${JSON.stringify({ ...m, hotspot: 'yes' })}\n`);
  const bad = run(d, ['build']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /git\.jsonl/);
});

test('the event table follows events/ on every build, with its evidence', () => {
  const d = plan(), dir = path.join(d, '.plangraph'), count = (): number => { const db = new DatabaseSync(path.join(dir, INDEX_FILE), { readOnly: true }); try { return (db.prepare('SELECT COUNT(*) c FROM event').get() as { c: number }).c; } finally { db.close(); } };
  assert.equal(count(), 0);
  appendEvent(dir, 'ana', { task: 'T-1', to: 'in_progress', by: 'ana' }, { now: new Date('2026-03-01T09:00:00Z'), branch: 'main' });
  appendEvent(dir, 'ana', { task: 'T-1', to: 'done', by: 'ana', evidence: ['pr:o/r#1'] }, { now: new Date('2026-03-01T10:00:00Z'), branch: 'main' });
  assert.equal(run(d, ['build']).status, 0);
  assert.equal(count(), 2);
  const db = new DatabaseSync(path.join(dir, INDEX_FILE), { readOnly: true });
  assert.equal((db.prepare("SELECT evidence FROM event WHERE \"to\" = 'done'").get() as { evidence: string }).evidence, '["pr:o/r#1"]');
  db.close();
});
