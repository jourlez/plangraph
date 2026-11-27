// fetchConfluence and fetchJira on the odd answers: bad inputs, caps, loops, retries, soft failures and malformed rows. Inline recorded replies, synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchConfluence, toPlainText } from '../lib/fetch/confluence.ts';
import { fetchJira } from '../lib/fetch/jira.ts';
import type { Runner } from '../lib/fetch/gh.ts';

type Step = string | Error | { code: number; out: string; err: string };
const reply = (body: unknown, head: string[] = []): string => `HTTP/2.0 200 OK\n${head.join('\n')}${head.length ? '\n' : ''}\n${typeof body === 'string' ? body : JSON.stringify(body)}`;
function rec(steps: Step[]): { run: Runner; calls: string[] } {
  const calls: string[] = []; let i = 0;
  const run: Runner = async (argv) => {
    calls.push(String(argv.at(-1)));
    const s = steps[Math.min(i++, steps.length - 1)] as Step;
    if (s instanceof Error) throw s;
    if (typeof s === 'string') return { code: 0, out: s, err: '' };
    return s;
  };
  return { run, calls };
}
const API = '/wiki/api/v2/';
const page = (id: unknown, more: Record<string, unknown> = {}) => ({ id, title: 'T', status: 'current', version: { number: 2, createdAt: '2026-01-01T00:00:00.000Z' }, labels: { results: [{ name: 'plan' }, { nope: 1 }, 7] }, body: { storage: { value: '<p>hi</p>' } }, ...more });

test('toPlainText decodes numeric, hex and named entities and leaves bad ones alone', () => {
  assert.equal(toPlainText('a&#65;&#x42;&amp;&unknown;&#0;&#1114112;&NBSP;z', 100), 'aAB&&unknown;&#0;&#1114112; z');
  assert.equal(toPlainText('<!-- open comment', 100), '');
});

test('confluence refuses a bad space id and reports soft failures', async () => {
  const bad = await fetchConfluence(rec([]).run, { space: 'abc' });
  assert.equal(bad.status, 'soft');
  assert.match(bad.notes[0]!, /numeric space id/);
  assert.equal((await fetchConfluence(rec([]).run, { space: 5 as never })).status, 'soft');
  const net = await fetchConfluence(rec([new Error('boom')]).run, { space: '1', cursor: 'x' });
  assert.equal(net.status, 'soft');
  assert.equal(net.next, 'x');
  const noList = await fetchConfluence(rec([reply({ nothing: true })]).run, { space: '1' });
  assert.match(noList.notes[0]!, /no results list/);
  const notJson = await fetchConfluence(rec([reply('not json')]).run, { space: '1' });
  assert.equal(notJson.status, 'soft');
});

test('confluence: Retry-After keeps the cursor, the byte cap stops, a loop is soft', async () => {
  const r = await fetchConfluence(rec([{ code: 0, out: 'HTTP/2.0 429 Too Many\nRetry-After: 7\n\n', err: '' }]).run, { space: '1' });
  assert.equal(r.status, 'retry-after');
  assert.equal(r.retryAfter, 7);
  assert.match(r.next, /^\/wiki\/api\/v2\/spaces\/1\/pages/);
  const capped = await fetchConfluence(rec([reply({ results: [page('1')] })]).run, { space: '1', maxBytes: 10 });
  assert.equal(capped.status, 'capped');
  assert.match(capped.notes[0]!, /fetch\.max_bytes 10 reached/);
  const next = `${API}spaces/1/pages?limit=100&cursor=same`;
  const loop = await fetchConfluence(rec([reply({ results: [], _links: { next } })]).run, { space: '1', cursor: next });
  assert.equal(loop.status, 'soft');
  assert.match(loop.notes[0]!, /paging loop/);
});

