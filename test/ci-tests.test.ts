// Tests for scripts/ci-tests.ts, which splits test/*.test.mjs and test/*.test.ts into the groups the parallel CI jobs run.
// Covered: the coverage and no-coverage groups are disjoint and together are every test file (no test is dropped from CI); the no-coverage
// group is exactly the measured list (a file joins it only by editing this test, after re-measuring that the coverage floors still hold
// without it); every listed file exists; the portable group is every test file but the solver one; a new test file lands in the coverage
// group by default; output is sorted, one file per line; an unknown group exits 2.
// NOT covered: that the floors still hold on the coverage group (the CI unit job enforces them on every run).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { NO_COVERAGE, groups } from '../scripts/ci-tests.ts';

const ROOT = path.join(import.meta.dirname, '..');
const all = fs.readdirSync(path.join(ROOT, 'test')).filter((f) => /\.test\.(mjs|ts)$/.test(f)).map((f) => `test/${f}`).sort();
const run = (args: string[]) => spawnSync(process.execPath, ['scripts/ci-tests.ts', ...args], { cwd: ROOT, encoding: 'utf8' });

test('coverage and no-coverage groups partition every test file', () => {
  const g = groups(all);
  assert.deepEqual([...g.coverage, ...g.nocoverage].sort(), all, 'every test file runs in exactly one of the two Linux jobs');
  assert.equal(new Set([...g.coverage, ...g.nocoverage]).size, all.length, 'disjoint');
  assert.ok(g.coverage.length > all.length / 2);
});

test('the no-coverage group is exactly the measured list, and every entry exists', () => {
  // measured 2026-11-23: the coverage group alone gives lines 99.68, branches 96.04, functions 98.61, the same as the whole suite
  // (99.68 / 96.01 / 98.61): these files reach no lib/ or src/ line, branch or function that the coverage group does not
  assert.deepEqual([...NO_COVERAGE].sort(), [
    'test/evals-bashwrite.test.ts', 'test/evals-native.test.ts', 'test/evals-real.test.ts', 'test/evals-report.test.ts',
    'test/evals-runp.test.ts', 'test/evals-schema.test.ts', 'test/icon.test.ts', 'test/solver.test.ts',
  ]);
  for (const f of NO_COVERAGE) assert.ok(all.includes(f), `stale entry: ${f}`);
});

test('portable is every test file but the solver one (the solver needs uv and runs on Linux only)', () => {
  assert.deepEqual(groups(all).portable, all.filter((f) => f !== 'test/solver.test.ts'));
});

test('a new test file lands in the coverage group by default', () => {
  const g = groups([...all, 'test/zz-new.test.mjs']);
  assert.ok(g.coverage.includes('test/zz-new.test.mjs'));
  assert.ok(g.portable.includes('test/zz-new.test.mjs'));
  assert.ok(!g.nocoverage.includes('test/zz-new.test.mjs'));
});

test('CLI: prints a group one file per line, sorted; an unknown or missing group exits 2', () => {
  for (const name of ['coverage', 'nocoverage', 'portable']) {
    const r = run([name]);
    assert.equal(r.status, 0, r.stderr);
    const ls = r.stdout.trimEnd().split('\n');
    assert.deepEqual(ls, groups(all)[(name as 'coverage'|'nocoverage'|'portable')]); // as: name is one of the three groups
    assert.deepEqual(ls, [...ls].sort());
  }
  for (const bad of [[], ['all'], ['coverage', 'extra']]) {
    const r = run(bad);
    assert.equal(r.status, 2, `args ${JSON.stringify(bad)}`);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /usage/);
  }
});
