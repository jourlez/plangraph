import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getCredentialsFor, parseSiteRegistry, siteTag } from '../lib/jira.ts';
import type { JiraError } from '../lib/jira.ts';

const noExec = async () => { throw new Error('no helper'); };
const A = 'acme.atlassian.net', B = 'beta-co.atlassian.net';
const env = { JIRA_EMAIL: 'me@a.co', JIRA_API_TOKEN: 'generic-token-1', JIRA_EMAIL__BETA_CO: 'me@b.co', JIRA_API_TOKEN__BETA_CO: 'beta-token-22', WORK_TOK: 'acme-token-333' };

test('siteTag turns a host into an env suffix', () => {
  assert.equal(siteTag('beta-co.atlassian.net'), 'BETA_CO');
  assert.equal(siteTag('jira.corp.example:8443'), 'JIRA_CORP_EXAMPLE_8443');
});

test('two tenants get their own credentials; generic is never used for an unpinned site', async () => {
  const b = await getCredentialsFor(B, { env, exec: noExec });
  assert.equal(b.email, 'me@b.co'); assert.equal(b.token, 'beta-token-22'); assert.match(b.source, /^host beta-co\.atlassian\.net/);
  await assert.rejects(getCredentialsFor(A, { env, exec: noExec }), (e: JiraError) => e.code === 'no_credentials' && /never sent to an unpinned site/.test(e.message));
  const pinned = await getCredentialsFor(A, { env, exec: noExec, allowGeneric: true });
  assert.equal(pinned.token, 'generic-token-1'); assert.match(pinned.source, /^generic/);
});

test('a registry entry binds a host to named env vars and never falls back to generic', async () => {
  const { reg, problems } = parseSiteRegistry(JSON.stringify({ sites: { [A]: { email_env: 'JIRA_EMAIL', token_env: 'WORK_TOK' }, 'bad host!': { token_env: 'X' }, [B]: { token_env: 'NOPE' } } }));
  assert.equal(problems.length, 1);
  const a = await getCredentialsFor(A, { env, exec: noExec, registry: reg, allowGeneric: true });
  assert.equal(a.token, 'acme-token-333'); assert.match(a.source, /^registry acme\.atlassian\.net/);
  await assert.rejects(getCredentialsFor(B, { env, exec: noExec, registry: reg, allowGeneric: true }), (e: JiraError) => e.code === 'no_credentials' && /registry entry for beta-co/.test(e.message));
});

test('registry rejects malformed names and keeps secrets out of the entry shape', () => {
  const { reg, problems } = parseSiteRegistry(JSON.stringify({ sites: { [A]: { token_env: 'bad name', op_ref: 'not-a-ref', keychain: 'ok.service:1' } } }));
  assert.deepEqual(Object.keys(reg[A]), ['keychain']);
  assert.equal(problems.length, 2);
  assert.equal(parseSiteRegistry('{nope').reg[A], undefined);
});
