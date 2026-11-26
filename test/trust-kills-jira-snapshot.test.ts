// Behavior tests for lib/jira/snapshot.ts, written to kill the mutants of the trust-root run: time parsing, issue normalization (caps, links,
// sprints), the full and delta pull with a fake client (query text, paging, failures, drift, summary), import, and the JSONL and legacy forms.
// Every comparison is on exact values. NOT covered: a real Jira (test/jira.test.ts runs a local mock server).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { str, parseJiraTime, normalizeIssue, pullSnapshot, importIssues, snapshotToJsonl, parseSnapshotJsonl, toLegacyMap } from '../lib/jira/snapshot.ts';
import { JiraError } from '../lib/jira/error.ts';

const iso = (s: string) => Date.parse(s);
const code = (c: string, msg?: string) => (e: JiraError) => e instanceof JiraError && e.code === c && (msg === undefined || e.message === msg);

test('str keeps strings only', () => { assert.equal(str('a'), 'a'); assert.equal(str(''), ''); for (const x of [1, null, undefined, {}, []]) assert.equal(str(x), ''); });

test('parseJiraTime: zones, fractions and rejects', () => {
  assert.equal(parseJiraTime('2026-03-01T12:00:00.000Z'), iso('2026-03-01T12:00:00.000Z'));
  assert.equal(parseJiraTime('2026-03-01T12:00:00Z'), iso('2026-03-01T12:00:00.000Z'));
  assert.equal(parseJiraTime('2026-03-01T12:00:00.5Z'), iso('2026-03-01T12:00:00.500Z'));
  assert.equal(parseJiraTime('2026-03-01T12:00:00.123456Z'), iso('2026-03-01T12:00:00.123Z'));
  assert.equal(parseJiraTime('2026-03-01T12:00:00.000+0530'), iso('2026-03-01T12:00:00.000+05:30'));
  assert.equal(parseJiraTime('2026-03-01T12:00:00.000+05:30'), iso('2026-03-01T12:00:00.000+05:30'));
  assert.equal(parseJiraTime('2026-03-01T12:00:00.000-0800'), iso('2026-03-01T12:00:00.000-08:00'));
  assert.equal(parseJiraTime('2026-03-01T12:00:00+02'), iso('2026-03-01T12:00:00.000+02:00'));
  for (const bad of ['2026-03-01 12:00:00Z', '2026-03-01T12:00:00', 'x', '', 5, null, undefined, '2026-3-01T12:00:00Z', '2026-03-01T12:00:00.Z']) assert.ok(Number.isNaN(parseJiraTime(bad)), String(bad));
});

const raw = (over: Record<string, unknown> = {}, fields: Record<string, unknown> = {}) => ({ key: 'AB-1', fields: { summary: 'S', status: { name: 'Open' }, assignee: { displayName: 'Ann' }, updated: '2026-03-01T10:00:00.000Z', resolutiondate: '', issuelinks: [], ...fields }, ...over }) as never;

test('normalizeIssue: key rule, fields and caps', () => {
  for (const bad of [null, undefined, {}, { key: 5 }, { key: 'ab-1' }, { key: 'AB-' }, { key: 'AB-1x' }, { key: ' AB-1' }, { key: 'A-1\n' }]) assert.equal(normalizeIssue(bad as never), null, JSON.stringify(bad));
  assert.deepEqual(normalizeIssue(raw()), { key: 'AB-1', summary: 'S', status: 'Open', assignee: 'Ann', updated: '2026-03-01T10:00:00.000Z', resolutiondate: '', issuelinks: [] });
  assert.deepEqual(normalizeIssue({ key: 'X9-12' } as never), { key: 'X9-12', summary: '', status: '', assignee: '', updated: '', resolutiondate: '', issuelinks: [] });
  assert.equal(normalizeIssue({ key: 'AB-1', fields: 'nope' } as never)?.summary, '');
  assert.equal(normalizeIssue({ key: 'AB-1', fields: null } as never)?.summary, '');
  const long = normalizeIssue(raw({}, { summary: 's'.repeat(301), assignee: { displayName: 'a'.repeat(301) }, status: { name: 'n'.repeat(81) } }));
  assert.equal(long?.summary, `${'s'.repeat(300)}…[+1 chars]`); assert.equal(long?.assignee, `${'a'.repeat(300)}…[+1 chars]`); assert.equal(long?.status, `${'n'.repeat(80)}…[+1 chars]`);
  const edge = normalizeIssue(raw({}, { summary: 's'.repeat(300), assignee: { displayName: 'a'.repeat(300) }, status: { name: 'n'.repeat(80) } }));
  assert.equal(edge?.summary, 's'.repeat(300)); assert.equal(edge?.assignee, 'a'.repeat(300)); assert.equal(edge?.status, 'n'.repeat(80));
  assert.equal('sprint' in (normalizeIssue(raw()) as object), false);
});

test('normalizeIssue: links of both directions, validated, capped and sorted', () => {
  const links = [
    { type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }, inwardIssue: { key: 'ZZ-2' } },
    { type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }, outwardIssue: { key: 'AA-9' } },
    { type: { name: 'Relates', inward: 'relates to', outward: 'relates to' }, inwardIssue: { key: 'AA-9' }, outwardIssue: { key: 'AA-9' } },
    { type: { name: 'Bad' }, inwardIssue: { key: 'nope' }, outwardIssue: { key: 5 } }, null, 5, { inwardIssue: null },
    { type: { name: 'n'.repeat(81), inward: 'i'.repeat(81) }, inwardIssue: { key: 'AA-1' } },
  ];
  const n = normalizeIssue(raw({}, { issuelinks: links }));
  assert.deepEqual(n?.issuelinks, [
    { key: 'AA-1', type: `${'n'.repeat(80)}…[+1 chars]`, dir: 'in', rel: `${'i'.repeat(80)}…[+1 chars]` },
    { key: 'AA-9', type: 'Blocks', dir: 'out', rel: 'blocks' },
    { key: 'AA-9', type: 'Relates', dir: 'in', rel: 'relates to' },
    { key: 'AA-9', type: 'Relates', dir: 'out', rel: 'relates to' },
    { key: 'ZZ-2', type: 'Blocks', dir: 'in', rel: 'is blocked by' },
  ]);
  assert.deepEqual(normalizeIssue(raw({}, { issuelinks: 'x' }))?.issuelinks, []);
  const same = normalizeIssue(raw({}, { issuelinks: [{ type: { name: 'T' }, inwardIssue: { key: 'AA-1' }, outwardIssue: { key: 'AA-1' } }] }));
  assert.deepEqual(same?.issuelinks.map((l) => l.dir), ['in', 'out']);
  const types = normalizeIssue(raw({}, { issuelinks: [{ type: { name: 'B' }, inwardIssue: { key: 'AA-1' } }, { type: { name: 'A' }, inwardIssue: { key: 'AA-1' } }] }));
  assert.deepEqual(types?.issuelinks.map((l) => l.type), ['A', 'B']);
});

