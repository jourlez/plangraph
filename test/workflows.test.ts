// Static checks of .github/workflows/*.yml, .github/dependabot.yml and .github/CODEOWNERS, read as text (no YAML parser, zero dependencies, no network).
// Covered: every `uses:` pinned to a 40-hex SHA with a version comment (local ./ reusable workflows exempt), top-level permissions are contents: read,
// release adds only the three allowed job permissions, every reusable-workflow caller grants what the called jobs ask for, no
// pull_request_target, persist-credentials: false after every checkout, the parallel CI jobs (unit with the coverage floors, slow, static,
// macos shards, compat, floor, mutation, gitleaks, release dry run) and their steps, the Node, Python and tool-version matrices, the checked
// tool tarballs, the hostile-uv step, the floor assertions, the weekly informational mutation smoke, dependabot covers github-actions, CODEOWNERS
// holds no invented owner.
// NOT covered: that the pinned SHAs exist upstream (needs the network; resolved with `gh api` when written) or that the workflows run on GitHub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const GH = path.join(ROOT, '.github');
const WF = ['ci.yml', 'release.yml', 'mutation.yml'];
const read = (...p: string[]) => fs.readFileSync(path.join(GH, ...p), 'utf8');
const lines = (t: string): string[] => t.split('\n');
const usesLines = (t: string) => lines(t).map((l, i): [number, string] => [i, l]).filter(([, l]) => /^\s*(-\s+)?uses:/.test(l));
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

test('release.yml: the release job adds only the three allowed job permissions; verify grants only what ci.yml asks for', () => {
  const t = read('workflows', 'release.yml');
  assert.deepEqual(Object.entries(jobPermissions(job(t, 'release')) ?? {}).map(([k, v]) => `${k}: ${v}`).sort(), ['attestations: write', 'contents: write', 'id-token: write']);
  assert.deepEqual(jobPermissions(job(t, 'verify')), { contents: 'read', 'pull-requests': 'read' });
  assert.match(t, /tags:\s*\['v\[0-9\]\+\.\[0-9\]\+\.\[0-9\]\+'\]/);
  assert.match(t, /uses: \.\/\.github\/workflows\/ci\.yml/);
});

// A job that calls a reusable workflow caps that workflow's permissions: a called job asking for more than the caller grants fails at
// startup (the whole run is invalid). Checked for every `uses: ./.github/workflows/X.yml` job of every workflow.
test('every reusable-workflow caller grants every permission the called workflow\'s jobs request', () => {
  const rank = (v: string | undefined) => (v === 'write' ? 2 : v === 'read' ? 1 : 0);
  let calls = 0;
  for (const f of WF) {
    const t = read('workflows', f);
    for (const name of jobNames(t)) {
      const m = /^ {4}uses: \.\/\.github\/workflows\/([\w.-]+\.yml)\s*$/m.exec(job(t, name));
      if (!m) continue;
      calls++;
      const granted = jobPermissions(job(t, name)) ?? topPermissions(t);
      const called = read('workflows', m[1]);
      for (const cj of jobNames(called)) {
        for (const [scope, level] of Object.entries(jobPermissions(job(called, cj)) ?? topPermissions(called))) {
          assert.ok(rank(granted[scope]) >= rank(level), `${f} job ${name} calls ${m[1]}: its job ${cj} asks ${scope}: ${level}, the caller grants ${granted[scope] ?? 'none'}`);
        }
      }
    }
  }
  assert.ok(calls >= 1, 'release.yml calls ci.yml: the check is not vacuous');
});

