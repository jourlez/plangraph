// Behavior tests for lib/jira.mjs edges written to kill mutants that survived scripts/mutate-all.mjs and the jira goldens: the secret
// length threshold, IPv6 loopback, a colon at the start of a helper secret, the Data Center sprint route, the exact body cap, the default
// mode and loopback flag, long paths in messages, status 300, a malformed reset header, a zero back-off, a body stream that fails, a
// non-string page token, a zero count, the JQL length limit, reconcile counting without delta_runs, the empty-page allowance, equal
// update stamps in pulls and imports, and issue text cuts (exact length, default cap, long keys, surrogate pairs).
// No network: scripted fetch and fake clients only. All keys, hosts and tokens are invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as J from '../lib/jira.mjs';

const EMAIL = 'dev@example.invalid', TOKEN = 'tok-EDGE-123456', CLOUD = 'cloud-id-5678';
const ok = (/** @type {unknown} */ body, status = 200, headers = {}) => () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
const client = (/** @type {any[]} */ steps, /** @type {any} */ extra = {}) => {
  /** @type {number[]} */ const sleeps = [];
  /** @type {string[]} */ const log = [];
  const fetchImpl = async (/** @type {string} */ url, /** @type {any} */ init) => { log.push(`${init.method} ${url} ct=${init.headers['Content-Type'] ?? '-'}`); const s = steps.shift(); if (s instanceof Error) throw s; return s(); };
  const c = J.makeClient({ baseConfig: { auth: { mode: 'scoped' }, cloudId: CLOUD }, creds: { email: EMAIL, token: TOKEN }, fetchImpl: /** @type {any} */ (fetchImpl), sleep: async (ms) => { sleeps.push(ms); }, now: () => Date.UTC(2026, 0, 1), random: () => 0, backoffMs: 0, ...extra });
  return { c, sleeps, log };
};
const fails = async (/** @type {() => Promise<unknown>} */ fn) => { try { await fn(); return 'no error'; } catch (e) { return `${/** @type {any} */ (e).code}: ${/** @type {Error} */ (e).message}`; } };

test('secrets of 6 characters are redacted, 5 are not; IPv6 loopback; the default mode; insecure loopback is off by default', () => {
  J.makeClient({ baseConfig: { auth: { mode: 'datacenter' }, baseUrl: 'https://jira.corp' }, creds: { token: 'sixsix' }, dcHosts: 'jira.corp' });
  assert.equal(J.redact('a sixsix b fives c'), 'a [redacted] b fives c');
  assert.equal(J.validateBase('http://[::1]:9/', { allowInsecureLocalhostForTests: true }).kind, 'loopback');
  assert.equal(J.makeClient({ baseConfig: { cloudId: CLOUD }, creds: { email: EMAIL, token: TOKEN } }).mode, 'scoped');
  assert.throws(() => J.makeClient({ baseConfig: { auth: { mode: 'datacenter' }, baseUrl: 'http://127.0.0.1:9' }, creds: { token: TOKEN } }), (/** @type {any} */ e) => e.code === 'bad_host');
});

test('credentials: a secret starting with a colon is a token, a one-letter email is checked as an email', async () => {
  const exec = (/** @type {string} */ out) => async () => out;
  const tok = /** @type {any} */ (await J.getCredentials({ env: { JIRA_OP_REF: 'op://v/i/f' }, exec: exec(':abcdefghij'), platform: 'win32' }));
  assert.deepEqual([tok.email, tok.token, tok.source], ['', ':abcdefghij', 'op']);
  assert.equal(await fails(() => J.getCredentials({ env: { JIRA_OP_REF: 'op://v/i/f' }, exec: exec('a:abcdefghij'), platform: 'win32' })), 'bad_credentials: JIRA_EMAIL is not an email address');
});

