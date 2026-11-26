// Behavior tests for the registry file handling of src/jira-tenant.ts (loadRegistry, approveAlias, resolutionOf, effectiveJira), written to kill
// the mutants of the trust-root run: the 64 KiB edge, symlink and non-file refusals with their exact reasons, the exact rewrite of the file on
// approval (2-space JSON, mode 0600, other content kept, once only), and refusals that name the file. Real files in a scratch directory.
// NOT covered: tenant resolution (test/jira-tenants.test.ts, test/jira-tenant-isolation.test.ts, test/jira-alias.test.ts).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRegistry, approveAlias, resolutionOf, effectiveJira, registryFile, configDir, resolveTenant, tenantCredentials, clientBase } from '../src/jira-tenant.ts';
import type { TenantResolution } from '../src/jira-tenant.ts';
import type { JiraError } from '../lib/jira.ts';

const posix = process.platform !== 'win32';
const made: string[] = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const scratch = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tenk-'))); made.push(d); return d; };
const world = (text?: string) => { const d = scratch(), env = { PLANGRAPH_CONFIG_DIR: d }; if (text !== undefined) fs.writeFileSync(path.join(d, 'jira-sites.json'), text); return { d, env, file: path.join(d, 'jira-sites.json') }; };
const bad = (code: string, msg: string | RegExp) => (e: JiraError) => e.code === code && (typeof msg === 'string' ? e.message === msg : msg.test(e.message));
const H64 = 'b'.repeat(64);

test('resolutionOf refuses anything that was not minted by resolveTenant', () => {
  for (const x of [{}, null, undefined, 5, 'x', { tenant: 't' }]) assert.throws(() => resolutionOf(x as never), bad('bad_config', 'the tracker needs a tenant decision minted by resolveTenant'));
});

test('configDir and registryFile follow PLANGRAPH_CONFIG_DIR, then XDG_CONFIG_HOME, then HOME', () => {
  assert.equal(configDir({ PLANGRAPH_CONFIG_DIR: '/a/b' }), '/a/b');
  assert.equal(configDir({ XDG_CONFIG_HOME: '/x' }), '/x/plangraph');
  assert.equal(configDir({ HOME: '/h' }), '/h/.config/plangraph');
  assert.equal(registryFile({ PLANGRAPH_CONFIG_DIR: '/a/b' }), '/a/b/jira-sites.json');
});

test('loadRegistry: a missing file, a non-file, the size edge, and a parsed file', { skip: !posix }, () => {
  const none = world(); const r0 = loadRegistry(none.env);
  assert.equal(r0.exists, false); assert.equal(r0.file, none.file); assert.deepEqual(r0.problems, []);
  for (const m of [r0.reg, r0.projects, r0.aliases]) assert.equal(Object.getPrototypeOf(m), null);
  // a directory and a symlink are refused, and the file counts as present
  const dirW = world(); fs.mkdirSync(dirW.file);
  const r1 = loadRegistry(dirW.env);
  assert.equal(r1.exists, true); assert.deepEqual(r1.problems, ['jira-sites.json is not a regular file (a symlink is refused)']); assert.deepEqual({ ...r1.reg }, {});
  const linkW = world(); fs.writeFileSync(path.join(linkW.d, 'real.json'), '{"sites":{}}'); fs.symlinkSync(path.join(linkW.d, 'real.json'), linkW.file);
  const r2 = loadRegistry(linkW.env);
  assert.equal(r2.exists, true); assert.deepEqual(r2.problems, ['jira-sites.json is not a regular file (a symlink is refused)']);
  for (const m of [r1.reg, r1.projects, r1.aliases, r2.reg]) assert.equal(Object.getPrototypeOf(m), null);
  // exactly 64 KiB is read, one byte more is refused
  const pad = (n: number) => { const base = JSON.stringify({ sites: { 'a.example': { token_env: 'X' } }, pad: '' }); return JSON.stringify({ sites: { 'a.example': { token_env: 'X' } }, pad: 'p'.repeat(n - base.length) }); };
  const okW = world(pad(65536)); assert.equal(fs.statSync(okW.file).size, 65536);
  const r3 = loadRegistry(okW.env); assert.deepEqual(r3.problems, []); assert.deepEqual({ ...r3.reg }, { 'a.example': { token_env: 'X' } });
  const bigW = world(pad(65537));
  const r4 = loadRegistry(bigW.env);
  assert.equal(r4.exists, true); assert.deepEqual(r4.problems, ['jira-sites.json is larger than 64 KiB']); assert.deepEqual({ ...r4.reg }, {}); assert.equal(Object.getPrototypeOf(r4.reg), null);
  // a normal file: present, parsed, with the file name
  const w = world('{"sites":{"b.example":{"keychain":"svc"}},"projects":{"/r/":{"jql":"x"}},"aliases":{"work":{"cloud_id":"c"}}}');
  const r5 = loadRegistry(w.env);
  assert.deepEqual([r5.exists, r5.file, r5.problems], [true, w.file, []]);
  assert.deepEqual({ ...r5.reg }, { 'b.example': { keychain: 'svc' } }); assert.deepEqual({ ...r5.projects }, { '/r': { jql: 'x' } }); assert.deepEqual({ ...r5.aliases }, { work: { cloud_id: 'c' } });
  assert.deepEqual(loadRegistry(world('{nope').env).problems, ['jira-sites.json is not valid JSON']);
});

