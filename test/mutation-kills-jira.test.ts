// Characterization goldens for lib/jira.ts (test/golden/mutation-kills/jira.json, UPDATE_GOLDEN=1 rewrites), written to kill mutants
// that survived scripts/mutate-all.ts. No network: the client gets a scripted fetch (real Response objects), a recording sleep, a fixed
// clock and a fixed random; credentials come from injected env and exec. Covered: redaction, host validation in every mode, credential
// sources and their errors, the read-only allowlist, retries and every HTTP failure class, the body cap, identity checks, paging for
// Cloud and Data Center, snapshot pulls (full, delta, reconcile, failures, drift), normalization (links, sprints in every shape), import,
// snapshot serialization, changelog and issue text rendering with cuts. All keys, names, hosts and tokens are invented.
// NOT covered: a real Jira (docs/JIRA.md); the OS keychain helpers themselves (exec is injected).
import { test } from 'node:test';
import * as J from '../lib/jira.ts';
import { golden, outcome } from './helpers/golden-json.ts';

const G = (name: string, fn: () => unknown) => golden('jira', name, outcome(fn));
const GA = async (name: string, fn: () => Promise<unknown>) => { let v: unknown; try { v = await fn(); } catch (e) { v = e; } golden('jira', name, outcome(() => { if (v instanceof Error) throw v; return v; })); };
/** awaited value, or the thrown error as a plain value */
const GAo = async (fn: () => Promise<unknown>) => { try { return await fn(); } catch (e) { return outcome(() => { throw e; }); } };
const TOKEN = 'tok-ABCDEFGH-1234', EMAIL = 'dev@example.invalid', CLOUD = 'cloud-id-1234';
const NOW = Date.UTC(2026, 4, 1, 12, 0, 0);

test('redaction, errors, host lists, base URL validation', () => {
  G('redact', () => [J.redact('Authorization: Basic abcdefghijkl and bearer=xyz'), J.redact('token Bearer abcdefghijkl123'), J.redact('ATATT3xFfGF0abcdefghijklmnop'), J.redact(null), J.redact(new Error('authorization="secret"')), J.redact('short Basic abc')]);
  G('error', () => { const e = new J.JiraError('x' as J.JiraErrorCode, 'm Authorization: s3cr3tvalue', { status: 418, resetAt: 'later' }); return [e.name, e.code, e.message, e.status, e.resetAt, new J.JiraError('y' as J.JiraErrorCode, 'z').status]; }); // invented codes: the constructor stores any code as given
  G('hosts', () => [[...J.parseDcHosts(' A.example.com ,b.example.com:8443,bad host,,x_y')], [...J.parseDcHosts(['C.example.com', 5])], [...J.parseDcHosts(null)], J.siteHostsFromEnv({ PLANGRAPH_JIRA_SITES: 'a.atlassian.net' }), J.dcHostsFromEnv({ PLANGRAPH_JIRA_DC_HOSTS: 'jira.corp:8443' }), J.siteHostsFromEnv(), J.dcHostsFromEnv()]);
  const urls = ['https://api.atlassian.com', 'https://api.atlassian.com/', 'https://team.atlassian.net', 'https://team.atlassian.net/x', 'http://team.atlassian.net', 'https://u:p@team.atlassian.net',
    'https://team.atlassian.net?q=1', 'https://team.atlassian.net#f', 'https://team.atlassian.net:8443', 'https://evil.example.com', 'https://jira.corp:8443/jira', 'https://jira.corp:8443/a b', 'https://jira.corp/x%2e',
    'not a url', '', 'https://tëam.atlassian.net', 'http://127.0.0.1:9/', 'http://localhost/x', 'https://-bad.atlassian.net', 'https://jira.corp:8443/jira/'];
  const modes: J.ValidateOptions[] = [{}, { mode: 'scoped' }, { mode: 'site-token' }, { mode: 'site-token', siteHosts: 'other.atlassian.net' }, { mode: 'datacenter', dcHosts: 'jira.corp:8443' }, { mode: 'datacenter' }, { allowInsecureLocalhostForTests: true }, { allowInsecureLocalhostForTests: true, mode: 'datacenter' }];
  G('validate', () => modes.map((o) => urls.map((u) => outcome(() => J.validateBase(u, o)))));
  G('validate-type', () => outcome(() => J.validateBase(5)));
});

