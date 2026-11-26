// Behavior tests for lib/jira/client.ts written to kill the mutants of the trust-root run (scripts/mutate/trust-roots.json). Every Jira answer is an
// injected fetch double and the clock and sleep are injected: no network, no wall clock. The retry loop is proved by counting fetch attempts and
// recorded sleeps (a runaway loop fails at once with its own error instead of waiting for a runner timeout).
// NOT covered: real Atlassian behaviour, the default fetch, sleep and clock (test/jira.test.ts runs a local mock server).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeClient } from '../lib/jira/client.ts';
import { validateBase } from '../lib/jira/host.ts';
import type { JiraError } from '../lib/jira/error.ts';

const CLOUD = '11111111-2222-3333-4444-555555555555';
const T0 = Date.parse('2026-03-01T12:00:00Z');
const creds = { email: 'ada@example.invalid', token: 'TOKEN-for-client-kills-0123456789' };
type Fetch = NonNullable<Parameters<typeof makeClient>[0]>['fetchImpl'];
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
const cloud = (extra: Record<string, unknown> = {}) => makeClient({ baseConfig: { cloudId: CLOUD }, creds, now: () => T0, ...extra } as Parameters<typeof makeClient>[0]);
const dcClient = (extra: Record<string, unknown> = {}) => makeClient({ baseConfig: { auth: { mode: 'datacenter' }, baseUrl: 'https://jira.corp:8443' }, creds: { token: creds.token }, dcHosts: 'jira.corp:8443', now: () => T0, ...extra } as Parameters<typeof makeClient>[0]);
const code = (c: string, msg?: string | RegExp) => (e: JiraError) => e.code === c && (msg === undefined || (typeof msg === 'string' ? e.message === msg : msg.test(e.message)));

/** a fetch double that answers every call with `make(n)` and throws past 40 calls (the runaway guard) */
const counting = (make: (n: number) => Response | object) => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (calls.length > 40) throw new Error('runaway retry loop');
    return make(calls.length) as Response;
  }) as unknown as Fetch;
  return { calls, fetchImpl };
};

test('the read-only allowlist lets exactly the listed method and path pairs through, for Cloud and for Data Center', async () => {
  const cloudOk: Array<[string, string]> = [
    ['GET', '/rest/api/3/myself'], ['POST', '/rest/api/3/search/jql'], ['POST', '/rest/api/3/search/approximate-count'], ['GET', '/rest/api/3/issue/AB-12'],
    ['GET', '/rest/api/3/issue/AB-12/changelog'], ['GET', '/rest/agile/1.0/board'], ['GET', '/rest/agile/1.0/board/7/sprint'], ['GET', '/rest/agile/1.0/sprint/9/issue'],
  ];
  const dcOk: Array<[string, string]> = [['GET', '/rest/api/2/myself'], ['POST', '/rest/api/2/search'], ['GET', '/rest/api/2/issue/AB-12'], ['GET', '/rest/agile/1.0/board'], ['GET', '/rest/agile/1.0/board/7/sprint'], ['GET', '/rest/agile/1.0/sprint/9/issue']];
  for (const [mk, list] of [[cloud, cloudOk], [dcClient, dcOk]] as const) {
    const { fetchImpl, calls } = counting(() => json({}));
    const c = mk({ fetchImpl });
    for (const [m, p] of list) {
      await c.request(m, p);
      const other = m === 'GET' ? 'POST' : 'GET';
      await assert.rejects(() => c.request(other, p), code('read_only', `blocked: ${other} ${p} is not on the read-only allowlist`), `${other} ${p}`);
      await assert.rejects(() => c.request('DELETE', p), code('read_only'), `DELETE ${p}`);
    }
    assert.equal(calls.length, list.length, 'only the allowed pairs reached fetch');
  }
});

test('a path that is not a string is blocked even when its string form would be on the allowlist', async () => {
  const { fetchImpl, calls } = counting(() => json({}));
  const c = cloud({ fetchImpl });
  await assert.rejects(() => c.request('GET', ['/rest/api/3/myself'] as unknown as string), code('read_only'));
  await assert.rejects(() => c.request('GET', { toString: () => '/rest/api/3/myself' } as unknown as string), code('read_only'));
  assert.equal(calls.length, 0);
});