test('effectiveJira: a project entry is found by its root without trailing slashes, and a layer that names a tenant decides it', () => {
  const w = world('{"projects":{"/work/repo":{"cloud_id":"cid-user-123","jql":"project = U"}}}');
  const reg = loadRegistry(w.env);
  const committed = { base_url: 'https://evil.atlassian.net', auth: { mode: 'site-token' as const }, jql: 'project = C', sprint_field: 'customfield_1' };
  for (const root of ['/work/repo', '/work/repo/', '/work/repo//']) {
    assert.deepEqual(effectiveJira(committed, root, w.env, {}, reg), { cloud_id: 'cid-user-123', jql: 'project = U', sprint_field: 'customfield_1', userTenant: true }, root);
  }
  assert.deepEqual(effectiveJira(committed, '/other', w.env, {}, reg), { ...committed, userTenant: false });
  assert.deepEqual(effectiveJira(committed, '', w.env, {}, reg), { ...committed, userTenant: false });
  assert.deepEqual(effectiveJira(committed, '/work/repomutant', w.env, {}, reg), { ...committed, userTenant: false });
});

const aliasFile = (extra: Record<string, unknown> = {}) => JSON.stringify({ sites: { 'a.example': { token_env: 'X' } }, aliases: { work: { cloud_id: 'c1', repos: [H64, 5] }, other: { cloud_id: 'c2' } }, ...extra });