test('credentials from env, 1Password, the keychain, and their errors', async () => {
  const exec = (by: Record<string, string | Error>) => async (file: string) => { const v = by[file]; if (v instanceof Error || v === undefined) throw v ?? new Error('missing'); return v; };
  const cases = [
    [{ JIRA_EMAIL: EMAIL, JIRA_API_TOKEN: TOKEN }, {}, 'linux'], [{ JIRA_API_TOKEN: TOKEN }, {}, 'win32'], [{ JIRA_EMAIL: 'not-an-email', JIRA_API_TOKEN: TOKEN }, {}, 'linux'],
    [{ JIRA_EMAIL: EMAIL, JIRA_API_TOKEN: 'short' }, {}, 'linux'], [{ JIRA_OP_REF: 'op://v/i/f' }, { op: `${EMAIL}:${TOKEN}\n` }, 'linux'], [{ JIRA_OP_REF: 'op://v/i/f', JIRA_EMAIL: EMAIL }, { op: TOKEN }, 'linux'],
    [{ JIRA_OP_REF: 'bad ref' }, {}, 'linux'], [{ JIRA_OP_REF: 'op://v/i/f' }, { op: new Error('x') }, 'linux'], [{ JIRA_OP_REF: 'op://v/i/f' }, { op: 'a\nb' }, 'linux'], [{ JIRA_OP_REF: 'op://v/i/f' }, { op: '   ' }, 'linux'],
    [{}, { security: `${EMAIL}:${TOKEN}` }, 'darwin'], [{}, { 'secret-tool': TOKEN }, 'linux'], [{ JIRA_EMAIL: EMAIL }, { 'secret-tool': TOKEN }, 'linux'], [{}, {}, 'darwin'], [{}, {}, 'win32'],
    [{ JIRA_API_TOKEN: TOKEN }, { security: `${EMAIL}:${TOKEN}x` }, 'darwin'], [{ JIRA_OP_REF: 'op://v/i/f' }, { op: TOKEN, security: `${EMAIL}:${TOKEN}` }, 'darwin'],
  ];
  const out = [];
  for (const [env, by, platform] of cases as Array<[Record<string, string>, Record<string, string | Error>, string]>) { // the table literal is a union TypeScript cannot read as tuples
    try { const c = await J.getCredentials({ env, exec: exec(by), platform }); out.push({ ...c, token: c.token === TOKEN ? 'TOKEN' : c.token === `${TOKEN}x` ? 'TOKENx' : 'other', json: JSON.stringify(c) }); } catch (e) { out.push(outcome(() => { throw e; })); }
  }
  golden('jira', 'credentials', out);
});

/** scripted fetch: each call takes the next step; a step is a function (url, init) -> Response, or an Error to throw */
type Step = Error | ((url: string, init: RequestInit) => Response);
const scripted = (steps: Step[], log: string[]) => async (url: string, init: RequestInit): Promise<Response> => {
  log.push(`${init.method} ${url} ${init.body ?? ''} redirect=${init.redirect} auth=${String((init.headers as Record<string, string>).Authorization).split(' ')[0]}`); // makeClient always sends a plain headers object
  const s = steps.shift();
  if (s instanceof Error) throw s;
  if (!s) return new Response('{}', { status: 200 });
  return s(url, init);
};
const res = (status: number, body: unknown, headers: Record<string, string> = {}) => () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
const client = (steps: Step[], extra: J.ClientOptions = {}) => {
  const log: string[] = [];
  const sleeps: number[] = [];
  const says: string[] = [];
  const c = J.makeClient({ baseConfig: { auth: { mode: 'scoped' }, cloudId: CLOUD }, creds: { email: EMAIL, token: TOKEN }, fetchImpl: scripted(steps, log), sleep: async (ms) => { sleeps.push(ms); }, now: () => NOW, random: () => 0.5, log: (s) => says.push(s), backoffMs: 10, ...extra });
  return { c, log, sleeps, says };
};
const ME = res(200, { accountId: 'acc-1', timeZone: 'Europe/Berlin' });

