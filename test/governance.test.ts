// Governance and packaging checks: files exist, package.json fields, dependabot groups, CONTRIBUTING and README sections. Files only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = (p: string): string => fs.readFileSync(path.join(root, p), 'utf8');

test('governance files and templates exist and are not stubs', () => {
  for (const f of ['CODE_OF_CONDUCT.md', '.github/ISSUE_TEMPLATE/bug_report.md', '.github/ISSUE_TEMPLATE/feature_request.md', '.github/pull_request_template.md']) {
    assert.ok(fs.existsSync(path.join(root, f)), `${f} is missing`);
    assert.ok(read(f).length > 100, `${f} is too short to be real`);
  }
  for (const f of ['.github/ISSUE_TEMPLATE/bug_report.md', '.github/pull_request_template.md']) {
    assert.match(read(f), /npm run bulletproof:check|plangraph doctor/, `${f} has no checklist command`);
  }
  assert.match(read('.github/pull_request_template.md'), /npm run bulletproof:check/);
});

test('the code of conduct is the Contributor Covenant 2.1 and names no email address', () => {
  const t = read('CODE_OF_CONDUCT.md');
  assert.match(t, /Contributor Covenant/);
  assert.match(t, /version 2\.1/);
  assert.match(t, /SECURITY\.md/);
  assert.doesNotMatch(t, /[\w.+-]+@[\w-]+\.[\w.-]+/, 'no email address');
});

test('package.json: private, ESM, node floor, packageManager, license', () => {
  const p = JSON.parse(read('package.json'));
  assert.equal(p.private, true);
  assert.equal(p.type, 'module');
  assert.equal(p.engines.node, '>=24.2');
  assert.match(p.packageManager, /^npm@\d+\.\d+\.\d+$/);
  assert.equal(p.license, 'MIT');
});

test('package.json has the playbook script set', () => {
  const s = JSON.parse(read('package.json')).scripts as Record<string, string>;
  const want: Record<string, string> = {
    lint: 'biome check --write .',
    'lint:fix': 'biome check --write .',
    'lint:check': 'biome check .',
    'test:coverage': 'node scripts/test-coverage.ts',
    'test:watch': 'node --test --watch "test/*.test.{mjs,ts}"',
    'validate:plugin': 'node test/validate-plugin.ts',
    validate: 'npm run lint:check && npm run typecheck && npm run test:coverage && npm run assure && npm run validate:plugin && npm run knip && npm audit --audit-level=high',
    typecheck: 'node scripts/typecheck.ts',
    test: 'node --test "test/*.test.{mjs,ts}"',
    bulletproof: 'npm run lint:fix && npm run typecheck && npm run test',
    'bulletproof:check': 'npm run lint:check && npm run typecheck && npm run test',
  };
  for (const [k, v] of Object.entries(want)) assert.equal(s[k], v, `script ${k}`);
  assert.equal(s.format, undefined, 'format is deferred with the formatter');
  assert.equal(s['format:check'], undefined, 'format:check is deferred with the formatter');
});

test('package.json has keywords and author', () => {
  const p = JSON.parse(read('package.json')), m = JSON.parse(read('.claude-plugin/plugin.json'));
  assert.deepEqual(p.keywords, m.keywords);
  assert.equal(p.author, m.author.name);
});

test('dependabot: weekly npm and github-actions, dev and production in separate groups', () => {
  const t = read('.github/dependabot.yml');
  const blocks = t.split(/^ {2}- package-ecosystem: /m).slice(1);
  const byName = new Map(blocks.map((b) => [b.split('\n')[0].trim(), b]));
  for (const name of ['npm', 'github-actions']) {
    const b = byName.get(name);
    assert.ok(b, `${name} missing`);
    assert.match(b, /interval: weekly/, `${name} is not weekly`);
  }
  const groupsOf = (b: string): string[] => (b.split(/^ {4}groups:\n/m)[1] ?? '').split(/^ {6}(?=[\w-]+:\s*$)/m).filter((g) => g.trim() !== '');
  const npmGroups = groupsOf(byName.get('npm') ?? '');
  assert.equal(npmGroups.length, 2, 'two separate npm groups');
  const prod = npmGroups.filter((g) => /dependency-type: production/.test(g));
  const dev = npmGroups.filter((g) => /dependency-type: development/.test(g));
  assert.equal(prod.length, 1, 'one group holds production dependencies');
  assert.equal(dev.length, 1, 'one group holds development dependencies');
  assert.notEqual(prod[0], dev[0], 'production and development are different groups');
});

test('CONTRIBUTING.md names the gate scripts', () => {
  const t = read('CONTRIBUTING.md');
  // the name must end at a backtick, whitespace or end of line, so `bulletproof` is not satisfied by `bulletproof:check`
  for (const s of ['bulletproof', 'bulletproof:check', 'knip', 'test:related']) {
    assert.match(t, new RegExp('npm run ' + s.replace(':', '\\:') + '(?:[`\\s]|$)', 'm'), `CONTRIBUTING.md omits ${s}`);
  }
});

test('README has the governance sections and a scripts table that names real scripts', () => {
  const t = read('README.md');
  for (const h of ['Requirements', 'Installation', 'Quick ?start', 'Development', 'Contributing', 'Security', 'Changelog', 'License']) {
    assert.match(t, new RegExp(`^## ${h}\\s*$`, 'm'), `README misses ## ${h}`);
    const body = t.split(new RegExp(`^## ${h}\\s*$`, 'm'))[1].split(/^## /m)[0];
    assert.ok(body.replace(/\s+/g, '').length >= 20, `README ## ${h} has no real body`);
  }
  const dev = t.split(/^## Development\s*$/m)[1].split(/^## /m)[0];
  assert.match(dev, /^\| Script \| What it does \|$/m);
  const scripts = JSON.parse(read('package.json')).scripts;
  const named = [...dev.matchAll(/^\| `npm (?:run )?([\w:]+)/gm)].map((m) => m[1]);
  assert.ok(named.length >= 8);
  for (const n of named) assert.ok(n === 'test' || n in scripts, `README table names npm script ${n}, which does not exist`);
});
