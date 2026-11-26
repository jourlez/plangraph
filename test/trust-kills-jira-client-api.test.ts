// Behavior tests for the API methods and error mapping of lib/jira/client.ts (verify, search, count, issue, changelog, the error answers, the
// body-read failures), written to kill the mutants of the trust-root run. Answers are fetch doubles; the paging loops are proved by counting
// requests (a runaway fails at once), never by a clock. NOT covered: the request allowlist and the 429 handling (test/trust-kills-jira-client.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeClient } from '../lib/jira/client.ts';
import type { JiraError } from '../lib/jira/error.ts';

const CLOUD = '11111111-2222-3333-4444-555555555555';
const creds = { email: 'ada@example.invalid', token: 'TOKEN-for-client-api-0123456789' };
type Fetch = NonNullable<Parameters<typeof makeClient>[0]>['fetchImpl'];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
interface Call { url: string; method: string; body: unknown }
const rig = (answer: (n: number, c: Call) => Response | Promise<Response>) => {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const c: Call = { url: url.replace(/^https:\/\/[^/]+(\/ex\/jira\/[^/]+)?/, ''), method: String(init.method), body: init.body === undefined ? undefined : JSON.parse(String(init.body)) };
    calls.push(c);
    if (calls.length > 60) throw new Error('runaway request loop');
    return answer(calls.length, c);
  }) as unknown as Fetch;
  return { calls, fetchImpl };
};
const cloud = (fetchImpl: Fetch, extra: Record<string, unknown> = {}) => makeClient({ baseConfig: { cloudId: CLOUD }, creds, fetchImpl, ...extra } as never);
const dc = (fetchImpl: Fetch, extra: Record<string, unknown> = {}) => makeClient({ baseConfig: { auth: { mode: 'datacenter' }, baseUrl: 'https://jira.corp:8443' }, creds: { token: creds.token }, dcHosts: 'jira.corp:8443', fetchImpl, ...extra } as never);
const err = (code: string, msg?: string | RegExp, status?: number) => (e: JiraError) => e.code === code && (msg === undefined || (typeof msg === 'string' ? e.message === msg : msg.test(e.message))) && (status === undefined || e.status === status);
const P = '/rest/api/3/myself';

test('error statuses map to their codes, carry the status, and say what was asked', async () => {
  for (const [status, c] of [[401, 'auth'], [403, 'forbidden'], [404, 'not_found'], [400, 'bad_request'], [500, 'http'], [418, 'http'], [402, 'http'], [405, 'http']] as const) {
    const { fetchImpl } = rig(() => json({ errorMessages: ['hidden'] }, status));
    await assert.rejects(() => cloud(fetchImpl).request('GET', P), c === 'bad_request' ? err(c, `Jira answered 400 on GET ${P}: hidden`, 400) : err(c, `Jira answered ${status} on GET ${P}`, status), String(status));
  }
});

test('a 400 reads errorMessages (strings joined by "; ", one capped line); a body that cannot be read adds nothing', async () => {
  const msgs = (body: unknown, status = 400) => { const { fetchImpl } = rig(() => (typeof body === 'string' ? new Response(body, { status }) : json(body, status))); return cloud(fetchImpl).request('GET', P).catch((e: JiraError) => e.message); };
  assert.equal(await msgs({ errorMessages: ['a', 'b'] }), `Jira answered 400 on GET ${P}: a; b`);
  assert.equal(await msgs({ errorMessages: ['a', 5, null] }), `Jira answered 400 on GET ${P}: a; 5; null`);
  assert.equal(await msgs({ errorMessages: [] }), `Jira answered 400 on GET ${P}: `);
  assert.equal(await msgs({ errorMessages: 'text' }), `Jira answered 400 on GET ${P}: `);
  assert.equal(await msgs({ errorMessages: ['x'.repeat(200)] }), `Jira answered 400 on GET ${P}: ${'x'.repeat(200)}`);
  assert.equal(await msgs({ errorMessages: ['x'.repeat(201)] }), `Jira answered 400 on GET ${P}: ${'x'.repeat(200)}…[+1 chars]`);
  assert.equal(await msgs({ errorMessages: ['<b>a\nb</b>'] }), `Jira answered 400 on GET ${P}: ?b?a b?/b?`);
  assert.equal(await msgs('not json'), `Jira answered 400 on GET ${P}`);
  assert.equal(await msgs('null'), `Jira answered 400 on GET ${P}`);
  assert.equal(await msgs({ other: 1 }), `Jira answered 400 on GET ${P}: `);
  // the error body is read up to 64 KiB, no further
  const padded = (n: number) => { const base = JSON.stringify({ errorMessages: ['kept'], pad: '' }); return JSON.stringify({ errorMessages: ['kept'], pad: 'p'.repeat(n - base.length) }); };
  assert.equal(padded(65536).length, 65536);
  assert.equal(await msgs(padded(65536)), `Jira answered 400 on GET ${P}: kept`);
  assert.equal(await msgs(padded(65537)), `Jira answered 400 on GET ${P}`);
  // other statuses never read the body
  let read = false;
  const { fetchImpl } = rig(() => ({ ok: false, status: 404, type: 'basic', headers: new Headers(), body: { cancel: async () => { read = true; } }, text: async () => { throw new Error('read'); } }) as unknown as Response);
  await assert.rejects(() => cloud(fetchImpl).request('GET', P), err('not_found'));
  assert.equal(read, true, 'the unread body was cancelled');
});

