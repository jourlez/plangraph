// scanRepo, globRe, parseCodeowners and mergeRow on the manifests and workspace layouts the other scan tests leave out. Synthetic repositories only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scanRepo, globRe, parseCodeowners, repoOwners, ownersFor, mergeRow, langsOf, subUnits, fingerprint } from '../lib/graph/repo.ts';
import type { ScanFile } from '../lib/graph/repo.ts';

const f = (path: string, text?: string): ScanFile => ({ path, sha: `sha-${path}`, ...(text === undefined ? {} : { text }) });
const people = new Set(['ana', 'bo']);

test('a package.json row carries the manager, frameworks, plain commands, entries and workspace sub-units; lifecycle hooks never', () => {
  const pkg = JSON.stringify({
    name: 'demo-app', packageManager: 'pnpm@9.0.0', main: 'dist/index.js', bin: { x: 'bin/x.js', y: '../evil.js' },
    dependencies: { react: '1', express: '4' }, devDependencies: { vitest: '1' },
    scripts: { build: 'tsc -p .', test: 'node --test; rm -rf /', lint: 'eslint .', start: 'node .', postinstall: 'curl x' },
    workspaces: { packages: ['packages/*', '../bad/*', 'apps/*', 5] },
  });
  const r = scanRepo({
    slug: 'demo', people,
    files: [f('package.json', pkg), f('.nvmrc', 'v20.1.2\n'), f('Dockerfile', 'ENV A_ONE=1 B_TWO=2\nENV SINGLE value\nenv lower=1\n'), f('.env.example', 'export TOKEN_X=abc\nplain\nlower=1\n'), f('CODEOWNERS', '* @ana @org/platform\n/docs/ @bo\n!neg @x\n# c\n')],
    paths: ['packages/a/package.json', 'packages/a/src/x.ts', 'packages/b/package.json', 'apps/web/package.json', 'a.ts', 'b.py', 'c.py', 'd.go'],
  });
  const row = r.row;
  assert.equal(row.id, 'repo:demo');
  assert.equal(row.name, 'demo-app');
  assert.equal(row.src, 'scan');
  assert.equal(row.pm, 'pnpm');
  assert.equal(row.runtime, 'node@20.1.2');
  assert.deepEqual(row.frameworks, ['react', 'express']);
  assert.deepEqual(row.cmds, { build: 'build', test: 'test', lint: 'lint' });
  assert.equal(row.build, 'tsc -p .');
  assert.equal(row.lint, 'eslint .');
  assert.equal(row.run, 'node .');
  assert.equal(row.test, undefined, 'a command with a shell metacharacter is not copied');
  assert.deepEqual(row.entry, ['bin/x.js', 'dist/index.js']);
  assert.deepEqual(row.paths, [{ glob: 'packages/a/**', sub: 'a' }, { glob: 'packages/b/**', sub: 'b' }, { glob: 'apps/web/**', sub: 'web' }]);
  assert.equal(row.role, 'monorepo');
  assert.deepEqual(row.langs, ['python', 'typescript', 'go']);
  assert.equal(row.deploy, 'docker');
  assert.deepEqual(row.env, ['A_ONE', 'B_TWO', 'SINGLE', 'TOKEN_X']);
  assert.deepEqual(row.teams, ['platform']);
  assert.deepEqual(row.owners, ['ana']);
  assert.deepEqual(row.pkgs, ['apps/web', 'packages/a', 'packages/b']);
  assert.deepEqual(r.warnings, []);
});