test('normalizeIssue: sprints from the connector custom fields, the REST field, and legacy strings', () => {
  const sp = (id: number, name = `S${id}`, state = 'active') => ({ id, name, state });
  const cf = (entries: Record<string, unknown>) => normalizeIssue(raw({}, { customFields: entries }), { sprintField: 'customfield_10020' })?.sprint;
  assert.deepEqual(cf({ 'Sprint X': { id: 'customfield_10020', value: [sp(5)] } }), [sp(5)]);
  assert.deepEqual(normalizeIssue(raw({}, { customFields: { Sprint: { id: 'other', value: [sp(6)] } } }))?.sprint, [sp(6)]);
  assert.deepEqual(cf({ Sprint: { id: 'other', value: [sp(6)] }, Other: { id: 'customfield_10020', value: [sp(7)] } }), [sp(7)], 'the id match comes before the name Sprint');
  assert.deepEqual(cf({ Sprint: null }), []); assert.deepEqual(cf({ Sprint: [] }), []); assert.deepEqual(cf({ Sprint: 'x' }), []);
  assert.deepEqual(normalizeIssue(raw({}, { customfield_10020: [sp(8)] }), { sprintField: 'customfield_10020' })?.sprint, [sp(8)]);
  assert.deepEqual(normalizeIssue(raw({}, { customFields: [] , customfield_10020: [sp(9)] }), { sprintField: 'customfield_10020' })?.sprint, [sp(9)]);
  assert.deepEqual(normalizeIssue(raw({}, {}), { sprintField: 'customfield_10020' })?.sprint, []);
  assert.deepEqual(normalizeIssue(raw({}, { constructor: [sp(1)], __proto__x: 1 }), { sprintField: 'constructor' })?.sprint, []);
  assert.deepEqual(normalizeIssue(raw({}, {}), { sprintField: '__proto__' })?.sprint, []);
  assert.deepEqual(cf({ __proto__: { id: 'customfield_10020', value: [sp(1)] } }), []);
  // legacy strings and bad entries
  const legacy = 'com.atlassian.greenhopper.service.sprint.Sprint@1[id=42,rapidViewId=1,state=CLOSED,name=Sprint 42,startDate=x]';
  assert.deepEqual(normalizeIssue(raw({}, { customfield_10020: [legacy, null, 5, { id: 'x' }, 'no id here'] }), { sprintField: 'customfield_10020' })?.sprint, [
    { id: 0, name: '', state: '' }, { id: 0, name: '', state: '' }, { id: 0, name: '', state: '' }, { id: 0, name: '', state: '' }, { id: 42, name: 'Sprint 42', state: 'CLOSED' },
  ]);
  assert.deepEqual(normalizeIssue(raw({}, { customfield_10020: [{ id: 3, name: 'n'.repeat(81), state: 's'.repeat(21) }, { id: '4', name: 5, state: null }, { id: 1e300, name: 'big' }] }), { sprintField: 'customfield_10020' })?.sprint, [
    { id: 0, name: 'big', state: '' }, { id: 3, name: `${'n'.repeat(80)}…[+1 chars]`, state: `${'s'.repeat(20)}…[+1 chars]` }, { id: 4, name: '', state: '' },
  ]);
  // only the 20 highest ids survive, ordered by id, ties by position
  const many = Array.from({ length: 25 }, (_, i) => sp(i + 1));
  assert.deepEqual(normalizeIssue(raw({}, { customfield_10020: many }), { sprintField: 'customfield_10020' })?.sprint?.map((s) => s.id), Array.from({ length: 20 }, (_, i) => i + 6));
  assert.deepEqual(normalizeIssue(raw({}, { customfield_10020: [sp(5), sp(5, 'second'), sp(3)] }), { sprintField: 'customfield_10020' })?.sprint?.map((s) => s.name), ['S3', 'S5', 'second']);
  assert.equal(normalizeIssue(raw({}, { customfield_10020: Array.from({ length: 21 }, (_, i) => sp(100)) }), { sprintField: 'customfield_10020' })?.sprint?.length, 20);
  assert.deepEqual(normalizeIssue(raw({}, { customfield_10020: 'not an array' }), { sprintField: 'customfield_10020' })?.sprint, []);
  const longLegacy = `id=7,name=${'q'.repeat(5000)}`;
  assert.deepEqual(normalizeIssue(raw({}, { customfield_10020: [longLegacy] }), { sprintField: 'customfield_10020' })?.sprint, [{ id: 7, name: `${'q'.repeat(80)}…[+${4000 - 'id=7,name='.length - 80} chars]`, state: '' }]);
  assert.deepEqual(normalizeIssue(raw({}, { customfield_10020: [`name=a]b,id=1`] }), { sprintField: 'customfield_10020' })?.sprint, [{ id: 1, name: 'a', state: '' }]);
});

// ---------------------------------------------------------------- pullSnapshot
type Page = { issues: unknown[]; cursor?: string | number | null; last: boolean };
const T0 = '2026-03-01T12:00:00.000Z';
const mkClient = (pages: Page[] | ((q: { jql: string; fields: string[]; pageSize: number; cursor?: unknown }, n: number) => Page), over: Record<string, unknown> = {}) => {
  const queries: Array<{ jql: string; fields: string[]; pageSize: number; cursor?: unknown }> = [];
  const counts: string[] = [];
  const client = {
    mode: 'scoped', identity: { cloud_id: 'cid' }, now: () => new Date(T0),
    verify: async () => ({ timeZone: 'UTC' }),
    search: async (q: { jql: string; fields: string[]; pageSize: number; cursor?: unknown }) => { queries.push(q); if (queries.length > 30) throw new Error('runaway paging'); return typeof pages === 'function' ? pages(q, queries.length) : (pages[queries.length - 1] as Page); },
    count: async (jql: string) => { counts.push(jql); return 2; },
    ...over,
  };
  return { client: client as never, queries, counts };
};
const rawIssue = (key: string, updated: string, extra: Record<string, unknown> = {}) => ({ key, fields: { summary: key, status: { name: 'Open' }, updated, ...extra } });
const A = rawIssue('AB-1', '2026-03-01T10:00:00.000Z'), B = rawIssue('AB-2', '2026-03-01T11:00:00.000Z');

