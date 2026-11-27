// Cases that need two or more items, ties or a second code path: sort comparators and map callbacks in the digest, the brief, the docs generators,
// docsExtras and the flow state order. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModel } from '../lib/model.ts';
import { buildContext, render } from '../lib/digest.ts';
import type { Extras as DigestExtras } from '../lib/digest.ts';
import { buildBrief } from '../lib/flow/brief.ts';
import type { FlowLink } from '../lib/flow/brief.ts';
import { buildDocs } from '../lib/docs/registry.ts';
import type { Extras } from '../lib/docs/types.ts';
import { docsExtras } from '../lib/extras.ts';
import type { Extras as LoadedExtras } from '../lib/extras.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../lib/planstore.ts';
import { caseCollisions } from '../lib/store2/check.ts';
import { registerItem, closeItem } from '../lib/openitems.ts';
import { doneOf } from '../lib/ready.ts';
import { loadExtras } from '../lib/extras.ts';
import { deriveState } from '../lib/flow/state.ts';
import { memfs } from './helpers/docsfs.ts';

const model = buildModel({
  tickets: [{ key: 'A-1', summary: 'login', sp: 2, epic: 'E', jira_status: 'To Do' }],
  schedule: [{ key: 'A-1', owner: 'Ana', sprint: 1 }],
});

test('buildContext orders several requirements, decisions, modules and authors by id, path and share', () => {
  const extras: DigestExtras = {
    repos: [{ id: 'web', cmds: { test: 't' }, tickets: ['A-1'], touched: { 'A-1': ['src/a.ts', 'src/b.ts'] } }],
    requirements: [{ id: 'R-9', text: 'nine', satisfiedBy: ['A-1'] }, { id: 'R-2', text: 'two', satisfiedBy: ['A-1'] }],
    decisions: [{ id: 'D-9', title: 'nine', affects: ['src/**'] }, { id: 'D-2', title: 'two', affects: ['src/**'] }],
    modules: [
      { repo: 'web', path: 'src/b.ts', hotspot: true, authors: [{ person: 'Zed', share: 0.5 }, { person: 'Amy', share: 0.5 }, { person: 'Bob', share: 0.9 }] },
      { repo: 'web', path: 'src/a.ts', hotspot: true, bus1: true },
    ],
  };
  const t = render(buildContext(model, 'A-1', { extras }), 2000).text;
  assert.ok(t.indexOf('R-2') < t.indexOf('R-9'));
  assert.ok(t.indexOf('D-2') < t.indexOf('D-9'));
  assert.ok(t.indexOf('src/a.ts') < t.indexOf('src/b.ts'));
  assert.ok(t.indexOf('Bob') >= 0 && t.indexOf('Bob') < t.indexOf('Amy'), 'share descending, then person');
  assert.ok(!t.includes('Zed'), 'only the top two authors');
});

test('buildBrief orders requirements and decisions and keeps consumes, produces and file-scoped decisions', () => {
  const L = (rel: string, to: string, to_type: string): FlowLink => ({ from: 'A-1', rel, to, to_type });
  const b = buildBrief(model, 'A-1', {
    links: [L('satisfies', 'R-9', 'requirement'), L('satisfies', 'R-2', 'requirement')],
    requirements: [{ id: 'R-9', text: 'nine' }, { id: 'R-2', text: 'two' }],
    decisions: [{ id: 'D-9', title: 'by dir', affects: ['src/auth'] }, { id: 'D-2', title: 'by file', affects: ['src/auth/login.ts'] }, { id: 'D-5', title: 'other', affects: ['lib'] }],
    task: { title: 'T', steps: ['s1'], consumes: ['c1', 'c2'], produces: ['p1'], files: ['src/auth/login.ts'] },
  });
  assert.deepEqual(b.requirements.map((r) => r.id), ['R-2', 'R-9']);
  assert.deepEqual(b.decisions.map((d) => d.id), ['D-2', 'D-9']);
  assert.deepEqual(b.consumes, ['c1', 'c2']);
  assert.deepEqual(b.produces, ['p1']);
});

const dmodel = buildModel({ tickets: [{ key: 'A-1', sp: 1, impl_status: 'done' }], schedule: [{ key: 'A-1', owner: 'Ana', sprint: 1 }] });
const dex: Extras = {
  repos: [{ id: 'svc/b', stack: ['node'] }, { id: 'svc/a', stack: ['go'], commands: { test: 'go test' } }],
  teams: [{ id: 'T-2', members: ['Zed', 'Amy'], owns: ['svc/b', 'svc/a'] }, { id: 'T-1', owns: [] }],
  decisions: [{ id: 'D-2', title: 'b', status: 'accepted', affects: ['svc/a/x'] }, { id: 'D-1', title: 'a', status: 'accepted', affects: ['svc/a'] }, { id: 'D-3', title: 'c', status: 'proposed' }],
  requirements: [{ id: 'R-2', status: 'accepted', acceptance: ['x'] }, { id: 'R-1', acceptance: ['y'] }],
  modules: [
    { repo: 'svc/a', path: 'b.ts', hotspot: 5, churn: 1, authors: ['zed', 'amy'], bus1: true },
    { repo: 'svc/a', path: 'a.ts', hotspot: 5, churn: 2, authors: ['amy'], bus1: true },
    { repo: 'svc/a', path: 'c.ts', hotspot: 7, churn: 3, bus1: true },
  ],
};