test('client: configuration, the allowlist, retries and failure classes', async () => {
  G('client-config', () => [
    outcome(() => J.makeClient({ baseConfig: { auth: { mode: 'nope' } } })), outcome(() => J.makeClient({ baseConfig: { auth: { mode: 'scoped' } }, creds: { email: EMAIL, token: TOKEN } })),
    outcome(() => J.makeClient({ baseConfig: { auth: { mode: 'scoped' }, cloudId: CLOUD } })), outcome(() => J.makeClient({ baseConfig: { auth: { mode: 'datacenter' }, baseUrl: 'https://jira.corp:8443' }, creds: { token: TOKEN }, dcHosts: 'jira.corp:8443' }).identity),
    outcome(() => J.makeClient({ baseConfig: { auth: { mode: 'site-token' }, baseUrl: 'https://team.atlassian.net' }, creds: { token: TOKEN } })), outcome(() => J.makeClient({ baseConfig: { mode: 'site-token', baseUrl: 'https://team.atlassian.net' }, creds: { email: EMAIL, token: TOKEN } }).mode),
  ]);
  const { c, log, sleeps, says } = client([
    res(429, '', { 'retry-after': '2' }), res(429, '', {}), ME,
    res(302, '', { location: 'https://elsewhere' }), res(400, { errorMessages: ['bad <jql>', 'x\ny'] }), res(400, 'not json'), res(401, ''), res(403, ''), res(404, ''), res(500, ''), res(200, 'not json'),
    new Error('socket hang up'), Object.assign(new Error('t'), { name: 'TimeoutError' }),
    res(429, '', { 'ratelimit-reason': 'Quota-Exceeded', 'x-ratelimit-reset': '2026-05-01T13:00:00Z' }), res(429, '', { 'retry-after': '999' }),
  ]);
  const r = [];
  r.push(await GAo(() => c.request('GET', '/rest/api/3/myself')));
  for (let i = 0; i < 10; i++) r.push(await GAo(() => c.request('GET', '/rest/api/3/issue/ABC-1', { query: { fields: 'summary' } })));
  r.push(await GAo(() => c.request('GET', '/rest/api/3/myself')), await GAo(() => c.request('GET', '/rest/api/3/myself')));
  r.push(await GAo(() => c.request('DELETE', '/rest/api/3/issue/ABC-1')), await GAo(() => c.request('GET', '/rest/api/3/issue/abc-1')), await GAo(() => c.request('GET', '/rest/api/2/myself')), await GAo(() => c.request('GET', 5 as unknown as string)), await GAo(() => c.request('GET', '/rest/api/3/myself?x=1'))); // 5: deliberate misuse
  golden('jira', 'client-requests', { r, log, sleeps, says });
  const many = client(Array.from({ length: 6 }, () => res(429, '', {})), { maxRetries: 2 });
  await GA('client-rate-limited', async () => ({ e: await GAo(() => many.c.request('GET', '/rest/api/3/myself')), sleeps: many.sleeps }));
  const big = client([() => new Response(new ReadableStream({ start(ctl) { ctl.enqueue(new Uint8Array(40)); ctl.enqueue(new Uint8Array(40)); ctl.close(); } }), { status: 200 })], { maxBodyBytes: 50 });
  await GA('client-body-cap', () => big.c.request('GET', '/rest/api/3/myself'));
  const streamed = client([() => new Response(new ReadableStream({ start(ctl) { ctl.enqueue(new TextEncoder().encode('{"a":')); ctl.enqueue(new TextEncoder().encode('1}')); ctl.close(); } }), { status: 200 })]);
  await GA('client-stream', () => streamed.c.request('GET', '/rest/api/3/myself'));
});

