import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { configDir } from '../src/jira-tenant.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8');
const json = (f: string) => JSON.parse(read(f));
// The previous plugin name, assembled so that this file does not itself contain it.
const OLD = ['open', 'brain'].join('-');

test('plugin, marketplace and package carry the name plangraph', () => {
  assert.equal(json('.claude-plugin/plugin.json').name, 'plangraph');
  assert.equal(json('package.json').name, 'plangraph');
  const m = json('.claude-plugin/marketplace.json');
  assert.equal(m.name, 'plangraph-marketplace');
  assert.deepEqual(m.plugins.map((p: { name: string }) => p.name), ['plangraph']);
});

test('the previous name survives only in the CHANGELOG history (and the migration plan that quotes it)', () => {
  const out = execFileSync('git', ['grep', '-l', '-i', OLD], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  const allowed = new Set(['CHANGELOG.md', 'docs/superpowers/plans/2026-11-23-typescript-migration.md']);
  assert.deepEqual(out.filter((f) => !allowed.has(f)), []);
});

test('the README install line uses the new names', () => {
  assert.ok(read('README.md').includes('plangraph@plangraph-marketplace'));
});

test('per-user state names are the plangraph names', () => {
  assert.ok(configDir({ HOME: '/h' }).endsWith(path.join('.config', 'plangraph')));
  assert.match(read('lib/jira.ts'), /service: 'plangraph-jira'/);
  assert.match(read('lib/jira.ts'), /`plangraph-jira:\$\{h\}`/);
  assert.match(read('lib/store.ts'), /^const DRIVER = 'brain-jsonl';$/m);
});
