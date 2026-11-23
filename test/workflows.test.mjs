// Static checks of .github/workflows/*.yml, .github/dependabot.yml and .github/CODEOWNERS, read as text (no YAML parser, zero dependencies, no network).
// Covered: every `uses:` pinned to a 40-hex SHA with a version comment (local ./ reusable workflows exempt), top-level permissions are contents: read,
// release adds only the three allowed job permissions, no pull_request_target, persist-credentials: false after every checkout, the parallel CI
// jobs (unit with the coverage floors, slow, static, macos shards, mutation, gitleaks) and their steps, the weekly informational mutation smoke,
// dependabot covers github-actions, CODEOWNERS holds no invented owner.
// NOT covered: that the pinned SHAs exist upstream (needs the network; resolved with `gh api` when written) or that the workflows run on GitHub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const GH = path.join(ROOT, '.github');
const WF = ['ci.yml', 'release.yml', 'mutation.yml'];
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

test('ci.yml: the parallel jobs, their commands and gates', () => {
  const t = read('workflows', 'ci.yml');
  assert.match(t, /workflow_call:/);
  assert.deepEqual(jobNames(t), ['unit', 'slow', 'static', 'macos', 'mutation', 'secrets']);
  assert.ok(!/^ {4}needs:/m.test(t), 'every CI job starts at once: none waits for another');
  assert.ok(!/^ {4}if:/m.test(t), 'every CI job always runs');
  for (const [name, cmds] of /** @type {Array<[string, string[]]>} */ ([
    ['unit', ['node --test --experimental-test-coverage', '--test-coverage-include=', 'node scripts/ci-tests.mjs coverage']],
    ['slow', ['npm run smoke', 'node scripts/ci-tests.mjs nocoverage', 'node --test $files', 'astral-sh/setup-uv@']],
    ['static', ['npm run validate', 'npm ci --ignore-scripts', 'npm run typecheck', 'npm run lint', 'claude plugin validate . --strict', '::notice::']],
    ['macos', ['node scripts/ci-tests.mjs portable', 'npm run smoke']],
    ['mutation', ['npm run mutate']],
    ['secrets', ['gitleaks/gitleaks-action@']],
  ])) for (const c of cmds) assert.ok(job(t, name).includes(c), `job ${name} is missing ${c}`);
  for (const name of ['unit', 'slow', 'static', 'mutation', 'secrets']) assert.match(job(t, name), /^ {4}runs-on: ubuntu-24\.04$/m, `${name} on ubuntu`);
  assert.equal((t.match(/actions\/setup-node@[0-9a-f]{40}[^\n]*\n\s+with:\n\s+node-version: '24'\n/g) ?? []).length, 5, 'every job but gitleaks sets up Node 24');
  assert.equal(/typecheck skipped|lint skipped|if \[ -f (tsconfig|biome)\.json \]/.test(t), false, 'typecheck and lint always run (their configs are committed)');
  // a step-level condition could hide a check; the only one runs the macOS smoke once instead of on every shard
  assert.deepEqual([...t.matchAll(/^ {8}if: (.+)$/gm)].map((m) => m[1]), ['matrix.shard == 1']);
});

test('ci.yml: macOS runs the portable group in shards that together cover every file, without coverage', () => {
  const t = read('workflows', 'ci.yml');
  const m = job(t, 'macos');
  assert.match(m, /^ {4}runs-on: macos-latest$/m);
  const shards = /^ {8}shard: \[([^\]]*)\]$/m.exec(m)?.[1].split(',').map((x) => Number(x.trim()));
  const n = Number(/--test-shard=\$\{\{ matrix\.shard \}\}\/(\d+) \$files$/m.exec(m)?.[1]);
  assert.ok(n >= 2, 'the macOS tests run sharded');
  assert.deepEqual(shards, Array.from({ length: n }, (_, k) => k + 1), 'the matrix lists every shard 1..N exactly once');
  assert.match(m, /fail-fast: false/);
  assert.ok(!/experimental-test-coverage/.test(m), 'coverage is measured once, by the unit job');
  assert.match(m, /^ {10}files=\$\(node scripts\/ci-tests\.mjs portable\)\n {10}test -n "\$files"$/m);
});