test('client: identity, search paging (Cloud and Data Center), count, issue, changelog', async () => {
  const runs = [];
  for (const [label, me] of ([['ok', ME], ['anon', res(200, { accountId: 'anonymous' })], ['inactive', res(200, { accountId: 'a', active: false })], ['empty', res(200, {})], ['401', res(401, '')], ['500', res(500, '')], ['no-tz', res(200, { accountId: 'a' })]])) {
    const { c } = client([me as Step]); // each row is [label, step]; TypeScript reads the table as a union
    runs.push([label, await GAo(() => c.verify()), await GAo(() => c.verify())]);
  }
  golden('jira', 'verify', runs);
  const cl = client([res(200, { issues: [{ key: 'A-1' }], nextPageToken: 'p2' }), res(200, { issues: [{ key: 'A-2' }], nextPageToken: 'p3', isLast: true }), res(200, { issues: 'x' }), res(200, { count: 7 }), res(200, { count: -1 }), res(200, { fields: {} }),
    res(200, { values: [{ id: '1' }], isLast: false }), res(200, { values: [{ id: '2' }] }), res(200, { values: [] })]);
  const out = [await cl.c.search({ jql: 'project = A', fields: ['summary'], pageSize: 1, cursor: null }), await cl.c.search({ jql: 'project = A', fields: ['summary'], pageSize: 1, cursor: 'p2' }), await cl.c.search({ jql: 'q', fields: ['x'], pageSize: 5, cursor: '' }),
    await cl.c.count('project = A'), await cl.c.count('project = A'), await cl.c.issue('A-1', ['summary', 'status']), await cl.c.changelog('A-1', { maxPages: 2 }), await cl.c.changelog('A-1')];
  golden('jira', 'cloud-calls', { out, log: cl.log, now: cl.c.now().toISOString(), identity: cl.c.identity, mode: cl.c.mode });
  const dlog: string[] = [];
  const dc = J.makeClient({ baseConfig: { auth: { mode: 'datacenter' }, baseUrl: 'https://jira.corp:8443/jira' }, creds: { token: TOKEN }, dcHosts: 'jira.corp:8443', fetchImpl: (scripted([res(200, { issues: [{ key: 'A-1' }, { key: 'A-2' }], total: 3 }), res(200, { issues: [{ key: 'A-3' }], total: 3 }), res(200, { issues: [], total: 0 }), res(200, { total: 4 }), res(200, { name: 'svc' })], dlog)), now: () => NOW });
  const d = [await dc.search({ jql: 'q', fields: ['a'], pageSize: 2, cursor: null }), await dc.search({ jql: 'q', fields: ['a'], pageSize: 2, cursor: 2 }), await dc.search({ jql: 'q', fields: ['a'], pageSize: 2, cursor: 0 }), await dc.count('q'), await dc.verify(), await GAo(() => dc.changelog('A-1'))];
  golden('jira', 'dc-calls', { d, log: dlog, identity: dc.identity });
});

const issue = (key: string, updated: string, extra: Record<string, unknown> = {}) => ({ key, fields: { summary: `sum ${key}`, status: { name: 'To Do' }, assignee: { displayName: 'Ana' }, updated, resolutiondate: null, issuelinks: [{ type: { inward: 'is blocked by', outward: 'blocks' }, inwardIssue: { key: 'B-1' } }, { type: { outward: 'relates' }, outwardIssue: { key: 'bad' } }], ...extra } });
const fakeClient = (pages: Array<J.SearchPage | Error>, { tz = 'UTC', count = 2 as number | Error, mode = 'scoped', identity = { cloud_id: CLOUD } } = {}): J.SnapshotClient & { calls: J.SearchQuery[] } => {
  const calls: J.SearchQuery[] = [];
  return { calls, mode, identity, now: () => new Date(NOW), verify: async () => ({ timeZone: tz }), count: async () => { if (count instanceof Error) throw count; return count; }, search: async (q: J.SearchQuery) => { calls.push(q); const p = pages.shift(); if (p instanceof Error) throw p; return p as J.SearchPage; } }; // the scripted pages never run out
};