test('a full pull without a previous snapshot: query, meta, hash, summary', async () => {
  const { client, queries, counts } = mkClient([{ issues: [B, A], last: true }]);
  const r = await pullSnapshot(client, { jql: '  project = AB  ' });
  assert.equal(r.ok, true); if (!r.ok) return;
  assert.deepEqual(queries, [{ jql: 'project = AB ORDER BY key ASC', fields: ['assignee', 'issuelinks', 'resolutiondate', 'status', 'summary', 'updated'], pageSize: 100, cursor: null }]);
  assert.deepEqual(counts, ['project = AB']);
  const issues = [normalizeIssue(A as never), normalizeIssue(B as never)];
  assert.deepEqual(r.snapshot.issues, issues);
  assert.deepEqual(r.snapshot.meta, { jql: 'project = AB', fetched_at: T0, mode: 'scoped', cloud_id: 'cid', expected_count: 2, received_count: 2, count_drift: 0, complete: true, content_hash: crypto.createHash('sha256').update(JSON.stringify(issues)).digest('hex'), pull: 'full', delta_runs: 0 });
  assert.equal(r.snapshot.schema, 1); assert.equal(r.mode, 'full'); assert.equal(r.reason, 'no-previous'); assert.equal(r.received, 2); assert.equal(r.windowMinutes, 5);
  assert.deepEqual(r.changedKeys, []); assert.deepEqual(r.removedKeys, []); assert.deepEqual(r.warnings, []);
  assert.equal(r.summary, `pulled 2 issues (full), drift 0, complete, hash ${r.snapshot.meta.content_hash?.slice(0, 6)}`);
});

test('jql and fields are validated before anything is fetched', async () => {
  const { client, queries } = mkClient([]);
  await assert.rejects(() => pullSnapshot(client, {}), code('unbounded_jql', 'refusing an empty or ORDER BY-only JQL: Jira rejects it, add a restriction (for example project = ABC)'));
  await assert.rejects(() => pullSnapshot(client, { jql: '   ' }), code('unbounded_jql'));
  await assert.rejects(() => pullSnapshot(client, { jql: 'ORDER BY key' }), code('unbounded_jql'));
  await assert.rejects(() => pullSnapshot(client, { jql: 'order  by key desc' }), code('unbounded_jql'));
  await assert.rejects(() => pullSnapshot(client, { jql: 5 as never }), code('unbounded_jql'));
  await assert.rejects(() => pullSnapshot(client, { jql: 'x'.repeat(20001) }), code('bad_jql', 'JQL is too long'));
  for (const fields of [[], 'summary', ['summary', 5], ['*all'], ['-summary'], ['1x'], [''], ['a b'], null] as unknown[]) {
    await assert.rejects(() => pullSnapshot(client, { jql: 'project = AB', fields: fields as never }), code('bad_fields', 'fields must be an explicit non-empty list of field ids (no *all, no negations)'), JSON.stringify(fields));
  }
  assert.deepEqual(queries, []);
  const ok = mkClient([{ issues: [], last: true }]);
  await pullSnapshot(ok.client, { jql: `${'x'.repeat(19990)} = 1` });
  assert.equal(ok.queries.length, 1);
  const order = mkClient([{ issues: [], last: true }]);
  await pullSnapshot(order.client, { jql: 'project = AB ORDER BY key DESC' });
  assert.equal(order.queries[0]?.jql, 'project = AB ORDER BY key ASC');
  const quoted = mkClient([{ issues: [], last: true }]);
  await pullSnapshot(quoted.client, { jql: 'summary ~ "order by x" ORDER BY key' });
  assert.equal(quoted.queries[0]?.jql, 'summary ~ "order by x" ORDER BY key ASC');
  const f = mkClient([{ issues: [], last: true }]);
  await pullSnapshot(f.client, { jql: 'project = AB', fields: ['summary', 'Zed_1.x-y'], sprintField: 'customfield_9' });
  assert.deepEqual(f.queries[0]?.fields, ['Zed_1.x-y', 'customfield_9', 'summary', 'updated']);
});

test('credentials are verified first: a failed verify fetches nothing', async () => {
  const { client, queries, counts } = mkClient([], { verify: async () => { throw new JiraError('auth', 'no'); } });
  await assert.rejects(() => pullSnapshot(client, { jql: 'project = AB' }), code('auth', 'no'));
  assert.deepEqual(queries, []); assert.deepEqual(counts, []);
});

const prevSnap = (over: Record<string, unknown> = {}, metaOver: Record<string, unknown> = {}) => ({
  schema: 1, issues: [normalizeIssue(A as never), normalizeIssue(B as never)],
  meta: { jql: 'project = AB', fetched_at: '2026-03-01T11:30:00.000Z', mode: 'scoped', cloud_id: 'cid', complete: true, delta_runs: 2, ...metaOver }, ...over,
}) as never;