test('ci.yml: the parallel jobs, their commands and gates', () => {
  const t = read('workflows', 'ci.yml');
  assert.match(t, /workflow_call:/);
  assert.deepEqual(jobNames(t), ['unit', 'slow', 'static', 'macos', 'compat', 'floor', 'mutation', 'secrets', 'release-dry-run']);
  assert.deepEqual(jobNames(t).filter((n) => /^ {4}needs:/m.test(job(t, n))), ['release-dry-run'], 'every CI job starts at once but the dry run');
  assert.deepEqual(jobNames(t).filter((n) => /^ {4}if:/m.test(job(t, n))), ['release-dry-run'], 'every other CI job always runs');
  for (const [name, cmds] of ([
    ['unit', ['node scripts/test-coverage.ts --group coverage']],
    ['slow', ['npm run smoke', 'node scripts/ci-tests.ts nocoverage', 'node --test $files', 'astral-sh/setup-uv@']],
    ['static', ['npm run validate:plugin', 'npm ci --ignore-scripts', 'npm run typecheck', 'npm run lint:check', 'npm run knip', 'npm run lint:sh', 'actionlint -shellcheck', 'node scripts/check-package.ts']],
    ['macos', ['node scripts/ci-tests.ts portable', 'npm run smoke']],
    ['compat', ['node scripts/ci-tests.ts portable', 'node --test $files']],
    ['floor', ['node src/entry.js card --if-present --heal']],
    ['release-dry-run', ['git archive', 'sha256sum', 'node scripts/check-package.ts']],
    ['mutation', ['npm run mutate']],
    ['secrets', ['gitleaks/gitleaks-action@']],
  ] as Array<[string, string[]]>)) for (const c of cmds) assert.ok(job(t, name).includes(c), `job ${name} is missing ${c}`);
  for (const name of ['unit', 'slow', 'static', 'compat', 'floor', 'mutation', 'secrets', 'release-dry-run']) assert.match(job(t, name), /^ {4}runs-on: ubuntu-24\.04$/m, `${name} on ubuntu`);
  assert.equal((t.match(/actions\/setup-node@[0-9a-f]{40}[^\n]*\n\s+with:\n\s+node-version: '24'\n/g) ?? []).length, 5, 'slow, static, macos, mutation and the dry run set up Node 24 (unit, compat and floor through a matrix; gitleaks needs none)');
  assert.match(job(t, 'unit'), /^ {8}node: \['24'(?:, '\d+')*\]/m, 'the unit job runs a Node matrix of the floor major');
  assert.match(job(t, 'unit'), /node-version: \$\{\{ matrix\.node \}\}\n/);
  assert.equal(/typecheck skipped|lint skipped|if \[ -f (tsconfig|biome)\.json \]/.test(t), false, 'typecheck and lint always run (their configs are committed)');
  // a step-level condition could hide a check; the only ones run the no-coverage and timing groups on one Python leg, and the macOS smoke once instead of on every shard
  assert.deepEqual([...t.matchAll(/^ {8}if: (.+)$/gm)].map((m) => m[1]), ["matrix.python == '3.14'", "matrix.python == '3.14'", 'matrix.shard == 1']);
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
  assert.match(m, /^ {10}files=\$\(node scripts\/ci-tests\.ts portable\)\n {10}test -n "\$files"$/m);
});