test('requests carry Accept: application/json, the auth header, redirect manual, and Content-Type only with a body', async () => {
  const { fetchImpl, calls } = counting(() => json({}));
  const c = cloud({ fetchImpl });
  await c.request('GET', '/rest/api/3/myself');
  await c.request('POST', '/rest/api/3/search/jql', { body: { jql: 'x' } });
  const h0 = calls[0]?.init.headers as Record<string, string>, h1 = calls[1]?.init.headers as Record<string, string>;
  assert.equal(h0.Accept, 'application/json'); assert.equal(h1.Accept, 'application/json');
  assert.equal(h0.Authorization, `Basic ${Buffer.from(`${creds.email}:${creds.token}`).toString('base64')}`);
  assert.equal('Content-Type' in h0, false); assert.equal(h1['Content-Type'], 'application/json');
  assert.equal(calls[0]?.init.redirect, 'manual');
  assert.equal(calls[1]?.init.body, JSON.stringify({ jql: 'x' }));
  assert.equal(calls[0]?.url, `https://api.atlassian.com/ex/jira/${CLOUD}/rest/api/3/myself`);
  const dc = counting(() => json({})); await dcClient({ fetchImpl: dc.fetchImpl }).request('GET', '/rest/api/2/myself');
  assert.equal((dc.calls[0]?.init.headers as Record<string, string> | undefined)?.Authorization, `Bearer ${creds.token}`);
});

test('the request timeout defaults to 30000 ms and follows timeoutMs', async (t) => {
  const seen: number[] = [];
  const real = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', (ms: number) => { seen.push(ms); return real(ms); });
  const { fetchImpl } = counting(() => json({}));
  await cloud({ fetchImpl }).request('GET', '/rest/api/3/myself');
  await cloud({ fetchImpl, timeoutMs: 1234 }).request('GET', '/rest/api/3/myself');
  assert.deepEqual(seen, [30000, 1234]);
});

test('constructor refusals name their reason', () => {
  assert.throws(() => makeClient({ baseConfig: { auth: { mode: 'datacenter' } }, creds: { token: 'x' }, dcHosts: 'jira.corp' } as never), (e: JiraError) => e.message === (() => { try { validateBase('', { mode: 'datacenter', dcHosts: 'jira.corp' }); } catch (x) { return (x as Error).message; } return ''; })());
  assert.throws(() => makeClient({ baseConfig: { auth: { mode: 'site-token' } }, creds } as never), code('bad_host', 'base URL rejected: empty'));
  assert.throws(() => makeClient({ baseConfig: { cloudId: CLOUD }, creds: { token: 'x' } } as never), code('no_credentials', 'an email and an API token are required'));
  assert.throws(() => makeClient({ baseConfig: { cloudId: CLOUD } } as never), code('no_credentials', 'an email and an API token are required'));
  assert.throws(() => makeClient({ baseConfig: { auth: { mode: 'datacenter' }, baseUrl: 'https://jira.corp:8443' }, creds: {}, dcHosts: 'jira.corp:8443' } as never), code('no_credentials', 'a personal access token is required'));
  assert.throws(() => makeClient({ baseConfig: { cloudId: 'short' }, creds } as never), code('bad_config', 'scoped mode needs a cloudId (see docs/JIRA.md)'));
  assert.throws(() => makeClient({ baseConfig: { auth: { mode: 'bogus' } }, creds } as never), code('bad_config', 'auth.mode must be scoped, site-token or datacenter'));
});

test('a fetch that rejects with a non-error value is a network error, never a TypeError', async () => {
  for (const thrown of [null, undefined, 0, '']) {
    const c = cloud({ fetchImpl: (async () => { throw thrown; }) as unknown as Fetch });
    await assert.rejects(() => c.request('GET', '/rest/api/3/myself'), code('network', /^network error on GET \/rest\/api\/3\/myself: /), String(thrown));
  }
  const named = cloud({ fetchImpl: (async () => { throw Object.assign(new Error('boom'), { name: 'TimeoutError' }); }) as unknown as Fetch });
  await assert.rejects(() => named.request('GET', '/rest/api/3/myself'), code('network', 'network error on GET /rest/api/3/myself: timeout'));
  const plain = cloud({ fetchImpl: (async () => { throw new Error('socket hang up'); }) as unknown as Fetch });
  await assert.rejects(() => plain.request('GET', '/rest/api/3/myself'), code('network', 'network error on GET /rest/api/3/myself: socket hang up'));
});

test('a redirect status or an opaque redirect is refused and never followed', async () => {
  for (const make of [() => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }), () => ({ ok: true, status: 200, type: 'opaqueredirect', headers: new Headers(), body: null, text: async () => '{}' })]) {
    const { fetchImpl, calls } = counting(make);
    await assert.rejects(() => cloud({ fetchImpl }).request('GET', '/rest/api/3/myself'), code('redirect', /^redirect refused on GET \/rest\/api\/3\/myself \(status (302|200)\); Authorization is never forwarded$/));
    assert.equal(calls.length, 1);
  }
});

