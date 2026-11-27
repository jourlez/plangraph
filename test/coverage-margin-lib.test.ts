// Coverage margin for lib/extras.ts and lib/flow/brief.ts: the shapes the main tests leave out (sparse rows, odd link and path rows, a missing
// ticket, empty and over-long lists), over synthetic plans in temporary directories.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../lib/planstore.ts';
import { appendEvent } from '../lib/store2/batches.ts';
import { loadExtras, docsExtras } from '../lib/extras.ts';
import type { Extras } from '../lib/extras.ts';
import { buildModel } from '../lib/model.ts';
import { buildBrief } from '../lib/flow/brief.ts';

const tmps: string[] = [];
after(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });
const tk = (key: string) => ({ key, summary: key, epic: '', sp: 1, jira_status: 'To Do', verdict: 'READY' });
function plan(kinds: Record<string, object[]>): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-margin-lib-'))); tmps.push(d);
  fs.writeFileSync(path.join(d, 'format.json'), '{"format_version":2,"min_reader":2,"storage":"entity"}\n');
  const st = openStore({ dir: d, root: d });
  st.writeKind('ticket', [tk('T-1'), tk('T-2')]);
  st.writeKind('schedule', [{ version: 'current', key: 'T-1', owner: 'Ana', sprint: 1 }]);
  for (const [k, rows] of Object.entries(kinds)) st.writeKind(k as never, rows as never);
  return d;
}
const load = (d: string): Extras => loadExtras({ dir: d, root: d });