test('a delta pull asks for the window since the newest update, merges, never overwrites with a staler read', async () => {
  const newer = rawIssue('AB-2', '2026-03-01T11:30:00.000Z', { summary: 'B2' }), stale = rawIssue('AB-1', '2026-03-01T09:00:00.000Z', { summary: 'old' }), fresh = rawIssue('AB-3', '2026-03-01T11:40:00.000Z');
  const { client, queries } = mkClient([{ issues: [newer, stale, fresh], last: true }]);
  const r = await pullSnapshot(client, { jql: 'project = AB', previous: prevSnap() });
  assert.equal(r.ok, true); if (!r.ok) return;
  assert.equal(queries[0]?.jql, '(project = AB) AND updated >= "2026-03-01 10:55" ORDER BY key ASC');
  assert.equal(r.mode, 'delta'); assert.equal(r.reason, ''); assert.deepEqual(r.changedKeys, ['AB-2', 'AB-3']); assert.deepEqual(r.removedKeys, []);
  assert.deepEqual(r.snapshot.issues.map((i) => [i.key, i.summary]), [['AB-1', 'AB-1'], ['AB-2', 'B2'], ['AB-3', 'AB-3']]);
  assert.equal(r.snapshot.meta.pull, 'delta'); assert.equal(r.snapshot.meta.delta_runs, 3);
  assert.equal(r.summary, `pulled 3 issues (delta 2, window 5m), drift 1, complete, hash ${r.snapshot.meta.content_hash?.slice(0, 6)}, WARN count_drift`.replace(', WARN count_drift', ''));
  // an unchanged re-read is not a change; an equal timestamp with a different body replaces
  const again = mkClient([{ issues: [rawIssue('AB-2', '2026-03-01T11:00:00.000Z')], last: true }]);
  const r2 = await pullSnapshot(again.client, { jql: 'project = AB', previous: prevSnap() });
  assert.ok(r2.ok && r2.changedKeys.length === 0);
  const eq = mkClient([{ issues: [rawIssue('AB-2', '2026-03-01T11:00:00.000Z', { summary: 'changed' })], last: true }]);
  const r3 = await pullSnapshot(eq.client, { jql: 'project = AB', previous: prevSnap() });
  assert.ok(r3.ok && r3.changedKeys.join() === 'AB-2' && r3.snapshot.issues[1]?.summary === 'changed');
  // overlapMinutes and since
  const w = mkClient([{ issues: [], last: true }]);
  await pullSnapshot(w.client, { jql: 'project = AB', previous: prevSnap(), overlapMinutes: 60 });
  assert.equal(w.queries[0]?.jql, '(project = AB) AND updated >= "2026-03-01 10:00" ORDER BY key ASC');
  const s = mkClient([{ issues: [], last: true }]);
  const rs = await pullSnapshot(s.client, { jql: 'project = AB', previous: prevSnap(), since: '2026-03-02T00:10:00Z' });
  assert.equal(s.queries[0]?.jql, '(project = AB) AND updated >= "2026-03-02 00:05" ORDER BY key ASC'); assert.ok(rs.ok && rs.windowMinutes === 5);
  const tz = mkClient([{ issues: [], last: true }], { verify: async () => ({ timeZone: 'Asia/Kolkata' }) });
  await pullSnapshot(tz.client, { jql: 'project = AB', previous: prevSnap() });
  assert.equal(tz.queries[0]?.jql, '(project = AB) AND updated >= "2026-03-01 16:25" ORDER BY key ASC');
});

test('a delta falls back to the fetch time when no updated stamp is usable, and to a full pull when it cannot be formed', async () => {
  const noStamps = prevSnap({ issues: [{ ...normalizeIssue(A as never), updated: 'garbage' }] });
  const a = mkClient([{ issues: [], last: true }]);
  await pullSnapshot(a.client, { jql: 'project = AB', previous: noStamps });
  assert.equal(a.queries[0]?.jql, '(project = AB) AND updated >= "2026-03-01 11:25" ORDER BY key ASC');
  const none = mkClient([{ issues: [], last: true }], { verify: async () => ({}) });
  const r = await pullSnapshot(none.client, { jql: 'project = AB', previous: prevSnap() });
  assert.ok(r.ok && r.mode === 'full' && r.reason === 'no-timezone' && r.warnings[0] === 'delta_unavailable:no-timezone');
  assert.equal(none.queries[0]?.jql, 'project = AB ORDER BY key ASC');
  const badTz = mkClient([{ issues: [], last: true }], { verify: async () => ({ timeZone: 'Not/AZone' }) });
  const b = await pullSnapshot(badTz.client, { jql: 'project = AB', previous: prevSnap() });
  assert.ok(b.ok && b.mode === 'full' && b.reason === 'bad-since' && b.warnings.includes('delta_unavailable:no-timezone') === false);
  const badSince = mkClient([{ issues: [], last: true }]);
  const c = await pullSnapshot(badSince.client, { jql: 'project = AB', previous: prevSnap(), since: 'not a date' as never });
  assert.ok(c.ok && c.mode === 'delta', 'an unreadable since falls back to the fetch time');
  assert.equal(badSince.queries[0]?.jql, '(project = AB) AND updated >= "2026-03-01 11:25" ORDER BY key ASC');
});

test('a previous snapshot is used only when it matches schema, completeness, jql, mode and identity', async () => {
  const cases: Array<[string, unknown]> = [
    ['schema', prevSnap({ schema: 2 })], ['incomplete', prevSnap({}, { complete: false })], ['complete as text', prevSnap({}, { complete: 'true' })], ['jql', prevSnap({}, { jql: 'project = OTHER' })], ['mode', prevSnap({}, { mode: 'site-token' })],
    ['identity', prevSnap({}, { cloud_id: 'other' })], ['no meta', prevSnap({ meta: null })], ['issues', prevSnap({ issues: 'x' })], ['null', null],
  ];
  for (const [name, previous] of cases) {
    const { client } = mkClient([{ issues: [A], last: true }]);
    const r = await pullSnapshot(client, { jql: 'project = AB', previous: previous as never });
    assert.ok(r.ok && r.mode === 'full' && r.reason === 'no-previous' && r.removedKeys.length === 0, name);
  }
  const { client } = mkClient([{ issues: [A], last: true }]);
  const r = await pullSnapshot(client, { jql: 'project = AB', previous: prevSnap() });
  assert.ok(r.ok && r.mode === 'delta');
});

test('a full pull over a previous snapshot reports changed and removed keys; reconcile and flag force it', async () => {
  const changed = rawIssue('AB-1', '2026-03-01T10:00:00.000Z', { summary: 'new' });
  const { client } = mkClient([{ issues: [changed, rawIssue('AB-9', '2026-03-01T10:00:00.000Z')], last: true }]);
  const r = await pullSnapshot(client, { jql: 'project = AB', previous: prevSnap(), full: true });
  assert.ok(r.ok); if (!r.ok) return;
  assert.equal(r.reason, 'flag'); assert.deepEqual(r.changedKeys, ['AB-1', 'AB-9']); assert.deepEqual(r.removedKeys, ['AB-2']); assert.deepEqual(r.snapshot.issues.map((i) => i.key), ['AB-1', 'AB-9']);
  assert.equal(r.snapshot.meta.delta_runs, 0);
  assert.match(r.summary, /^pulled 2 issues \(full, removed 1\), drift 0, complete, hash [0-9a-f]{6}$/);
  for (const [every, runs, expected] of [[3, 2, 'reconcile'], [3, 1, ''], [0, 99, ''], [1, 0, 'reconcile'], [2, 1, 'reconcile']] as const) {
    const c = mkClient([{ issues: [], last: true }]);
    const x = await pullSnapshot(c.client, { jql: 'project = AB', previous: prevSnap({}, { delta_runs: runs }), fullReconcileEvery: every });
    assert.ok(x.ok && x.reason === expected, `every ${every} runs ${runs}`);
  }
  const noRuns = mkClient([{ issues: [], last: true }]);
  const nr = await pullSnapshot(noRuns.client, { jql: 'project = AB', previous: prevSnap({}, { delta_runs: undefined }), fullReconcileEvery: 1 });
  assert.ok(nr.ok && nr.reason === 'reconcile');
});