test('architecture, onboarding and repo-page order several items deterministically', () => {
  const fs = memfs();
  const r = buildDocs(dmodel, {}, fs, dex);
  assert.deepEqual(r.violations, []);
  const arch = fs.files.get('docs/plangraph/architecture.md')!;
  assert.ok(arch.indexOf('svc/a/c.ts') < arch.indexOf('svc/a/a.ts') && arch.indexOf('svc/a/a.ts') < arch.indexOf('svc/a/b.ts'), 'hotspot desc then path');
  assert.ok(arch.indexOf('T-1') < arch.indexOf('T-2'));
  const onb = fs.files.get('docs/plangraph/onboarding.md')!;
  assert.ok(onb.indexOf('svc/a') < onb.indexOf('svc/b'));
  assert.ok(onb.indexOf('T-1') < onb.indexOf('T-2'));
  const page = fs.files.get('docs/plangraph/repos/svc-a.md') ?? [...fs.files].find(([k]) => k.includes('repos/'))?.[1];
  assert.ok(page && page.indexOf('a.ts') < page.indexOf('b.ts'));
  assert.match(page!, /D-1/);
  assert.ok(page!.indexOf('D-1') < page!.indexOf('D-2'));
});

test('docsExtras ranks hot modules by churn, then repo, then path', () => {
  const mod = (repo: string, path: string, churn: number, hotspot: boolean) => ({ repo, path, commits: 1, churn, authors: [{ person: 'Ana', share: 1 }], last: '', coupled: [], hotspot, bus1: false, window: 1, min_cochange: 1, hot_percentile: 90 });
  const x = { requirements: [], decisions: [], repos: [], teams: [], events: [], links: [], xrefs: [], modules: [mod('b', 'x', 5, true), mod('a', 'y', 5, true), mod('a', 'x', 5, true), mod('c', 'z', 9, true), mod('d', 'w', 1, false)] } as unknown as LoadedExtras;
  const out = Object.fromEntries(docsExtras(x).modules!.map((m) => [`${m.repo}/${m.path}`, m.hotspot]));
  assert.deepEqual(out, { 'c/z': 4, 'a/x': 3, 'a/y': 2, 'b/x': 1, 'd/w': 0 });
});

test('events with the same time, seq, actor and hash are ordered by their content, whatever the input order', () => {
  const base = { at: '2026-01-01T00:00:00Z', seq: 1, actor: 'a', task: 't', by: 'ann', evidence: [] as string[] };
  const NONE = { openDeps: () => [], gated: () => false };
  const e1 = { ...base, to: 'claimed', note: 'one' }, e2 = { ...base, to: 'ready', note: 'two' };
  const a = deriveState('t', [e1, e2], NONE), b = deriveState('t', [e2, e1], NONE);
  assert.deepEqual(a, b);
});

test('buildBrief lists each touched repo with its commands and its owners as people to ask', () => {
  const L = (rel: string, to: string, to_type: string): FlowLink => ({ from: 'A-1', rel, to, to_type });
  const b = buildBrief(model, 'A-1', {
    links: [L('touches', 'web', 'repo'), L('touches', 'api', 'repo')],
    repos: [{ id: 'web', cmds: { test: 'make t', build: 'make b' }, owners: ['Bo'] }, { id: 'api' }],
    decisions: [{ id: 'D-1', title: 'by repo', affects: ['web'] }],
  });
  assert.deepEqual(b.repos, [{ id: 'api', test: '', build: '' }, { id: 'web', test: 'make t', build: 'make b' }]);
  assert.deepEqual(b.ask, ['Ana', 'Bo']);
  assert.deepEqual(b.decisions.map((d) => d.id), ['D-1']);
});

test('caseCollisions groups names equal ignoring case and sorts the groups', () => {
  assert.deepEqual(caseCollisions(['b/X', 'b/x', 'a/Y', 'a/y', 'a/Y', 'z']), [['a/Y', 'a/y'], ['b/X', 'b/x']]);
});

test('closeItem stamps today and the clock default when no date is given', () => {
  const items = registerItem([], { key: 'K-1', kind: 'manual', owner: 'Ben' });
  const closed = closeItem(items, 'K-1', 'manual');
  assert.equal(closed[0]?.status, 'done');
  assert.match(String(closed[0]?.closed_at), /^\d{4}-\d{2}-\d{2}$/);
});

test('doneOf says how a ticket is done by its own status and null when it is not', () => {
  const m = buildModel({ tickets: [{ key: 'A-1', jira_status: 'Done' }, { key: 'A-2', jira_status: 'To Do' }, { key: 'A-3', jira_status: 'Shipped' }] });
  assert.notEqual(doneOf(m, 'A-1'), null);
  assert.equal(doneOf(m, 'A-2'), null);
  assert.equal(doneOf(m, 'A-3'), null);
  assert.notEqual(doneOf(m, 'A-3', { closed: new Set(['Shipped']) }), null);
});

test('loadExtras sorts several teams by id', () => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-gap-x-')));
  try {
    fs.writeFileSync(path.join(d, 'format.json'), '{"format_version":2,"min_reader":2,"storage":"entity"}\n');
    const st = openStore({ dir: d, root: d });
    st.writeKind('team', [{ id: 'TEAM-2', name: 'b', members: [], owns: [] }, { id: 'TEAM-1', name: 'a', members: ['Ana'], owns: [] }]);
    assert.deepEqual(loadExtras({ dir: d, root: d }).teams.map((t) => t.id), ['TEAM-1', 'TEAM-2']);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