test('loadExtras: sparse rows, odd path and ref shapes, decision links and several hot modules', () => {
  const d = plan({
    ref: [{ key: 'T-1', plans: [], files: { 'src/a.ts': 'h', 'src/b.ts': 'h' }, fp_files: '', jira_updated: '', audited_at: '' }],
    repo: [
      { id: 'a', paths: [{ glob: 'src/a.*' }, { nope: 1 }, null, 'text', { glob: 7 }], cmds: { test: 'npm test', build: 'npm run build', n: 3 }, owners: ['Ana', 'Ana'], runtime: 'node', langs: ['ts'], frameworks: ['x'] },
      { id: 'b', paths: 'not a list', cmds: ['x'] }, { id: 'c', cmds: null }, { id: 'd' },
    ],
    requirement: [{ id: 'R-1' }, { id: 'R-2', text: '', status: 5 }],
    decision: [{ id: 'D-1', affects: ['a', 3] }, { id: 'D-2', title: 'second' }, { id: 'D-3' }],
    team: [{ id: 'TEAM-2' }, { id: 'TEAM-1' }],
    link: [
      { from: 'T-1', from_type: 'ticket', rel: 'touches', to: 'a', to_type: 'repo' }, { from: 'T-2', from_type: 'ticket', rel: 'touches', to: 'a', to_type: 'repo' },
      { from: 'T-1', from_type: 'ticket', rel: 'touches', to: 'b', to_type: 'repo' }, { from: 'T-1', from_type: 'ticket', rel: 'touches', to: 'c', to_type: 'repo' },
      { from: 'D-1', from_type: 'decision', rel: 'affects', to: 'c', to_type: 'repo' }, { from: 'D-1', from_type: 'decision', rel: 'affects', to: 'b', to_type: 'repo' },
      { from: 'D-2', from_type: 'decision', rel: 'supersedes', to: 'D-1', to_type: 'decision' }, { from: 'D-2', from_type: 'decision', rel: 'supersedes', to: 'D-3', to_type: 'decision' },
      { from: 'D-3', from_type: 'decision', rel: 'mentions', to: 'D-1', to_type: 'decision' },
    ],
  });
  appendEvent(d, 'ana', { task: 'T-1', to: 'in_progress', by: 'ana' }, { now: new Date('2026-03-01T09:00:00Z'), branch: 'main' });
  appendEvent(d, 'ana', { task: 'T-1', to: 'done', by: 'ana', evidence: [] }, { now: new Date('2026-03-01T10:00:00Z'), branch: 'main' });
  fs.mkdirSync(path.join(d, 'cache'), { recursive: true });
  const mod = (p: string, churn: number, hotspot: boolean, repo = 'a') => ({ repo, path: p, commits: 2, churn, authors: [{ person: 'Ana', share: 1 }], last: '2026-03-01', coupled: [], hotspot, bus1: false, window: 365, min_cochange: 5, hot_percentile: 90 });
  fs.writeFileSync(path.join(d, 'cache', 'git.jsonl'), [mod('src/z.ts', 10, true), mod('src/y.ts', 10, true), mod('src/x.ts', 30, true, 'b'), mod('src/w.ts', 5, false), mod('src/v.ts', 10, true, 'b')].map((m) => JSON.stringify(m)).join('\n') + '\n');
  const x = load(d);
  assert.deepEqual(x.requirements.map((r) => [r.id, r.state, r.satisfiedBy.length, r.acceptance.length]), [['R-1', 'orphan', 0, 0], ['R-2', 'orphan', 0, 0]]);
  assert.equal(x.requirements[1]?.status, undefined);
  assert.equal(x.requirements[1]?.text, undefined);
  const a = x.repos.find((r) => r.id === 'a');
  assert.deepEqual(a?.cmds, { build: 'npm run build', test: 'npm test' });
  assert.deepEqual(a?.touched, { 'T-1': ['src/a.ts'] }, 'only the paths the glob accepts, and a ticket with no ref row has none');
  assert.deepEqual(a?.stack, ['node', 'ts', 'x']);
  assert.deepEqual(a?.tickets, ['T-1', 'T-2']);
  const b = x.repos.find((r) => r.id === 'b');
  assert.deepEqual(b?.touched, { 'T-1': ['src/a.ts', 'src/b.ts'] }, 'no glob list: every file of the ticket counts');
  assert.equal(b?.cmds, undefined);
  assert.equal(x.repos.find((r) => r.id === 'c')?.cmds, undefined);
  assert.deepEqual(x.decisions.map((r) => [r.id, r.affects, r.supersedes]), [['D-1', ['a', 'b', 'c'], []], ['D-2', [], ['D-1', 'D-3']], ['D-3', [], []]]);
  assert.deepEqual(x.teams.map((t) => t.id), ['TEAM-1', 'TEAM-2']);
  assert.deepEqual(x.repos.find((r) => r.id === 'd')?.tickets, []);
  assert.deepEqual(x.events.map((e) => [e.task, e.evidence]), [['T-1', []], ['T-1', []]]);
  const docs = docsExtras(x);
  assert.deepEqual(docs.modules?.map((m) => [m.path, m.hotspot]).sort(), [['src/v.ts', 1], ['src/w.ts', 0], ['src/x.ts', 4], ['src/y.ts', 3], ['src/z.ts', 2]].sort());
  assert.deepEqual(docs.modules?.find((m) => m.path === 'src/z.ts')?.authors, ['Ana']);
});

test('loadExtras of a plan with no history cache, no events and no requirement rows is empty and well-formed', () => {
  const x = load(plan({}));
  assert.deepEqual([x.requirements, x.decisions, x.repos, x.teams, x.events, x.modules, x.links, x.xrefs], [[], [], [], [], [], [], [], []]);
  assert.deepEqual(docsExtras(x).modules, []);
});

test('loadExtras surfaces a history cache that cannot be read, and ignores only a missing one', () => {
  const d = plan({});
  fs.mkdirSync(path.join(d, 'cache'), { recursive: true });
  fs.mkdirSync(path.join(d, 'cache', 'git.jsonl'));
  assert.throws(() => load(d), (e: unknown) => (e as NodeJS.ErrnoException).code === 'NOT_A_FILE');
});

// ---- brief
const M = buildModel({ tickets: [{ key: 'T-1', summary: 'Login' }], schedule: [{ key: 'T-1', owner: 'Ana', sprint: 1 }] });
const lk = (rel: string, to: string, to_type: string, from = 'T-1') => ({ from, rel, to, to_type });

