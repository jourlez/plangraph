// Per-file coverage floor: the optional-input and error branches of repo-page, flow actions, the traceability matrix and the module-facts reader.
// Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModel } from '../lib/model.ts';
import { actions } from '../lib/flow/actions.ts';
import { rtm } from '../lib/flow/rtm.ts';
import { parseModuleFacts, MODULE_FILE } from '../lib/history/module-facts.ts';
import { repoPage, commandBlock } from '../lib/docs/generators/repo-page.ts';
import { policyFromList } from '../lib/docs/policy.ts';
import type { Extras } from '../lib/docs/types.ts';

test('the docs types module loads and holds only types', async () => {
  const mod = await import('../lib/docs/types.ts');
  assert.deepEqual(Object.keys(mod), []);
});

const ev = (task: string, to: string, evidence: string[] = [], seq = 2) => ({ at: '2026-01-01T00:00:00Z', seq, actor: 'x', task, to, by: 'x', evidence });
const done = (task: string, evidence: string[]) => [ev(task, 'in_progress', [], 1), ev(task, 'done', evidence, 2)];

// ---- repo-page
const model = buildModel({ tickets: [{ key: 'A-1' }] });
const ctxOf = (extras: Extras, key?: string, inc: string[] = []) => ({ extras, cfg: {}, policy: policyFromList(inc), ...(key !== undefined ? { key } : {}) });

const keyOf = (e: Extras): string => repoPage.keys?.(model, e)[0] as string;

test('repo-page without a key falls back to the empty title and the x file name', () => {
  assert.equal(repoPage.title(), '# Repository ');
  assert.equal(repoPage.title('web'), '# Repository web');
  assert.equal(repoPage.out({} as never), 'repos/x.md');
  assert.equal(repoPage.out({} as never, 'web'), 'repos/web.md');
});

test('repo-page keys and render tolerate extras with no repos, and an unknown key renders the unknown marker', () => {
  assert.deepEqual(repoPage.keys?.(model, {}), []);
  assert.equal(repoPage.render(model, policyFromList([]), ctxOf({}, 'nope')), 'Unknown: repository');
  assert.equal(repoPage.render(model, policyFromList([]), ctxOf({ repos: [{ id: 'web' }] })), 'Unknown: repository');
});

test('repo-page for a bare repository prints the unknown stack, owner, no commands, no hotspots and no decisions', () => {
  const text = repoPage.render(model, policyFromList([]), ctxOf({ repos: [{ id: 'web' }] }, keyOf({ repos: [{ id: 'web' }] })));
  assert.match(text, /Stack: Unknown: stack\./);
  assert.match(text, /Owned by: Unknown: owner\./);
  assert.match(text, /No commands recorded\./);
  assert.match(text, /Unknown: no history facts/);
  assert.match(text, /Authors in these modules: 0\./);
  assert.match(text, /None recorded\./);
  assert.equal(commandBlock('web', undefined)[0], 'No commands recorded.');
});

test('repo-page with partial teams, decisions and modules: defaults for status and title, authors listed only when the policy says so', () => {
  const extras: Extras = {
    repos: [{ id: 'web', stack: ['node'], commands: { test: 'node --test' } }],
    teams: [{ id: 'T-1', owns: ['web'] }, { id: 'T-2' }],
    decisions: [{ id: 'D-1', affects: ['web/src'] }, { id: 'D-2', affects: ['other'] }, { id: 'D-3' }],
    modules: [{ repo: 'web', path: 'a.ts', hotspot: 3, authors: ['zed', 'amy'], bus1: true }, { repo: 'web', path: 'b.ts' }, { repo: 'other', path: 'c.ts', hotspot: 9 }],
  };
  const plain = repoPage.render(model, policyFromList([]), ctxOf(extras, keyOf(extras)));
  assert.match(plain, /Owned by: T-1\./);
  assert.match(plain, /\| D-1 \| proposed \| {2}\|/);
  assert.doesNotMatch(plain, /D-2|D-3/);
  assert.match(plain, /\| a\.ts \| 3 \| 0 \| yes \|/);
  assert.match(plain, /\| b\.ts \| 0 \| 0 \| no \|/);
  assert.match(plain, /Authors in these modules: 2\./);
  assert.match(plain, /node --test/);
  const withAuthors = repoPage.render(model, policyFromList(['authors']), ctxOf(extras, keyOf(extras)));
  assert.match(withAuthors, /Authors in these modules: amy, zed\./);
});

