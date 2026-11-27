// Packaging checks: license, changelog, security policy, honest manifests, README sections. Files only, no network, no clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { sourceFilesIn } from './helpers/source-files.ts';
import { changelogOk, versionOk } from './helpers/changelog.ts';

const root = path.resolve(import.meta.dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const json = (p: string) => JSON.parse(read(p));

test('LICENSE, CHANGELOG.md and SECURITY.md exist and are not stubs', () => {
  for (const f of ['LICENSE', 'CHANGELOG.md', 'SECURITY.md']) {
    assert.ok(fs.existsSync(path.join(root, f)), `${f} is missing`);
    assert.ok(read(f).length > 300, `${f} is too short to be real`);
  }
  assert.match(read('LICENSE'), /^MIT License\n\nCopyright \(c\) 2026 plangraph authors\n/);
  assert.match(read('LICENSE'), /Permission is hereby granted, free of charge/);
});

test('plugin.json and package.json carry the same version', () => {
  const a = json('.claude-plugin/plugin.json').version;
  const b = json('package.json').version;
  assert.ok(versionOk(a), 'version is X.Y.Z or X.Y.Z-dev');
  assert.equal(a, b);
});

test('plugin.json has the required fields', () => {
  const m = json('.claude-plugin/plugin.json');
  assert.equal(m.name, 'plangraph');
  assert.equal(typeof m.version, 'string');
  assert.ok(typeof m.description === 'string' && m.description.length > 20);
  assert.equal(m.license, 'MIT');
  assert.ok(Array.isArray(m.keywords) && m.keywords.length > 0);
  assert.equal(typeof m.author?.name, 'string');
  assert.ok(m.author.name.length > 0);
  assert.deepEqual(Object.keys(m.author), ['name']);
});

const REPO = 'https://github.com/jourlez/plangraph';

test('plugin.json declares the verified Claude Code minimum, the one repository and a homepage', () => {
  const m = json('.claude-plugin/plugin.json');
  // Verified: the plugin installs and runs on Claude Code 2.1.329 (validator, marketplace add, hooks, bin, skills).
  // The newest published release when this was written, 2.1.330, was NOT tested. Raise this only after testing a newer one.
  assert.deepEqual(m.engines, { 'claude-code': '>=2.1.329' });
  assert.equal(m.repository, REPO);
  assert.equal(m.homepage, REPO);
  assert.equal('bugs' in m, false, 'the plugin validator does not read bugs; it lives in package.json');
  assert.equal(m.icon, './.claude-plugin/icon.png');
});

test('package.json stays private and carries the same repository, homepage and bugs URL', () => {
  const p = json('package.json');
  assert.equal(p.private, true);
  assert.deepEqual(p.repository, { type: 'git', url: `git+${REPO}.git` });
  assert.equal(p.homepage, REPO);
  assert.deepEqual(p.bugs, { url: `${REPO}/issues` });
  assert.deepEqual(p.engines, { node: '>=26.0' });
});

test('the marketplace entry has no version of its own', () => {
  const mk = json('.claude-plugin/marketplace.json');
  assert.ok(mk.plugins.length > 0);
  for (const p of mk.plugins) assert.equal('version' in p, false);
});

test('manifests and docs name no URL except the one repository and its derived URLs', () => {
  const ok = /^https:\/\/github\.com\/jourlez\/plangraph(\.git|\/issues|\/security\/advisories\/new|\/pulls?|\/blob\/[\w./-]+|\/actions\/workflows\/ci\.yml(\/badge\.svg)?)?$/;
  for (const f of ['.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', 'package.json', 'README.md', 'SECURITY.md', 'CHANGELOG.md', 'CONTRIBUTING.md']) {
    for (const m of read(f).matchAll(/(?:git\+)?https?:\/\/[^\s"'`)>\]]+/gi)) {
      const u = m[0].replace(/^git\+/, '').replace(/[.,;]+$/, '');
      assert.ok(ok.test(u), `${f} names a URL other than the repository: ${u}`);
    }
  }
});

test('CODEOWNERS names the owner and the install section uses the GitHub shorthand and the real marketplace name', () => {
  assert.match(read('.github/CODEOWNERS'), /^\*\s+@jourlez\s*$/m);
  const r = read('README.md');
  assert.match(r, /\/plugin marketplace add jourlez\/plangraph/);
  const name = json('.claude-plugin/marketplace.json').name;
  assert.ok(r.includes(`/plugin install plangraph@${name}`));
  assert.match(r, /local path/i);
  assert.equal(/minimum Claude Code version is not verified|manifest sets none/i.test(r), false);
  assert.match(r, /Claude Code 2\.1\.329 or newer/);
  assert.equal(/no minimum declared|sets no `engines`/i.test(read('CHANGELOG.md').split('## Unreleased')[1]), false);
});

test('README has the required headings', () => {
  const t = read('README.md');
  for (const h of ['Quickstart', 'What runs on your machine', 'Works with']) {
    assert.match(t, new RegExp(`^## ${h}\\s*$`, 'm'), `missing heading ${h}`);
  }
});

test('README says Node 26, never the old floor', () => {
  const t = read('README.md');
  assert.match(t, /Node 26/);
  assert.equal(/22\.13/.test(t), false);
});

test('every plangraph command in the README quickstart is a registered command', async () => {
  const { registry } = await import('../src/registry.ts');
  const readme = read('README.md');
  // the section ends at the next level-2 heading OUTSIDE a fenced block (the output of `plangraph init` holds a `## Plan questions` line)
  const lines = readme.split('\n'), start = lines.indexOf('## Quickstart');
  assert.ok(start >= 0);
  let fenced = false, end = lines.length;
  for (let k = start + 1; k < lines.length; k++) {
    if (/^\s*```/.test(lines[k] as string)) fenced = !fenced;
    else if (!fenced && /^## /.test(lines[k] as string)) { end = k; break; }
  }
  const section = lines.slice(start, end).join('\n');
  const cmds = [...section.matchAll(/`plangraph ([a-z][a-z-]*)/g)].map((m) => m[1]);
  assert.ok(cmds.length >= 3, `quickstart names ${cmds.length} plangraph commands`);
  for (const c of cmds) assert.ok(registry.has(c), `plangraph ${c} is not a registered command`);
  for (const c of ['build', 'doctor', 'integrations']) assert.ok(cmds.includes(c), `quickstart lacks plangraph ${c}`);
});

test('quickstart skill commands exist as skills', () => {
  const t = read('README.md');
  for (const m of t.matchAll(/\/plangraph:([a-z-]+)/g)) {
    assert.ok(fs.existsSync(path.join(root, 'skills', m[1], 'SKILL.md')), `no skill ${m[1]}`);
  }
  assert.match(t, /\/plangraph:init/);
});

test('README states the real status: what was verified, what was not, and the untested newer releases', () => {
  const t = read('README.md');
  // the install was exercised with the claude plugin CLI; the interactive /plugin menu, newer releases and Windows were not
  assert.match(t, /Interactive `\/plugin` menu \| not exercised/);
  assert.match(t, /releases after 2\.1\.329 have not been tested/i);
  assert.match(t, /Windows is not supported/);
  assert.doesNotMatch(t, /production[- ]ready|battle[- ]tested|enterprise[- ]grade|blazing|seamless/i, 'no marketing claims');
});

test('CHANGELOG has a 0.1.0 entry matching the version and names every removed feature', () => {
  const v = json('package.json').version;
  const c = read('CHANGELOG.md');
  // a -dev version is the open development line: its entries live under [Unreleased] until the release commit
  assert.ok(changelogOk(v, c), `CHANGELOG has no entry for ${v}`);
  for (const w of [/claims?/i, /hash(ed)? ids?/i, /compaction/i, /command execution/i, /format_version/, /\bextra\b/, /impl_status/, /live (Claude Code )?session/i]) {
    assert.match(c, w, `CHANGELOG lacks ${w}`);
  }
});

test('a -dev version passes the version check and needs an Unreleased CHANGELOG section', () => {
  assert.ok(versionOk('0.3.0-dev') && versionOk('0.3.0'));
  assert.ok(!versionOk('0.3.0-rc1') && !versionOk('0.3-dev'));
  assert.ok(changelogOk('0.3.0-dev', '# Changelog\n\n## [Unreleased]\n\n## 0.2.4\n'));
  assert.ok(!changelogOk('0.3.0-dev', '# Changelog\n\n## 0.2.4\n'), 'a -dev version without the heading fails');
  assert.ok(!changelogOk('0.3.0-dev', '# Changelog\n\n## Unreleased\n'), 'the unbracketed heading is refused for a -dev version');
  assert.ok(!changelogOk('0.3.0-dev', '# Changelog\n\n## 0.2.4\n\n## [Unreleased]\n'), 'Unreleased must come above the first release heading');
  assert.ok(!changelogOk('0.3.0', '# Changelog\n\n## [Unreleased]\n\n## 0.2.4\n'), 'a release needs its own entry');
  assert.ok(changelogOk('0.3.0', '## [0.3.0] - 2026-12-01\n') && changelogOk('0.2.4', '## 0.2.4\n'));
  assert.match(json('package.json').version, /^\d+\.\d+\.\d+(-dev)?$/);
});

test('SECURITY.md invents no contact and states the real limits', () => {
  const s = read('SECURITY.md');
  assert.equal(/@[a-z0-9-]+\.[a-z]{2,}/i.test(s), false, 'SECURITY.md contains an email address');
  assert.match(s, /private vulnerability reporting/i);
  assert.match(s, /Security tab/);
  assert.match(s, /Report a vulnerability/);
  assert.match(s, /must be enabled/i);
  assert.equal(/contact the maintainer directly|no public repository yet/i.test(s), false);
  assert.match(s, /unsandboxed/i);
  assert.match(s, /live (Claude Code )?session/i);
});

test('no runtime dependencies: devDependencies are exactly typescript, @types/node, @biomejs/biome, knip and lefthook, pinned exactly and locked', () => {
  const p = json('package.json');
  for (const k of ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies']) assert.equal(k in p, false, `package.json must not have ${k}`);
  assert.equal(p.type, 'module');
  assert.deepEqual(Object.keys(p.devDependencies).sort(), ['@biomejs/biome', '@types/node', 'knip', 'lefthook', 'typescript']);
  for (const [n, v] of Object.entries(p.devDependencies as Record<string, string>)) assert.match(v, /^\d+\.\d+\.\d+$/, `${n} must be an exact version`); // package.json pins each one with a version string
  assert.match(p.devDependencies['@types/node'], /^\d+\.\d+\.\d+$/, 'pinned exactly');
  const lock = json('package-lock.json'), top = lock.packages[''];
  assert.deepEqual(top.devDependencies, p.devDependencies, 'package-lock.json matches package.json');
  assert.equal('dependencies' in top, false);
  for (const [k, v] of Object.entries(lock.packages as Record<string, { dev?: boolean; integrity?: string }>)) if (k) { assert.equal(v.dev, true, `${k} must be a dev-only package`); assert.match(v.integrity ?? '', /^sha512-/, `${k} has no integrity hash`); } // package-lock.json's packages map
  assert.match(read('.gitignore'), /^node_modules\/$/m, 'node_modules is never committed (so never in the plugin)');
});

test('every import in lib, src, scripts, mcp and the node entry points is relative or node: (nothing from node_modules at run time)', () => {
  const files = [];
  files.push(...sourceFilesIn(root, ['lib', 'src', 'scripts', 'mcp']));
  for (const f of fs.readdirSync(path.join(root, 'bin'))) if (fs.statSync(path.join(root, 'bin', f)).isFile() && read(path.join('bin', f)).startsWith('#!/usr/bin/env node')) files.push(path.join('bin', f));
  assert.ok(files.length > 20);
  for (const f of files) {
    for (const m of read(f).matchAll(/(?:(?<!['"])\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm)) {
      assert.ok(m[1].startsWith('.') || m[1].startsWith('node:'), `${f} imports ${m[1]}`);
    }
  }
});

test('CONTRIBUTING.md exists, names the real checks, points at the issue and pull request flow and invents no contact', () => {
  assert.ok(fs.existsSync(path.join(root, 'CONTRIBUTING.md')), 'CONTRIBUTING.md is missing');
  const c = read('CONTRIBUTING.md');
  assert.ok(c.length > 300);
  for (const w of [/Node 26/, /node --test/, /test\/smoke\.sh/, /test\/validate-plugin\.ts/, /docs\/REUSE\.md/, /failing test/i]) {
    assert.match(c, w, `CONTRIBUTING lacks ${w}`);
  }
  assert.match(c, /issue/i);
  assert.match(c, /pull request/i);
  assert.equal(/send a patch|no public repository yet/i.test(c), false);
  assert.equal(/@[a-z0-9-]+\.[a-z]{2,}/i.test(c), false, 'CONTRIBUTING has an email address');
  assert.equal(/co-authored-by/i.test(c), false);
});

test('README and CHANGELOG hard-code no test-count claim', () => {
  for (const f of ['README.md', 'CHANGELOG.md']) assert.doesNotMatch(read(f), /\b\d{2,}\s+tests\b/, `${f} states a test count that goes stale`);
});

test('docs/TOKENS.md measured block equals the benchmark output (node test/bench-tokens.ts --check)', () => {
  const r = spawnSync(process.execPath, [path.join(root, 'test/bench-tokens.ts'), '--check', '--dir', fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-bench-check-'))], { encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, `TOKENS.md drifted or an answer is wrong: run node test/bench-tokens.ts\n${r.stderr.slice(0, 500)}`);
});

test('README lists every skill and every registry command; REUSE.md does not call report planned', async () => {
  const readme = read('README.md');
  for (const n of fs.readdirSync(path.join(root, 'skills'))) assert.ok(readme.includes(n), `README does not mention skill ${n}`);
  const { registry } = await import('../src/registry.ts');
  const cmds = readme.split('## Commands')[1].split('\n## ')[0];
  for (const c of registry.keys()) assert.ok(new RegExp(`(^|[\`|\\s])${c}([\`|\\s,;.]|$)`).test(cmds), `README Commands omits ${c}`);
  assert.doesNotMatch(read('docs/REUSE.md'), /plangraph report`?,? planned|\d+x vs grep/);
});

test('SECURITY.md states that plangraph doctor spawns uv and git', () => {
  const line = read('SECURITY.md').split('\n').find((l) => /plangraph doctor/.test(l) && /spawn/.test(l)) || '';
  assert.match(line, /uv/);
  assert.match(line, /git/);
  assert.doesNotMatch(read('SECURITY.md'), /never start another program/);
});

test('docs/MCP.md token table equals the benchmark output (bench-mcp --check), fails on drift, and never writes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-mcp-check-'));
  try {
    const run = (doc: string) => spawnSync(process.execPath, [path.join(root, 'test/bench-mcp.ts'), '--check', '--doc', doc, '--dir', path.join(dir, 'scratch')], { encoding: 'utf8', timeout: 300000 });
    const real = path.join(root, 'docs/MCP.md');
    const before = fs.readFileSync(real, 'utf8');
    const ok = run(real);
    assert.equal(ok.status, 0, `docs/MCP.md drifted: paste node test/bench-mcp.ts into it\n${ok.stderr.slice(0, 400)}`);
    const drifted = path.join(dir, 'MCP.md');
    fs.writeFileSync(drifted, before.replace('| tool definitions (JSON of the 7 tools) |', '| tool definitions (JSON of the 7 tools) | 1 |'));
    const bad = run(drifted);
    assert.equal(bad.status, 1, 'a drifted table must fail the check');
    assert.match(bad.stderr, /stale/);
    assert.equal(fs.readFileSync(drifted, 'utf8'), before.replace('| tool definitions (JSON of the 7 tools) |', '| tool definitions (JSON of the 7 tools) | 1 |'), 'check must not write');
    assert.equal(fs.readFileSync(real, 'utf8'), before, 'check must not touch docs/MCP.md');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