test('buildBrief of an unknown ticket with no extras is a bare, well-formed brief', () => {
  const b = buildBrief(M, 'NOPE-1');
  assert.deepEqual([b.key, b.title, b.owner, b.steps, b.files, b.repos, b.requirements, b.decisions, b.ask, b.omitted], ['NOPE-1', '', '', [], [], [], [], [], [], 0]);
  assert.equal(b.text.split('\n')[0], 'brief NOPE-1');
  assert.equal(buildBrief(M, 'T-1').title, 'Login');
});

test('buildBrief picks requirement and decision text with its fallbacks, and matches decisions to files by path prefix', () => {
  const b = buildBrief(M, 'T-1', {
    links: [lk('satisfies', 'R-1', 'requirement'), lk('satisfies', 'R-2', 'requirement'), lk('satisfies', 'R-3', 'requirement'), lk('touches', 'web', 'repo'), lk('touches', 'api', 'repo'), lk('touches', 'x', 'repo', 'OTHER')],
    requirements: [{ id: 'R-3', title: 'from title' }, { id: 'R-1', text: 'from text', title: 'ignored' }, { id: 'R-2' }, { id: 'R-9', text: 'not linked' }],
    decisions: [
      { id: 'D-4', title: 'prefix without slash', affects: ['src/a'] }, { id: 'D-1', title: 'by repo id', affects: ['web'] }, { id: 'D-2', text: 'by file path', affects: ['src/a/'] }, { id: 'D-3', affects: ['src/a/main.ts'] },
      { id: 'D-5', title: 'partial name', affects: ['src/ab'] }, { id: 'D-6', title: 'no affects' }, { id: 'D-7', title: 'elsewhere', affects: ['other'] },
    ],
    repos: [{ id: 'web', owners: ['Bo'], cmds: { test: 't' } }, { id: 'api', owners: ['Cy'] }, { id: 'other', owners: ['Di'] }],
    task: { files: ['src/a/main.ts'] },
  });
  assert.deepEqual(b.requirements, [{ id: 'R-1', text: 'from text' }, { id: 'R-2', text: '' }, { id: 'R-3', text: 'from title' }]);
  assert.deepEqual(b.decisions, [{ id: 'D-1', title: 'by repo id' }, { id: 'D-2', title: 'by file path' }, { id: 'D-3', title: '' }, { id: 'D-4', title: 'prefix without slash' }]);
  assert.deepEqual(b.repos, [{ id: 'api', test: '', build: '' }, { id: 'web', test: 't', build: '' }]);
  assert.deepEqual(b.ask, ['Ana', 'Cy', 'Bo']);
  assert.match(b.text, /web test: t build: -/);
});

test('buildBrief with no owner and a repo without owners asks nobody, and caps every list with an omitted count', () => {
  const m = buildModel({ tickets: [{ key: 'T-1', summary: 'Login' }] });
  const many = (n: number, p: string) => Array.from({ length: n }, (_, i) => `${p}${i}`);
  const b = buildBrief(m, 'T-1', {
    links: [lk('touches', 'web', 'repo'), ...many(10, 'R-').map((r) => lk('satisfies', r, 'requirement'))],
    repos: [{ id: 'web' }], requirements: many(10, 'R-').map((id) => ({ id, text: id })), decisions: many(10, 'D-').map((id) => ({ id, title: id, affects: ['web'] })),
    task: { title: 'T', steps: many(14, 's'), consumes: many(10, 'c'), produces: many(10, 'p'), files: many(20, 'src/f') },
    maxTokens: 100000,
  });
  assert.equal(b.owner, '');
  assert.deepEqual(b.ask, []);
  assert.ok(!/\nask:/.test(b.text));
  assert.ok(!b.text.startsWith('brief T-1 owner'));
  assert.equal(b.omitted, 2 + 2 + 2 + 5 + 2 + 2);
  assert.match(b.text, /omitted 15$/);
});