test('a body that fails while it is read is a network error; a non-JSON body is bad_json', async () => {
  const failing = (e: unknown) => rig(() => new Response(new ReadableStream({ start(c) { c.error(e); } }), { status: 200 })).fetchImpl;
  await assert.rejects(() => cloud(failing(new Error('conn reset'))).request('GET', P), err('network', `network error reading the answer to GET ${P}: conn reset`));
  await assert.rejects(() => cloud(failing(Object.assign(new Error('x'), { name: 'TimeoutError' }))).request('GET', P), err('network', `network error reading the answer to GET ${P}: timeout`));
  for (const thrown of [null, undefined, 0]) await assert.rejects(() => cloud(failing(thrown)).request('GET', P), err('network', `network error reading the answer to GET ${P}: ${thrown === 0 ? '0' : ''}`), String(thrown));
  await assert.rejects(() => cloud(rig(() => new Response('<html>', { status: 200 })).fetchImpl).request('GET', P), err('bad_json', `Jira answered 200 with a non-JSON body on GET ${P}`));
  assert.deepEqual(await cloud(rig(() => json({ a: [1] })).fetchImpl).request('GET', P), { a: [1] });
});

test('verify: asks /myself once, caches only a success, reports the time zone, and names a rejected credential', async () => {
  const ok = rig(() => json({ accountId: 'abc123', timeZone: 'Europe/Paris' }));
  const c = cloud(ok.fetchImpl);
  assert.deepEqual(await c.verify(), { timeZone: 'Europe/Paris' }); assert.deepEqual(await c.verify(), { timeZone: 'Europe/Paris' });
  assert.deepEqual(ok.calls.map((x) => `${x.method} ${x.url}`), ['GET /rest/api/3/myself']);
  assert.deepEqual(await cloud(rig(() => json({ accountId: 'abc123' })).fetchImpl).verify(), { timeZone: '' });
  assert.deepEqual(await cloud(rig(() => json({ accountId: 'abc123', timeZone: 5 })).fetchImpl).verify(), { timeZone: '' });
  // a failure is not cached
  let n = 0;
  const flaky = rig(() => (++n === 1 ? json({}, 500) : json({ accountId: 'abc123' })));
  const f = cloud(flaky.fetchImpl);
  await assert.rejects(() => f.verify(), err('http', 'Jira answered 500 on GET /rest/api/3/myself', 500));
  assert.deepEqual(await f.verify(), { timeZone: '' }); assert.equal(flaky.calls.length, 2);
  // 401 is rewritten with the advice
  await assert.rejects(() => cloud(rig(() => json({}, 401)).fetchImpl).verify(), err('auth', 'Jira rejected the credentials (401 on /myself). Scoped tokens need mode "scoped" + cloudId (api.atlassian.com gateway); unscoped tokens need mode "site-token"; Data Center needs a PAT', 401));
  // anything else keeps its own error
  await assert.rejects(() => cloud(rig(() => json({}, 403)).fetchImpl).verify(), err('forbidden', 'Jira answered 403 on GET /rest/api/3/myself', 403));
  await assert.rejects(() => cloud((async () => { throw new Error('down'); }) as unknown as Fetch).verify(), err('network', 'network error on GET /rest/api/3/myself: down'));
});