test('a body without a stream is read with text(); a body with a stream that has no reader is too', async () => {
  const mk = (body: unknown) => () => ({ ok: true, status: 200, type: 'basic', headers: new Headers(), body, text: async () => '{"a":1}' });
  for (const body of [null, undefined, {}, { getReader: 5 }]) {
    assert.deepEqual(await cloud({ fetchImpl: counting(mk(body)).fetchImpl }).request('GET', '/rest/api/3/myself'), { a: 1 });
  }
});

test('the default body cap is exactly 64 MiB', async () => {
  const chunk = new Uint8Array(1024 * 1024).fill(0x20);
  const streamOf = (extra: number) => () => new Response(new ReadableStream<Uint8Array>({
    start(ctl) { for (let i = 0; i < 64; i++) ctl.enqueue(chunk); if (extra) ctl.enqueue(new Uint8Array(extra).fill(0x20)); ctl.close(); },
  }), { status: 200 });
  await assert.rejects(() => cloud({ fetchImpl: counting(streamOf(0)).fetchImpl }).request('GET', '/rest/api/3/myself'), code('bad_json'), 'exactly 64 MiB is within the cap (and not JSON)');
  await assert.rejects(() => cloud({ fetchImpl: counting(streamOf(1)).fetchImpl }).request('GET', '/rest/api/3/myself'), code('too_large', `Jira answered with a body over ${64 * 1024 * 1024} bytes on GET /rest/api/3/myself`));
});

