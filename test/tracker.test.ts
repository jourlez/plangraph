// The tracker provider seam and the Trust binding (src/tracker-factory.ts, lib/tracker.ts, lib/jira/provider.ts, src/jira-tenant.ts).
// Every trust decision has an attack test: a recording exec counts credential-helper calls and a stub fetch counts requests, through the
// production wiring (makeContext({ exec, fetch }) and createTracker). A forged Trust is a cast, an object spread or a mutation attempt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTracker } from '../src/tracker-factory.ts';
import { makeContext } from '../src/context.ts';
import { main } from '../src/cli.ts';
import { resolveTenant, isMintedTrust, tenantOf } from '../src/jira-tenant.ts';
import { PROVIDERS, snapshotToJsonl } from '../lib/tracker.ts';
import { JiraError } from '../lib/jira.ts';
import { PROBES } from '../scripts/baseline.ts';
import type { Ctx, ContextOptions } from '../src/context.ts';
import type { Trust } from '../src/jira-tenant.ts';
import type { TrackerProvider, Snapshot, PullResult } from '../lib/tracker.ts';
import type { Exec, FetchLike } from '../lib/jira.ts';

const made: string[] = [];
const tmp = (): string => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-'))); made.push(d); return d; };
process.on('exit', () => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

const GEN = { JIRA_EMAIL: 'me@example.invalid', JIRA_API_TOKEN: 'generic-token-1' };
const CLOUD_A = 'cloud-aaaa-0001', CLOUD_B = 'cloud-bbbb-0002';
/** A repository root with a .git entry and a .plangraph/config.json holding `config`; `rawConfig` is written as is when given. */
function repo(config: unknown = {}, rawConfig?: string): string {
  const d = tmp();
  fs.mkdirSync(path.join(d, '.git')); fs.mkdirSync(path.join(d, '.plangraph'));
  fs.writeFileSync(path.join(d, '.plangraph', 'config.json'), rawConfig ?? JSON.stringify(config));
  return d;
}
/** A user config dir (the registry file when `obj` is given). */
function cfgEnv(obj?: unknown): Record<string, string> {
  const dir = tmp();
  if (obj !== undefined) fs.writeFileSync(path.join(dir, 'jira-sites.json'), JSON.stringify(obj));
  return { PLANGRAPH_CONFIG_DIR: dir };
}
const io = () => { const out: string[] = []; return { out, io: { out: (l: string) => out.push(l), err: (l: string) => out.push(`ERR ${l}`), raw: (t: string) => out.push(t) } }; };
function recorders() {
  const execCalls: string[] = [], urls: string[] = [];
  const exec: Exec = async (file, args) => { execCalls.push([file, ...args].join(' ')); throw new Error('no helper item'); };
  const fetch: FetchLike = async (url, init) => {
    urls.push(url);
    const u = new URL(url), method = String(init.method || 'GET');
    const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (u.pathname.endsWith('/myself')) return reply({ accountId: 'acct-1', timeZone: 'UTC' });
    if (method === 'POST' && /\/search\/(jql|approximate-count)$/.test(u.pathname)) return reply({ issues: [], isLast: true, count: 0 });
    if (/\/issue\/[A-Z]+-\d+$/.test(u.pathname)) return reply({ key: 'TST-1', fields: { summary: 's', status: { name: 'To Do' }, updated: '2026-01-01T00:00:00.000+0000' } });
    return new Response('{}', { status: 404 });
  };
  return { execCalls, urls, exec, fetch };
}
function ctxFor(root: string, env: Record<string, string | undefined>, extra: Partial<ContextOptions> = {}): Ctx & Disposable {
  return makeContext({ root, cwd: root, env, io: io().io, ...extra });
}
const code = (e: unknown) => e instanceof JiraError && e.code;

test('createTracker returns the jira provider by default', () => {
  const ctx = ctxFor(repo(), {});
  const t = createTracker(ctx);
  assert.equal(t.kind, 'jira');
  assert.equal(ctx.tracker(), ctx.tracker(), 'ctx.tracker() is memoized');
  assert.equal(ctx.tracker().kind, 'jira');
});

test('an unknown tracker.kind is exit 2 and names jira', async () => {
  const d = repo({ tracker: { kind: 'github' } });
  assert.throws(() => createTracker(ctxFor(d, {})), (e: unknown) => (e as { exitCode: number }).exitCode === 2 && /known kinds: jira/.test((e as Error).message));
  const out = io();
  assert.equal(await main(['jira-pull', '--out', path.join(d, 'x.jsonl')], { io: out.io, env: { ...cfgEnv() }, cwd: d }), 2);
});

test('tracker.kind "__proto__" and "constructor" are unknown kinds, exit 2', () => {
  for (const kind of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', '']) {
    const d = repo(null, `{"tracker":{"kind":${JSON.stringify(kind)}}}`);
    assert.throws(() => createTracker(ctxFor(d, {})), (e: unknown) => (e as { exitCode: number }).exitCode === 2, kind);
  }
  assert.throws(() => createTracker(ctxFor(repo({ tracker: { kind: 7 } }), {})), (e: unknown) => (e as { exitCode: number }).exitCode === 2);
  assert.equal(Object.getPrototypeOf(PROVIDERS), null);
  assert.ok(Object.isFrozen(PROVIDERS));
  assert.deepEqual(Object.keys(PROVIDERS), ['jira']);
});

const FIXED: Snapshot = { schema: 1, meta: { jql: 'project = TST', complete: true }, issues: [{ key: 'TST-1', summary: 'one', status: 'To Do', assignee: '', updated: '2026-01-01T00:00:00.000Z', resolutiondate: '', issuelinks: [] }] };
function fakeProvider(over: Partial<TrackerProvider> = {}): TrackerProvider {
  const pulled: PullResult = { ok: true, complete: true, snapshot: FIXED, mode: 'full', windowMinutes: 0, reason: 'fake', received: 1, warnings: [], changedKeys: [], removedKeys: [], summary: 'fake pull: 1 issue' };
  return { kind: 'fake', tenantId: () => 'fake', credentials: async () => { throw new Error('fake has no credentials'); }, pull: async () => pulled,
    importIssues: (prev) => ({ snapshot: prev ?? FIXED, imported: 0, dropped: 0, changedKeys: [], summary: 'fake import' }), renderIssue: () => 'fake text', fetchIssueText: async () => 'fake text', ...over };
}
const withTracker = (tracker: TrackerProvider) => (opts: ContextOptions) => makeContext({ ...opts, tracker });

test('jira-pull uses an injected fake provider and never touches the network', async (t) => {
  const d = repo(), out = path.join(d, 'snap.jsonl');
  const fetchCalls: unknown[] = [];
  t.mock.method(globalThis, 'fetch', async (...a: unknown[]) => { fetchCalls.push(a); throw new Error('network'); });
  const o = io();
  assert.equal(await main(['jira-pull', '--out', out], { io: o.io, env: cfgEnv(), cwd: d, makeContext: withTracker(fakeProvider()) }), 0);
  assert.equal(fs.readFileSync(out, 'utf8'), snapshotToJsonl(FIXED));
  assert.equal(fetchCalls.length, 0);
});

test('jira-pull --out through the provider writes mode 0600', async () => {
  const d = repo(), out = path.join(d, 'snap.jsonl');
  await main(['jira-pull', '--out', out], { io: io().io, env: cfgEnv(), cwd: d, makeContext: withTracker(fakeProvider()) });
  assert.equal(fs.statSync(out).mode & 0o777, 0o600);
});

test('a fake snapshot with an unknown field does not crash jira-import', async () => {
  const d = repo(), out = path.join(d, 'snap.jsonl'), inFile = path.join(d, 'in.json');
  fs.writeFileSync(inFile, JSON.stringify([{ key: 'TST-1', fields: { summary: 'x' } }]));
  const odd = { ...FIXED, extra: 1, issues: FIXED.issues.map((i) => ({ ...i, surprise: { nested: true } })) } as unknown as Snapshot;
  const o = io();
  const tracker = fakeProvider({ importIssues: () => ({ snapshot: odd, imported: 1, dropped: 0, changedKeys: ['TST-1'], summary: 'odd' }) });
  assert.equal(await main(['jira-import', inFile, '--out', out], { io: o.io, env: cfgEnv(), cwd: d, makeContext: withTracker(tracker) }), 0);
  assert.ok(fs.readFileSync(out, 'utf8').includes('surprise'));
});

const committedOnly = { auth: { mode: 'site-token' }, base_url: 'https://evil.atlassian.net', jql: 'project = TST' };
const badTrust = (e: unknown) => code(e) === 'bad_config';

test('a hand-built Trust is refused with bad_config and runs no credential helper', async () => {
  const r = recorders(), env = { ...GEN, JIRA_OP_REF: 'op://Private/jira/generic', ...cfgEnv() };
  const provider = createTracker(ctxFor(repo(), env, { exec: r.exec, fetch: r.fetch }));
  const hand = { tenant: CLOUD_A, allowGeneric: true, pinned: true, userTenant: true } as unknown as Trust; // as Trust: the brand is type-only; this is the forgery under test
  assert.equal(isMintedTrust(hand), false);
  await assert.rejects(provider.credentials(hand), badTrust);
  await assert.rejects(provider.pull(hand, { jql: 'project = TST' }), badTrust);
  await assert.rejects(provider.fetchIssueText(hand, 'TST-1'), badTrust);
  for (const junk of [null, undefined, 'x', 1, {}, [], Object.create(null)]) await assert.rejects(provider.credentials(junk as unknown as Trust), badTrust);
  assert.deepEqual(r.execCalls, []); assert.deepEqual(r.urls, []);
});

test('a minted trust for a committed-only site gets no generic credentials', async () => {
  const r = recorders(), env = { ...GEN, JIRA_OP_REF: 'op://Private/jira/generic', ...cfgEnv() }, root = repo();
  const t = resolveTenant(committedOnly as never, root, env);
  assert.equal(t.allowGeneric, false);
  const provider = createTracker(ctxFor(root, env, { exec: r.exec, fetch: r.fetch }));
  await assert.rejects(provider.credentials(t.trust), (e: unknown) => code(e) === 'no_credentials');
  await assert.rejects(provider.pull(t.trust, { jql: 'project = TST' }), (e: unknown) => code(e) === 'no_credentials');
  assert.deepEqual(r.urls, []);
  assert.deepEqual(r.execCalls.filter((c) => c.startsWith('op read op://Private/jira/generic')), []);
});

test('a trust minted for site A cannot be re-used for site B: a copy with tenant B (object spread) is unminted, bad_config, zero helper calls', async () => {
  const r = recorders(), env = { ...GEN, JIRA_OP_REF: 'op://Private/jira/generic', ...cfgEnv() }, root = repo();
  const t = resolveTenant(committedOnly as never, root, env).trust;
  const forged = { ...t, tenant: 'other.example.net' };
  const provider = createTracker(ctxFor(root, env, { exec: r.exec, fetch: r.fetch }));
  assert.equal(isMintedTrust(forged), false);
  await assert.rejects(provider.credentials(forged), badTrust);
  await assert.rejects(provider.pull(forged, { jql: 'project = TST' }), badTrust);
  await assert.rejects(provider.credentials(Object.assign(Object.create(Object.getPrototypeOf(t)), t, { tenant: 'other.example.net' })), badTrust);
  assert.equal(r.execCalls.length, 0); assert.equal(r.urls.length, 0);
  // the minted object itself cannot be edited into another tenant
  assert.throws(() => { (t as { tenant: string }).tenant = 'other.example.net'; }, TypeError);
  assert.ok(Object.isFrozen(t));
});

test('a trust minted in one context cannot be used for credentials of a changed environment: the client refuses a moved site', async () => {
  const r = recorders(), cfg = cfgEnv(), env: Record<string, string> = { ...GEN, PLANGRAPH_JIRA_SITES: 'a.atlassian.net', ...cfg }, root = repo();
  const t = resolveTenant({ auth: { mode: 'site-token' }, base_url: 'https://a.atlassian.net' } as never, root, env);
  assert.equal(t.allowGeneric, true); assert.equal(t.tenant, 'a.atlassian.net');
  env.JIRA_BASE_URL = 'https://b.atlassian.net'; // the environment moves after the decision
  const provider = createTracker(ctxFor(root, env, { exec: r.exec, fetch: r.fetch }));
  await assert.rejects(provider.pull(t.trust, { jql: 'project = TST' }), badTrust);
  await assert.rejects(provider.fetchIssueText(t.trust, 'TST-1'), badTrust);
  assert.equal(r.urls.length, 0); assert.equal(r.execCalls.length, 0);
});

test('an unknown auth.mode through the provider throws before any helper runs', async () => {
  const r = recorders(), env = { ...GEN, JIRA_OP_REF: 'op://Private/jira/generic', ...cfgEnv() }, root = repo();
  assert.throws(() => resolveTenant({ auth: { mode: 'evil' }, base_url: 'https://evil.atlassian.net' } as never, root, env), badTrust);
  const d = repo({ jira: { auth: { mode: 'evil' }, base_url: 'https://evil.atlassian.net', jql: 'project = TST' } });
  const o = io();
  assert.equal(await main(['jira-pull', '--out', path.join(d, 's.jsonl')], { io: o.io, env, cwd: d, makeContext: (opts) => makeContext({ ...opts, exec: r.exec, fetch: r.fetch }) }), 3);
  assert.equal(r.execCalls.length, 0); assert.equal(r.urls.length, 0);
});

test('an empty tenant through the provider runs no helper', async () => {
  const r = recorders(), env = { ...GEN, JIRA_OP_REF: 'op://Private/jira/generic', ...cfgEnv() }, root = repo();
  const t = resolveTenant({ jql: 'project = TST' } as never, root, env); // scoped, no cloud id
  assert.equal(t.tenant, '');
  const provider = createTracker(ctxFor(root, env, { exec: r.exec, fetch: r.fetch }));
  await assert.rejects(provider.credentials(t.trust), badTrust);
  await assert.rejects(provider.pull(t.trust, { jql: 'project = TST' }), badTrust);
  assert.equal(r.execCalls.length, 0); assert.equal(r.urls.length, 0);
});

test('Data Center with two allowlisted hosts and no binding gets no generic credentials', async () => {
  const r = recorders(), env = { ...GEN, PLANGRAPH_JIRA_DC_HOSTS: 'jira.one.example.net,jira.two.example.net', ...cfgEnv() }, root = repo();
  const t = resolveTenant({ auth: { mode: 'datacenter' }, base_url: 'https://jira.two.example.net', jql: 'project = TST' } as never, root, env);
  assert.equal(t.allowGeneric, false);
  const provider = createTracker(ctxFor(root, env, { exec: r.exec, fetch: r.fetch }));
  await assert.rejects(provider.credentials(t.trust), (e: unknown) => code(e) === 'no_credentials');
  await assert.rejects(provider.pull(t.trust, { jql: 'project = TST' }), (e: unknown) => code(e) === 'no_credentials');
  assert.equal(r.urls.length, 0);
});

test('pull and fetchIssueText with a trust minted for site A contact only A\'s origin', async () => {
  const r = recorders(), env = { ...GEN, ...cfgEnv({ projects: {} }) };
  for (const [cloud, root] of [[CLOUD_A, repo()], [CLOUD_B, repo()]] as const) {
    const t = resolveTenant({ cloud_id: cloud, jql: 'project = TST' } as never, root, env);
    assert.equal(t.allowGeneric, true); assert.equal(t.tenant, cloud);
    const provider = createTracker(ctxFor(root, env, { exec: r.exec, fetch: r.fetch }));
    r.urls.length = 0;
    const pulled = await provider.pull(t.trust, { jql: 'project = TST' });
    assert.equal(pulled.ok, true);
    assert.equal(await provider.fetchIssueText(t.trust, 'TST-1').then((s) => s.includes('TST-1')), true);
    assert.ok(r.urls.length >= 3);
    for (const u of r.urls) assert.ok(u.startsWith(`https://api.atlassian.com/ex/jira/${cloud}/`), u);
  }
});

test('pull with an unminted trust is bad_config with zero fetch and zero helper calls', async () => {
  const r = recorders(), env = { ...GEN, ...cfgEnv() }, root = repo();
  const t = resolveTenant({ cloud_id: CLOUD_A, jql: 'project = TST' } as never, root, env);
  const provider = createTracker(ctxFor(root, env, { exec: r.exec, fetch: r.fetch }));
  await assert.rejects(provider.pull({ ...t.trust } as Trust, { jql: 'project = TST' }), badTrust);
  assert.equal(r.urls.length, 0); assert.equal(r.execCalls.length, 0);
});

test('the provider tenantId follows src/jira-tenant.ts tenantOf', () => {
  const p = createTracker(ctxFor(repo(), {}));
  const cases = [{ cloud_id: 'AbCd-1234-xx' }, { auth: { mode: 'site-token' as const }, base_url: 'https://A.atlassian.net/' }, { auth: { mode: 'datacenter' as const }, base_url: 'nope' }, {}];
  for (const c of cases) assert.equal(p.tenantId(c), tenantOf(c, {}));
});

test('importIssues and renderIssue are offline: no trust is needed', () => {
  const p = createTracker(ctxFor(repo(), {}));
  assert.equal(p.importIssues(null, [{ key: 'TST-1', fields: { summary: 'x', status: { name: 'To Do' }, updated: '2026-01-01T00:00:00.000+0000' } }]).imported, 1);
  assert.match(p.renderIssue('TST-1', { fields: { summary: 'x' } }), /^# TST-1/);
});

// ---- baseline probes: the expected outputs ----
const probe = (id: string) => (PROBES.find((p) => p.id === id) as { run(): unknown }).run();
test('probe provider-default', async () => { assert.deepEqual(await probe('provider-default'), { kind: 'jira', tenant: 'abcd-1234-xx', same: true }); });
test('probe provider-unknown-kind: exit 2 naming jira', async () => {
  const r = await probe('provider-unknown-kind') as { code: number; message: string };
  assert.equal(r.code, 2); assert.match(r.message, /known kinds: jira/);
});
test('probe provider-fake-pull: the fixed snapshot bytes', async () => {
  const r = await probe('provider-fake-pull') as { code: number; file: string };
  assert.equal(r.code, 0); assert.equal(r.file, snapshotToJsonl(FIXED));
});