// ---- flow actions
const amodel = buildModel({
  tickets: [{ key: 'sp:a', summary: 'Login', sp: 2, epic: 'E1' }, { key: 'sp:b' }, { key: 'sp:c', summary: 'Gone' }, { key: 'sp:d', summary: 'Impl', impl_status: 'done' }],
  config: { closed_statuses: ['Shipped'] },
});
const x = (id: string, xid: string, sys = 'jira:acme') => ({ type: 'ticket' as const, id, sys, xid });

test('actions: create_ticket carries summary, sp and epic, falls back to the key, honours a custom tracker, and skips removed and skipped tasks', () => {
  const a = actions(amodel, [], { sys: 'linear', events: [ev('sp:c', 'removed')] });
  const byTask = Object.fromEntries(a.map((r) => [r.task, r]));
  assert.deepEqual(byTask['sp:a'], { op: 'create_ticket', sys: 'linear', task: 'sp:a', fields: { summary: 'Login', sp: 2, epic: 'E1' } });
  assert.deepEqual(byTask['sp:b']?.fields, { summary: 'sp:b' });
  assert.equal(byTask['sp:c'], undefined);
  const skipped = actions(amodel, [], { events: [ev('sp:c', 'skipped')] });
  assert.equal(skipped.some((r) => r.task === 'sp:c'), false);
});

test('actions: an observation whose fields (object or JSON text) name the task becomes a link; bad JSON and non-objects do not', () => {
  const obs = [
    { sys: 'jira:acme', xid: 'P-1', fields: JSON.stringify({ task: 'sp:a' }) },
    { sys: 'jira:acme', xid: 'P-2', fields: { task: 'sp:b' } },
    { sys: 'jira:acme', xid: 'P-3', fields: '{not json' },
    { sys: 'jira:acme', xid: 'P-4', fields: '[1,2]' },
    { sys: 'jira:acme', xid: 'P-5', fields: null },
  ];
  const a = actions(amodel, obs, {});
  assert.deepEqual(a.filter((r) => r.op === 'link').map((r) => [r.task, r.sys, r.fields]), [['sp:a', 'jira:acme', { xid: 'P-1' }], ['sp:b', 'jira:acme', { xid: 'P-2' }]]);
  assert.deepEqual(a.filter((r) => r.op === 'create_ticket').map((r) => r.task), ['sp:c', 'sp:d']);
});

test('actions: a tracked, plan-done task is moved to the done status unless the tracker is closed, already there (any case), unknown or has no status', () => {
  const xrefs = [x('sp:a', 'A-1'), x('sp:a', 'A-IGNORED'), x('sp:b', 'B-1'), x('sp:c', 'C-1'), x('sp:d', 'D-1'), { type: 'other' as never, id: 'sp:z', sys: 'jira:acme', xid: 'Z-1' }];
  const events = [...done('sp:a', ['pr:x']), ...done('sp:b', ['pr:x']), ...done('sp:c', ['pr:x'])];
  const obs = [
    { sys: 'jira:acme', xid: 'A-1', fields: { status: 'In Progress' } },
    { sys: 'jira:acme', xid: 'B-1', fields: JSON.stringify({ status: 'SHIPPED' }) },
    { sys: 'jira:acme', xid: 'C-1', fields: { status: 7 } },
    { sys: 'jira:acme', xid: 'D-1', fields: { status: 'Review' } },
  ];
  const a = actions(amodel, obs, { xrefs: xrefs as never, events });
  assert.deepEqual(a, [
    { op: 'transition_ticket', sys: 'jira:acme', task: 'sp:a', fields: { xid: 'A-1', from: 'In Progress', to: 'Done' } },
    { op: 'transition_ticket', sys: 'jira:acme', task: 'sp:d', fields: { xid: 'D-1', from: 'Review', to: 'Done' } },
  ]);
  const custom = actions(amodel, [{ sys: 'jira:acme', xid: 'A-1', fields: { status: 'resolved' } }], { xrefs: [x('sp:a', 'A-1')] as never, events: done('sp:a', ['pr:x']), doneStatus: 'Resolved' });
  assert.deepEqual(custom.filter((r) => r.op === 'transition_ticket'), [], 'a status equal to the done status ignoring case needs no move');
  assert.deepEqual(actions(amodel, [], { xrefs: [x('sp:a', 'A-1')] as never, events: done('sp:a', ['pr:x']) }).filter((r) => r.task === 'sp:a'), [], 'no observation, no move');
});

