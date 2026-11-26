// Tests for scripts/ci-tests.ts, which splits test/*.test.mjs and test/*.test.ts into the groups the parallel CI jobs run.
// Covered: the coverage and no-coverage groups are disjoint and together are every test file (no test is dropped from CI); the no-coverage
// group is exactly the measured list (a file joins it only by editing this test, after re-measuring that the coverage floors still hold
// without it); every listed file exists; the portable group is every test file but the solver one; a new test file lands in the coverage
// group by default; output is sorted, one file per line; an unknown group exits 2. Task 21A: the timing files (test/*-timing.test.*) are their
// own group and in no other; only timing files import the clocked helpers of test/helpers/perf.ts; no test file calls the retired budget().
// NOT covered: that the floors still hold on the coverage group (the CI unit job enforces them on every run).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { NO_COVERAGE, groups, GROUP_NAMES } from '../scripts/ci-tests.ts';
import type { GroupName } from '../scripts/ci-tests.ts';

const ROOT = path.join(import.meta.dirname, '..');
const ls = (d: string) => fs.readdirSync(path.join(ROOT, d)).filter((f) => /\.test\.(mjs|ts)$/.test(f)).map((f) => `${d}/${f}`);
const all = [...ls('test'), ...ls('test/differential')].sort();
const run = (args: string[]) => spawnSync(process.execPath, ['scripts/ci-tests.ts', ...args], { cwd: ROOT, encoding: 'utf8' });

test('coverage, no-coverage and timing groups partition every test file', () => {
  const g = groups(all);
  assert.deepEqual([...g.coverage, ...g.nocoverage, ...g.timing].sort(), all, 'every test file runs in exactly one of the three groups');
  assert.equal(new Set([...g.coverage, ...g.nocoverage, ...g.timing]).size, all.length, 'disjoint');
  assert.deepEqual([...g.nontiming, ...g.timing].sort(), all, 'nontiming is every file but the timing ones');
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

test('portable is every test file but the solver one and the timing ones (the solver needs uv and runs on Linux only)', () => {
  assert.deepEqual(groups(all).portable, all.filter((f) => f !== 'test/solver.test.ts' && !f.endsWith('-timing.test.ts')));
});

test('timing tests are their own group and no other group contains them', () => {
  const g = groups(all), timing = all.filter((f) => /-timing\.test\.(mjs|ts)$/.test(f));
  assert.ok(timing.length >= 6, `timing files found: ${timing.length}`);
  assert.deepEqual(g.timing, timing);
  for (const name of ['coverage', 'nocoverage', 'portable', 'nontiming'] as const) for (const f of timing) assert.ok(!g[name].includes(f), `${f} is in ${name}`);
  assert.ok(!NO_COVERAGE.some((f) => timing.includes(f)));
  // a timing file is recognized by its name alone, in the top test directory only
  const x = groups(['test/a-timing.test.ts', 'test/a.test.ts', 'test/helpers/b-timing.test.ts']);
  assert.deepEqual(x.timing, ['test/a-timing.test.ts']); assert.deepEqual(x.coverage, ['test/a.test.ts', 'test/helpers/b-timing.test.ts']);
});

const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');
// this file and test/perf-helper.test.ts (the helper's own test, injected clock) name the helper without using a real clock
const SELF = ['test/ci-tests.test.ts', 'test/perf-helper.test.ts'];
const perfImporters = all.filter((f) => !SELF.includes(f) && /helpers\/perf\.ts/.test(read(f)));

test('every file that imports helpers/perf.ts is a -timing.test.ts file, except files that use only workScaling or builtinWork (deterministic, no clock)', () => {
  assert.ok(perfImporters.length >= 8, `perf importers: ${perfImporters.length}`);
  for (const f of perfImporters) {
    if (/-timing\.test\.(mjs|ts)$/.test(f)) continue;
    const code = read(f);
    assert.ok(!/(?<![A-Za-z])scaling\(|baselineMs|\bratio\(|\bfactor\(/.test(code), `${f} reads a clock through helpers/perf.ts: move it to a -timing.test.ts file`);
    assert.ok(/workScaling|builtinWork/.test(code), `${f} imports helpers/perf.ts but uses nothing from it`);
  }
});

test('timing files read no clock limit and never read node_modules (the slow job runs them without npm ci)', () => {
  for (const f of groups(all).timing) {
    const code = read(f);
    assert.ok(!code.includes('node_modules'), `${f} reads node_modules`);
    assert.ok(!/budget\(/.test(code), `${f} uses an absolute budget`);
  }
});

test('no test file calls budget() from helpers/perf.ts (absolute millisecond bounds are retired)', () => {
  const perf = read('test/helpers/perf.ts');
  assert.ok(!/export (function|const) (budget|baselineMs|ratio)\b/.test(perf), 'helpers/perf.ts exports no absolute-bound helper');
  for (const f of all) {
    const code = read(f);
    if (SELF.includes(f) || !/helpers\/perf/.test(code)) continue;
    assert.ok(!/\bbudget\b/.test(code.replace(/\/\/.*$/gm, '')), `${f} uses budget from helpers/perf.ts`);
  }
});

test('a new test file lands in the coverage group by default', () => {
  const g = groups([...all, 'test/zz-new.test.mjs']);
  assert.ok(g.coverage.includes('test/zz-new.test.mjs'));
  assert.ok(g.portable.includes('test/zz-new.test.mjs'));
  assert.ok(!g.nocoverage.includes('test/zz-new.test.mjs'));
});

test('CLI: prints a group one file per line, sorted; an unknown or missing group exits 2', () => {
  for (const name of GROUP_NAMES) {
    const r = run([name]);
    assert.equal(r.status, 0, r.stderr);
    const ls = r.stdout.trimEnd().split('\n');
    assert.deepEqual(ls, groups(all)[name as GroupName]); // as: name is one of the group names
    assert.deepEqual(ls, [...ls].sort());
  }
  for (const bad of [[], ['all'], ['coverage', 'extra']]) {
    const r = run(bad);
    assert.equal(r.status, 2, `args ${JSON.stringify(bad)}`);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /usage/);
  }
});