test('confluence: labels filter, malformed rows, max items and a next link outside the API', async () => {
  const body = { results: [page('1'), page('2', { labels: { results: [{ name: 'other' }] } }), page('x9'), 'junk', page('3', { title: 5, status: 5, version: 'v', body: 'b', labels: 'l' }), page('4')] };
  const r = await fetchConfluence(rec([reply(body)]).run, { space: '1', labels: ['plan'] });
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.rows.map((x) => x.id), ['1', '4']);
  assert.ok(r.notes.some((n) => /skipped/.test(n)));
  const all = await fetchConfluence(rec([reply(body)]).run, { space: '1' });
  assert.deepEqual(all.rows.map((x) => x.id), ['1', '2', '3', '4']);
  assert.deepEqual(all.rows[2], { id: '3', title: '', status: '', version: 0, updated: '', labels: [], text: '' });
  const two = await fetchConfluence(rec([reply(body)]).run, { space: '1', maxItems: 2 });
  assert.equal(two.status, 'capped');
  assert.match(two.notes[0]!, /fetch\.max_items 2 reached/);
  const out = await fetchConfluence(rec([reply({ results: [page('1')], _links: { next: '/other/api' } })]).run, { space: '1' });
  assert.equal(out.status, 'ok');
  assert.ok(out.notes.some((n) => /outside the v2 API/.test(n)));
  const afterFull = await fetchConfluence(rec([reply({ results: [page('1')], _links: { next: `${API}spaces/1/pages?cursor=n` } })]).run, { space: '1', maxItems: 1 });
  assert.equal(afterFull.status, 'capped');
  assert.equal(afterFull.next, `${API}spaces/1/pages?cursor=n`);
  const resumed = rec([reply({ results: [] })]);
  await fetchConfluence(resumed.run, { space: '1', cursor: `${API}spaces/1/pages?cursor=r` });
  assert.equal(resumed.calls[0], `${API}spaces/1/pages?cursor=r`);
  const full = rec([reply({ results: [] })]);
  await fetchConfluence(full.run, { space: '1', cursor: `${API}spaces/1/pages?cursor=r`, full: true });
  assert.match(full.calls[0]!, /limit=100/);
});

const issue = (key: unknown, updated: unknown, more: Record<string, unknown> = {}) => ({ key, fields: { summary: 's', updated, ...more } });

test('jira: refused input, soft answers, retry and caps', async () => {
  const none = rec([]);
  assert.equal((await fetchJira(none.run, { jql: '' })).status, 'soft');
  assert.equal((await fetchJira(none.run, { jql: 'project = A order by updated' })).status, 'soft');
  assert.equal((await fetchJira(none.run, { jql: 5 as never })).status, 'soft');
  const bad = await fetchJira(none.run, { jql: 'project = A', watermark: 'nope' });
  assert.match(bad.notes[0]!, /not a date/);
  assert.equal(none.calls.length, 0);
  assert.equal((await fetchJira(rec([new Error('x')]).run, { jql: 'project = A' })).status, 'soft');
  assert.match((await fetchJira(rec([reply({ nope: 1 })]).run, { jql: 'project = A' })).notes[0]!, /no issues list/);
  assert.equal((await fetchJira(rec([reply('x')]).run, { jql: 'project = A' })).status, 'soft');
  const retry = await fetchJira(rec([{ code: 0, out: 'HTTP/2.0 503 x\nRetry-After: 3\n\n', err: '' }]).run, { jql: 'project = A' });
  assert.equal(retry.status, 'retry-after');
  assert.equal(retry.retryAfter, 3);
  const bytes = await fetchJira(rec([reply({ issues: [issue('A-1', '2026-01-01T00:00:00Z')] })]).run, { jql: 'project = A', maxBytes: 5 });
  assert.equal(bytes.status, 'capped');
  assert.match(bytes.notes[0]!, /max_bytes 5/);
});