test('paging: cursors are passed on, duplicates keep the newest, bad keys are dropped and counted', async () => {
  const { client, queries } = mkClient([
    { issues: [rawIssue('AB-1', '2026-03-01T10:00:00.000Z', { summary: 'first' }), { key: 'bad' }, null], cursor: 'c1', last: false },
    { issues: [rawIssue('AB-1', '2026-03-01T09:00:00.000Z', { summary: 'older' }), rawIssue('AB-2', '2026-03-01T10:00:00.000Z')], cursor: 'c2', last: false },
    { issues: [rawIssue('AB-1', '2026-03-01T10:00:00.000Z', { summary: 'same time wins later' })], last: true },
  ]);
  const r = await pullSnapshot(client, { jql: 'project = AB', pageSize: 7 });
  assert.ok(r.ok); if (!r.ok) return;
  assert.deepEqual(queries.map((q) => [q.cursor, q.pageSize]), [[null, 7], ['c1', 7], ['c2', 7]]);
  assert.equal(r.snapshot.issues[0]?.summary, 'same time wins later'); assert.equal(r.received, 6);
  assert.deepEqual(r.warnings, ['invalid_key_dropped:2', 'count_drift'].filter((w) => w !== 'count_drift'));
});

test('paging failures are returned, never thrown, with the reason and the reset time', async () => {
  const loop = mkClient([{ issues: [A], cursor: 'same', last: false }, { issues: [], cursor: 'same', last: false }]);
  const a = await pullSnapshot(loop.client, { jql: 'project = AB' });
  assert.deepEqual([a.ok, a.ok ? '' : a.code, a.ok ? '' : a.error], [false, 'pagination_loop', 'Jira returned the same page cursor twice']);
  assert.equal(a.summary, 'INCOMPLETE after 1 issues (pagination_loop): Jira returned the same page cursor twice; nothing written');
  if (!a.ok) { assert.equal(a.complete, false); assert.equal(a.snapshot, null); assert.equal(a.received, 1); assert.deepEqual(a.changedKeys, []); assert.deepEqual(a.removedKeys, []); assert.deepEqual(a.warnings, []); }
  // a first page that repeats the starting cursor (null) is a loop too
  const first = mkClient([{ issues: [A], cursor: null, last: false }]);
  const f = await pullSnapshot(first.client, { jql: 'project = AB' });
  assert.ok(!f.ok && f.code === 'pagination_loop');
  const stall = mkClient((_q, n) => ({ issues: [], cursor: `c${n}`, last: false }));
  const s = await pullSnapshot(stall.client, { jql: 'project = AB' });
  assert.ok(!s.ok && s.code === 'pagination_stalled' && s.error === 'Jira returned several empty pages without finishing'); assert.equal(stall.queries.length, 4);
  const pages = mkClient((_q, n) => ({ issues: [rawIssue(`AB-${n}`, '2026-03-01T10:00:00.000Z')], cursor: `c${n}`, last: false }));
  const p = await pullSnapshot(pages.client, { jql: 'project = AB', maxPages: 3 });
  assert.ok(!p.ok && p.code === 'too_many_pages' && p.error === 'stopped after 3 pages' && p.received === 3); assert.equal(pages.queries.length, 3);
  assert.equal(p.summary, 'INCOMPLETE after 3 issues (too_many_pages): stopped after 3 pages; nothing written');
  const quota = mkClient([], { search: async () => { throw new JiraError('quota', 'quota out', { status: 429, resetAt: '2026-03-02T00:00:00.000Z' }); } });
  const q = await pullSnapshot(quota.client, { jql: 'project = AB' });
  assert.ok(!q.ok && q.resetAt === '2026-03-02T00:00:00.000Z' && q.code === 'quota');
  assert.equal(q.summary, 'INCOMPLETE after 0 issues (quota, resets 2026-03-02T00:00:00.000Z): quota out; nothing written');
  const odd = mkClient([], { search: async () => { throw new Error('boom'); } });
  const o = await pullSnapshot(odd.client, { jql: 'project = AB' });
  assert.ok(!o.ok && o.code === 'internal' && o.error === 'unexpected error: boom' && o.resetAt === undefined);
  // a falsy thrown value still fails the pull: an incomplete snapshot is never reported complete
  for (const [thrown, text] of [[null, 'null'], [undefined, 'undefined'], [0, '0'], ['', '']] as const) {
    const nul = mkClient([], { search: async () => { throw thrown; } });
    const n = await pullSnapshot(nul.client, { jql: 'project = AB' });
    assert.ok(!n.ok && n.code === 'internal' && n.error === `unexpected error: ${text}` && n.resetAt === undefined, String(thrown));
  }
  const empties = mkClient((_q, k) => (k <= 3 ? { issues: [], cursor: `c${k}`, last: false } : { issues: [A], last: true }));
  assert.ok((await pullSnapshot(empties.client, { jql: 'project = AB' })).ok, 'three empty pages are tolerated');
});

