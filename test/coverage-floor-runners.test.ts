// Per-file coverage floor: the search defaults, the page cursor, the rate-limit headers and the error shapes of jiraRunner, and the successful
// Atlassian runner built by defaultFetchDeps over an injected fetch. Synthetic tenant and token; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { jiraRunner, defaultFetchDeps } from '../src/fetch-runners.ts';

const GET = (p: string): string[] => ['api', '--include', '--method', 'GET', p];
const bodyOf = (out: string): unknown => JSON.parse(out.slice(out.indexOf('\r\n\r\n') + 4));
const retryAfter = (out: string): number => Number(/Retry-After: (\d+)/.exec(out)?.[1]);

test('jiraRunner search uses its defaults when the query is bare, and passes jql, fields, page size and cursor when given', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const client = { mode: 'scoped', search: async (q: Record<string, unknown>) => { seen.push(q); return { issues: [{ key: 'A-1' }], cursor: null, last: true }; }, request: async () => ({}) };
  const run = jiraRunner(client as never);
  const bare = await run(GET('/rest/api/3/search/jql'));
  assert.equal(bare.code, 0);
  assert.deepEqual(seen[0], { jql: '', fields: [], pageSize: 100 });
  assert.deepEqual(bodyOf(bare.out), { issues: [{ key: 'A-1' }], isLast: true });
  assert.match(bare.out, /^HTTP\/1\.1 200 OK\r\n/);
  await run(GET('/rest/api/3/search/jql?jql=project%3DX&fields=a,,b&maxResults=abc'));
  assert.deepEqual(seen[1], { jql: 'project=X', fields: ['a', 'b'], pageSize: 100 });
  await run(GET('/rest/api/3/search/jql?maxResults=50&nextPageToken=tok'));
  assert.deepEqual(seen[2], { jql: '', fields: [], pageSize: 50, cursor: 'tok' });
});

test('jiraRunner turns a numeric or missing page cursor into nextPageToken or leaves it out', async () => {
  const pages = [{ issues: [], cursor: 5, last: false }, { issues: [], last: true }, { issues: [], cursor: undefined, last: true }];
  const run = jiraRunner({ mode: 'scoped', search: async () => pages.shift(), request: async () => ({}) } as never);
  assert.deepEqual(bodyOf((await run(GET('/rest/api/3/search/jql'))).out), { issues: [], nextPageToken: '5', isLast: false });
  assert.deepEqual(bodyOf((await run(GET('/rest/api/3/search/jql'))).out), { issues: [], isLast: true });
  assert.deepEqual(bodyOf((await run(GET('/rest/api/3/search/jql'))).out), { issues: [], isLast: true });
});

test('jiraRunner sends other GETs through client.request with the query and answers Data Center search with a failed request', async () => {
  const calls: unknown[][] = [];
  const run = jiraRunner({ mode: 'scoped', search: async () => ({ issues: [], last: true }), request: async (...a: unknown[]) => { calls.push(a); return { ok: true }; } } as never);
  const r = await run(GET('/rest/api/3/issue/A-1?expand=names'));
  assert.deepEqual(calls[0], ['GET', '/rest/api/3/issue/A-1', { query: { expand: 'names' } }]);
  assert.deepEqual(bodyOf(r.out), { ok: true });
  const dc = await jiraRunner({ mode: 'datacenter', search: async () => ({}), request: async () => ({}) } as never)(GET('/rest/api/3/search/jql'));
  assert.deepEqual([dc.code, dc.out, dc.err], [1, '', 'Data Center is not supported by sync-fetch']);
});

test('jiraRunner rate-limit errors become a 429 whose Retry-After follows resetAt: clamped to 1 and to a day, 60 when absent or unreadable', async () => {
  const limited = (code: string, resetAt?: string) => jiraRunner({ mode: 'scoped', search: async () => { throw Object.assign(new Error('slow down'), { code, ...(resetAt !== undefined ? { resetAt } : {}) }); }, request: async () => ({}) } as never)(GET('/rest/api/3/search/jql'));
  const inSeconds = (s: number): string => new Date(Date.now() + s * 1000).toISOString();
  const soon = await limited('quota', inSeconds(3600));
  assert.match(soon.out, /^HTTP\/1\.1 429 Error\r\n/);
  assert.ok(retryAfter(soon.out) >= 3590 && retryAfter(soon.out) <= 3601, String(retryAfter(soon.out)));
  assert.equal(retryAfter((await limited('rate_limited', inSeconds(-500))).out), 1);
  assert.equal(retryAfter((await limited('rate_limit_wait', inSeconds(10 * 86400))).out), 86400);
  assert.equal(retryAfter((await limited('quota', 'not a date')).out), 60);
  assert.equal(retryAfter((await limited('quota')).out), 60);
  assert.deepEqual(bodyOf(soon.out), {});
});

test('jiraRunner reports any other failure as code 1 with the message, whatever was thrown', async () => {
  const failing = (e: unknown) => jiraRunner({ mode: 'scoped', search: async () => { throw e; }, request: async () => ({}) } as never)(GET('/rest/api/3/search/jql'));
  assert.deepEqual(await failing(new Error('Jira answered 401')), { code: 1, out: '', err: 'Jira answered 401' });
  assert.deepEqual(await failing('boom'), { code: 1, out: '', err: 'boom' });
  assert.equal((await failing(null)).code, 1);
  assert.equal((await failing(Object.assign(new Error('x'), { code: 7 }))).code, 1);
});

test('the Atlassian runner from defaultFetchDeps answers through the injected fetch with the credentials of the environment', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-floor-runner-')));
  try {
    const urls: string[] = [];
    const fetchStub = async (url: unknown, init?: { headers?: Record<string, string> }): Promise<Response> => {
      urls.push(String(url));
      assert.ok(init?.headers && Object.keys(init.headers).some((h) => h.toLowerCase() === 'authorization'));
      return new Response(JSON.stringify({ accountId: 'acct-1' }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const ctx = {
      config: () => ({ jira: { auth: { mode: 'scoped' }, cloud_id: 'cloud-id-0001' } }), root: dir, now: () => new Date('2026-01-01T00:00:00Z'), fetch: fetchStub,
      exec: async (): Promise<string> => { throw new Error('item not found'); }, env: { XDG_CONFIG_HOME: path.join(dir, 'cfg'), JIRA_EMAIL: 'user@example.invalid', JIRA_API_TOKEN: 'synthetic-token-1' },
    };
    const runner = await defaultFetchDeps(ctx as never).atlassian.runner();
    const r = await runner(GET('/rest/api/3/myself'));
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(bodyOf(r.out), { accountId: 'acct-1' });
    assert.equal(urls.length, 1);
    assert.match(urls[0] as string, /cloud-id-0001\/rest\/api\/3\/myself/);
    const bare = { ...ctx, exec: undefined, fetch: undefined };
    assert.equal(typeof (await defaultFetchDeps(bare as never).atlassian.runner()), 'function');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
