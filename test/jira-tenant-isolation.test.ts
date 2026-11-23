// Credential isolation between Jira tenants, end to end: resolveTenant decides, getCredentialsFor binds, makeClient sends (a stub fetch counts
// requests). GENERIC credentials (JIRA_EMAIL/JIRA_API_TOKEN, JIRA_OP_REF, the generic keychain item) must never reach a host chosen only by a
// committed (untrusted) config, and a hostile auth.mode must be refused before any credential helper runs. Synthetic names only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dcHostsFromEnv, getCredentials, getCredentialsFor, makeClient, siteHostsFromEnv } from '../lib/jira.ts';
import type { Exec, FetchLike, JiraError } from '../lib/jira.ts';
import { resolveTenant } from '../src/jira-tenant.ts';
import type { JiraSettings, TenantResolution } from '../src/jira-tenant.ts';

const ROOT = '/work/acme-repo';
const GEN = { JIRA_EMAIL: 'me@example.invalid', JIRA_API_TOKEN: 'generic-token-1' };
const GEN_OP = { JIRA_EMAIL: 'me@example.invalid', JIRA_OP_REF: 'op://Private/jira/generic' }; // generic credentials that need a helper
const EVIL = 'https://evil.atlassian.net';

/** A fresh user-level config dir; `obj` is written as its jira-sites.json when given. */
function cfgEnv(obj?: unknown): Record<string, string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-iso-'));
  if (obj !== undefined) fs.writeFileSync(path.join(dir, 'jira-sites.json'), JSON.stringify(obj));
  return { BRAIN_CONFIG_DIR: dir };
}

interface Attempt { t: TenantResolution | null; source: string; outcome: string; hits: string[]; calls: string[] }
/** The jira-pull path of src/commands/audit.ts (jiraClient + verify) with a recording exec and a counting fetch. */
async function attempt(committed: unknown, env: Record<string, string>): Promise<Attempt> {
  const calls: string[] = [], hits: string[] = [];
  const exec: Exec = async (file, args) => { calls.push([file, ...args].join(' ')); throw new Error('no helper item'); };
  const fetchImpl: FetchLike = async (url) => { hits.push(url); return new Response(JSON.stringify({ accountId: 'acct-1', timeZone: 'UTC' }), { status: 200 }); };
  let t: TenantResolution | null = null, source = '', outcome = 'ok';
  try {
    t = resolveTenant(committed as JiraSettings, ROOT, env); // untrusted committed JSON under test: resolveTenant must test every field
    const creds = t.tenant ? await getCredentialsFor(t.tenant, { env, exec, platform: 'darwin', registry: t.registry.reg, allowGeneric: t.allowGeneric }) : await getCredentials({ env, exec, platform: 'darwin' });
    source = creds.source;
    const client = makeClient({ baseConfig: { auth: t.jira.auth, cloudId: t.jira.cloud_id, baseUrl: env.JIRA_BASE_URL || t.jira.base_url }, creds, fetchImpl, dcHosts: dcHostsFromEnv(env), siteHosts: siteHostsFromEnv(env) });
    await client.verify();
  } catch (e) { outcome = (e as JiraError).code || 'throw'; } // every throw on this path is a JiraError; a plain Error shows as 'throw'
  return { t, source, outcome, hits, calls };
}
const genericHelper = (c: string) => c.startsWith('op read op://Private/jira/generic') || / -s project-brain-jira -w$/.test(c) || c === 'secret-tool lookup service project-brain-jira';

test('makeClient refuses an unknown auth.mode with bad_config and never calls fetch', () => {
  let called = 0;
  const fetchImpl: FetchLike = async () => { called++; return new Response('{}'); };
  assert.throws(() => makeClient({ baseConfig: { auth: { mode: 'evil' }, baseUrl: EVIL }, creds: { email: 'me@example.invalid', token: 'generic-token-1' }, fetchImpl }), { code: 'bad_config' });
  assert.equal(called, 0);
});