test('pullSnapshot: full, delta, reconcile, failures, drift', async () => {
  const p1 = [{ issues: [issue('A-1', '2026-04-01T10:00:00.000+0000'), issue('A-2', '2026-04-02T10:00:00.000+0000'), { key: 'nope' }], cursor: 'c2', last: false }, { issues: [issue('A-1', '2026-03-01T10:00:00.000+0000')], cursor: null, last: true }];
  const c1 = fakeClient(p1);
  const full = await J.pullSnapshot(c1, { jql: 'project = A ORDER BY created', sprintField: 'customfield_1' });
  golden('jira', 'pull-full', { full, calls: c1.calls });
  const prev = full.snapshot as J.Snapshot; // the full pull above succeeds
  const c2 = fakeClient([{ issues: [issue('A-2', '2026-04-03T10:00:00Z'), issue('A-3', '2026-04-03T11:00:00Z'), issue('A-1', '2026-01-01T00:00:00Z')], last: true }], { count: 9 });
  golden('jira', 'pull-delta', { r: await J.pullSnapshot(c2, { jql: 'project = A', previous: prev, sprintField: 'customfield_1' }), calls: c2.calls });
  const c3 = fakeClient([{ issues: [issue('A-1', '2026-04-01T10:00:00.000+0000')], last: true }], { count: new Error('x') });
  golden('jira', 'pull-reconcile', await J.pullSnapshot(c3, { jql: 'project = A', previous: { ...prev, meta: { ...prev.meta, delta_runs: 2 } }, fullReconcileEvery: 3, sprintField: 'customfield_1' }));
  const c4 = fakeClient([{ issues: [], last: true }], { tz: '' });
  golden('jira', 'pull-no-tz', await J.pullSnapshot(c4, { jql: 'project = A', previous: prev, sprintField: 'customfield_1' }));
  const c5 = fakeClient([{ issues: [], last: true }], { tz: 'Not/AZone' });
  golden('jira', 'pull-bad-tz', await J.pullSnapshot(c5, { jql: 'project = A', previous: prev, since: '2026-04-01T00:00:00Z', overlapMinutes: 0 }));
  const fails = [];
  for (const pages of [[{ issues: [], cursor: 'x', last: false }, { issues: [], cursor: 'x', last: false }], Array.from({ length: 6 }, (_, i) => ({ issues: [], cursor: `c${i}`, last: false })), [new J.JiraError('rate_limited', 'slow', { resetAt: '2026-05-02T00:00:00.000Z' })], [new Error('boom')]]) {
    fails.push(await J.pullSnapshot(fakeClient(pages), { jql: 'project = A' }));
  }
  fails.push(await J.pullSnapshot(fakeClient([{ issues: [issue('A-1', 'x')], cursor: 'n', last: false }, { issues: [], cursor: 'n2', last: true }]), { jql: 'project = A', maxPages: 1 }));
  golden('jira', 'pull-failures', fails);
  golden('jira', 'pull-bad-input', [await GAo(() => J.pullSnapshot(fakeClient([]), { jql: ' ORDER BY key' })), await GAo(() => J.pullSnapshot(fakeClient([]), { jql: 'x'.repeat(20001) })), await GAo(() => J.pullSnapshot(fakeClient([]), { jql: 'p', fields: [] })), await GAo(() => J.pullSnapshot(fakeClient([]), { jql: 'p', fields: ['ok', '1bad'] }))]);
  golden('jira', 'pull-drift', await J.pullSnapshot(fakeClient([{ issues: Array.from({ length: 3 }, (_, i) => issue(`A-${i + 1}`, '2026-04-01T10:00:00Z')), last: true }], { count: 200 }), { jql: 'project = A', fields: ['summary'], driftAbs: 1, driftPct: 0.5 }));
});