test('the count check: advisory, with a drift threshold of max(driftAbs, ceil(expected * driftPct))', async () => {
  const run = async (expected: number | null, received: number, opts: Record<string, unknown> = {}) => {
    const issues = Array.from({ length: received }, (_, i) => rawIssue(`AB-${i + 1}`, '2026-03-01T10:00:00.000Z'));
    const { client } = mkClient([{ issues, last: true }], { count: async () => { if (expected === null) throw new Error('down'); return expected; } });
    const r = await pullSnapshot(client, { jql: 'project = AB', ...opts });
    assert.ok(r.ok); return r.ok ? r : (undefined as never);
  };
  const none = await run(null, 3);
  assert.deepEqual(none.warnings, ['count_unavailable']); assert.equal(none.snapshot.meta.expected_count, null); assert.equal(none.snapshot.meta.count_drift, null);
  assert.match(none.summary, /drift n\/a, complete, hash [0-9a-f]{6}, WARN count_unavailable$/);
  assert.deepEqual((await run(3, 8)).warnings, []);       // drift 5, threshold 5
  assert.deepEqual((await run(3, 9)).warnings, ['count_drift']); // drift 6
  assert.deepEqual((await run(9, 3)).warnings, ['count_drift']); // drift -6
  assert.deepEqual((await run(8, 3)).warnings, []);       // drift -5
  assert.equal((await run(1000, 1120)).snapshot.meta.count_drift, 120);
  assert.deepEqual((await run(1000, 1120)).warnings, ['count_drift']); // threshold max(5, ceil(20)) = 20
  assert.deepEqual((await run(1000, 1020)).warnings, []);
  assert.deepEqual((await run(10, 12, { driftAbs: 1 })).warnings, ['count_drift']);
  assert.deepEqual((await run(10, 11, { driftAbs: 1 })).warnings, []);
  assert.deepEqual((await run(100, 110, { driftPct: 0.1, driftAbs: 0 })).warnings, []);
  assert.deepEqual((await run(100, 111, { driftPct: 0.1, driftAbs: 0 })).warnings, ['count_drift']);
  const w = await run(3, 9);
  assert.match(w.summary, /, drift 6, complete, hash [0-9a-f]{6}, WARN count_drift$/);
  const both = await run(null, 1);
  assert.deepEqual(both.warnings, ['count_unavailable']);
});

test('the sprint field is requested and kept in pulled issues', async () => {
  const { client } = mkClient([{ issues: [rawIssue('AB-1', '2026-03-01T10:00:00.000Z', { customfield_5: [{ id: 2, name: 'S2', state: 'active' }] })], last: true }]);
  const r = await pullSnapshot(client, { jql: 'project = AB', sprintField: 'customfield_5' });
  assert.ok(r.ok && JSON.stringify(r.snapshot.issues[0]?.sprint) === JSON.stringify([{ id: 2, name: 'S2', state: 'active' }]));
});

// ---------------------------------------------------------------- import
test('importIssues: accepted shapes and the refusal', () => {
  const one = rawIssue('AB-1', '2026-03-01T10:00:00.000Z');
  const shapes: unknown[] = [[one], { issues: [one] }, { issues: { nodes: [one] } }, { nodes: [one] }, one];
  for (const s of shapes) assert.equal(importIssues(null, s as never).imported, 1, JSON.stringify(s));
  for (const bad of [null, undefined, {}, 5, { issues: 'x' }, { issues: {} }, { key: 5 }]) assert.throws(() => importIssues(null, bad as never), code('bad_input', 'no issues found in the input (expected an array, {issues:[..]}, {issues:{nodes:[..]}} or one issue)'), JSON.stringify(bad));
  const r = importIssues(null, [one, { key: 'bad' }, null] as never, { now: () => new Date(T0) });
  assert.deepEqual(r.snapshot.meta, { source: 'import', imported_at: T0, received_count: 1, complete: false, pull: 'import', content_hash: r.snapshot.meta.content_hash });
  assert.equal(r.snapshot.schema, 1); assert.equal(r.imported, 1); assert.equal(r.dropped, 2); assert.deepEqual(r.changedKeys, ['AB-1']);
  assert.equal(r.summary, `imported 1 issue(s) (changed 1, dropped 2); snapshot now 1 issues, partial, hash ${r.snapshot.meta.content_hash?.slice(0, 6)}`);
  assert.equal(r.snapshot.meta.content_hash, crypto.createHash('sha256').update(JSON.stringify(r.snapshot.issues)).digest('hex'));
});

test('importIssues: merges over the previous snapshot, keeps what a slim answer leaves out, never regresses an issue', () => {
  const base = prevSnap({}, { jql: 'project = AB', extra: 'kept' });
  const withLinks = { ...(base as { issues: unknown[] }), issues: [{ ...normalizeIssue(A as never), issuelinks: [{ key: 'ZZ-1', type: 'T', dir: 'in', rel: 'r' }], sprint: [{ id: 1, name: 'S1', state: 'active' }] }, normalizeIssue(B as never)] };
  // a slim answer: only a status; summary, assignee, updated, resolutiondate, links and sprint stay
  const slim = importIssues(withLinks as never, [{ key: 'AB-1', fields: { status: { name: 'Done' } } }] as never);
  const kept = slim.snapshot.issues[0];
  assert.deepEqual(kept, { key: 'AB-1', summary: 'AB-1', status: 'Done', assignee: '', updated: '2026-03-01T10:00:00.000Z', resolutiondate: '', issuelinks: [{ key: 'ZZ-1', type: 'T', dir: 'in', rel: 'r' }], sprint: [{ id: 1, name: 'S1', state: 'active' }] });
  assert.equal(slim.snapshot.meta.extra, 'kept'); assert.equal(slim.snapshot.meta.jql, 'project = AB'); assert.equal(slim.snapshot.meta.complete, false); assert.equal(slim.snapshot.meta.source, 'import');
  assert.deepEqual(slim.changedKeys, ['AB-1']); assert.equal(slim.snapshot.issues.length, 2);
  // a present field, even empty or null, replaces; an own issuelinks replaces the known links
  const replaced = importIssues(withLinks as never, [{ key: 'AB-1', fields: { summary: '', assignee: null, issuelinks: [], updated: '2026-03-01T10:00:00.000Z' } }] as never).snapshot.issues[0];
  assert.equal(replaced?.summary, ''); assert.equal(replaced?.assignee, ''); assert.deepEqual(replaced?.issuelinks, []);
  // an issue without a fields object at all replaces every field (nothing says which ones it left out)
  const noFields = importIssues(withLinks as never, [{ key: 'AB-1' }] as never);
  assert.deepEqual(noFields.snapshot.issues[0]?.issuelinks, []); assert.equal(noFields.snapshot.issues[0]?.summary, '');
  // an older copy never replaces a newer one; the same or newer does
  const older = importIssues(withLinks as never, [rawIssue('AB-1', '2026-03-01T09:00:00.000Z', { summary: 'older' })] as never);
  assert.equal(older.snapshot.issues[0]?.summary, 'AB-1'); assert.deepEqual(older.changedKeys, []); assert.equal(older.imported, 1);
  const newer = importIssues(withLinks as never, [rawIssue('AB-1', '2026-03-01T10:00:01.000Z', { summary: 'newer' })] as never);
  assert.equal(newer.snapshot.issues[0]?.summary, 'newer');
  const unchanged = importIssues(withLinks as never, [{ ...A, fields: { ...(A as { fields: object }).fields, issuelinks: undefined } }] as never);
  assert.deepEqual(unchanged.changedKeys, []);
  // sprint: kept when the answer carries none, replaced when it does (even with an empty list)
  const sprintField = 'customfield_5';
  assert.deepEqual(importIssues(withLinks as never, [{ key: 'AB-1', fields: { status: { name: 'X' } } }] as never, { sprintField }).snapshot.issues[0]?.sprint, [{ id: 1, name: 'S1', state: 'active' }].map((s) => s).slice(0, 0).concat([{ id: 1, name: 'S1', state: 'active' }]));
  assert.deepEqual(importIssues(withLinks as never, [{ key: 'AB-1', fields: { status: { name: 'X' }, customfield_5: [] } }] as never, { sprintField }).snapshot.issues[0]?.sprint, []);
  assert.deepEqual(importIssues(null, [{ key: 'AB-1', fields: { customfield_5: [{ id: 3, name: 'N', state: 'closed' }] } }] as never, { sprintField }).snapshot.issues[0]?.sprint, [{ id: 3, name: 'N', state: 'closed' }]);
  // sorted by key, counts in the summary
  const sorted = importIssues(null, [rawIssue('ZZ-1', ''), rawIssue('AA-1', ''), rawIssue('AA-10', ''), rawIssue('AA-2', '')] as never);
  assert.deepEqual(sorted.snapshot.issues.map((i) => i.key), ['AA-1', 'AA-10', 'AA-2', 'ZZ-1']);
  const empty = importIssues(null, [] as never); assert.equal(empty.snapshot.issues.length, 0);
});

