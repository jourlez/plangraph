import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { effectiveJira } from '../src/jira-tenant.mjs';
import { parseSiteRegistry } from '../lib/jira.mjs';

function envWith(obj) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-cfg-'));
  fs.writeFileSync(path.join(dir, 'jira-sites.json'), JSON.stringify(obj));
  return { BRAIN_CONFIG_DIR: dir };
}

test('a user-level project entry supplies the tenant; the committed config can stay empty', () => {
  const env = envWith({ projects: { '/work/repo/': { auth: { mode: 'site-token' }, base_url: 'https://acme.atlassian.net', jql: 'project = A' } } });
  const j = effectiveJira({ base_url: '', jql: '' }, '/work/repo', env);
  assert.equal(j.base_url, 'https://acme.atlassian.net'); assert.equal(j.jql, 'project = A'); assert.equal(j.auth.mode, 'site-token'); assert.equal(j.userTenant, true);
});

test('with no user-level entry the committed config is used and its host is not trusted', () => {
  const j = effectiveJira({ base_url: 'https://evil.atlassian.net', jql: 'project = X' }, '/work/other', envWith({ sites: {} }));
  assert.equal(j.base_url, 'https://evil.atlassian.net'); assert.equal(j.userTenant, false);
});

test('project entries keep only known fields and absolute paths', () => {
  const { projects, problems } = parseSiteRegistry(JSON.stringify({ projects: { rel: { jql: 'x' }, '/ok': { jql: 'project = Z', evil: 'drop', auth: { mode: 'nope' } } } }));
  assert.deepEqual(Object.keys(projects), ['/ok']); assert.deepEqual(projects['/ok'], { jql: 'project = Z' }); assert.equal(problems.length, 1);
});

import { resolveTenant } from '../src/jira-tenant.mjs';

test('resolveTenant is the single trust rule: committed site hosts are untrusted, user-chosen and pinned ones are trusted', () => {
  const none = envWith({ sites: {} });
  const committed = { auth: { mode: 'site-token' }, base_url: 'https://evil.atlassian.net' };
  assert.equal(resolveTenant(committed, '/r', none).allowGeneric, false);
  assert.equal(resolveTenant(committed, '/r', { ...none, BRAIN_JIRA_SITES: 'evil.atlassian.net' }).allowGeneric, true);
  const mine = envWith({ projects: { '/r': { auth: { mode: 'site-token' }, base_url: 'https://mine.atlassian.net' } } });
  assert.equal(resolveTenant({}, '/r', mine).allowGeneric, true);
  assert.equal(resolveTenant({ cloud_id: 'abc' }, '/r', none).allowGeneric, true); // scoped: fixed gateway host
});
