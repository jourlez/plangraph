// sp-ingest plan fields: **Assignee:**, **Sprint:**, **Ticket:**, **Repo:**, **Requirements:** on the plan header and on tasks (plan 1.0, task 19).
// Covered: schedule row only with a sprint (else UNPLACED_ASSIGNEE), reassign refusal, tracked_by xref one to one (XREF_DUPLICATE), no second ticket
// node for a Jira key, touches (plan and Files lines), satisfies (only when this format has the relation; the Requirements link needs task 12),
// zero-change re-ingest, an unchanged plan without the fields, and the whole chain in one `graph` call.
// NOT covered: requirement existence (requirement nodes do not exist yet; `check` reports a missing one as LINK_MISSING_NODE).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { parsePlan, ingestPlan } from '../lib/integrations/superpowers.ts';
import { RELATIONS } from '../lib/graph/files.ts';
import { openStore } from '../lib/planstore.ts';
import { adoptPlanDir } from './helpers/plan-dir.ts';
import type { Kind } from '../lib/planstore.ts';

const BRAIN = path.join(import.meta.dirname, '..', 'bin', 'plangraph');
const REL = 'docs/superpowers/plans/slug.md', URI = 'pg:plantask/docs%2Fsuperpowers%2Fplans%2Fslug.md%232';
const HAS_SATISFIES = (RELATIONS as readonly string[]).includes('satisfies');
const DATA = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-splinks-data-')));
process.on('exit', () => fs.rmSync(DATA, { recursive: true, force: true }));

const plan = (head = '', t2 = '', t1 = '') => `# Slug Plan\n\n**Goal:** g\n${head}\n### Task 1: One\n\n${t1}**Files:** Create \`web/a.ts\`\n\n- [ ] **Step 1: x**\n\n### Task 2: Two\n\n${t2}\n- [ ] **Step 1: x**\n`;
const T2 = '**Assignee:** ana\n**Sprint:** 3\n**Ticket:** ABC-9\n**Repo:** web\n';

function project(text: string) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-splinks-')));
  process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  fs.mkdirSync(path.join(root, 'docs/superpowers/plans'), { recursive: true });
  const write = (t: string) => fs.writeFileSync(path.join(root, REL), t);
  write(text);
  const pg = (...a: string[]) => spawnSync(process.execPath, [BRAIN, ...a], { cwd: root, encoding: 'utf8', env: { ...process.env, PLANGRAPH_DIR: '', CLAUDE_PLUGIN_DATA: DATA } });
  assert.equal(pg('init').status, 0);
  const file = (n: string) => path.join(root, '.plangraph', n);
  const KIND: Record<string, Kind> = { tickets: 'ticket', schedule: 'schedule', xrefs: 'xref', links: 'link' };
  const rows = (k: string) => openStore({ dir: path.join(root, '.plangraph'), root }).readKind(KIND[k] as Kind) as Record<string, unknown>[];
  const ingest = (...a: string[]) => pg('sp-ingest', REL, '--ledger', 'none', ...a);
  const walk = (d: string, base = d): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? (e.name === 'cache' || e.name === '.txn' ? [] : walk(path.join(d, e.name), base)) : e.name.startsWith('plangraph.sqlite') ? [] : [path.relative(base, path.join(d, e.name))]);
  const snap = () => Object.fromEntries(walk(path.join(root, '.plangraph')).map((n) => [n, fs.readFileSync(file(n), 'utf8')]));
  return { root, pg, rows, ingest, write, file, snap };
}

test('Assignee, Sprint and Ticket on a task: schedule row, tracked_by xref, one ticket node', () => {
  const p = project(plan('', T2));
  const r = p.ingest(); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(p.rows('schedule'), [{ version: 'current', key: 'sp:slug/2', owner: 'ana', sprint: 3 }]);
  assert.deepEqual(p.rows('xrefs'), [{ type: 'ticket', id: 'sp:slug/2', sys: 'jira', xid: 'ABC-9' }]);
  assert.equal(p.rows('tickets').filter((t) => t.key === 'sp:slug/2').length, 1);
  assert.equal(p.rows('tickets').some((t) => t.key === 'ABC-9'), false);
});

test('a Jira ticket node that already exists is not duplicated: the xref attaches to the one canonical ticket', () => {
  const p = project(plan('', T2));
  fs.writeFileSync(p.file('tickets.jsonl'), JSON.stringify({ key: 'ABC-9', summary: 'tracked', jira_status: 'To Do', verdict: '', epic: '', sp: 3 }) + '\n');
  adoptPlanDir(path.join(p.root, '.plangraph'));
  const r = p.ingest(); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(p.rows('tickets').filter((t) => t.key === 'ABC-9').length, 1);
  assert.equal(p.rows('xrefs').length, 1);
});

test('an Assignee without a sprint is UNPLACED_ASSIGNEE and writes no schedule row; --sprint or a plan Sprint places it', () => {
  const p = project(plan('', '**Assignee:** ana\n'));
  let r = p.ingest(); assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /UNPLACED_ASSIGNEE sp:slug\/2/); assert.deepEqual(p.rows('schedule'), []);
  r = p.ingest('--sprint', '4', '--owner', 'bob'); assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(p.rows('schedule').filter((x) => x.key === 'sp:slug/2'), [{ version: 'current', key: 'sp:slug/2', owner: 'ana', sprint: 4 }]);
  const q = project(plan('**Sprint:** 5\n', '**Assignee:** ana\n'));
  r = q.ingest(); assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(q.rows('schedule'), [{ version: 'current', key: 'sp:slug/2', owner: 'ana', sprint: 5 }]);
});