test('verify: the identity must be a real, active account', async () => {
  const anon = 'Jira answered /myself with an anonymous, empty or inactive identity: the token is not being accepted (wrong mode for this token type?)';
  const bad = async (mk: typeof cloud, body: unknown) => assert.rejects(() => mk(rig(() => new Response(JSON.stringify(body), { status: 200 })).fetchImpl).verify(), err('anonymous', anon), JSON.stringify(body));
  for (const body of [null, {}, { accountId: '' }, { accountId: 5 }, { accountId: 'anonymous' }, { accountId: 'abc', active: false }, { name: 'ada' }, []]) await bad(cloud, body);
  for (const body of [null, {}, { name: '' }, { name: 'anonymous' }, { key: 'anonymous' }, { name: 'ada', active: false }, { accountId: 'abc' }, { name: 5, key: 5 }]) await bad(dc, body);
  assert.deepEqual(await cloud(rig(() => json({ accountId: 'abc', active: true })).fetchImpl).verify(), { timeZone: '' });
  assert.deepEqual(await cloud(rig(() => json({ accountId: 'abc', active: null })).fetchImpl).verify(), { timeZone: '' });
  assert.deepEqual(await dc(rig(() => json({ name: 'ada' })).fetchImpl).verify(), { timeZone: '' });
  assert.deepEqual(await dc(rig(() => json({ key: 'JIRAUSER1' })).fetchImpl).verify(), { timeZone: '' });
  assert.deepEqual(await dc(rig(() => json({ name: '', key: 'JIRAUSER1' })).fetchImpl).verify(), { timeZone: '' });
  const dcCall = rig(() => json({ name: 'ada' })); await dc(dcCall.fetchImpl).verify();
  assert.deepEqual(dcCall.calls.map((x) => `${x.method} ${x.url}`), ['GET /rest/api/2/myself']);
});

test('Cloud search: body, page token, last page rules', async () => {
  const r = rig((n) => json(n === 1 ? { issues: [{ key: 'A-1' }], nextPageToken: 'tok2', isLast: false } : n === 2 ? { issues: [], nextPageToken: 'tok3' } : n === 3 ? { issues: 'x', isLast: true, nextPageToken: 'ignored' } : { issues: [{ key: 'B-1' }], nextPageToken: '' }));
  const c = cloud(r.fetchImpl);
  assert.deepEqual(await c.search({ jql: 'project = A', fields: ['summary'], pageSize: 50 }), { issues: [{ key: 'A-1' }], cursor: 'tok2', last: false });
  assert.deepEqual(await c.search({ jql: 'q', fields: ['f'], pageSize: 5, cursor: 'tok2' }), { issues: [], cursor: 'tok3', last: false });
  assert.deepEqual(await c.search({ jql: 'q', fields: ['f'], pageSize: 5, cursor: 'tok3' }), { issues: [], cursor: null, last: true });
  assert.deepEqual(await c.search({ jql: 'q', fields: ['f'], pageSize: 5, cursor: '' }), { issues: [{ key: 'B-1' }], cursor: null, last: true });
  assert.deepEqual(r.calls.map((x) => [x.method, x.url, x.body]), [
    ['POST', '/rest/api/3/search/jql', { jql: 'project = A', fields: ['summary'], maxResults: 50 }],
    ['POST', '/rest/api/3/search/jql', { jql: 'q', fields: ['f'], maxResults: 5, nextPageToken: 'tok2' }],
    ['POST', '/rest/api/3/search/jql', { jql: 'q', fields: ['f'], maxResults: 5, nextPageToken: 'tok3' }],
    ['POST', '/rest/api/3/search/jql', { jql: 'q', fields: ['f'], maxResults: 5 }],
  ]);
  const numeric = rig(() => json({ issues: [], nextPageToken: 'x' }));
  await cloud(numeric.fetchImpl).search({ jql: 'q', fields: ['f'], pageSize: 5, cursor: 7 });
  assert.deepEqual(numeric.calls[0]?.body, { jql: 'q', fields: ['f'], maxResults: 5 }, 'a numeric cursor is not a page token');
  const nonStr = await cloud(rig(() => json({ issues: [], nextPageToken: 5 })).fetchImpl).search({ jql: 'q', fields: ['f'], pageSize: 5 });
  assert.deepEqual(nonStr, { issues: [], cursor: null, last: true });
  const full = await cloud(rig(() => json({ issues: [{ key: 'A-1' }], nextPageToken: 'more', isLast: 'true' })).fetchImpl).search({ jql: 'q', fields: ['f'], pageSize: 5 });
  assert.deepEqual(full, { issues: [{ key: 'A-1' }], cursor: 'more', last: false }, 'only a boolean true isLast ends the paging');
});

