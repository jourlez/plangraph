import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { configDir, registryFile } from '../src/jira-tenant.mjs';
import { defaultDataDir } from '../lib/driver.mjs';

// The plugin was renamed to open-brain, but two per-user state locations keep their old names so that existing Jira bindings and the
// solver environment keep working after the rename. A rename that touches them silently loses user data: these tests pin the names.
test('the user-level config directory keeps its pre-rename name', () => {
  assert.equal(configDir({ HOME: '/h' }), path.join('/h', '.config', 'project-brain'));
  assert.equal(configDir({ HOME: '/h', XDG_CONFIG_HOME: '/x' }), path.join('/x', 'project-brain'));
  assert.equal(registryFile({ HOME: '/h' }), path.join('/h', '.config', 'project-brain', 'jira-sites.json'));
  assert.equal(configDir({ BRAIN_CONFIG_DIR: '/c' }), path.resolve('/c'));
});

test('the data and cache directory keeps its pre-rename name', () => {
  assert.equal(defaultDataDir({}, '/h'), path.join('/h', '.cache', 'project-brain'));
  assert.equal(defaultDataDir({ CLAUDE_PLUGIN_DATA: '/d' }, '/h'), '/d');
});