test('normalization, import, snapshots, changelog, issue text', async () => {
  const legacy = 'com.atlassian.greenhopper.service.sprint.Sprint@1[id=7,rapidViewId=1,state=ACTIVE,name=Sprint 7,startDate=x]';
  G('normalize', () => [
    J.normalizeIssue(issue('A-1', '2026-04-01T10:00:00Z', { customfield_1: [legacy, { id: 9, name: 'S <9>', state: 'future' }, 'garbage'] }), { sprintField: 'customfield_1' }),
    J.normalizeIssue({ key: 'A-2', fields: { customFields: { Sprint: { id: 'cf_s', value: [{ id: 3, name: 'S3', state: 'closed' }] }, Other: 'x' } } }),
    J.normalizeIssue({ key: 'A-3', fields: { customFields: { Iteration: { id: 'customfield_9', value: [{ id: 4 }] }, __proto__: { id: 'customfield_9' } } } }, { sprintField: 'customfield_9' }),
    J.normalizeIssue({ key: 'A-4', fields: { customfield_2: Array.from({ length: 25 }, (_, i) => ({ id: 100 - i, name: `S${100 - i}` })) } }, { sprintField: 'customfield_2' }),
    J.normalizeIssue({ key: 'A-5', fields: null }, { sprintField: 'cf' }), J.normalizeIssue({ key: 'a-1' }), J.normalizeIssue(null), J.normalizeIssue({ key: 'A-6', fields: { issuelinks: 'x', summary: 5 } }),
  ]);
  G('times', () => ['2026-04-01T10:00:00Z', '2026-04-01T10:00:00.12+0200', '2026-04-01T10:00:00.1234-05:30', '2026-04-01T10:00:00+01', 'nope', 5].map((s) => J.parseJiraTime(s)));
  const prev = { schema: 1, meta: { jql: 'p', complete: true }, issues: [{ key: 'A-1', updated: '2026-04-05T00:00:00Z', issuelinks: [{ key: 'B-1', type: 'blocks', dir: 'out' }] }] } as J.Snapshot; // deliberately partial issues
  const now = () => new Date(NOW);
  G('import', () => [
    J.importIssues(prev, { issues: { nodes: [{ key: 'A-1', fields: { summary: 'new', updated: '2026-04-06T00:00:00Z' } }, { key: 'A-2', fields: { updated: '2026-04-01T00:00:00Z' } }, { key: 'x' }] } }, { now }),
    J.importIssues(prev, [{ key: 'A-1', fields: { updated: '2026-04-01T00:00:00Z', issuelinks: [] } }], { now }),
    J.importIssues(null, { nodes: [{ key: 'C-1', fields: {} }] }, { now }), J.importIssues(null, { key: 'D-1', fields: {} }, { now }), J.importIssues(null, { issues: [] }, { now }),
    outcome(() => J.importIssues(null, 5 as unknown as J.RawImport, { now })), outcome(() => J.importIssues(null, null, { now })), // 5: deliberate misuse
  ]);
  const snap = J.importIssues(null, [issue('A-1', '2026-04-01T10:00:00Z')], { now }).snapshot;
  const text = J.snapshotToJsonl(snap);
  G('snapshot', () => [text, J.parseSnapshotJsonl(text), J.toLegacyMap(J.parseSnapshotJsonl(text)), outcome(() => J.parseSnapshotJsonl('{"schema":2,"meta":{}}\n')), outcome(() => J.parseSnapshotJsonl('{"schema":1}\n')), outcome(() => J.parseSnapshotJsonl(''))]);
  const changes = { verify: async () => ({}), changelog: async () => [{ id: 1, created: '2026-01-01', author: { displayName: 'Ana' }, items: [{ field: 'status', fromString: 'To Do', toString: 'Done', from: 1, to: 2 }] }, { items: null }] };
  await GA('changelog', async () => [await J.fetchChangelog(changes, 'A-1'), await GAo(() => J.fetchChangelog(changes, 'bad'))]);
  const adf = { type: 'doc', content: [{ type: 'heading', attrs: { level: 9 }, content: [{ type: 'text', text: 'Title' }] }, { type: 'heading', content: [{ type: 'text', text: 'Sub' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'a' }, { type: 'hardBreak' }, { type: 'mention', attrs: { text: 'Ben' } }, { type: 'mention' }] }, { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] }] }, { type: 'orderedList', content: [{ type: 'listItem', content: [{ type: 'text', text: 'two' }] }] }, { type: 'codeBlock', content: [{ type: 'text', text: 'x = 1' }] }, { type: 'unknown', content: [{ type: 'text' }] }, 'raw'] };
  let deep: J.RawAdf = { type: 'text', text: 'leaf' }; for (let i = 0; i < 120; i++) deep = { type: 'paragraph', content: [deep] };
  G('adf', () => [J.adfToText(adf), J.adfToText(null), J.adfToText(deep).length, outcome(() => J.adfToText({ type: 'paragraph', content: 'x' })), J.adfToText({ type: 'heading', attrs: { level: 0 } })]);
  const fields = { summary: 'Fix <untrusted> the\nthing', status: { name: 'Done' }, updated: '2026-04-01', description: adf, comment: { total: 3, comments: [{ author: { displayName: 'Ana' }, created: '2026-04-02', body: adf }, { body: null }] } };
  G('render', () => [J.renderIssue('ABC-1', { fields }), J.renderIssue(' AB C-2\n', { fields: {} }), J.renderIssue('ABC-3', null), ...[60, 120, 200, 260, 400].map((n) => J.renderIssue('ABC-1', { fields }, { maxChars: n }))]);
  const ic = { verify: async () => ({}), issue: async (k: string, f: string[]) => ({ fields: { summary: `${k} ${f.join(',')}` } }) };
  await GA('issue-text', async () => [await J.fetchIssueText(ic, 'ABC-9'), await GAo(() => J.fetchIssueText(ic, 'abc')), await GAo(() => J.fetchIssueText(ic, 5 as unknown as string))]); // 5: deliberate misuse
});