test('Data Center search: offsets, the total, and the last page', async () => {
  const r = rig((n) => json(n === 1 ? { issues: [{}, {}], total: 5 } : n === 2 ? { issues: [{}, {}, {}], total: 5 } : n === 3 ? { issues: [{}] } : n === 4 ? { issues: [], total: 99 } : { issues: 'x', total: 3 }));
  const c = dc(r.fetchImpl);
  assert.deepEqual(await c.search({ jql: 'q', fields: ['f'], pageSize: 2 }), { issues: [{}, {}], cursor: 2, last: false });
  assert.deepEqual(await c.search({ jql: 'q', fields: ['f'], pageSize: 3, cursor: 2 }), { issues: [{}, {}, {}], cursor: 5, last: true });
  assert.deepEqual(await c.search({ jql: 'q', fields: ['f'], pageSize: 3, cursor: 5 }), { issues: [{}], cursor: 6, last: true }, 'a missing total reads as 0');
  assert.deepEqual(await c.search({ jql: 'q', fields: ['f'], pageSize: 3, cursor: 6 }), { issues: [], cursor: 6, last: true });
  assert.deepEqual(await c.search({ jql: 'q', fields: ['f'], pageSize: 3, cursor: null }), { issues: [], cursor: 0, last: true });
  assert.deepEqual(r.calls.map((x) => [x.method, x.url, x.body]), [
    ['POST', '/rest/api/2/search', { jql: 'q', fields: ['f'], startAt: 0, maxResults: 2 }],
    ['POST', '/rest/api/2/search', { jql: 'q', fields: ['f'], startAt: 2, maxResults: 3 }],
    ['POST', '/rest/api/2/search', { jql: 'q', fields: ['f'], startAt: 5, maxResults: 3 }],
    ['POST', '/rest/api/2/search', { jql: 'q', fields: ['f'], startAt: 6, maxResults: 3 }],
    ['POST', '/rest/api/2/search', { jql: 'q', fields: ['f'], startAt: 0, maxResults: 3 }],
  ]);
  const exact = dc(rig(() => json({ issues: [{}, {}], total: 4 })).fetchImpl);
  assert.equal((await exact.search({ jql: 'q', fields: ['f'], pageSize: 2, cursor: 2 })).last, true, 'reaching the total ends it');
  assert.equal((await exact.search({ jql: 'q', fields: ['f'], pageSize: 2, cursor: 1 })).last, false);
});

test('count: Cloud approximate-count and Data Center total, integers from zero up only', async () => {
  const r = rig(() => json({ count: 7, total: 9 }));
  assert.equal(await cloud(r.fetchImpl).count('project = A'), 7);
  assert.deepEqual(r.calls.map((x) => [x.method, x.url, x.body]), [['POST', '/rest/api/3/search/approximate-count', { jql: 'project = A' }]]);
  const d = rig(() => json({ count: 7, total: 9 }));
  assert.equal(await dc(d.fetchImpl).count('project = A'), 9);
  assert.deepEqual(d.calls.map((x) => [x.method, x.url, x.body]), [['POST', '/rest/api/2/search', { jql: 'project = A', fields: ['key'], maxResults: 0 }]]);
  const val = async (mk: typeof cloud, key: string, v: unknown) => mk(rig(() => json({ [key]: v })).fetchImpl).count('q');
  for (const [mk, key] of [[cloud, 'count'], [dc, 'total']] as const) {
    assert.equal(await val(mk, key, 0), 0); assert.equal(await val(mk, key, 1), 1);
    for (const bad of [-1, 1.5, '3', null, 'x', true]) assert.equal(await val(mk, key, bad), null, `${key} ${String(bad)}`);
    assert.equal(await mk(rig(() => json({})).fetchImpl).count('q'), null);
  }
});