test('429 answers: Retry-After, reset header, quota and wait limits give exact errors and the loop is bounded', async () => {
  const resetOf = (e: JiraError) => (e as unknown as { resetAt?: string }).resetAt;
  // quota: message with a reset time (an absent Retry-After reads as 0, so the reset is now); status 429; no sleep, one fetch
  let sleeps: number[] = [];
  const sleep = async (ms: number) => { sleeps.push(ms); };
  let r = counting(() => json({}, 429, { 'ratelimit-reason': 'Quota-Exceeded', 'retry-after': '30' }));
  await assert.rejects(() => cloud({ fetchImpl: r.fetchImpl, sleep }).request('GET', '/rest/api/3/myself'), (e: JiraError) => e.code === 'quota' && e.status === 429 && resetOf(e) === new Date(T0 + 30000).toISOString() && e.message === `rate-limit quota exhausted (quota-exceeded); stopping, resets at ${new Date(T0 + 30000).toISOString()}`);
  r = counting(() => json({}, 429, { 'ratelimit-reason': 'quota' }));
  await assert.rejects(() => cloud({ fetchImpl: r.fetchImpl, sleep }).request('GET', '/rest/api/3/myself'), (e: JiraError) => e.code === 'quota' && e.status === 429 && e.message === `rate-limit quota exhausted (quota); stopping, resets at ${new Date(T0).toISOString()}`);
  assert.equal(r.calls.length, 1); assert.deepEqual(sleeps, []);
  // the x-ratelimit-reset header wins over Retry-After; an unparseable one is ignored
  r = counting(() => json({}, 429, { 'ratelimit-reason': 'quota', 'x-ratelimit-reset': '2026-03-02T00:00:00Z', 'retry-after': '5' }));
  await assert.rejects(() => cloud({ fetchImpl: r.fetchImpl, sleep }).request('GET', '/rest/api/3/myself'), (e: JiraError) => resetOf(e) === '2026-03-02T00:00:00.000Z');
  r = counting(() => json({}, 429, { 'ratelimit-reason': 'quota', 'x-ratelimit-reset': 'not a date', 'retry-after': '5' }));
  await assert.rejects(() => cloud({ fetchImpl: r.fetchImpl, sleep }).request('GET', '/rest/api/3/myself'), (e: JiraError) => resetOf(e) === new Date(T0 + 5000).toISOString());
  // Retry-After that is not a finite non-negative number is not a wait request: Infinity, negative and text give no reset time
  for (const bad of ['Infinity', '-5', 'soon']) {
    r = counting(() => json({}, 429, { 'ratelimit-reason': 'quota', 'retry-after': bad }));
    await assert.rejects(() => cloud({ fetchImpl: r.fetchImpl, sleep }).request('GET', '/rest/api/3/myself'), (e: JiraError) => resetOf(e) === undefined && e.message === 'rate-limit quota exhausted (quota); stopping', bad);
  }
  // Retry-After: 0 is a valid number (a reset time of now)
  r = counting(() => json({}, 429, { 'ratelimit-reason': 'quota', 'retry-after': '0' }));
  await assert.rejects(() => cloud({ fetchImpl: r.fetchImpl, sleep }).request('GET', '/rest/api/3/myself'), (e: JiraError) => resetOf(e) === new Date(T0).toISOString());
  // a wait above the limit stops at once; exactly at the limit it sleeps
  r = counting(() => json({}, 429, { 'retry-after': '121' }));
  await assert.rejects(() => cloud({ fetchImpl: r.fetchImpl, sleep }).request('GET', '/rest/api/3/myself'), (e: JiraError) => e.code === 'rate_limit_wait' && e.status === 429 && e.message === `rate limited, Retry-After 121s exceeds the 120s limit; stopping, retry after ${new Date(T0 + 121000).toISOString()}`);
  assert.equal(r.calls.length, 1);
  r = counting((n) => (n === 1 ? json({}, 429, { 'retry-after': '120' }) : json({ ok: 1 })));
  sleeps = [];
  assert.deepEqual(await cloud({ fetchImpl: r.fetchImpl, sleep, random: () => 0.5 }).request('GET', '/rest/api/3/myself'), { ok: 1 });
  assert.deepEqual(sleeps, [120000]); assert.equal(r.calls.length, 2);
  // the limit follows maxSleepSeconds
  r = counting(() => json({}, 429, { 'retry-after': '99' }));
  await assert.rejects(() => cloud({ fetchImpl: r.fetchImpl, sleep, maxSleepSeconds: 10 }).request('GET', '/rest/api/3/myself'), (e: JiraError) => e.message === `rate limited, Retry-After 99s exceeds the 10s limit; stopping, retry after ${new Date(T0 + 99000).toISOString()}`);
  // a 429 with no usable header retries maxRetries times (counted), sleeping the jittered backoff each time, then gives up
  for (const maxRetries of [0, 1, 3]) {
    sleeps = [];
    r = counting(() => json({}, 429));
    await assert.rejects(() => cloud({ fetchImpl: r.fetchImpl, sleep, maxRetries, backoffMs: 100, random: () => 0.5 }).request('GET', '/rest/api/3/myself'), (e: JiraError) => e.code === 'rate_limited' && e.status === 429 && e.message === `rate limited after ${maxRetries} retries`);
    assert.equal(r.calls.length, maxRetries + 1, `maxRetries ${maxRetries}`);
    assert.deepEqual(sleeps, Array.from({ length: maxRetries }, (_, a) => Math.round(100 * 2 ** a)), 'backoff doubles; jitter 0.7 + 0.6 * 0.5 = 1');
  }
  // Retry-After is a minimum: a larger backoff wins, a larger Retry-After wins
  sleeps = [];
  r = counting((n) => (n === 1 ? json({}, 429, { 'retry-after': '2' }) : json({})));
  await cloud({ fetchImpl: r.fetchImpl, sleep, backoffMs: 10000, random: () => 0.5 }).request('GET', '/rest/api/3/myself');
  assert.deepEqual(sleeps, [10000]);
  sleeps = [];
  r = counting((n) => (n === 1 ? json({}, 429, { 'retry-after': '2' }) : json({})));
  await cloud({ fetchImpl: r.fetchImpl, sleep, backoffMs: 100, random: () => 0.5 }).request('GET', '/rest/api/3/myself');
  assert.deepEqual(sleeps, [2000]);
  // jitter bounds: 0.7x at random 0, 1.3x at random 1
  sleeps = [];
  for (const rnd of [0, 1]) { r = counting((n) => (n === 1 ? json({}, 429) : json({}))); await cloud({ fetchImpl: r.fetchImpl, sleep, backoffMs: 1000, random: () => rnd }).request('GET', '/rest/api/3/myself'); }
  assert.deepEqual(sleeps, [700, 1300]);
});

test('a 429 without a usable Retry-After sleeps only the backoff, which may be zero', async () => {
  const sleeps: number[] = [];
  for (const header of [undefined, 'soon', '-3', 'Infinity']) {
    const r = counting((n) => (n === 1 ? json({}, 429, header === undefined ? {} : { 'retry-after': header }) : json({})));
    await cloud({ fetchImpl: r.fetchImpl, sleep: async (ms: number) => { sleeps.push(ms); }, backoffMs: 0, random: () => 0.5 }).request('GET', '/rest/api/3/myself');
  }
  assert.deepEqual(sleeps, [0, 0, 0, 0]);
});