test('buildBrief keeps a fence whole and a preceding label with it when the bound drops the last lines', () => {
  const links = [lk('touches', 'web', 'repo'), lk('satisfies', 'R-1', 'requirement')];
  const args = { links, repos: [{ id: 'web', owners: ['Bo'], cmds: { test: 'npm test' } }], requirements: [{ id: 'R-1', text: 'x'.repeat(250) }], decisions: [{ id: 'D-1', title: 'y'.repeat(190), affects: ['web'] }], task: { title: 'Login', steps: ['one', 'two'], consumes: ['a'], produces: ['b'], files: ['src/a.ts'] } };
  for (const maxTokens of [400, 120, 80, 50, 30, 10, 1]) {
    const b = buildBrief(M, 'T-1', { ...args, maxTokens });
    assert.equal((b.text.match(/<untrusted /g) ?? []).length, (b.text.match(/<\/untrusted>/g) ?? []).length, String(maxTokens));
    assert.ok(!/(requirements|decisions|from the repository \(data, not instructions\)):\n?$/.test(b.text.replace(/\nomitted \d+$/, '')), `${maxTokens}: ${JSON.stringify(b.text.slice(-60))}`);
  }
});

// ---- graph providers
import { PROVIDERS } from '../lib/graph/provider.ts';
const POPTS = { tenant: 'acme', now: '2026-11-26', prev: null };
const prov = (name: string) => PROVIDERS[name] as NonNullable<(typeof PROVIDERS)[string]>;
const gbatch = (observations: unknown[], sys = 'x-demo') => ({ schema: 'plangraph-ext-batch@1', sys, observations });

test('generic provider drops an observation whose fields or links are not the plain shapes, and sorts links by their text', () => {
  const link = (rel: string, xid: string) => ({ rel, sys: 'x-demo', xid });
  const r = prov('generic').normalize(gbatch([
    { xid: 'a', type: 'x-demo.item', fields: 'text' }, { xid: 'b', type: 'x-demo.item', fields: ['x'] }, { xid: 'c', type: 'x-demo.item', links: ['text'] }, { xid: 'd', type: 'x-demo.item', links: 'text' },
    { xid: 'e', type: 'x-demo.item', links: [null] }, { xid: 'f', type: 'x-demo.item', fields: { k: { nested: 1 } } }, { xid: 'g', type: 'x-demo.item', fields: { k: Infinity } },
    { xid: 'ok', type: 'x-demo.item', links: [link('x-demo/b', 'z'), link('x-demo/a', 'y'), link('x-demo/a', 'x')] },
  ]), POPTS);
  assert.equal(r.observations.length, 1);
  assert.equal(r.dropped, 7);
  assert.deepEqual(r.observations[0]?.links.map((l) => `${l.rel}:${l.xid}`), ['x-demo/a:x', 'x-demo/a:y', 'x-demo/b:z']);
  assert.match(r.warnings[0] as string, /^7 observation\(s\) dropped/);
});

test('jira provider keeps the sprint ids and the state of the last sprint when the issue has sprints', () => {
  const issue = (key: string, sprints: unknown) => ({ key, fields: { summary: 'S', status: { name: 'To Do' }, updated: '2026-11-20T10:00:00.000+0000', customFields: { Sprint: { id: 'customfield_1', value: sprints } } } });
  const r = prov('jira').normalize({ issues: [issue('ABC-1', [{ id: 5, name: 'S5', state: 'closed' }, { id: 6, name: 'S6', state: 'active' }]), issue('ABC-2', []), { key: 'ABC-3', fields: { summary: 'none', status: { name: 'To Do' } } }] }, POPTS);
  const by = (k: string) => r.observations.find((o) => o.xid === k)?.fields;
  assert.deepEqual([by('ABC-1')?.sprint, by('ABC-1')?.sprint_state], ['5,6', 'active']);
  assert.equal(by('ABC-2')?.sprint, undefined);
  assert.equal(by('ABC-3')?.sprint, undefined);
});