test('ci.yml: the slow job runs the no-coverage group with uv, smoke first, without coverage', () => {
  const t = read('workflows', 'ci.yml');
  const s = job(t, 'slow');
  assert.ok(!/experimental-test-coverage/.test(s));
  assert.ok(s.indexOf('npm run smoke') < s.indexOf('ci-tests.mjs nocoverage'), 'smoke first: it builds the solver environment');
  assert.ok(s.indexOf('astral-sh/setup-uv@') < s.indexOf('npm run smoke'), 'uv before anything needs it');
  assert.match(s, /^ {10}files=\$\(node scripts\/ci-tests\.mjs nocoverage\)\n {10}test -n "\$files"\n(?: {10}#.*\n)? {10}node --test \$files$/m);
});

test('ci.yml: npm ci and its npm cache are in the static job only', () => {
  const t = read('workflows', 'ci.yml');
  for (const name of jobNames(t)) {
    const j = job(t, name);
    assert.equal(/npm ci/.test(j), name === 'static', `npm ci in ${name}`);
    assert.equal(/^ {10}cache: npm$/m.test(j), name === 'static', `npm cache in ${name}`);
  }
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
/** names of the jobs under `jobs:` in file order @param {string} t */
function jobNames(t) {
  const ls = lines(t); const s = ls.indexOf('jobs:');
  assert.ok(s >= 0, 'no jobs:');
  let e = s + 1; while (e < ls.length && !/^\S/.test(ls[e])) e++;
  return ls.slice(s + 1, e).filter((l) => /^ {2}[A-Za-z0-9_-]+:\s*$/.test(l)).map((l) => l.trim().slice(0, -1));
}
function job(/** @type {string} */ t, /** @type {string} */ name) {
  const ls = lines(t); const s = ls.indexOf(`  ${name}:`);
  assert.ok(s >= 0, `no job ${name}`);
  let e = s + 1; while (e < ls.length && !/^ {2}\S/.test(ls[e])) e++;
  return ls.slice(s, e).join('\n');
}

test('ci.yml: only the gitleaks job adds permissions, exactly contents and pull-requests read; the others inherit contents: read', () => {
  const t = read('workflows', 'ci.yml');
  for (const name of jobNames(t).filter((n) => n !== 'secrets')) assert.ok(!/permissions:/.test(job(t, name)), `the ${name} job must inherit the top-level contents: read`);
  const s = job(t, 'secrets');
  const m = /^ {4}permissions:\n((?: {6}\S.*\n?)+)/m.exec(s);
  assert.ok(m, 'the secrets job needs job-level permissions (gitleaks-action reads PR commits)');
  assert.deepEqual(m[1].trim().split('\n').map((x) => x.trim()).sort(), ['contents: read', 'pull-requests: read']);
});

test('ci.yml: no continue-on-error anywhere, and the coverage floors and include globs stay put', () => {
  for (const f of WF) assert.ok(!/continue-on-error:\s*true/i.test(read('workflows', f)), `${f} lets a failure pass`);
  const t = read('workflows', 'ci.yml');
  const floor = (k) => Number(new RegExp(`--test-coverage-${k}=(\\d+)`).exec(t)?.[1]);
  assert.ok(floor('lines') >= 99 && floor('branches') >= 95 && floor('functions') >= 98, 'coverage floors were lowered or removed');
  assert.ok(t.includes("--test-coverage-include='lib/**'") && t.includes("--test-coverage-include='src/**'"), 'src/** must stay in coverage');
  for (const f of WF) assert.equal((read('workflows', f).match(/--experimental-test-coverage/g) ?? []).length, f === 'ci.yml' ? 1 : 0, `${f}: coverage is measured once, by the unit job`);
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

// The coverage group runs ONCE, with the coverage floors, in the unit job; the other Linux jobs and the mutation run run in parallel with it.
test('ci.yml: the unit job runs the coverage group once with the floors; `npm test` is not run', () => {
  const t = read('workflows', 'ci.yml');
  const j = job(t, 'unit');
  const steps = j.split(/\n {6}- /).slice(1).map((x) => /^name: (.+)\n {8}run: [>|]?\s*([\s\S]*)$/.exec(x)).filter(Boolean).map((m) => [m[1], m[2].replace(/\s+/g, ' ').trim()]);
  assert.equal(steps.length, 1, `one test step: ${JSON.stringify(steps)}`);
  const run = steps[0][1];
  assert.match(run, /^files=\$\(node scripts\/ci-tests\.mjs coverage\) test -n "\$files" (?:# .* )?node --test --experimental-test-coverage .* \$files$/, run);
  assert.ok(!/npm test|npm run mutate|npm run smoke/.test(j), 'npm test would run the suite a second time; the mutation run and smoke belong to their own jobs');
  assert.ok(run.includes("--test-coverage-include='lib/**'") && run.includes("--test-coverage-include='src/**'"));
  for (const { k, min } of [{ k: 'lines', min: 99 }, { k: 'branches', min: 95 }, { k: 'functions', min: 98 }]) {
    assert.ok(Number(new RegExp(`--test-coverage-${k}=(\\d+)`).exec(run)?.[1]) >= min, `${k} floor lowered or missing in the unit test step`);
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts.test, 'node --test test/*.test.mjs', 'local npm test unchanged');
});

test('ci.yml: the mutation job is its own required job, ubuntu only, same Node and uv setup, 15 minute cap, never allowed to fail', () => {
  const t = read('workflows', 'ci.yml');
  const m = job(t, 'mutation');
  assert.match(m, /^ {4}runs-on: ubuntu-24\.04$/m, 'mutation runs on ubuntu only, not the OS matrix');
  assert.ok(!/matrix/.test(m) && !/strategy:/.test(m));
  assert.ok(!/^ {4}needs:/m.test(m), 'it runs in parallel with the test job');
  assert.ok(!/^ {4}if:/m.test(m), 'it always runs');
  assert.match(m, /^ {4}timeout-minutes: 15\b/m);
  assert.match(m, /actions\/setup-node@[0-9a-f]{40}[^\n]*\n\s+with:\n\s+node-version: '24'/);
  assert.match(m, /astral-sh\/setup-uv@[0-9a-f]{40}/);
  assert.match(m, /^ {6}- name: mutation run[^\n]*\n {8}run: npm run mutate$/m, 'a named step runs exactly `npm run mutate`');
  assert.doesNotMatch(m, /npm run mutate\s*(\|\||;|&)/, 'the step result is not swallowed');
  assert.ok(!/permissions:/.test(m), 'the mutation job inherits contents: read');
  assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts.mutate, 'node scripts/mutate.mjs');
});

test('ci.yml: every job has a timeout; concurrency cancels superseded runs but never on main', () => {
  const t = read('workflows', 'ci.yml');
  assert.deepEqual(jobNames(t).filter((n) => !/^ {4}timeout-minutes: \d+\b/m.test(job(t, n))), [], 'a job without a timeout');
  for (const [name, mins] of /** @type {Array<[string, number]>} */ ([['unit', 15], ['slow', 15], ['static', 10], ['macos', 15], ['mutation', 15], ['secrets', 10]])) {
    assert.match(job(t, name), new RegExp(`^ {4}timeout-minutes: ${mins}\\b`, 'm'), `${name} timeout`);
  }
  assert.match(t, /^concurrency:\n {2}group: .+\n {2}cancel-in-progress: \$\{\{ github\.ref != 'refs\/heads\/main' \}\}$/m);
});

test('mutation.yml: the mutation smoke reports without gating, runs weekly and on demand only, and its npm scripts exist', () => {
  const t = read('workflows', 'mutation.yml');
  const on = /^on:\n((?: {2}.*\n)+)/m.exec(t)?.[1] ?? '';
  assert.deepEqual([...on.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]), ['workflow_dispatch', 'schedule'], 'not on every push: the required ci.yml mutation job gates pushes');
  assert.match(on, /cron: '[^']+'/);
  assert.match(t, /^ {4}timeout-minutes: \d+\b/m);
  assert.match(t, /run: npm run mutate:smoke -- --informational$/m);
  const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts;
  assert.match(scripts['mutate:smoke'], /scripts\/mutate-all\.mjs .*--limit 40 --seed 1/);
  assert.match(scripts['mutate:all'], /scripts\/mutate-all\.mjs/);
  assert.ok(!/uses: \.\/\.github\/workflows\/mutation\.yml/.test(read('workflows', 'release.yml')), 'the release must not wait on the informational mutation job');

});