test('issue: the fields travel as one comma-joined query value', async () => {
  const r = rig(() => json({ key: 'AB-1' }));
  assert.deepEqual(await cloud(r.fetchImpl).issue('AB-1', ['summary', 'status']), { key: 'AB-1' });
  assert.deepEqual(r.calls.map((x) => [x.method, x.url]), [['GET', '/rest/api/3/issue/AB-1?fields=summary%2Cstatus']]);
  const d = rig(() => json({})); await dc(d.fetchImpl).issue('AB-1', ['a']);
  assert.deepEqual(d.calls.map((x) => x.url), ['/rest/api/2/issue/AB-1?fields=a']);
});

test('changelog: Cloud only, paged by startAt, ends on isLast or an empty page, at most 20 pages by default (counted requests)', async () => {
  await assert.rejects(() => dc(rig(() => json({})).fetchImpl).changelog('AB-1'), err('unsupported', 'changelog is only implemented for Cloud'));
  const r = rig((n) => json(n === 1 ? { values: [{ id: 1 }, { id: 2 }], isLast: false } : n === 2 ? { values: [{ id: 3 }] } : { values: [{ id: 4 }], isLast: true }));
  assert.deepEqual(await cloud(r.fetchImpl).changelog('AB-1'), [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]);
  assert.deepEqual(r.calls.map((x) => [x.method, x.url]), [
    ['GET', '/rest/api/3/issue/AB-1/changelog?startAt=0&maxResults=100'], ['GET', '/rest/api/3/issue/AB-1/changelog?startAt=2&maxResults=100'], ['GET', '/rest/api/3/issue/AB-1/changelog?startAt=3&maxResults=100'],
  ]);
  const empty = rig((n) => json(n === 1 ? { values: [{ id: 1 }] } : { values: [] }));
  assert.deepEqual(await cloud(empty.fetchImpl).changelog('AB-1'), [{ id: 1 }]); assert.equal(empty.calls.length, 2);
  const noValues = rig(() => json({})); assert.deepEqual(await cloud(noValues.fetchImpl).changelog('AB-1'), []); assert.equal(noValues.calls.length, 1);
  const bad = rig(() => json({ values: 'x', isLast: false })); assert.deepEqual(await cloud(bad.fetchImpl).changelog('AB-1'), []); assert.equal(bad.calls.length, 1);
  const endless = rig(() => json({ values: [{ id: 1 }], isLast: false }));
  assert.equal((await cloud(endless.fetchImpl).changelog('AB-1')).length, 20); assert.equal(endless.calls.length, 20);
  const three = rig(() => json({ values: [{ id: 1 }], isLast: false }));
  assert.equal((await cloud(three.fetchImpl).changelog('AB-1', { maxPages: 3 })).length, 3); assert.equal(three.calls.length, 3);
  const zero = rig(() => json({ values: [{ id: 1 }] }));
  assert.deepEqual(await cloud(zero.fetchImpl).changelog('AB-1', { maxPages: 0 }), []); assert.equal(zero.calls.length, 0);
  const strict = rig(() => json({ values: [{ id: 1 }], isLast: 'true' }));
  assert.equal((await cloud(strict.fetchImpl).changelog('AB-1', { maxPages: 2 })).length, 2, 'only a boolean true isLast ends it');
});

test('the client is frozen and reports its mode, identity and clock', () => {
  const now = new Date('2026-03-01T12:00:00Z');
  const c = cloud(rig(() => json({})).fetchImpl, { now: () => now });
  assert.ok(Object.isFrozen(c)); assert.equal(c.mode, 'scoped'); assert.deepEqual(c.identity, { cloud_id: CLOUD }); assert.ok(Object.isFrozen(c.identity));
  assert.equal(c.now().getTime(), now.getTime()); assert.notEqual(c.now(), now);
  const d = dc(rig(() => json({})).fetchImpl);
  assert.equal(d.mode, 'datacenter'); assert.deepEqual(d.identity, { host: 'jira.corp' });
  const site = makeClient({ baseConfig: { auth: { mode: 'site-token' }, baseUrl: 'https://acme.atlassian.net' }, creds, fetchImpl: rig(() => json({})).fetchImpl } as never);
  assert.equal(site.mode, 'site-token'); assert.deepEqual(site.identity, { host: 'acme.atlassian.net' });
  assert.ok(Math.abs(site.now().getTime() - Date.now()) < 5000);
  assert.equal(makeClient({ baseConfig: { mode: 'site-token', baseUrl: 'https://acme.atlassian.net' }, creds, fetchImpl: rig(() => json({})).fetchImpl } as never).mode, 'site-token');
});
