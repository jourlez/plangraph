// Static checks of .github/workflows/*.yml, .github/dependabot.yml and .github/CODEOWNERS, read as text (no YAML parser, zero dependencies, no network).
// Covered: every `uses:` pinned to a 40-hex SHA with a version comment (local ./ reusable workflows exempt), top-level permissions are contents: read,
// release adds only the three allowed job permissions, no pull_request_target, persist-credentials: false after every checkout, CI matrix and steps,
// dependabot covers github-actions, CODEOWNERS holds no invented owner.
// NOT covered: that the pinned SHAs exist upstream (needs the network; resolved with `gh api` when written) or that the workflows run on GitHub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const GH = path.join(ROOT, '.github');
const WF = ['ci.yml', 'release.yml'];
const read = (...p) => fs.readFileSync(path.join(GH, ...p), 'utf8');
const lines = (t) => t.split('\n');
const usesLines = (t) => lines(t).map((l, i) => [i, l]).filter(([, l]) => /^\s*(-\s+)?uses:/.test(l));
const PIN = /^\s*(-\s+)?uses:\s+[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[0-9a-f]{40}\s+#\s+v\d+(\.\d+){0,2}\s*$/;

for (const f of WF) {
  const text = read('workflows', f);
  test(`${f}: every uses is a 40-hex SHA pin with a version comment`, () => {
    const us = usesLines(text);
    assert.ok(us.length > 0);
    for (const [, l] of us) {
      if (/^\s*(-\s+)?uses:\s+\.\//.test(l)) continue;
      assert.match(l, PIN, `unpinned: ${l.trim()}`);
    }
  });
  test(`${f}: top-level permissions are contents: read only`, () => {
    const m = /^permissions:\n((?: {2}\S.*\n)+)/m.exec(text);
    assert.ok(m, 'no top-level permissions');
    assert.equal(m[1], '  contents: read\n');
  });
  test(`${f}: no pull_request_target, no write-all`, () => {
    assert.ok(!/pull_request_target/.test(text));
    assert.ok(!/write-all/.test(text));
  });
  test(`${f}: every checkout sets persist-credentials: false`, () => {
    const ls = lines(text);
    const cos = usesLines(text).filter(([, l]) => /actions\/checkout@/.test(l));
    assert.ok(cos.length > 0);
    for (const [i] of cos) {
      let ok = false;
      for (let j = i + 1; j < ls.length && !/^\s*-\s/.test(ls[j]) && ls[j].trim() !== ''; j++) {
        if (/^\s+persist-credentials:\s*false\s*$/.test(ls[j])) ok = true;
      }
      assert.ok(ok, `checkout at line ${i + 1} lacks persist-credentials: false`);
    }
  });
  test(`${f}: no secrets expressions other than GITHUB_TOKEN`, () => {
    for (const m of text.matchAll(/secrets\.([A-Za-z0-9_]+)/g)) assert.equal(m[1], 'GITHUB_TOKEN');
  });
}

test('release.yml: only the three allowed job permissions are added', () => {
  const t = read('workflows', 'release.yml');
  const keys = new Set();
  const ls = lines(t);
  for (let i = 0; i < ls.length; i++) {
    if (/^ {4}permissions:\s*$/.test(ls[i])) {
      for (let j = i + 1; j < ls.length && /^ {6}\S/.test(ls[j]); j++) keys.add(ls[j].trim().split(/\s+/).slice(0, 2).join(' '));
    }
  }
  assert.deepEqual([...keys].sort(), ['attestations: write', 'contents: write', 'id-token: write']);
  assert.match(t, /tags:\s*\['v\[0-9\]\+\.\[0-9\]\+\.\[0-9\]\+'\]/);
  assert.match(t, /uses: \.\/\.github\/workflows\/ci\.yml/);
});

test('ci.yml: matrix, commands and gates', () => {
  const t = read('workflows', 'ci.yml');
  assert.match(t, /workflow_call:/);
  assert.match(t, /os:\s*\[ubuntu-24\.04,\s*macos-latest\]/);
  assert.match(t, /node:\s*\['24'\]/);
  for (const c of ['npm test', 'npm run smoke', 'npm run validate', 'node --test --experimental-test-coverage',
    '--test-coverage-include=', 'claude plugin validate . --strict', 'gitleaks/gitleaks-action@', 'npm ci --ignore-scripts', 'npm run typecheck', 'npm run lint']) {
    assert.ok(t.includes(c), `missing ${c}`);
  }
  assert.match(t, /::notice::/, 'absent claude CLI must be a notice, not a failure');
  assert.equal(/typecheck skipped|lint skipped|if \[ -f (tsconfig|biome)\.json \]/.test(t), false, 'typecheck and lint always run (their configs are committed)');
});

test('ci.yml: every npm script it runs exists in package.json', () => {
  const t = read('workflows', 'ci.yml');
  const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts;
  const run = [...t.matchAll(/npm run ([a-z:-]+)/g)].map((m) => m[1]);
  assert.ok(run.length >= 2);
  for (const s of run) assert.ok(scripts[s], `package.json has no script ${s}`);
  assert.ok(scripts.test);
});

test('dependabot.yml covers github-actions weekly', () => {
  const t = read('dependabot.yml');
  assert.match(t, /^version: 2$/m);
  assert.match(t, /package-ecosystem: github-actions/);
  assert.match(t, /interval: weekly/);
});

test('CODEOWNERS has comments and exactly one rule: everything is owned by the owner handle jourlez', () => {
  const t = read('CODEOWNERS');
  const rules = lines(t).filter((l) => l.trim() !== '' && !l.startsWith('#'));
  assert.deepEqual(rules.map((l) => l.trim().split(/\s+/)), [['*', '@jourlez']]);
  assert.ok(lines(t).some((l) => l.startsWith('#')), 'keep the comments');
});

// ------------------------------------------------------------------ gates that must not be weakened silently
// text of one top-level job (from `  name:` to the next 2-space-indented key)
const job = (t, name) => {
  const ls = lines(t); const s = ls.indexOf(`  ${name}:`);
  assert.ok(s >= 0, `no job ${name}`);
  let e = s + 1; while (e < ls.length && !/^ {2}\S/.test(ls[e])) e++;
  return ls.slice(s, e).join('\n');
};

test('ci.yml: the test job adds no permissions; the gitleaks job asks for exactly contents and pull-requests read', () => {
  const t = read('workflows', 'ci.yml');
  assert.ok(!/permissions:/.test(job(t, 'test')), 'the test job must inherit the top-level contents: read');
  const s = job(t, 'secrets');
  const m = /^ {4}permissions:\n((?: {6}\S.*\n?)+)/m.exec(s);
  assert.ok(m, 'the secrets job needs job-level permissions (gitleaks-action reads PR commits)');
  assert.deepEqual(m[1].trim().split('\n').map((x) => x.trim()).sort(), ['contents: read', 'pull-requests: read']);
});

test('ci.yml: no continue-on-error anywhere, and the coverage floors and include globs stay put', () => {
  for (const f of WF) assert.ok(!/continue-on-error:\s*true/i.test(read('workflows', f)), `${f} lets a failure pass`);
  const t = read('workflows', 'ci.yml');
  const floor = (k) => Number(new RegExp(`--test-coverage-${k}=(\\d+)`).exec(t)?.[1]);
  assert.ok(floor('lines') >= 98 && floor('branches') >= 90 && floor('functions') >= 96, 'coverage floors were lowered or removed');
  assert.ok(t.includes("--test-coverage-include='lib/**'") && t.includes("--test-coverage-include='src/**'"), 'src/** must stay in coverage');
});

test('release.yml: the release job needs verify, checks the tag is on main, and attests a specific subject', () => {
  const t = read('workflows', 'release.yml');
  assert.match(job(t, 'release'), /^ {4}needs: verify$/m);
  assert.match(t, /git merge-base --is-ancestor "\$GITHUB_SHA" origin\/main/);
  const a = /actions\/attest@[^\n]*\n\s+with:\n\s+subject-path:\s*(.+)\n/.exec(t);
  assert.ok(a, 'no attest subject-path');
  const sp = a[1].trim();
  assert.ok(!/^["']?\*+["']?$/.test(sp) && /project-brain-/.test(sp), `attest subject-path too broad: ${sp}`);
});

test('release.yml: no extra git fetch after persist-credentials: false (fetch-depth: 0 already has origin/main)', () => {
  const t = read('workflows', 'release.yml');
  assert.ok(!/git fetch/.test(t), 'a fetch with no credentials fails on private repositories');
  assert.match(t, /fetch-depth: 0/);
});

test('SECURITY.md explains the organization licence and the data gitleaks-action sends', () => {
  const t = fs.readFileSync(path.join(ROOT, 'SECURITY.md'), 'utf8');
  assert.match(t, /GITLEAKS_LICENSE/);
  assert.match(t, /repo(?:sitory)? name/i);
  assert.match(t, /owner/i);
});
