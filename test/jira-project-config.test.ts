import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { effectiveJira } from '../src/jira-tenant.ts';
import type { JiraSettings } from '../src/jira-tenant.ts';
import { parseSiteRegistry } from '../lib/jira.ts';

function envWith(obj: unknown): Record<string, string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-cfg-'));
  fs.writeFileSync(path.join(dir, 'jira-sites.json'), JSON.stringify(obj));
  return { PLANGRAPH_CONFIG_DIR: dir };
}

test('a user-level project entry supplies the tenant; the committed config can stay empty', () => {
  const env = envWith({ projects: { '/work/repo/': { auth: { mode: 'site-token' }, base_url: 'https://acme.atlassian.net', jql: 'project = A' } } });
  const j = effectiveJira({ base_url: '', jql: '' }, '/work/repo', env);
  assert.equal(j.base_url, 'https://acme.atlassian.net'); assert.equal(j.jql, 'project = A'); assert.equal((j.auth as { mode: string }).mode, 'site-token'); /* the entry sets auth */ assert.equal(j.userTenant, true);
});

test('with no user-level entry the committed config is used and its host is not trusted', () => {
  const j = effectiveJira({ base_url: 'https://evil.atlassian.net', jql: 'project = X' }, '/work/other', envWith({ sites: {} }));
  assert.equal(j.base_url, 'https://evil.atlassian.net'); assert.equal(j.userTenant, false);
});

test('project entries keep only known fields and absolute paths', () => {
  const { projects, problems } = parseSiteRegistry(JSON.stringify({ projects: { rel: { jql: 'x' }, '/ok': { jql: 'project = Z', evil: 'drop', auth: { mode: 'nope' } } } }));
  assert.deepEqual(Object.keys(projects), ['/ok']); assert.deepEqual(projects['/ok'], { jql: 'project = Z' }); assert.equal(problems.length, 1);
});

import { resolveTenant } from '../src/jira-tenant.ts';

test('resolveTenant is the single trust rule: committed site hosts are untrusted, user-chosen and pinned ones are trusted', () => {
  const none = envWith({ sites: {} });
  const committed: JiraSettings = { auth: { mode: 'site-token' }, base_url: 'https://evil.atlassian.net' };
  assert.equal(resolveTenant(committed, '/r', none).allowGeneric, false);
  assert.equal(resolveTenant(committed, '/r', { ...none, PLANGRAPH_JIRA_SITES: 'evil.atlassian.net' }).allowGeneric, true);
  const mine = envWith({ projects: { '/r': { auth: { mode: 'site-token' }, base_url: 'https://mine.atlassian.net' } } });
  assert.equal(resolveTenant({}, '/r', mine).allowGeneric, true);
  assert.equal(resolveTenant({ cloud_id: 'abc' }, '/r', none).allowGeneric, true); // scoped: fixed gateway host
});

test('a user entry with any tenant field replaces every committed tenant field; non-tenant committed fields still merge', () => {
  const committed: JiraSettings = { auth: { mode: 'site-token' }, base_url: 'https://evil.atlassian.net', cloud_id: 'attacker-cloud-0001', jql: 'project = C', sprint_field: 'customfield_9', full_reconcile_every: 5 };
  const byCloud = effectiveJira(committed, '/work/repo', envWith({ projects: { '/work/repo': { cloud_id: 'acme-cloud-0001' } } }));
  assert.deepEqual([byCloud.auth, byCloud.base_url, byCloud.cloud_id, byCloud.userTenant], [undefined, undefined, 'acme-cloud-0001', true]);
  assert.deepEqual([byCloud.jql, byCloud.sprint_field, byCloud.full_reconcile_every], ['project = C', 'customfield_9', 5]);
  const byAuth = effectiveJira(committed, '/work/repo', envWith({ projects: { '/work/repo': { auth: { mode: 'datacenter' }, jql: 'project = U' } } }));
  assert.deepEqual([byAuth.auth, byAuth.base_url, byAuth.cloud_id, byAuth.jql, byAuth.userTenant], [{ mode: 'datacenter' }, undefined, undefined, 'project = U', false]);
  const byBase = effectiveJira(committed, '/work/repo', envWith({ projects: { '/work/repo': { base_url: 'https://acme.atlassian.net' } } }));
  assert.deepEqual([byBase.auth, byBase.cloud_id, byBase.userTenant], [undefined, undefined, false]); // scoped by default: the user gave no cloud id
  const noTenant = effectiveJira(committed, '/work/repo', envWith({ projects: { '/work/repo': { jql: 'project = U' } } }));
  assert.deepEqual([noTenant.auth, noTenant.base_url, noTenant.jql, noTenant.userTenant], [{ mode: 'site-token' }, 'https://evil.atlassian.net', 'project = U', false]);
});
