// Behavior tests for lib/jira/provider.ts and lib/tracker.ts, written to kill the mutants of the trust-root run: an unminted trust is refused
// with the exact reason before any credential helper or request, a client base that no longer matches the decided tenant is refused, and
// the tenant id follows the same rule as the tenant resolver. Dependencies and the fetch are doubles.
// NOT covered: resolveTenant itself (test/jira-tenants.test.ts, test/jira-tenant-isolation.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJiraProvider } from '../lib/jira/provider.ts';
import { PROVIDERS } from '../lib/tracker.ts';
import type { ProviderDeps } from '../lib/tracker.ts';

const CLOUD = '11111111-2222-3333-4444-555555555555';
const mk = (over: Partial<ProviderDeps> = {}, ctxOver: Record<string, unknown> = {}) => {
  const calls: string[] = [];
  const deps: ProviderDeps = {
    verifyTrust: ((t: unknown) => { calls.push('verify'); return (t as { minted?: boolean }).minted === true; }) as ProviderDeps['verifyTrust'],
    credentialsFor: async () => { calls.push('credentials'); return { email: 'a@example.invalid', token: 'TOKEN-for-provider-kills-0123456789', source: 'env' }; },
    clientBaseFor: () => { calls.push('base'); return { auth: { mode: 'scoped' }, cloudId: CLOUD, baseUrl: undefined }; },
    ...over,
  };
  const fetchCalls: string[] = [];
  const ctx = { env: {}, now: () => new Date(0), fetch: (async (u: string) => { fetchCalls.push(String(u)); return new Response('{}', { status: 200 }); }) as unknown as typeof fetch, ...ctxOver };
  return { p: createJiraProvider(ctx as never, deps), calls, fetchCalls };
};
const trust = (tenant: string) => ({ minted: true, tenant, allowGeneric: false, pinned: false, userTenant: false }) as never;
const bad = (msg: string) => (e: Error & { code?: string }) => e.code === 'bad_config' && e.message === msg;
const NOT_MINTED = 'the tracker needs a tenant decision minted by resolveTenant';

test('an unminted trust is refused by every networked member before any helper or request', async () => {
  const { p, calls, fetchCalls } = mk();
  const fake = { minted: false, tenant: CLOUD } as never;
  await assert.rejects(() => p.credentials(fake), bad(NOT_MINTED));
  await assert.rejects(() => p.pull(fake, {} as never), bad(NOT_MINTED));
  await assert.rejects(() => p.fetchIssueText(fake, 'AB-1'), bad(NOT_MINTED));
  assert.deepEqual(calls, ['verify', 'verify', 'verify']);
  assert.deepEqual(fetchCalls, []);
});

test('a minted trust passes the gate; credentials come from the dependency', async () => {
  const { p, calls } = mk();
  assert.deepEqual({ ...(await p.credentials(trust(CLOUD))) }, { email: 'a@example.invalid', token: 'TOKEN-for-provider-kills-0123456789', source: 'env' });
  assert.deepEqual(calls, ['verify', 'credentials']);
});

test('a client base that no longer names the decided tenant is refused before credentials are read', async () => {
  const { p, calls, fetchCalls } = mk();
  const msg = 'the client settings no longer match the tenant that was decided';
  await assert.rejects(() => p.fetchIssueText(trust('99999999-2222-3333-4444-555555555555'), 'AB-1'), bad(msg));
  await assert.rejects(() => p.pull(trust('99999999-2222-3333-4444-555555555555'), {} as never), bad(msg));
  assert.deepEqual(calls, ['verify', 'base', 'verify', 'base']);
  assert.deepEqual(fetchCalls, []);
});

test('tenantId: the cloud id (lower case) for a scoped token or no mode, else the host of the base URL, empty when there is none', () => {
  const { p } = mk({}, { env: {} });
  assert.equal(p.tenantId({ cloud_id: CLOUD.toUpperCase() }), CLOUD);
  assert.equal(p.tenantId({ auth: { mode: 'scoped' }, cloud_id: CLOUD }), CLOUD);
  assert.equal(p.tenantId({}), '');
  assert.equal(p.tenantId({ auth: { mode: 'site-token' }, base_url: 'https://Acme.atlassian.net/' }), 'acme.atlassian.net');
  assert.equal(p.tenantId({ auth: { mode: 'datacenter' }, base_url: 'https://jira.corp:8443/x' }), 'jira.corp:8443');
  assert.equal(p.tenantId({ auth: { mode: 'site-token' } }), '');
  assert.equal(p.tenantId({ auth: { mode: 'site-token' }, base_url: 'not a url' }), '');
  // the environment's base URL wins over the committed one
  const e = mk({}, { env: { JIRA_BASE_URL: 'https://env.atlassian.net/' } });
  assert.equal(e.p.tenantId({ auth: { mode: 'site-token' }, base_url: 'https://file.atlassian.net/' }), 'env.atlassian.net');
  assert.equal(e.p.tenantId({ cloud_id: CLOUD }), CLOUD);
});

test('the provider is frozen, is of kind jira, and PROVIDERS is a frozen null-prototype table holding it', () => {
  const { p } = mk();
  assert.equal(p.kind, 'jira'); assert.ok(Object.isFrozen(p));
  assert.ok(Object.isFrozen(PROVIDERS)); assert.equal(Object.getPrototypeOf(PROVIDERS), null);
  assert.deepEqual(Object.keys(PROVIDERS), ['jira']); assert.equal(PROVIDERS.jira, createJiraProvider);
});