// ---------------------------------------------------------------- serialization
test('snapshot JSONL: head line, one issue per line, round trip, refusals; legacy map', () => {
  const s = prevSnap() as { schema: number; meta: Record<string, unknown>; issues: Array<{ key: string }> };
  const text = snapshotToJsonl(s as never);
  const lines = text.split('\n');
  assert.equal(lines.length, 4); assert.equal(lines[3], '');
  assert.equal(lines[0], JSON.stringify({ schema: 1, meta: s.meta })); assert.equal(lines[1], JSON.stringify(s.issues[0])); assert.equal(lines[2], JSON.stringify(s.issues[1]));
  assert.deepEqual(parseSnapshotJsonl(text), { schema: 1, meta: s.meta, issues: s.issues });
  const bad = (t: string) => assert.throws(() => parseSnapshotJsonl(t), code('bad_snapshot', 'unsupported snapshot schema'), t);
  bad(''); bad('{"schema":2,"meta":{}}\n'); bad('{"schema":1}\n'); bad('{"meta":{}}\n'); bad('{"schema":1,"meta":0}\n');
  assert.deepEqual(parseSnapshotJsonl('{"schema":1,"meta":{"a":1}}\n').issues, []);
  const legacy = toLegacyMap({ schema: 1, meta: {}, issues: [
    { key: 'AB-1', summary: 's', status: 'Open', assignee: 'a', updated: 'u', resolutiondate: 'r', issuelinks: [{ key: 'X-1', dir: 'in' }, { key: 'X-2', dir: 'out' }, { key: 'X-3', dir: 'in' }] },
  ] } as never);
  assert.deepEqual(legacy, { 'AB-1': { summary: 's', status: 'Open', assignee: 'a', updated: 'u', resolved: 'r', blockedBy: ['X-1', 'X-3'] } });
});

// ---------------------------------------------------------------- second round
test('same-key issues across pages: an unreadable time never beats a readable newer one', async () => {
  const { client } = mkClient([
    { issues: [rawIssue('AB-1', '2026-03-01T10:00:00.000Z', { summary: 'valid' })], cursor: 'c', last: false },
    { issues: [rawIssue('AB-1', '1999-garbage', { summary: 'garbage' })], last: true },
  ]);
  const r = await pullSnapshot(client, { jql: 'project = AB' });
  assert.ok(r.ok && r.snapshot.issues[0]?.summary === 'valid');
  const both = mkClient([{ issues: [rawIssue('AB-1', 'b-text', { summary: 'first' }), rawIssue('AB-1', 'a-text', { summary: 'second' })], last: true }]);
  const r2 = await pullSnapshot(both.client, { jql: 'project = AB' });
  assert.ok(r2.ok && r2.snapshot.issues[0]?.summary === 'first', 'two unreadable times compare as text');
});

test('sprints: ordering by id is exact for legacy strings, ties keep their order, and the caps are exact', () => {
  const sprints = (v: unknown) => normalizeIssue(raw({}, { customfield_1: v }), { sprintField: 'customfield_1' })?.sprint;
  assert.deepEqual(sprints(['id=9,name=nine', 'id=3,name=three', { id: 5, name: 'five' }]), [{ id: 3, name: 'three', state: '' }, { id: 5, name: 'five', state: '' }, { id: 9, name: 'nine', state: '' }]);
  assert.deepEqual((sprints(Array.from({ length: 6 }, (_, i) => ({ id: 7, name: `n${i}` }))) ?? []).map((s) => s.name), ['n0', 'n1', 'n2', 'n3', 'n4', 'n5']);
  assert.deepEqual((sprints([...Array.from({ length: 4 }, (_, i) => ({ id: 7, name: `t${i}` })), { id: 2, name: 'lo' }, { id: 9, name: 'hi' }]) ?? []).map((s) => s.name), ['lo', 't0', 't1', 't2', 't3', 'hi']);
  assert.equal(sprints([`${'x'.repeat(3997)}id=5`, 'id=2,name=b'])?.map((s) => s.id).join(), '0,2', 'an id that starts past the first 4000 characters is not read');
  assert.equal(sprints([`id=${'4'.repeat(10)}`])?.[0]?.id, 4444444444);
  const legacy = sprints(['id=1,name=' + 'n'.repeat(81) + ',state=' + 's'.repeat(21)]);
  assert.deepEqual(legacy, [{ id: 1, name: `${'n'.repeat(80)}…[+1 chars]`, state: `${'s'.repeat(20)}…[+1 chars]` }]);
  assert.deepEqual(sprints(['id=1,name=' + 'n'.repeat(80) + ',state=' + 's'.repeat(20)]), [{ id: 1, name: 'n'.repeat(80), state: 's'.repeat(20) }]);
});