test('python, rust and go manifests, runtime hints from version files, and an oversized file warning', () => {
  const py = scanRepo({ slug: 'py', people, paths: [], files: [f('pyproject.toml', '[tool.poetry]\nname = "My-Lib"\n[project]\ndependencies = [\n  "flask>=2",\n]\n'), f('.python-version', '3.12\n'), f('.tool-versions', 'nodejs 18.2\nunknown 1\nruby\n')] });
  assert.deepEqual([py.row.pm, py.row.name, py.row.frameworks, py.row.runtime], ['poetry', 'my-lib', ['flask'], 'python@3.12']);
  const uv = scanRepo({ slug: 'uv', people, paths: [], files: [f('pyproject.toml', '[tool.uv]\n[project]\nname = "x"\n')] });
  assert.equal(uv.row.pm, 'uv');
  assert.equal(scanRepo({ slug: 'pip', people, paths: [], files: [f('pyproject.toml', '')] }).row.pm, 'pip');
  const rs = scanRepo({ slug: 'rs', people, paths: [], files: [f('Cargo.toml', '[package]\nname = "crate-x"\n[workspace]\nmembers = ["crates/*", "tools/one"]\n'), f('go.work', 'use (\n./svc // c\n)\nuse ./solo\n'), f('pnpm-workspace.yaml', 'packages:\n  - "libs/*"\n  - \'extra\'\nother:\n  - nope\n')] });
  assert.deepEqual([rs.row.runtime, rs.row.pm, rs.row.name], ['rust', 'cargo', 'crate-x']);
  const go = scanRepo({ slug: 'go', people, paths: ['crates/a/Cargo.toml', 'tools/one/main.rs', 'libs/l/package.json', 'extra/x.txt'], files: [f('go.mod', 'module example.invalid/team/svc-x\n'), f('Cargo.toml', '[workspace]\nmembers = ["crates/*", "tools/one"]\n'), f('pnpm-workspace.yaml', 'packages:\n  - "libs/*"\n  - \'extra\'\nother:\n  - nope\n')] });
  assert.deepEqual([go.row.runtime, go.row.name], ['rust', 'svc-x']);
  assert.deepEqual(go.row.pkgs, ['crates/a', 'extra', 'libs/l', 'tools/one']);
  const hint = scanRepo({ slug: 'h', people, paths: [], files: [f('.tool-versions', 'python 3.11\nnodejs 20\n')] });
  assert.equal(hint.row.runtime, 'node@20');
  const big = scanRepo({ slug: 'big', people, paths: [], files: [f('package.json')] });
  assert.match(big.warnings[0]!, /package\.json: over 256 KB, not read/);
  assert.equal(big.row.name, 'big');
  assert.equal(scanRepo({ slug: 'bad', people, paths: [], files: [f('package.json', '[1]'), f('go.mod', 'nothing')] }).row.runtime, 'go');
  assert.equal(scanRepo({ slug: 'bad2', people, paths: [], files: [f('package.json', '{not json')] }).row.runtime, undefined);
});

test('globRe and CODEOWNERS: anchoring, directory-only patterns, wildcards and last-match-wins', () => {
  assert.equal(globRe('docs/').test('docs/a.md'), true);
  assert.equal(globRe('docs/').test('docs'), false);
  assert.equal(globRe('/src/*.ts').test('src/a.ts'), true);
  assert.equal(globRe('/src/*.ts').test('src/x/a.ts'), false);
  assert.equal(globRe('*.md').test('deep/er/a.md'), true);
  assert.equal(globRe('a?c').test('abc'), true);
  assert.equal(globRe('a?c').test('a/c'), false);
  assert.equal(globRe('src/**').test('src/a/b\nc'), true);
  assert.equal(globRe('a***b').test('axxb'), true);
  assert.equal(globRe('x').test('y/x/z'), true);
  const rules = parseCodeowners('* @ana\n/docs/ @bo @cy\n\tbad\u0001pat @x\n' + 'p'.repeat(201) + ' @x\n/lone\n');
  assert.deepEqual(rules.map((r) => r.pattern), ['*', '/docs/', '/lone']);
  assert.deepEqual(ownersFor(rules, 'docs/a.md'), ['@bo', '@cy']);
  assert.deepEqual(ownersFor(rules, 'other'), ['@ana']);
  assert.deepEqual(ownersFor(rules, 'lone'), []);
  assert.deepEqual(ownersFor([], 'x'), []);
  assert.deepEqual(repoOwners(parseCodeowners('/** @bo @ana @ghost @org/team\n'), people), ['ana', 'bo']);
  assert.deepEqual(repoOwners([], people), []);
});

test('mergeRow keeps hand-written fields, fills gaps from the seed, drops vanished scan fields and unions owners', () => {
  assert.deepEqual(mergeRow(undefined, { id: 'repo:x' }), { id: 'repo:x' });
  const merged = mergeRow({ id: 'repo:x', role: 'service', note: 'mine', pm: 'npm', env: ['A'], owners: ['bo'] }, { id: 'repo:x', role: 'lib', paths: [{ glob: 'a/**', sub: 'a' }], pm: 'pnpm', owners: ['ana'] });
  assert.deepEqual(merged, { id: 'repo:x', role: 'service', note: 'mine', pm: 'pnpm', paths: [{ glob: 'a/**', sub: 'a' }], owners: ['ana', 'bo'] });
  assert.equal('owners' in mergeRow({ id: 'r' }, { id: 'r' }), false);
});

test('langsOf, subUnits and fingerprint on edge inputs', () => {
  assert.deepEqual(langsOf(['a.ts', 'b.TS', 'c.py', 'd.go', 'e.rs', 'f.unknown', 'noext']), ['typescript', 'go', 'python']);
  assert.deepEqual(subUnits('x', []), []);
  assert.deepEqual(subUnits([5, 'pk/*'], ['pk/a/package.json', 'pk/B!/package.json', 'pk/a/x/package.json']), [{ glob: 'pk/a/**', sub: 'a' }]);
  assert.equal(fingerprint([{ path: 'b', sha: '2' }, { path: 'a', sha: '1' }]), fingerprint([{ path: 'a', sha: '1' }, { path: 'b', sha: '2' }]));
});