test('a changed Assignee on re-ingest exits 2 and writes nothing, unless --reassign', () => {
  const p = project(plan('', T2));
  assert.equal(p.ingest().status, 0);
  p.write(plan('', T2.replace('ana', 'bob')));
  const before = p.snap(), r = p.ingest();
  assert.equal(r.status, 2, r.stdout + r.stderr); assert.match(r.stderr, /--reassign/); assert.deepEqual(p.snap(), before);
  assert.equal(p.ingest('--reassign').status, 0);
  assert.deepEqual(p.rows('schedule'), [{ version: 'current', key: 'sp:slug/2', owner: 'bob', sprint: 3 }]);
});

test('the same Jira ticket on two tasks is XREF_DUPLICATE and only the first xref is written', () => {
  const p = project(plan('', T2, '**Ticket:** ABC-9\n'));
  const r = p.ingest(); assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /XREF_DUPLICATE sp:slug\/2/);
  assert.deepEqual(p.rows('xrefs').map((x) => x.id), ['sp:slug/1']);
});

test('Repo (conf 1, why plan) and Files lines (through the repos paths) give touches links; plan-level Repo goes to the epic', () => {
  const p = project(plan('**Repo:** web\n', T2));
  fs.writeFileSync(p.file('repos.jsonl'), JSON.stringify({ id: 'repo:web', name: 'web' }) + '\n' + JSON.stringify({ id: 'repo:mono', name: 'mono', paths: [{ glob: 'web/**', sub: 'web' }] }) + '\n');
  adoptPlanDir(path.join(p.root, '.plangraph'));
  const r = p.ingest(); assert.equal(r.status, 0, r.stderr);
  const touch = p.rows('links').filter((l) => l.rel === 'touches').map((l) => `${l.from} ${l.to} ${(l.attrs as Record<string, unknown>).conf} ${(l.attrs as Record<string, unknown>).why}`).sort();
  assert.deepEqual(touch, ['sp:slug repo:web 1 plan', 'sp:slug/1 repo:mono 0.7 files', 'sp:slug/2 repo:web 1 plan']);
});

test('Requirements become satisfies links only for ids of the id grammar (no existence check)', () => {
  const text = parsePlan(plan('**Requirements:** R-a1b2c3, nope\n', '**Requirements:** R-0a0b0c0d\n'), REL);
  assert.deepEqual(text.links?.requirements, ['R-a1b2c3']); assert.deepEqual(text.tasks[1]?.requirements, ['R-0a0b0c0d']);
  assert.ok(text.warnings.some((w) => /Requirements value not recorded/.test(w)));
  const r = ingestPlan({ plan: text, satisfies: true });
  assert.deepEqual(r.links.map((l) => [l.from, l.rel, l.to, l.to_type]), [['sp:slug', 'satisfies', 'R-a1b2c3', 'requirement'], ['sp:slug/2', 'satisfies', 'R-0a0b0c0d', 'requirement']]);
  const off = ingestPlan({ plan: text, satisfies: false });
  assert.deepEqual(off.links, []); assert.ok(off.report.warnings.some((w) => /no satisfies relation/.test(w)));
});

test('a missing requirement is LINK_MISSING_NODE in check', { skip: HAS_SATISFIES ? false : 'skipped: the satisfies relation and requirement nodes arrive with task 12' }, () => {
  const p = project(plan('**Requirements:** R-a1b2c3\n', ''));
  assert.equal(p.ingest().status, 0);
  assert.equal(p.pg('build').status, 0);
  const r = p.pg('check'); assert.match(r.stdout + r.stderr, /LINK_MISSING_NODE/);
});

test('re-ingest writes zero changes', () => {
  const p = project(plan('**Repo:** web\n', T2));
  assert.equal(p.ingest().status, 0);
  const before = p.snap(), times = Object.fromEntries(Object.keys(before).map((n) => [n, fs.statSync(p.file(n)).mtimeMs]));
  const r = p.ingest(); assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(p.snap(), before);
  for (const n of Object.keys(before)) assert.equal(fs.statSync(p.file(n)).mtimeMs, times[n], `${n} not rewritten`);
});

test('graph answers assigned_to, tracked_by and touches for a plan task in one call', () => {
  const p = project(plan('', T2));
  fs.writeFileSync(p.file('repos.jsonl'), JSON.stringify({ id: 'repo:web', name: 'web' }) + '\n');
  adoptPlanDir(path.join(p.root, '.plangraph'));
  assert.equal(p.ingest().status, 0);
  const b = p.pg('build'); assert.equal(b.status, 0, b.stdout + b.stderr);
  const g = p.pg('graph', URI, '--depth', '2'); assert.equal(g.status, 0, g.stdout + g.stderr);
  assert.match(g.stdout, /assigned_to ana person/); assert.match(g.stdout, /tracked_by jira:ABC-9/); assert.match(g.stdout, /touches repo:web repo/);
});

test('a plan without the new fields writes no links, xrefs or extra rows', () => {
  const p = project(plan('', ''));
  const r = p.ingest(); assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(p.rows('links'), []); assert.deepEqual(p.rows('xrefs'), []); assert.deepEqual(p.rows('schedule'), []);
  assert.doesNotMatch(r.stdout, /link|xref|UNPLACED/);
});