test('client edges: DC sprint route, exact body cap, long paths, status 300, bad reset header, zero back-off, failing body stream', async () => {
  const dc = J.makeClient({ baseConfig: { auth: { mode: 'datacenter' }, baseUrl: 'https://jira.corp' }, creds: { token: TOKEN }, dcHosts: 'jira.corp', fetchImpl: /** @type {any} */ (async () => new Response('{"values":[]}')) });
  assert.deepEqual(await dc.request('GET', '/rest/agile/1.0/sprint/7/issue'), { values: [] });
  const exact = client([() => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"a":1}')); c.close(); } }))], { maxBodyBytes: 7 });
  assert.deepEqual(await exact.c.request('GET', '/rest/api/3/myself'), { a: 1 }, 'a body of exactly the cap is read');
  const long = client([]);
  assert.match(await fails(() => long.c.request('DELETE', `/rest/api/3/${'x'.repeat(200)}`)), new RegExp(`^read_only: blocked: DELETE /rest/api/3/${'x'.repeat(68)} is not`));
  const s300 = client([ok('', 300)]);
  assert.match(await fails(() => s300.c.request('GET', '/rest/api/3/myself')), /^redirect: redirect refused .* \(status 300\)/);
  const badReset = client([ok('', 429, { 'x-ratelimit-reset': 'not a date', 'retry-after': '1' }), ok({ accountId: 'a' })]);
  assert.deepEqual(await badReset.c.request('GET', '/rest/api/3/myself'), { accountId: 'a' });
  assert.deepEqual(badReset.sleeps, [1000]);
  const zero = client([ok('', 429), ok({ x: 1 })]);
  await zero.c.request('GET', '/rest/api/3/myself');
  assert.deepEqual(zero.sleeps, [0], 'no Retry-After and a back-off of 0 sleeps 0 ms');
  const broken = client([() => new Response(new ReadableStream({ start(c) { c.error(new Error('stream reset')); } }))]);
  assert.equal(await fails(() => broken.c.request('GET', '/rest/api/3/myself')), 'network: network error reading the answer to GET /rest/api/3/myself: stream reset');
  const slow = client([() => new Response(new ReadableStream({ start(c) { c.error(Object.assign(new Error('t'), { name: 'TimeoutError' })); } }))]);
  assert.equal(await fails(() => slow.c.request('GET', '/rest/api/3/myself')), 'network: network error reading the answer to GET /rest/api/3/myself: timeout');
  const post = client([ok({ issues: [], nextPageToken: 5 }), ok({ count: 0 })]);
  assert.deepEqual(await post.c.search({ jql: 'p', fields: ['a'], pageSize: 1, cursor: null }), { issues: [], cursor: null, last: true }, 'a non-string page token ends the paging');
  assert.equal(await post.c.count('p'), 0);
  assert.deepEqual(post.log.map((l) => l.split(' ct=')[1]), ['application/json', 'application/json']);
});

const issue = (/** @type {string} */ key, /** @type {string} */ updated, summary = 's') => ({ key, fields: { summary, status: { name: 'To Do' }, updated, issuelinks: [] } });
const fake = (/** @type {any[]} */ pages, extra = {}) => ({ mode: 'scoped', identity: { cloud_id: CLOUD }, now: () => new Date(Date.UTC(2026, 0, 1)), verify: async () => ({ timeZone: 'UTC' }), count: async () => 1, search: async () => pages.shift(), ...extra });

test('pulls: the JQL length limit, reconcile counting without delta_runs, empty pages, equal stamps', async () => {
  assert.notEqual((await fails(() => J.pullSnapshot(fake([{ issues: [], last: true }]), { jql: 'x'.repeat(20000) }))).startsWith('bad_jql'), true, 'exactly 20000 characters are accepted');
  const full = await J.pullSnapshot(fake([{ issues: [issue('A-1', '2026-01-01T00:00:00Z')], last: true }]), { jql: 'p' });
  const prev = { ...full.snapshot, meta: { ...full.snapshot.meta } }; delete prev.meta.delta_runs;
  const r = await J.pullSnapshot(fake([{ issues: [], last: true }]), { jql: 'p', previous: prev, fullReconcileEvery: 2 });
  assert.equal(r.reason, '', 'one delta run since a full pull is not yet a reconcile at every 2');
  const empties = (/** @type {number} */ n) => [...Array.from({ length: n }, (_, i) => ({ issues: [], cursor: `c${i}`, last: false })), { issues: [], last: true }];
  assert.equal((await J.pullSnapshot(fake(empties(3)), { jql: 'p' })).ok, true, 'three empty pages are tolerated');
  assert.equal((await J.pullSnapshot(fake(empties(4)), { jql: 'p' })).code, 'pagination_stalled');
  const same = await J.pullSnapshot(fake([{ issues: [issue('A-1', '2026-01-01T00:00:00Z', 'changed text')], last: true }]), { jql: 'p', previous: full.snapshot });
  assert.deepEqual([same.mode, same.changedKeys, same.snapshot.issues[0].summary], ['delta', ['A-1'], 'changed text'], 'an equal stamp with new content replaces the old copy');
  const imp = J.importIssues(full.snapshot, [issue('A-1', full.snapshot.issues[0].updated, 'imported text')], { now: () => new Date(0) });
  assert.equal(imp.snapshot.issues[0].summary, 'imported text', 'import: an equal stamp replaces too');
});

test('issue text: exact length kept, default cap, long keys, a surrogate pair at the cut', () => {
  const fields = { summary: 'S', status: { name: 'Done' }, updated: 'u', description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x'.repeat(40) }] }] } };
  const whole = J.renderIssue('ABC-1', { fields }, { maxChars: 1e9 });
  assert.equal(J.renderIssue('ABC-1', { fields }, { maxChars: whole.length }), whole, 'a text of exactly maxChars is not cut');
  assert.notEqual(J.renderIssue('ABC-1', { fields }, { maxChars: whole.length - 1 }), whole);
  const big = { ...fields, description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'y'.repeat(31000) }] }] } };
  assert.match(J.renderIssue('ABC-2', { fields: big }), /\n\.\.\. \d+ more chars\n$/);
  assert.equal(J.renderIssue('ABC-2', { fields: big }).length < 30100, true);
  assert.ok(J.renderIssue('K'.repeat(50), { fields }).startsWith(`# ${'K'.repeat(40)}…[+10 chars]\n`));
  const emoji = { ...fields, summary: '😀'.repeat(40) };
  for (let n = 40; n < 80; n++) { const t = J.renderIssue('ABC-3', { fields: emoji }, { maxChars: n }); assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(t), false, `cut at ${n} keeps surrogate pairs whole`); }
});