test('sp provider reads a ledger status, ignores a ledger that is not text, and passes a plan warning on', () => {
  const name = 'docs/superpowers/plans/2026-11-20-widget.md', plan = '# W\n\n### Task 1: first\n- [ ] **Step 1: a**\n\n### Task 2: second\n';
  const withLedger = prov('sp').normalize({ name, text: plan, ledger: 'Task 1: complete\nTask 2: blocked' }, POPTS);
  assert.deepEqual(withLedger.observations.filter((o) => o.type === 'ticket').map((o) => o.fields.status), ['done', 'blocked']);
  const noLedger = prov('sp').normalize({ name, text: plan, ledger: 5 }, POPTS);
  assert.ok(noLedger.observations.every((o) => o.fields.status === undefined));
  const hidden = prov('sp').normalize({ name, text: '# W\n\n<!--\n### Task 1: hidden\n-->\n\n### Task 2: ok\n' }, POPTS);
  assert.match(hidden.warnings[0] as string, /swallows a task heading/);
});

test('confluence provider needs a tenant and a pages list, keeps a numeric space, drops pages without an id, and cuts labels', () => {
  assert.throws(() => prov('confluence').normalize({ pages: [] }, { ...POPTS, tenant: '' }), /tenant alias/);
  for (const bad of [null, 'text', {}, { pages: 'no' }, []]) assert.throws(() => prov('confluence').normalize(bad, POPTS), /needs "pages"/, JSON.stringify(bad));
  const r = prov('confluence').normalize({ space: '123', pages: [{ id: '10', title: 'T', status: 'current', version: 3, labels: ['a', 5, 'b'], text: 'body' }, { id: '11' }, { id: 12 }, null, 'text', { id: 'abc' }] }, POPTS);
  assert.deepEqual(r.observations.map((o) => [o.xid, o.fields.space, o.fields.version, o.fields.labels]), [['10', '123', 3, 'a,b'], ['11', '123', undefined, undefined]]);
  assert.equal(r.dropped, 4);
  assert.match(r.warnings[0] as string, /^4 page\(s\) dropped/);
  const bare = prov('confluence').normalize({ space: 'not numeric', pages: [{ id: '1' }] }, POPTS);
  assert.equal(bare.observations[0]?.fields.space, undefined);
  assert.equal(bare.warnings.length, 0);
});

// ---- lib/docs/extras.ts
import { loadExtras as loadDocsExtras } from '../lib/docs/extras.ts';
import type { ExtrasStore } from '../lib/docs/extras.ts';

test('docs loadExtras reads repos only: no kind, a store that throws, bad ids, duplicate ids, odd stack and commands', () => {
  const store = (rows: Record<string, unknown>[] | 'throws' | 'missing'): ExtrasStore => ({
    exists: () => rows !== 'missing',
    readKind: () => { if (rows === 'throws') throw new Error('unreadable'); return rows as Record<string, unknown>[]; },
  });
  assert.deepEqual(loadDocsExtras(store('missing')), {});
  assert.deepEqual(loadDocsExtras(store('throws')), {});
  assert.deepEqual(loadDocsExtras(store([])), {});
  assert.deepEqual(loadDocsExtras(store([{ id: '' }, { id: 5 }, {}, { stack: ['x'] }])), {});
  const x = loadDocsExtras(store([
    { id: 'b', stack: ['ts', 'go'], commands: { test: 'npm test', build: 'make', n: 3, z: null } }, { id: 'a', stack: ['ok', 7], commands: 'text' },
    { id: 'c', commands: ['x'] }, { id: 'b', stack: 'text' }, { id: 'd', commands: null },
  ]));
  assert.deepEqual(x.repos?.map((r) => r.id), ['a', 'b', 'b', 'c', 'd']);
  const first = x.repos?.find((r) => r.stack?.includes('go'));
  assert.deepEqual(first, { id: 'b', stack: ['go', 'ts'], commands: { build: 'make', test: 'npm test' } });
  assert.equal(x.repos?.find((r) => r.id === 'a')?.stack, undefined);
  assert.equal(x.repos?.find((r) => r.id === 'a')?.commands, undefined);
  assert.equal(x.repos?.find((r) => r.id === 'c')?.commands, undefined);
});
