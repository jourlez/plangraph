// loadExtras (lib/extras.ts): the rows of the new node kinds, the events, the history modules, the links and the xrefs in one call, in the shapes the
// libraries take (lib/digest.ts, lib/docs, lib/flow). NOT covered: the libraries themselves (their own tests) or the commands that will call this.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../lib/planstore.ts';
import type { Row } from '../lib/planstore.ts';
import { appendEvent } from '../lib/store2/batches.ts';
import { loadExtras, docsExtras } from '../lib/extras.ts';
import { loadModel } from '../lib/model.ts';
import { buildMap, buildContext } from '../lib/digest.ts';
import { buildBrief } from '../lib/flow/brief.ts';
import { rtm } from '../lib/flow/rtm.ts';
import { planDocs } from '../lib/docs/registry.ts';

const tmps: string[] = [];
after(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });
const tk = (key: string, more: Record<string, unknown> = {}) => ({ key, summary: key, epic: '', sp: 1, jira_status: 'To Do', verdict: 'READY', ...more });
const NOW = new Date('2026-03-01T10:00:00Z');
const MOD = { repo: 'api', path: 'src/api/x.ts', commits: 3, churn: 40, authors: [{ person: 'Ana', share: 1 }], last: '2026-03-01', coupled: ['src/b.ts'], hotspot: true, bus1: true, window: 365, min_cochange: 5, hot_percentile: 90 };

function fixture(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-extras-'))); tmps.push(d);
  fs.writeFileSync(path.join(d, 'format.json'), '{"format_version":2,"min_reader":2,"storage":"entity"}\n');
  const st = openStore({ dir: d, root: d });
  st.writeKind('ticket', [tk('T-1'), tk('T-2'), tk('T-3')]);
  st.writeKind('schedule', [{ version: 'current', key: 'T-1', owner: 'Ana', sprint: 1 }, { version: 'current', key: 'T-2', owner: 'Ben', sprint: 1 }, { version: 'current', key: 'T-3', owner: 'Ben', sprint: 2 }]);
  st.writeKind('ref', [{ key: 'T-1', plans: [], files: { 'src/api/x.ts': 'h', 'docs/y.md': 'h' }, fp_files: '', jira_updated: '', audited_at: '' }]);
  st.writeKind('person', [{ id: 'Ana' }, { id: 'Ben' }]);
  st.writeKind('repo', [{ id: 'api', name: 'API', pm: 'npm', langs: ['ts'], cmds: { test: 'npm test', build: 'npm run build' }, owners: ['Ana'], paths: [{ glob: 'src/api/**', sub: 'api' }] }, { id: 'web' }]);
  st.writeKind('requirement', [{ id: 'R-2', text: 'second', status: 'proposed' }, { id: 'R-1', text: 'first', kind: 'ears', status: 'accepted', source: 'docs/s.md', acceptance: ['y', 'x'], priority: 'high' }, { id: 'R-3', text: 'alone' }]);
  st.writeKind('decision', [{ id: 'D-2', title: 'new', status: 'accepted', date: '2026-02-01', affects: ['src/api'] }, { id: 'D-1', title: 'old', status: 'superseded' }]);
  st.writeKind('team', [{ id: 'TEAM-1', name: 'core', members: ['Ana'], owns: ['api'] }]);
  st.writeKind('link', [
    { from: 'T-1', from_type: 'ticket', rel: 'satisfies', to: 'R-1', to_type: 'requirement' },
    { from: 'T-2', from_type: 'ticket', rel: 'satisfies', to: 'R-1', to_type: 'requirement' },
    { from: 'T-3', from_type: 'ticket', rel: 'satisfies', to: 'R-2', to_type: 'requirement' },
    { from: 'T-1', from_type: 'ticket', rel: 'touches', to: 'api', to_type: 'repo', attrs: { conf: 0.9 } },
    { from: 'D-2', from_type: 'decision', rel: 'supersedes', to: 'D-1', to_type: 'decision' },
    { from: 'Ben', from_type: 'person', rel: 'member_of', to: 'TEAM-1', to_type: 'team' },
  ]);
  st.writeKind('xref', [{ type: 'ticket', id: 'T-1', sys: 'jira:acme', xid: 'ABC-1' }]);
  appendEvent(d, 'ana', { task: 'T-1', to: 'in_progress', by: 'ana' }, { now: new Date('2026-03-01T09:00:00Z'), branch: 'main' });
  appendEvent(d, 'ana', { task: 'T-1', to: 'done', by: 'ana', evidence: ['pr:o/r#1'] }, { now: NOW, branch: 'main' });
  fs.mkdirSync(path.join(d, 'cache'), { recursive: true });
  fs.writeFileSync(path.join(d, 'cache', 'git.jsonl'), `${JSON.stringify(MOD)}\n`);
  return d;
}