test('custom fields: prototype-ish names and array containers are ignored; an id match counts as found on import', () => {
  const sp = { id: 3, name: 'S3', state: 'active' };
  const via = (cf: unknown) => normalizeIssue(raw({}, { customFields: cf }), { sprintField: 'customfield_5' })?.sprint;
  assert.deepEqual(via(JSON.parse(`{"__proto__":{"id":"customfield_5","value":[${JSON.stringify(sp)}]}}`)), []);
  assert.deepEqual(via({ prototype: { id: 'customfield_5', value: [sp] } }), []);
  assert.deepEqual(via({ constructor: { id: 'customfield_5', value: [sp] } }), []);
  assert.deepEqual(via([{ id: 'customfield_5', value: [sp] }]), []);
  assert.deepEqual(via({ Mine: { id: 'customfield_5', value: [sp] } }), [sp]);
  assert.deepEqual(via('text'), []);
  // import: an id match with an empty list replaces the known sprint (it was found), while an absent field keeps it
  const known = { schema: 1, meta: {}, issues: [{ ...normalizeIssue(raw()), sprint: [sp] }] } as never;
  const found = importIssues(known, [{ key: 'AB-1', fields: { customFields: { Mine: { id: 'customfield_5', value: [] } } } }] as never, { sprintField: 'customfield_5' });
  assert.deepEqual(found.snapshot.issues[0]?.sprint, []);
  const absent = importIssues(known, [{ key: 'AB-1', fields: { summary: 'S' } }] as never, { sprintField: 'customfield_5' });
  assert.deepEqual(absent.snapshot.issues[0]?.sprint, [sp]);
});

test('a slim import keeps every known field it leaves out, each on its own', () => {
  const full = { key: 'AB-1', summary: 'Sum', status: 'Open', assignee: 'Ann', updated: '2026-03-01T10:00:00.000Z', resolutiondate: '2026-03-02T00:00:00.000Z', issuelinks: [] };
  const known = { schema: 1, meta: {}, issues: [full] } as never;
  for (const field of ['summary', 'status', 'assignee', 'updated', 'resolutiondate']) {
    const fields: Record<string, unknown> = { summary: 'New', status: { name: 'New' }, assignee: { displayName: 'New' }, updated: '2026-03-01T11:00:00.000Z', resolutiondate: '2026-04-01T00:00:00.000Z' };
    delete fields[field];
    const issue = importIssues(known, [{ key: 'AB-1', fields }] as never).snapshot.issues[0] as unknown as Record<string, unknown>;
    assert.equal(issue[field], (full as Record<string, unknown>)[field], `${field} is kept`);
  }
});

test('a full pull over an identical previous snapshot changes nothing; a delta without delta_runs counts its first run', async () => {
  const same = mkClient([{ issues: [A, B], last: true }]);
  const r = await pullSnapshot(same.client, { jql: 'project = AB', previous: prevSnap(), full: true });
  assert.ok(r.ok && r.changedKeys.length === 0 && r.removedKeys.length === 0 && r.complete === true);
  const d = mkClient([{ issues: [], last: true }]);
  const noRuns = await pullSnapshot(d.client, { jql: 'project = AB', previous: prevSnap({}, { delta_runs: undefined }) });
  assert.ok(noRuns.ok && noRuns.mode === 'delta' && noRuns.snapshot.meta.delta_runs === 1);
  const e = mkClient([{ issues: [], last: true }]);
  const two = await pullSnapshot(e.client, { jql: 'project = AB', previous: prevSnap({}, { delta_runs: undefined }), fullReconcileEvery: 2 });
  assert.ok(two.ok && two.reason === '' && two.mode === 'delta');
});

test('limits: JQL of exactly 20000 characters passes, 2000 pages is the default bound (counted requests)', async () => {
  const exact = mkClient([{ issues: [], last: true }]);
  assert.ok((await pullSnapshot(exact.client, { jql: `${'x'.repeat(19996)} = 1` })).ok);
  assert.equal(`${'x'.repeat(19996)} = 1`.length, 20000);
  let calls = 0;
  const plain = { mode: 'scoped', identity: { cloud_id: 'cid' }, now: () => new Date(T0), verify: async () => ({ timeZone: 'UTC' }), count: async () => 1,
    search: async () => { calls++; if (calls > 2500) throw new Error('runaway paging'); return { issues: [rawIssue(`AB-${calls}`, '2026-03-01T10:00:00.000Z')], cursor: `c${calls}`, last: false }; } } as never;
  const r = await pullSnapshot(plain, { jql: 'project = AB' });
  assert.ok(!r.ok && r.code === 'too_many_pages' && r.error === 'stopped after 2000 pages'); assert.equal(calls, 2000);
});

test('several warnings are joined by + in the summary', async () => {
  const { client } = mkClient([{ issues: [A, { key: 'bad' }], last: true }], { count: async () => 99 });
  const r = await pullSnapshot(client, { jql: 'project = AB' });
  assert.ok(r.ok); if (!r.ok) return;
  assert.deepEqual(r.warnings, ['invalid_key_dropped:1', 'count_drift']);
  assert.match(r.summary, /, WARN invalid_key_dropped:1\+count_drift$/);
});

test('sprints with the same id keep their order, including unreadable ids (zero)', () => {
  const sprints = (v: unknown) => (normalizeIssue(raw({}, { customfield_1: v }), { sprintField: 'customfield_1' })?.sprint ?? []).map((s) => s.name);
  assert.deepEqual(sprints([{ id: 0, name: 'a' }, { id: 0, name: 'b' }, { id: 0, name: 'c' }, { id: 0, name: 'd' }]), ['a', 'b', 'c', 'd']);
  assert.deepEqual(sprints([{ id: 'x', name: 'a' }, { id: null, name: 'b' }, { name: 'c' }, { id: 4, name: 'z' }]), ['a', 'b', 'c', 'z']);
  assert.deepEqual(sprints([{ id: 2, name: 'a' }, { id: 1, name: 'b' }, { id: 2, name: 'c' }, { id: 1, name: 'd' }]), ['b', 'd', 'a', 'c']);
});

test('parseSnapshotJsonl names the file in its line errors', () => {
  assert.throws(() => parseSnapshotJsonl('{"schema":1,"meta":{}}\nnot json\n'), (e: Error) => /^snapshot\.jsonl:2: invalid JSON/.test(e.message));
});