test('approveAlias writes the key once, keeps everything else, mode 0600, 2-space JSON with a final newline', { skip: !posix }, () => {
  const w = world(aliasFile());
  approveAlias(w.env, 'work', 'a'.repeat(64));
  const j = JSON.parse(fs.readFileSync(w.file, 'utf8'));
  assert.deepEqual(j.aliases.work.repos, [H64, 'a'.repeat(64)]); assert.deepEqual(j.aliases.other, { cloud_id: 'c2' }); assert.deepEqual(j.sites, { 'a.example': { token_env: 'X' } });
  assert.equal(fs.readFileSync(w.file, 'utf8'), `${JSON.stringify(j, null, 2)}\n`);
  assert.match(fs.readFileSync(w.file, 'utf8'), /^\{\n {2}"sites": \{\n {4}"a\.example"/);
  assert.equal((fs.statSync(w.file).mode & 0o777).toString(8), '600');
  approveAlias(w.env, 'work', 'a'.repeat(64));
  assert.deepEqual(JSON.parse(fs.readFileSync(w.file, 'utf8')).aliases.work.repos, [H64, 'a'.repeat(64)], 'approving twice adds it once');
  approveAlias(w.env, 'other', H64);
  assert.deepEqual(JSON.parse(fs.readFileSync(w.file, 'utf8')).aliases.other.repos, [H64]);
});

test('approveAlias refuses an unusable file or alias with the reason, and writes nothing', { skip: !posix }, () => {
  const unusable = (file: string) => new RegExp(`^${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} (is missing or refused: .+|is not valid JSON)$`); // the registry reader names the reason (hardened in 0.3.0)
  const none = world(); assert.throws(() => approveAlias(none.env, 'work', H64), bad('bad_config', unusable(none.file)));
  const dirW = world(); fs.mkdirSync(dirW.file); assert.throws(() => approveAlias(dirW.env, 'work', H64), bad('bad_config', unusable(dirW.file)));
  const linkW = world(); fs.writeFileSync(path.join(linkW.d, 'real.json'), aliasFile()); fs.symlinkSync(path.join(linkW.d, 'real.json'), linkW.file);
  assert.throws(() => approveAlias(linkW.env, 'work', H64), bad('bad_config', unusable(linkW.file)));
  assert.equal(JSON.parse(fs.readFileSync(path.join(linkW.d, 'real.json'), 'utf8')).aliases.work.repos.length, 2, 'the symlink target was not written');
  const junk = world('{nope'); assert.throws(() => approveAlias(junk.env, 'work', H64), bad('bad_config', unusable(junk.file)));
  const pad = (n: number) => { const base = aliasFile({ pad: '' }); return aliasFile({ pad: 'p'.repeat(n - base.length) }); };
  const edge = world(pad(65536)); assert.equal(fs.statSync(edge.file).size, 65536);
  approveAlias(edge.env, 'work', 'c'.repeat(64)); assert.ok(JSON.parse(fs.readFileSync(edge.file, 'utf8')).aliases.work.repos.includes('c'.repeat(64)));
  const big = world(pad(65537)); assert.throws(() => approveAlias(big.env, 'work', H64), bad('bad_config', unusable(big.file)));
  // an alias that is not in the file, or a file whose shape cannot hold one
  const notDefined = (text: string, name: string) => { const w = world(text); assert.throws(() => approveAlias(w.env, name, H64), bad('bad_config', `alias ${name} is not defined in ${w.file}`), `${name} in ${text.slice(0, 40)}`); assert.equal(fs.readFileSync(w.file, 'utf8'), text, 'nothing written'); };
  notDefined(aliasFile(), 'missing'); notDefined(aliasFile(), 'Work'); notDefined(aliasFile(), 'constructor'); notDefined(aliasFile(), '__proto__'); notDefined(aliasFile(), '');
  notDefined('null', 'work'); notDefined('5', 'work'); notDefined('{}', 'work'); notDefined('{"aliases":null}', 'work'); notDefined('{"aliases":"work"}', 'work'); notDefined('{"aliases":5}', 'work');
  notDefined('{"aliases":{"work":null}}', 'work'); notDefined('{"aliases":{"work":"x"}}', 'work'); notDefined('{"aliases":{"work":5}}', 'work'); notDefined('{"aliases":{"constructor":{"cloud_id":"c"}}}', 'constructor');
  notDefined('[]', 'work'); notDefined('{"aliases":[]}', 'work');
});

test('resolveTenant: a bad mode is refused with its reason; the trust is frozen and carries exact booleans', { skip: !posix }, () => {
  const w = world();
  assert.throws(() => resolveTenant({ auth: { mode: 'bogus' } } as never, '/r', w.env), bad('bad_config', 'auth.mode must be scoped, site-token or datacenter'));
  for (const mode of ['Scoped', ' scoped', '']) assert.throws(() => resolveTenant({ auth: { mode } } as never, '/r', w.env), bad('bad_config', 'auth.mode must be scoped, site-token or datacenter'), mode);
  const r = resolveTenant({ cloud_id: 'CID-Committed-1' }, '/r', w.env);
  assert.ok(Object.isFrozen(r.trust)); assert.deepEqual({ ...r.trust }, { tenant: 'cid-committed-1', allowGeneric: true, pinned: false, userTenant: false });
  assert.strictEqual(r.trust.userTenant, false); assert.strictEqual(r.trust.pinned, false); assert.equal(resolutionOf(r.trust), r);
  const user = world('{"projects":{"/r":{"cloud_id":"cid-user-0001"}}}');
  const u = resolveTenant({ cloud_id: 'cid-committed-1' }, '/r', user.env);
  assert.deepEqual({ ...u.trust }, { tenant: 'cid-user-0001', allowGeneric: true, pinned: false, userTenant: true });
  assert.strictEqual(u.jira.userTenant, true);
});

test('resolveTenant: pinning is by the exact tenant host in PLANGRAPH_JIRA_SITES, never by a placeholder', { skip: !posix }, () => {
  const w = world();
  const scoped = (cloud: string, sites?: string) => resolveTenant({ cloud_id: cloud }, '/r', { ...w.env, ...(sites === undefined ? {} : { PLANGRAPH_JIRA_SITES: sites }) });
  assert.strictEqual(scoped('mutant').pinned, false); assert.strictEqual(scoped('mutant', '').pinned, false);
  assert.strictEqual(scoped('mutant', 'mutant').pinned, true); assert.strictEqual(scoped('mutant', 'other, MUTANT ,x').pinned, true);
  assert.strictEqual(scoped('mutant', 'other').pinned, false);
  const site = (url: string, sites: string) => resolveTenant({ auth: { mode: 'site-token' }, base_url: url }, '/r', { ...w.env, PLANGRAPH_JIRA_SITES: sites });
  assert.strictEqual(site('https://acme.atlassian.net', 'acme.atlassian.net').pinned, true);
  assert.strictEqual(site('https://acme.atlassian.net:8443', 'acme.atlassian.net').pinned, true, 'the port is not part of the pin');
  assert.strictEqual(site('https://acme.atlassian.net', 'other.atlassian.net').allowGeneric, false);
  assert.strictEqual(site('https://acme.atlassian.net', 'acme.atlassian.net').allowGeneric, true);
  const empty = resolveTenant({ auth: { mode: 'site-token' } }, '/r', { ...w.env, PLANGRAPH_JIRA_SITES: ',' });
  assert.deepEqual([empty.tenant, empty.pinned, empty.allowGeneric], ['', false, false]);
});

const hand = (over: Partial<TenantResolution> & { jira?: Record<string, unknown> }) => ({ aliasProblem: null, tenant: '', mode: 'scoped', jira: {}, entry: null, allowGeneric: false, ...over }) as unknown as TenantResolution;

test('tenantCredentials: an empty tenant is refused before any helper, with the reason for its mode', async () => {
  const calls: string[] = [];
  const exec = async (f: string) => { calls.push(f); throw new Error('no'); };
  const t = (r: TenantResolution, env: Record<string, string> = {}) => tenantCredentials(r, env, { exec, platform: 'darwin' });
  await assert.rejects(() => t(hand({ aliasProblem: 'alias x is not approved' })), bad('bad_config', 'alias x is not approved'));
  await assert.rejects(() => t(hand({})), bad('bad_config', 'scoped mode needs a cloud_id (see docs/JIRA.md)'));
  await assert.rejects(() => t(hand({ jira: { base_url: 'https://a.atlassian.net' } })), bad('bad_config', 'scoped mode (the default auth.mode) needs cloud_id; for a site URL alone add "auth": {"mode": "site-token"} (see docs/JIRA.md)'));
  await assert.rejects(() => t(hand({}), { JIRA_BASE_URL: 'https://a.atlassian.net' }), bad('bad_config', 'scoped mode (the default auth.mode) needs cloud_id; for a site URL alone add "auth": {"mode": "site-token"} (see docs/JIRA.md)'));
  await assert.rejects(() => t(hand({ mode: 'site-token' })), bad('bad_host', 'base URL rejected: empty (see docs/JIRA.md)'));
  await assert.rejects(() => t(hand({ mode: 'site-token', jira: { base_url: 'https://evil.example' } })), bad('bad_host', 'base URL rejected: host is not on the Atlassian allowlist (see docs/JIRA.md)'));
  await assert.rejects(() => t(hand({ mode: 'site-token', jira: { base_url: 'https://evil.example' } }), { JIRA_BASE_URL: '' }), bad('bad_host', 'base URL rejected: host is not on the Atlassian allowlist (see docs/JIRA.md)'));
  await assert.rejects(() => t(hand({ mode: 'site-token' }), { JIRA_BASE_URL: 'https://evil.example' }), bad('bad_host', 'base URL rejected: host is not on the Atlassian allowlist (see docs/JIRA.md)'));
  await assert.rejects(() => t(hand({ mode: 'site-token', jira: { base_url: 'https://acme.atlassian.net' } })), bad('bad_host', 'base URL rejected: no host (see docs/JIRA.md)'));
  await assert.rejects(() => t(hand({ mode: 'datacenter', jira: { base_url: 'https://jira.corp:8443' } }), { PLANGRAPH_JIRA_DC_HOSTS: 'other.corp' }), bad('bad_host', 'base URL rejected: host is not in the user-level Data Center allowlist (PLANGRAPH_JIRA_DC_HOSTS) (see docs/JIRA.md)'));
  await assert.rejects(() => t(hand({ mode: 'site-token', jira: { base_url: 'https://acme.atlassian.net' } }), { PLANGRAPH_JIRA_SITES: 'other.atlassian.net' }), bad('bad_host', 'base URL rejected: site is not in the user-level site allowlist (PLANGRAPH_JIRA_SITES) (see docs/JIRA.md)'));
  assert.deepEqual(calls, [], 'no credential helper ran');
});

test('tenantCredentials: the registry entry is bound to the tenant, generic credentials only when allowed; clientBase prefers the environment URL', async () => {
  const exec = async () => { throw new Error('no'); };
  const entry = { token_env: 'MY_T' };
  const c = await tenantCredentials(hand({ tenant: 'acme.atlassian.net', mode: 'site-token', entry }), { MY_T: 'tok-for-the-tenant-123', JIRA_EMAIL: 'a@b.co' }, { exec, platform: 'win32' });
  assert.equal(c.source, 'registry acme.atlassian.net:env');
  await assert.rejects(() => tenantCredentials(hand({ tenant: 'acme.atlassian.net', mode: 'site-token', entry: null }), { JIRA_EMAIL: 'a@b.co', JIRA_API_TOKEN: 'generic-token-12345' }, { exec, platform: 'win32' }), bad('no_credentials', /^no credentials bound to acme\.atlassian\.net/));
  const g = await tenantCredentials(hand({ tenant: 'acme.atlassian.net', mode: 'site-token', allowGeneric: true }), { JIRA_EMAIL: 'a@b.co', JIRA_API_TOKEN: 'generic-token-12345' }, { exec, platform: 'win32' });
  assert.equal(g.source, 'generic:env');
  const t = hand({ jira: { auth: { mode: 'site-token' }, cloud_id: 'c', base_url: 'https://file.example' } });
  assert.deepEqual(clientBase(t), { auth: { mode: 'site-token' }, cloudId: 'c', baseUrl: 'https://file.example' });
  assert.equal(clientBase(t, { JIRA_BASE_URL: 'https://env.example' }).baseUrl, 'https://env.example');
  assert.equal(clientBase(hand({ jira: { base_url: '' } })).baseUrl, undefined);
  assert.equal(clientBase(hand({ jira: {} }), { JIRA_BASE_URL: '' }).baseUrl, undefined);
});

test('resolveTenant finds the projects entry of a root written with trailing slashes', { skip: !posix }, () => {
  const w = world('{"projects":{"/work/repo":{"cloud_id":"cid-user-0001"}}}');
  for (const root of ['/work/repo', '/work/repo/', '/work/repo///']) {
    const r = resolveTenant({ cloud_id: 'cid-committed-1' }, root, w.env);
    assert.equal(r.tenant, 'cid-user-0001', root); assert.strictEqual(r.trust.userTenant, true);
  }
  assert.equal(resolveTenant({ cloud_id: 'cid-committed-1' }, '/work/repomutant', w.env).tenant, 'cid-committed-1');
  assert.equal(resolveTenant({ cloud_id: 'cid-committed-1' }, '/work', w.env).tenant, 'cid-committed-1');
});

test('resolveTenant: a projects entry that names a tenant (found by its root without trailing slashes) outranks an alias that does not resolve', { skip: !posix }, () => {
  const w = world('{"projects":{"/work/repo":{"cloud_id":"cid-user-0001"}}}');
  for (const root of ['/work/repo', '/work/repo/']) {
    const r = resolveTenant({ tenant: 'work', cloud_id: 'cid-committed-1' }, root, w.env);
    assert.equal(r.tenant, 'cid-user-0001', root); assert.equal(r.aliasProblem, null); assert.equal(r.aliasMissing, false); assert.equal(r.alias, null);
  }
  const other = resolveTenant({ tenant: 'work', cloud_id: 'cid-committed-1' }, '/elsewhere', w.env);
  assert.equal(other.aliasMissing, true); assert.match(other.aliasProblem ?? '', /^jira\.tenant names alias work, which is not defined in /);
});