test('ci.yml: the slow job runs the no-coverage group with uv, smoke first, without coverage', () => {
  const t = read('workflows', 'ci.yml');
  const s = job(t, 'slow');
  assert.ok(!/experimental-test-coverage/.test(s));
  assert.ok(s.indexOf('npm run smoke') < s.indexOf('ci-tests.ts nocoverage'), 'smoke first: it builds the solver environment');
  assert.ok(s.indexOf('astral-sh/setup-uv@') < s.indexOf('npm run smoke'), 'uv before anything needs it');
  assert.match(s, /^ {8}if: matrix\.python == '3\.14'\n {8}run: \|\n {10}files=\$\(node scripts\/ci-tests\.ts nocoverage\)\n {10}test -n "\$files"\n(?: {10}#.*\n)? {10}node --test \$files$/m);
});

test('ci.yml: the slow job also runs the timing group alone and serially, after the other groups, on one Python leg', () => {
  const s = job(read('workflows', 'ci.yml'), 'slow');
  assert.ok(s.indexOf('ci-tests.ts nocoverage') < s.indexOf('ci-tests.ts timing'), 'timing runs last');
  assert.match(s, /^ {8}if: matrix\.python == '3\.14'\n {8}run: \|\n {10}files=\$\(node scripts\/ci-tests\.ts timing\)\n {10}test -n "\$files"\n(?: {10}#.*\n)? {10}node --test --test-concurrency=1 \$files$/m);
  assert.ok(!/run: npm ci/.test(s));
});

// unit, macos and compat run test/types.test.ts, which runs tsc from node_modules, so they install the locked dev tools too (lifecycle scripts off).
test('ci.yml: npm ci runs in static, unit, macos and compat only, always with the npm cache (the three test jobs: lockfile-exact, no scripts)', () => {
  const t = read('workflows', 'ci.yml');
  const install = new Set(['static', 'unit', 'macos', 'compat']);
  for (const name of jobNames(t)) {
    const j = job(t, name);
    assert.equal(/^ {8}run: npm ci/m.test(j), install.has(name), `npm ci in ${name}`);
    assert.equal(/^ {10}cache: npm$/m.test(j), install.has(name), `npm cache in ${name}`);
    if (name !== 'static' && install.has(name)) assert.equal([...j.matchAll(/npm ci.*/g)].map((m) => m[0]).join('|'), 'npm ci --ignore-scripts --no-fund', `npm ci in ${name}`);
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
/** names of the jobs under `jobs:` in file order */
/** The `permissions:` block of a job (keys at 6 spaces), or null when the job sets none. */
function jobPermissions(jobText: string): Record<string, string> | null {
  const ls = lines(jobText), i = ls.findIndex((l) => /^ {4}permissions:\s*$/.test(l));
  if (i < 0) return null;
  const out: Record<string, string> = {};
  for (let j = i + 1; j < ls.length && /^ {6}\S/.test(ls[j]); j++) { const [k, v] = ls[j].trim().split(/:\s*/); out[k] = v; }
  return out;
}
/** The top-level `permissions:` block of a workflow (keys at 2 spaces). */
function topPermissions(t: string): Record<string, string> {
  const m = /^permissions:\n((?: {2}\S.*\n)+)/m.exec(t);
  assert.ok(m, 'no top-level permissions');
  return Object.fromEntries(m[1].trim().split('\n').map((l) => l.trim().split(/:\s*/) as [string, string]));
}
function jobNames(t: string): string[] {
  const ls = lines(t); const s = ls.indexOf('jobs:');
  assert.ok(s >= 0, 'no jobs:');
  let e = s + 1; while (e < ls.length && !/^\S/.test(ls[e])) e++;
  return ls.slice(s + 1, e).filter((l) => /^ {2}[A-Za-z0-9_-]+:\s*$/.test(l)).map((l) => l.trim().slice(0, -1));
}
function job(t: string, name: string): string {
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
  const script = fs.readFileSync(path.join(ROOT, 'scripts/test-coverage.ts'), 'utf8');
  const floor = (k: string) => Number(new RegExp(`const ${k} = (\\d+)`).exec(script)?.[1]);
  assert.ok(floor('LINES') >= 99 && floor('BRANCHES') >= 95 && floor('FUNCTIONS') >= 98, 'coverage floors were lowered or removed');
  for (const g of ['lib/**', 'src/**', 'mcp/**']) assert.ok(script.includes(`'${g}'`), `${g} must stay in coverage`);
  assert.ok(!/test-coverage-(lines|branches|functions)=/.test(t), 'the floors live in scripts/test-coverage.ts once, not in ci.yml');
  for (const f of WF) assert.ok(!/--experimental-test-coverage/.test(read('workflows', f)), `${f}: coverage is measured by scripts/test-coverage.ts only`);
  assert.equal((script.match(/--experimental-test-coverage/g) ?? []).length, 1);
  assert.match(job(t, 'unit'), /fetch-depth: 0/, 'the unit job runs the commit-author check, which needs history');
});

test('release.yml: the release job needs verify, checks the tag is on main, and attests a specific subject', () => {
  const t = read('workflows', 'release.yml');
  assert.match(job(t, 'release'), /^ {4}needs: verify$/m);
  assert.match(t, /git merge-base --is-ancestor "\$GITHUB_SHA" origin\/main/);
  const a = /actions\/attest@[^\n]*\n\s+with:\n\s+subject-path:\s*(.+)\n/.exec(t);
  assert.ok(a, 'no attest subject-path');
  const sp = a[1].trim();
  assert.ok(!/^["']?\*+["']?$/.test(sp) && /plangraph-/.test(sp), `attest subject-path too broad: ${sp}`);
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
  const steps = j.split(/\n {6}- /).slice(1).map((x) => /^name: (.+)\n {8}run: [>|]?\s*([\s\S]*)$/.exec(x)).filter(Boolean).map((m) => [(m as RegExpExecArray)[1], (m as RegExpExecArray)[2].replace(/\s+/g, ' ').trim()]);
  assert.equal(steps.length, 2, `the dev-tool install, then one test step: ${JSON.stringify(steps)}`);
  assert.equal(steps[0][1], 'npm ci --ignore-scripts --no-fund', 'the first step installs the locked dev tools (test/types.test.ts runs tsc)');
  const run = steps[1][1];
  assert.equal(run, 'node scripts/test-coverage.ts --group coverage', 'the floors and includes live in scripts/test-coverage.ts, checked in the floors test');
  assert.ok(!/npm test|npm run mutate|npm run smoke/.test(j), 'npm test would run the suite a second time; the mutation run and smoke belong to their own jobs');
  assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts.test, 'node --test $(node scripts/ci-tests.ts nontiming) && node --test --test-concurrency=1 $(node scripts/ci-tests.ts timing)', 'local npm test: the non-timing files, then the timing files serially');
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
  assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts.mutate, 'node scripts/mutate.ts');
});

test('ci.yml: every job has a timeout; concurrency cancels superseded runs but never on main', () => {
  const t = read('workflows', 'ci.yml');
  assert.deepEqual(jobNames(t).filter((n) => !/^ {4}timeout-minutes: \d+\b/m.test(job(t, n))), [], 'a job without a timeout');
  for (const [name, mins] of ([['unit', 15], ['slow', 15], ['static', 10], ['macos', 15], ['compat', 15], ['floor', 5], ['mutation', 15], ['secrets', 10], ['release-dry-run', 10]] as Array<[string, number]>)) {
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
  assert.match(scripts['mutate:smoke'], /scripts\/mutate-all\.ts .*--limit 40 --seed 1/);
  assert.match(scripts['mutate:all'], /scripts\/mutate-all\.ts/);
  assert.ok(!/uses: \.\/\.github\/workflows\/mutation\.yml/.test(read('workflows', 'release.yml')), 'the release must not wait on the informational mutation job');

});

// ------------------------------------------------------------------ Task 20: compat, floor, slow matrix, static tools, dry run, package contents
const CI = read('workflows', 'ci.yml');
const values = (j: string, key: string): string[] => (new RegExp(`^ {8}${key}: \\[([^\\]]*)\\]`, 'm').exec(j)?.[1] ?? '').split(',').map((x) => x.trim().replace(/^'|'$/g, ''));

test('compat: Node 24.15.0 and 26 on ubuntu run the portable group in one step that fails when the redirected warning file is non-empty', () => {
  const j = job(CI, 'compat');
  assert.deepEqual(values(j, 'node'), ['24.15.0', '26']);
  assert.match(j, /^ {4}runs-on: ubuntu-24\.04$/m);
  assert.match(j, /^ {10}NODE_OPTIONS: --redirect-warnings=\$\{\{ runner\.temp \}\}\/w\.log$/m, 'the expression, never a literal $RUNNER_TEMP (a YAML env value is not shell-expanded)');
  assert.ok(!/NODE_OPTIONS:.*\$RUNNER_TEMP/.test(j));
  assert.match(j, /node scripts\/ci-tests\.ts portable/);
  assert.match(j, /if \[ -s "\$RUNNER_TEMP\/w\.log" \]; then[^\n]*exit 1; fi/);
  assert.equal((j.match(/NODE_OPTIONS/g) ?? []).length, 1, 'one step carries the redirect');
  assert.ok(!/RUNTIME_WARNING_ALLOW|--check-warnings/.test(j + fs.readFileSync(path.join(ROOT, 'scripts/ci-tests.ts'), 'utf8')), 'no allow list: any warning fails');
});

test('floor: Node 18, 20.9.0 and 24.14.0 on ubuntu, no npm ci; the hook exits 0, prints at most the one floor line and writes nothing', () => {
  const j = job(CI, 'floor');
  assert.deepEqual(values(j, 'node'), ['18', '20.9.0', '24.14.0']);
  assert.match(j, /^ {4}runs-on: ubuntu-24\.04$/m);
  assert.ok(!/run: npm ci/.test(j));
  assert.match(j, /node src\/entry\.js card --if-present --heal >"\$out" 2>"\$err" \|\| rc=\$\?/);
  for (const c of ['test "$rc" = 0', 'test ! -s "$err"', "grep -Eq '^plangraph: needs Node >= 24\\.15, found v'", 'test -z "$(git status --porcelain)"']) assert.ok(j.includes(c), `floor step lacks ${c}`);
  const hook = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks/hooks.json'), 'utf8')).hooks.SessionStart[0].hooks[0];
  assert.deepEqual(hook.args.map((a: string) => a.replace('${CLAUDE_PLUGIN_ROOT}/', '')), ['src/entry.js', 'card', '--if-present', '--heal'], 'the floor job runs the command and arguments the hook runs');
});

test('slow: Python 3.10 and 3.14 with a pinned uv, the hostile working directory asserts both markers absent, the no-coverage group runs once', () => {
  const j = job(CI, 'slow');
  assert.deepEqual(values(j, 'python'), ['3.10', '3.14']);
  assert.match(j, /^ {6}UV_PYTHON: \$\{\{ matrix\.python \}\}$/m);
  assert.match(j, /astral-sh\/setup-uv@[0-9a-f]{40}[^\n]*\n\s+with:\n\s+version: '\d+\.\d+\.\d+'/, 'uv is pinned');
  const h = j.slice(j.indexOf('hostile working directory'), j.indexOf('no-coverage test group'));
  for (const c of ['PLANGRAPH_SOLVE_LAUNCH: uv-run', '.venv/bin/python', '.python-version', 'uv.toml', 'evil/python3', 'marks"', 'a planted interpreter ran', 'exit 1']) assert.ok(h.includes(c), `hostile step lacks ${c}`);
  assert.ok(j.indexOf('hostile working directory') > j.indexOf('npm run smoke'));
  assert.ok(!/0\.4\.30|PLANGRAPH_TEST_UV_0430/.test(CI), 'the uv 0.4.30 leg is not in CI (the test skips it without the variable)');
});

test('static: shellcheck 0.11.0 and actionlint come from SHA-256-checked tarballs before they are used; actionlint gets -shellcheck with that path; lint:sh runs with the tools required', () => {
  const j = job(CI, 'static');
  const at = (x: string) => { const i = j.indexOf(x); assert.ok(i >= 0, `static lacks ${x}`); return i; };
  const sc = /koalaman\/shellcheck\/releases\/download\/v0\.11\.0\/shellcheck-v0\.11\.0\.linux\.x86_64\.tar\.xz/.exec(j);
  assert.ok(sc, 'shellcheck 0.11.0 tarball');
  assert.match(j, /echo "[0-9a-f]{64} {2}shellcheck\.tar\.xz" \| sha256sum -c -/);
  assert.match(j, /rhysd\/actionlint\/releases\/download\/v\d+\.\d+\.\d+\/actionlint_\d+\.\d+\.\d+_linux_amd64\.tar\.gz/);
  assert.match(j, /echo "[0-9a-f]{64} {2}actionlint\.tar\.gz" \| sha256sum -c -/);
  assert.ok(at('echo "$bin" >> "$GITHUB_PATH"') < at('actionlint -shellcheck "$RUNNER_TEMP/tools/bin/shellcheck"'));
  assert.ok(at('actionlint -shellcheck') < at('npm run lint:sh'));
  assert.match(j, /PLANGRAPH_REQUIRE_TOOLS: '1'\n\s+run: npm run lint:sh/);
  assert.ok(!/setup-uv/.test(j), 'static needs no uv');
  assert.ok(!/bulletproof/.test(j), 'the suite runs in unit and slow, not a third time');
});

test('static: the plugin validator runs through npx at a fixed version with no secrets and no login', () => {
  const j = job(CI, 'static');
  assert.match(j, /^ {8}run: npx --yes @anthropic-ai\/claude-code@\d+\.\d+\.\d+ plugin validate \. --strict$/m);
  const step = j.slice(j.indexOf('claude plugin validate'));
  assert.ok(!/secrets\.|env:/.test(step));
});

test('release-dry-run needs unit and static and runs on pull requests and tags only; it builds the tarball and checks the package contents', () => {
  const j = job(CI, 'release-dry-run');
  assert.match(j, /^ {4}needs: \[unit, static\]$/m);
  assert.match(j, /^ {4}if: github\.event_name == 'pull_request' \|\| startsWith\(github\.ref, 'refs\/tags\/'\)$/m);
  assert.ok(!/ci\/|snapshot/.test(CI.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')), 'no ci/** snapshot trigger');
  assert.match(CI, /^on:\n {2}push:\n {4}branches: \[main\]\n {2}pull_request:\n {2}workflow_call:/m);
});

test('release.yml checks the package contents before the attestation', () => {
  const t = read('workflows', 'release.yml');
  assert.ok(t.indexOf('node scripts/check-package.ts') > 0 && t.indexOf('node scripts/check-package.ts') < t.indexOf('actions/attest@'));
});

test('package.json: lint:sh runs scripts/lint-sh.ts and the validate script runs it after knip', () => {
  const s = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts;
  assert.equal(s['lint:sh'], 'node scripts/lint-sh.ts');
  assert.match(s.validate, /npm run knip && npm run lint:sh && /);
});