test('jira: upsert keeps the newer copy, skips malformed issues, caps on items, pages and detects a loop', async () => {
  const issues = [issue('A-2', '2026-01-02T00:00:00Z'), issue('A-1', '2026-01-03T00:00:00Z'), issue('A-1', '2026-01-01T00:00:00Z', { summary: 'older' }), issue('bad', '2026-01-01T00:00:00Z'), issue(5, 'x'), { key: 'A-3' }, 'junk'];
  const r = await fetchJira(rec([reply({ issues, isLast: true })]).run, { jql: 'project = A', watermark: '2026-01-01T00:00:00Z' });
  assert.deepEqual(r.issues.map((i) => i.key), ['A-1', 'A-2']);
  assert.equal(r.issues[0]?.fields.summary, 's');
  assert.equal(r.nextWatermark, '2026-01-03T00:00:00.000Z');
  const capped = await fetchJira(rec([reply({ issues })]).run, { jql: 'project = A', maxItems: 1 });
  assert.equal(capped.status, 'capped');
  assert.match(capped.notes[0]!, /max_items 1/);
  const paged = rec([reply({ issues: [issue('A-1', '2026-01-01T00:00:00Z')], nextPageToken: 't1' }), reply({ issues: [issue('A-2', '2026-01-02T00:00:00Z')], isLast: true })]);
  const two = await fetchJira(paged.run, { jql: 'project = A' });
  assert.equal(two.issues.length, 2);
  assert.match(paged.calls[1]!, /nextPageToken=t1/);
  const cap2 = await fetchJira(rec([reply({ issues: [issue('A-1', '2026-01-01T00:00:00Z')], nextPageToken: 't1' })]).run, { jql: 'project = A', maxItems: 1 });
  assert.equal(cap2.status, 'capped');
  const loop = await fetchJira(rec([reply({ issues: [issue('A-1', '2026-01-01T00:00:00Z')], nextPageToken: 't1' })]).run, { jql: 'project = A' });
  assert.equal(loop.status, 'aborted');
  assert.deepEqual(loop.issues, []);
  assert.equal(loop.error, 'fetch jira: paging loop');
});

test('jira changelogs: transitions, tenant link, skipped tickets, retry and the byte cap', async () => {
  const hist = (id: unknown, items: unknown, created: unknown = '2026-01-01T00:00:00.000Z') => ({ id, created, items });
  const log = { values: [hist('10', [{ field: 'status', fromString: 'To Do', toString: 'Done' }]), hist(11, [{ field: 'other' }]), hist(12, 'x'), hist(null, []), hist('13', [{ field: 'status' }], 'bad'), hist(14, [{ field: 'status', fromString: 5 }])], isLast: true };
  const first = rec([reply({ issues: [], isLast: true }), reply(log)]);
  const r = await fetchJira(first.run, { jql: 'project = A', changelog: ['A-1', 'bad key', 'A-1'], tenant: 'acme' });
  assert.deepEqual(r.transitions?.observations.map((o) => o.xid), ['A-1#10', 'A-1#14']);
  assert.deepEqual(r.transitions?.observations[0]?.fields, { from: 'To Do', to: 'Done', at: '2026-01-01T00:00:00.000Z' });
  assert.deepEqual(r.transitions?.observations[0]?.links, [{ rel: 'x-jira/of', sys: 'jira:acme', xid: 'A-1' }]);
  assert.deepEqual(r.transitions?.observations[1]?.fields.from, '');
  const noTenant = await fetchJira(rec([reply({ issues: [], isLast: true }), reply(log)]).run, { jql: 'project = A', changelog: ['A-1'], tenant: '../x' });
  assert.deepEqual(noTenant.transitions?.observations[0]?.links, []);
  const pages = rec([reply({ issues: [], isLast: true }), reply({ values: [hist('1', [{ field: 'status' }])] }), reply({ values: [] })]);
  const p = await fetchJira(pages.run, { jql: 'project = A', changelog: ['A-1'] });
  assert.equal(p.transitions?.observations.length, 1);
  assert.match(pages.calls[2]!, /startAt=1/);
  const soft = await fetchJira(rec([reply({ issues: [], isLast: true }), { code: 1, out: '', err: 'x' }]).run, { jql: 'project = A', changelog: ['A-1'] });
  assert.ok(soft.notes.some((n) => /changelog of A-1 skipped/.test(n)));
  assert.deepEqual(soft.transitions?.observations, []);
  const retry = await fetchJira(rec([reply({ issues: [], isLast: true }), 'HTTP/2.0 429 x\nRetry-After: 9\n\n']).run, { jql: 'project = A', changelog: ['A-1'] });
  assert.equal(retry.status, 'retry-after');
  const cap = await fetchJira(rec([reply({ issues: [], isLast: true }), reply(log)]).run, { jql: 'project = A', changelog: ['A-1'], maxBytes: 100 });
  assert.equal(cap.status, 'capped');
  const notJson = await fetchJira(rec([reply({ issues: [], isLast: true }), reply('nope')]).run, { jql: 'project = A', changelog: ['A-1'] });
  assert.deepEqual(notJson.transitions?.observations, []);
});
