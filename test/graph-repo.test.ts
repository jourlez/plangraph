// lib/graph/repo.ts: the pure parsers of `plangraph repo scan` (docs/superpowers/plans/2026-11-25-graph-v2-amendment.md section 3.10).
// Not covered here: reading blobs through git (test/repo-scan-command.test.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MAX_FILE, fingerprint, isScanFile, langsOf, mergeRow, ownersFor, parseCodeowners, repoOwners, scanRepo } from '../lib/graph/repo.ts';
import { validators } from '../lib/schema.ts';

const FX = path.join(import.meta.dirname, 'fixtures/repo-scan');
const fx = (n: string) => fs.readFileSync(path.join(FX, n), 'utf8');
const f = (p: string, text: string, sha = p) => ({ path: p, sha, text });
const people = new Set(['alice', 'bob']);

test('hostile manifest and CODEOWNERS text never reaches the row', () => {
  const { row } = scanRepo({ slug: 'web', files: [f('package.json', fx('hostile-package.json.txt')), f('CODEOWNERS', fx('hostile-CODEOWNERS.txt'))], paths: ['a.ts'], people });
  const text = JSON.stringify(row);
  for (const bad of ['Ignore', 'SYSTEM', 'curl', 'rm -rf', 'postinstall', 'etc/passwd', 'evilpm', 'mallory', 'ghost', 'example.invalid', 'PLANTED', 'ignore-all-rules', 'node build.js']) assert.ok(!text.includes(bad), `${bad} leaked: ${text}`);
  assert.deepEqual(row.cmds, { build: 'build', lint: 'lint', test: 'test' }); // script names only
  assert.equal(row.name, 'web'); // the hostile name fails the token pattern: the slug stands in
  assert.deepEqual(row.frameworks, ['react']);
  assert.equal(row.pm, 'npm');
  assert.equal(validators['repos.jsonl']?.(row), null);
});

test('CODEOWNERS: last match wins, no negation, unresolvable owners dropped', () => {
  const rules = parseCodeowners('* @alice\n/docs/ @bob\n*.md @alice @bob\n!*.md @nobody\n');
  assert.equal(rules.length, 3, 'the negation line is not a rule');
  assert.deepEqual(ownersFor(rules, 'docs/a.md'), ['@alice', '@bob']); // the last matching rule
  assert.deepEqual(ownersFor(rules, 'docs/b.txt'), ['@bob']);
  assert.deepEqual(ownersFor(rules, 'src/x.ts'), ['@alice']);
  assert.deepEqual(repoOwners(parseCodeowners('* @alice\n* @bob @ghost @org/team a@b.c\n'), people), ['bob']);
  assert.deepEqual(repoOwners(parseCodeowners('/docs/ @bob\n'), people), []);
});

test('a script or dependency change moves fp, a README change does not read the README at all', () => {
  const base = [f('package.json', '{"scripts":{"build":"x"}}', 'aaa')];
  const a = scanRepo({ slug: 'r', files: base, paths: [], people }).row.fp;
  assert.notEqual(a, scanRepo({ slug: 'r', files: [f('package.json', '{"scripts":{"build":"y"}}', 'bbb')], paths: [], people }).row.fp);
  assert.equal(isScanFile('README.md'), false);
  assert.equal(isScanFile('node_modules/x/package.json'), false);
  assert.equal(fingerprint([{ path: 'b', sha: '2' }, { path: 'a', sha: '1' }]), fingerprint([{ path: 'a', sha: '1' }, { path: 'b', sha: '2' }]));
});

test('an oversized file is refused (warning, no field) but stays in fp', () => {
  const { row, warnings } = scanRepo({ slug: 'big', files: [{ path: 'package.json', sha: 'zzz' }], paths: [], people });
  assert.equal(row.pm, undefined);
  assert.match(warnings.join(), new RegExp(`package.json: over ${MAX_FILE / 1024} KB`));
  assert.notEqual(row.fp, scanRepo({ slug: 'big', files: [], paths: [], people }).row.fp);
});

test('manifests, tool versions and languages become allowlisted tokens', () => {
  const r = scanRepo({ slug: 'svc', files: [f('go.mod', 'module example.invalid/team/svc\n'), f('.tool-versions', 'golang 1.22.1\nnodejs 20\n'), f('Dockerfile', 'FROM scratch\n')], paths: ['a.go', 'b.go', 'c.ts', 'd.py', 'e.rs', 'f.rs', 'README.md'], people }).row;
  assert.deepEqual([r.name, r.pm, r.runtime, r.deploy, r.langs], ['svc', 'go', 'go@1.22.1', 'docker', ['go', 'rust', 'python']]);
  assert.deepEqual(langsOf(['a.TS', 'b.ts', 'c.js']), ['typescript', 'javascript']);
  const py = scanRepo({ slug: 'p', files: [f('pyproject.toml', '[project]\nname = "Api"\n[tool.uv]\n"flask>=2"\n'), f('.python-version', '3.12\n')], paths: [], people }).row;
  assert.deepEqual([py.name, py.pm, py.runtime], ['api', 'uv', 'python@3.12']);
});

test('a rescan overwrites scanned fields and keeps hand-written ones', () => {
  const old = { id: 'repo:foo', name: 'old', role: 'service', paths: [{ glob: 'a/**', sub: 'a' }], owners: ['bob'], frameworks: ['vue'], note: 'kept', src: 'manual' };
  const fresh = scanRepo({ slug: 'foo', files: [f('package.json', '{"name":"renamed"}')], paths: [], people }).row;
  const m = mergeRow(old, { ...fresh, scanned_at: '2026-11-26' });
  assert.deepEqual([m.id, m.name, m.role, m.note, m.src, m.owners, m.frameworks, m.paths], ['repo:foo', 'renamed', 'service', 'kept', 'scan', ['bob'], undefined, old.paths]);
});