test('finding 1: a user cloud id with a committed site-token mode and host resolves scoped to the user cloud id, never the committed host', async () => {
  const env = { ...GEN, ...cfgEnv({ projects: { [ROOT]: { cloud_id: 'my-own-cloud-0001', jql: 'project = ACME' } } }) };
  const r = await attempt({ auth: { mode: 'site-token' }, base_url: EVIL }, env);
  const t = r.t as TenantResolution; // resolveTenant does not throw for a valid mode
  assert.equal(t.mode, 'scoped'); assert.equal(t.tenant, 'my-own-cloud-0001'); assert.equal(t.jira.base_url, undefined); assert.equal(t.jira.userTenant, true);
  assert.equal(r.outcome, 'ok');
  assert.deepEqual(r.hits, ['https://api.atlassian.com/ex/jira/my-own-cloud-0001/rest/api/3/myself']);
  assert.ok(!r.hits.some((h) => h.includes('evil')));
});

test('finding 1: a committed-only site never gets generic credentials: no request, no generic helper', async () => {
  for (const user of [{}, { projects: { [ROOT]: { jql: 'project = ACME', sprint_field: 'customfield_1' } } }]) {
    const env = { ...GEN_OP, ...cfgEnv(user) };
    const r = await attempt({ auth: { mode: 'site-token' }, base_url: EVIL }, env);
    const t = r.t as TenantResolution; // valid mode: no throw
    assert.equal(t.tenant, 'evil.atlassian.net'); assert.equal(t.allowGeneric, false); assert.equal(t.jira.userTenant, false);
    assert.equal(r.outcome, 'no_credentials'); assert.deepEqual(r.hits, []);
    assert.deepEqual(r.calls.filter(genericHelper), []);
  }
});

test('finding 1: a user base_url with a committed datacenter mode keeps the user tenant only (committed auth and host ignored)', () => {
  const env = { ...GEN, ...cfgEnv({ projects: { [ROOT]: { base_url: 'https://mine.atlassian.net' } } }) };
  const t = resolveTenant({ auth: { mode: 'datacenter' }, base_url: EVIL, cloud_id: 'attacker-cloud-0001', jql: 'project = X' }, ROOT, env);
  assert.equal(t.mode, 'scoped'); // the user entry decides the whole tenant: no committed mode is merged in
  assert.equal(t.jira.cloud_id, undefined); assert.equal(t.jira.base_url, 'https://mine.atlassian.net'); assert.equal(t.jira.jql, 'project = X');
  assert.equal(t.tenant, ''); assert.equal(t.jira.userTenant, false); // scoped needs the user's cloud id, which the entry lacks
});

const HOSTILE: unknown[] = ['evil', 'Site-Token', 'site-token ', '__proto__', 'constructor', 'toString', '', ['site-token'], { mode: 'site-token' }, 7, true];
test('hostile auth modes are refused with bad_config before any credential helper runs', async () => {
  for (const mode of HOSTILE) {
    const env = { ...GEN_OP, BRAIN_JIRA_DC_HOSTS: 'evil.atlassian.net', ...cfgEnv() };
    assert.throws(() => resolveTenant({ auth: { mode }, base_url: EVIL, cloud_id: 'abcdefgh-1234' } as JiraSettings, ROOT, env), { code: 'bad_config' }, JSON.stringify(mode)); // the hostile shape under test
    const r = await attempt({ auth: { mode }, base_url: EVIL, cloud_id: 'abcdefgh-1234' }, env);
    assert.equal(r.outcome, 'bad_config', JSON.stringify(mode)); assert.equal(r.source, '');
    assert.deepEqual(r.calls, [], JSON.stringify(mode)); assert.deepEqual(r.hits, [], JSON.stringify(mode));
  }
});

test('a hostile mode in the user entry is dropped by the registry parser, and a hostile committed mode cannot ride on it', async () => {
  const env = { ...GEN_OP, ...cfgEnv({ projects: { [ROOT]: { auth: { mode: 'evil' }, jql: 'project = ACME' } } }) };
  const r = await attempt({ auth: { mode: 'Site-Token' }, base_url: EVIL }, env);
  assert.equal(r.outcome, 'bad_config'); assert.deepEqual(r.calls, []); assert.deepEqual(r.hits, []);
});

