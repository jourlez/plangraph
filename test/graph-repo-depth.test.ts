// lib/graph/repo.ts depth fields: stack commands, workspace packages, env names, teams (task 15). Pure parsers: no I/O beyond fixture reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mergeRow, scanRepo } from '../lib/graph/repo.ts';
import { validators } from '../lib/schema.ts';

const FX = path.join(import.meta.dirname, 'fixtures/repo-scan/depth');
const fx = (n: string) => fs.readFileSync(path.join(FX, n), 'utf8');
const f = (p: string, text: string) => ({ path: p, sha: p, text });
const people = new Set(['alice']);
const scan = (files: Array<[string, string]>, paths: string[] = []) => scanRepo({ slug: 'web', files: files.map(([p, t]) => f(p, t)), paths, people }).row;

test('test, lint, build and run are copied from allowlisted scripts; postinstall and prepare never', () => {
  const row = scan([['package.json', fx('package.json.txt')]]);
  assert.deepEqual([row.test, row.lint, row.build, row.run], ['node --test', 'eslint .', 'tsc -b', 'node dist/main.js']);
  const text = JSON.stringify(row);
  for (const bad of ['postinstall', 'setup.js', 'husky']) assert.ok(!text.includes(bad), bad);
  assert.equal(validators['repos.jsonl']?.(row), null);
});

test('a script with a newline, a shell metacharacter or a substitution is not copied', () => {
  const row = scan([['package.json', fx('hostile-scripts.json.txt')]]);
  for (const k of ['test', 'lint', 'build', 'run']) assert.equal(row[k], undefined, k);
  assert.ok(!JSON.stringify(row).includes('ignore previous'));
});

test('pkgs: pnpm-workspace.yaml, package.json workspaces, Cargo members and go.work', () => {
  const paths = ['apps/a/package.json', 'apps/b/package.json', 'apps/skip/package.json', 'apps/c/readme.md', 'libs/core/index.ts', 'crates/x/Cargo.toml', 'tools/cli/main.rs', 'svc/a/go.mod', 'svc/b/main.go', 'tools/t.go'];
  assert.deepEqual(scan([['pnpm-workspace.yaml', fx('pnpm-workspace.yaml.txt')]], paths).pkgs, ['apps/a', 'apps/b', 'libs/core']);
  assert.deepEqual(scan([['package.json', '{"workspaces":["apps/*"]}']], paths).pkgs, ['apps/a', 'apps/b', 'apps/skip']);
  assert.deepEqual(scan([['Cargo.toml', fx('Cargo.toml.txt')]], paths).pkgs, ['crates/x', 'tools/cli']);
  assert.deepEqual(scan([['go.work', fx('go.work.txt')]], paths).pkgs, ['svc/a', 'svc/b', 'tools']);
  assert.equal(scan([['pnpm-workspace.yaml', '- "../etc"\n']], paths).pkgs, undefined);
});

test('env: names only from .env.example and Dockerfile ENV; no value appears anywhere', () => {
  const row = scan([['.env.example', fx('env.example.txt')], ['Dockerfile', fx('Dockerfile.txt')]]);
  assert.deepEqual(row.env, ['API_KEY', 'DB_URL', 'EMPTY', 'LEGACY_FLAG', 'NODE_ENV', 'PORT']);
  const text = JSON.stringify(row);
  for (const v of ['secret123', 'postgres', 'production', '8080', 'somevalue123', 'lower']) assert.ok(!text.includes(v), v);
});

test('teams: group handles map to team ids, handle only, no org', () => {
  const row = scan([['CODEOWNERS', fx('CODEOWNERS.txt')]]);
  assert.deepEqual(row.teams, ['docs-team', 'platform']);
  assert.ok(!JSON.stringify(row).includes('org'));
  assert.equal(scan([['CODEOWNERS', '* @alice\n']]).teams, undefined);
});

test('a rescan drops depth fields that are gone and keeps hand-written ones', () => {
  const first = scan([['package.json', fx('package.json.txt')], ['.env.example', 'A=1\n']]);
  const second = scan([['package.json', '{"name":"web"}']]);
  const merged = mergeRow({ ...first, role: 'app' }, { ...second, scanned_at: '2026-01-01' });
  assert.deepEqual([merged.test, merged.env, merged.role], [undefined, undefined, 'app']);
});