// ---- rtm
const rmodel = buildModel({ tickets: [{ key: 'sp:a' }, { key: 'sp:b' }, { key: 'sp:c' }] });
const S = (from: string, to: string, extra: object = {}) => ({ from, rel: 'satisfies', to, to_type: 'requirement', ...extra });

test('rtm: no extras at all gives no rows; links alone name their requirements', () => {
  assert.deepEqual(rtm(rmodel, []), []);
  const rows = rtm(rmodel, [], { links: [S('sp:b', 'R2'), S('sp:a', 'R2'), S('sp:a', 'R2'), { from: 'sp:c', rel: 'touches', to: 'R9', to_type: 'requirement' }, { from: 'sp:c', rel: 'satisfies', to: 'R8', to_type: 'repo' }] });
  assert.deepEqual(rows.map((r) => [r.requirement, r.status, r.tasks.map((t) => t.key)]), [['R2', 'proposed', ['sp:a', 'sp:b']]]);
});

test('rtm: implemented without proof, verified with a pr or test proof, and merged is passed to the state machine', () => {
  const links = [S('sp:a', 'R1'), S('sp:b', 'R2'), S('sp:c', 'R3')];
  const events = [...done('sp:a', ['note:x']), ...done('sp:b', ['test:t1']), ...done('sp:c', ['pr:o/r#1'])];
  const st = (merged?: (r: string) => boolean) => Object.fromEntries(rtm(rmodel, events, { links, ...(merged ? { merged } : {}) }).map((r) => [r.requirement, r.status]));
  assert.deepEqual(st(), { R1: 'implemented', R2: 'verified', R3: 'verified' });
  assert.deepEqual(st(() => true), { R1: 'implemented', R2: 'verified', R3: 'verified' });
});

test('rtm: a requirement whose only task is skipped is proposed, not implemented; an unlinked declared one is an orphan', () => {
  const rows = rtm(rmodel, [ev('sp:a', 'skipped')], { requirements: [{ id: 'R1' }, { id: 'R0' }], links: [S('sp:a', 'R1')] });
  assert.deepEqual(rows.map((r) => [r.requirement, r.status]), [['R0', 'orphan'], ['R1', 'proposed']]);
});

// ---- module facts
const good = (over: object = {}) => ({ repo: 'web', path: 'a.ts', commits: 1, churn: 2, window: 90, min_cochange: 3, hot_percentile: 90, last: '2026-01-01', hotspot: true, bus1: false, coupled: ['b.ts'], authors: [{ person: 'Ana', share: 1 }], ...over });
const text = (...rows: object[]) => rows.map((r) => JSON.stringify(r)).join('\n');

test('module facts: a valid row passes and a repeated (repo, path) keeps its first row', () => {
  assert.equal(MODULE_FILE, 'cache/git.jsonl');
  const rows = parseModuleFacts(text(good(), good({ churn: 9 }), good({ path: 'b.ts' })));
  assert.deepEqual(rows.map((r) => [r.path, r.churn]), [['a.ts', 2], ['b.ts', 2]]);
});

test('module facts: every kind of bad field is refused with an error naming the field and never the value', () => {
  const bad: Array<[object, RegExp]> = [
    [{ repo: 5 }, /"repo" must be a string/],
    [{ last: null }, /"last" must be a string/],
    [{ commits: -1 }, /"commits" must be a whole number/],
    [{ churn: 1.5 }, /"churn" must be a whole number/],
    [{ window: 'x' }, /"window" must be a whole number/],
    [{ hotspot: 'yes' }, /"hotspot" must be true or false/],
    [{ bus1: 1 }, /"bus1" must be true or false/],
    [{ coupled: 'b.ts' }, /"coupled" must be an array of strings/],
    [{ coupled: [1] }, /"coupled" must be an array of strings/],
    [{ authors: 'Ana' }, /"authors" must be an array/],
    [{ authors: [null] }, /"authors" must be an array/],
    [{ authors: [{ person: 1, share: 1 }] }, /"authors" must be an array/],
    [{ authors: [{ person: 'Ana', share: '1' }] }, /"authors" must be an array/],
  ];
  for (const [over, re] of bad) assert.throws(() => parseModuleFacts(text(good(over))), (e: Error) => re.test(JSON.stringify((e as { errors?: string[] }).errors ?? e.message)) || re.test(String(e.message)), JSON.stringify(over));
});
