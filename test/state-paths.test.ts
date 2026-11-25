import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { configDir, registryFile } from '../src/jira-tenant.ts';
import { defaultDataDir } from '../lib/driver.ts';

// The plugin was renamed to plangraph, but two per-user state locations keep their old names so that existing Jira bindings and the
// solver environment keep working after the rename. A rename that touches them silently loses user data: these tests pin the names.
test('the user-level config directory is ~/.config/plangraph', () => {
  assert.equal(configDir({ HOME: '/h' }), path.join('/h', '.config', 'plangraph'));
  assert.equal(configDir({ HOME: '/h', XDG_CONFIG_HOME: '/x' }), path.join('/x', 'plangraph'));
  assert.equal(registryFile({ HOME: '/h' }), path.join('/h', '.config', 'plangraph', 'jira-sites.json'));
  assert.equal(configDir({ PLANGRAPH_CONFIG_DIR: '/c' }), path.resolve('/c'));
});

test('the data and cache directory is ~/.cache/plangraph', () => {
  assert.equal(defaultDataDir({}, '/h'), path.join('/h', '.cache', 'plangraph'));
  assert.equal(defaultDataDir({ CLAUDE_PLUGIN_DATA: '/d' }, '/h'), '/d');
});