const DC_A = 'jira.acme.example', DC_B = 'jira.beta.example';
test('datacenter with several allowlisted hosts refuses generic credentials without a binding', async () => {
  const env = { ...GEN_OP, BRAIN_JIRA_DC_HOSTS: `${DC_A},${DC_B}`, ...cfgEnv() };
  const r = await attempt({ auth: { mode: 'datacenter' }, base_url: `https://${DC_B}` }, env);
  assert.equal((r.t as TenantResolution).allowGeneric, false); // valid mode: no throw
  assert.equal(r.outcome, 'no_credentials'); assert.deepEqual(r.hits, []); assert.deepEqual(r.calls.filter(genericHelper), []);
});

test('datacenter with exactly one allowlisted host allows generic credentials there only', async () => {
  const ok = await attempt({ auth: { mode: 'datacenter' }, base_url: `https://${DC_B}` }, { ...GEN, BRAIN_JIRA_DC_HOSTS: DC_B, ...cfgEnv() });
  assert.equal((ok.t as TenantResolution).allowGeneric, true); assert.match(ok.source, /^generic/); // valid mode: no throw
  assert.deepEqual(ok.hits, [`https://${DC_B}/rest/api/2/myself`]);
  const other = resolveTenant({ auth: { mode: 'datacenter' }, base_url: `https://${DC_A}` }, ROOT, { ...GEN, BRAIN_JIRA_DC_HOSTS: DC_B, ...cfgEnv() });
  assert.equal(other.allowGeneric, false); // the single allowlisted host is not this one
});

test('datacenter with several hosts uses a registry or convention binding', async () => {
  const reg = await attempt({ auth: { mode: 'datacenter' }, base_url: `https://${DC_B}` }, { ...GEN, BETA_PAT: 'beta-pat-0001', BRAIN_JIRA_DC_HOSTS: `${DC_A},${DC_B}`, ...cfgEnv({ sites: { [DC_B]: { token_env: 'BETA_PAT' } } }) });
  assert.match(reg.source, /^registry jira\.beta\.example/); assert.equal(reg.hits.length, 1);
  const conv = await attempt({ auth: { mode: 'datacenter' }, base_url: `https://${DC_B}` }, { ...GEN, JIRA_API_TOKEN__JIRA_BETA_EXAMPLE: 'beta-pat-0002', BRAIN_JIRA_DC_HOSTS: `${DC_A},${DC_B}`, ...cfgEnv() });
  assert.match(conv.source, /^host jira\.beta\.example/); assert.equal(conv.hits.length, 1);
});

test('legitimate paths keep generic credentials: user site, user cloud id, committed cloud id, pinned site; a registry binding always wins', async () => {
  const userSite = await attempt({ base_url: EVIL }, { ...GEN, ...cfgEnv({ projects: { [ROOT]: { auth: { mode: 'site-token' }, base_url: 'https://acme.atlassian.net' } } }) });
  assert.equal((userSite.t as TenantResolution).jira.userTenant, true); assert.match(userSite.source, /^generic/); // valid mode: no throw
  assert.deepEqual(userSite.hits, ['https://acme.atlassian.net/rest/api/3/myself']);
  const userCloud = await attempt({}, { ...GEN, ...cfgEnv({ projects: { [ROOT]: { cloud_id: 'acme-cloud-0001' } } }) });
  assert.match(userCloud.source, /^generic/); assert.deepEqual(userCloud.hits, ['https://api.atlassian.com/ex/jira/acme-cloud-0001/rest/api/3/myself']);
  const committedCloud = await attempt({ cloud_id: 'acme-cloud-0002' }, { ...GEN, ...cfgEnv() });
  assert.match(committedCloud.source, /^generic/); // scoped: the gateway host is fixed
  const pinned = await attempt({ auth: { mode: 'site-token' }, base_url: 'https://acme.atlassian.net' }, { ...GEN, BRAIN_JIRA_SITES: 'acme.atlassian.net', ...cfgEnv() });
  assert.equal((pinned.t as TenantResolution).pinned, true); assert.match(pinned.source, /^generic/); assert.equal(pinned.hits.length, 1); // valid mode: no throw
  const bound = await attempt({}, { ...GEN, ACME_TOK: 'acme-token-333', ...cfgEnv({ sites: { 'acme.atlassian.net': { token_env: 'ACME_TOK' } }, projects: { [ROOT]: { auth: { mode: 'site-token' }, base_url: 'https://acme.atlassian.net' } } }) });
  assert.match(bound.source, /^registry acme\.atlassian\.net/);
});