test('loadExtras returns every kind in sorted, library-ready shapes', () => {
  const d = fixture(), x = loadExtras({ dir: d, root: d });
  assert.deepEqual(Object.keys(x), ['requirements', 'decisions', 'repos', 'teams', 'events', 'modules', 'links', 'xrefs']);
  assert.deepEqual(x.requirements.map((r) => r.id), ['R-1', 'R-2', 'R-3']);
  const r1 = x.requirements[0];
  assert.deepEqual(r1, { id: 'R-1', text: 'first', status: 'accepted', kind: 'ears', priority: 'high', source: 'docs/s.md', acceptance: ['x', 'y'], satisfiedBy: ['T-1', 'T-2'], state: 'proposed' });
  assert.equal(x.requirements[2]?.state, 'orphan', 'no satisfying link');
  assert.deepEqual(x.decisions.find((r) => r.id === 'D-2'), { id: 'D-2', title: 'new', status: 'accepted', date: '2026-02-01', affects: ['src/api'], supersedes: ['D-1'] });
  assert.deepEqual(x.teams, [{ id: 'TEAM-1', name: 'core', members: ['Ana', 'Ben'], owns: ['api'] }], 'members from the team and from member_of links');
  const api = x.repos.find((r) => r.id === 'api');
  assert.deepEqual(api, { id: 'api', name: 'API', pm: 'npm', cmds: { build: 'npm run build', test: 'npm test' }, commands: { build: 'npm run build', test: 'npm test' }, owners: ['Ana'], stack: ['ts'], tickets: ['T-1'], touched: { 'T-1': ['src/api/x.ts'] } });
  assert.deepEqual(x.repos.find((r) => r.id === 'web'), { id: 'web', owners: [], stack: [], tickets: [], touched: {} });
  assert.deepEqual(x.events.map((e) => [e.task, e.to, e.evidence]), [['T-1', 'in_progress', []], ['T-1', 'done', ['pr:o/r#1']]]);
  assert.deepEqual(x.modules, [MOD]);
  assert.equal(x.links.length, 6);
  assert.deepEqual(x.xrefs, [{ type: 'ticket', id: 'T-1', sys: 'jira:acme', xid: 'ABC-1' }]);
  assert.deepEqual(loadExtras({ dir: d, root: d }), x, 'deterministic');
});

test('a requirement whose satisfying tasks are done with proof is verified', () => {
  const d = fixture();
  appendEvent(d, 'ben', { task: 'T-2', to: 'in_progress', by: 'ben' }, { now: new Date('2026-03-01T09:30:00Z'), branch: 'main' });
  appendEvent(d, 'ben', { task: 'T-2', to: 'done', by: 'ben', evidence: ['test:t1'] }, { now: NOW, branch: 'main' });
  assert.equal(loadExtras({ dir: d, root: d }).requirements[0]?.state, 'verified');
});

test('a plan with none of the new kinds gives empty extras and no error', () => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-extras-'))); tmps.push(d);
  fs.writeFileSync(path.join(d, 'format.json'), '{"format_version":2,"min_reader":2,"storage":"entity"}\n');
  const x = loadExtras({ dir: d, root: d });
  for (const k of Object.keys(x) as Array<keyof typeof x>) assert.deepEqual(x[k], [], k);
});

test('the one value feeds the digest, the brief, the matrix and the document planner', () => {
  const d = fixture(), x = loadExtras({ dir: d, root: d }), model = loadModel(d);
  const map = buildMap(model, { extras: x });
  assert.ok(map.lines.some((l) => /hot api:src\/api\/x\.ts/.test(l.text)), 'the hotspot line');
  assert.ok(buildContext(model, 'T-1', { extras: x }).lines.some((l) => /hotspot/.test(l.text)), 'the module of a touched path');
  const brief = buildBrief(model, 'T-1', { requirements: x.requirements, decisions: x.decisions, repos: x.repos, links: x.links });
  assert.deepEqual(brief.requirements.map((r) => r.id), ['R-1']);
  assert.deepEqual(brief.repos.map((r) => r.id), ['api']);
  assert.deepEqual(rtm(model, x.events, { requirements: x.requirements, links: x.links }).map((r) => [r.requirement, r.status]), [['R-1', 'proposed'], ['R-2', 'proposed'], ['R-3', 'orphan']]);
  const dx = docsExtras(x);
  assert.deepEqual(dx.modules, [{ repo: 'api', path: 'src/api/x.ts', churn: 40, bus1: true, hotspot: 1, authors: ['Ana'] }]);
  const paths = planDocs(model, model.config, dx).map((u) => u.path);
  assert.ok(paths.length > 0);
});

test('a row of the old kinds is untouched: the store still reads the same tickets', () => {
  const d = fixture();
  assert.deepEqual((openStore({ dir: d, root: d }).readKind('ticket', { defaults: false }) as Row[]).map((r) => r.key), ['T-1', 'T-2', 'T-3']);
});
