// Splits test/*.test.mjs and test/*.test.ts (both, during the .mjs to .ts migration) into the groups the parallel CI jobs run (.github/workflows/ci.yml), one file per line:
//   coverage    every test file but NO_COVERAGE and the timing files: the unit job runs these with the coverage floors
//   nocoverage  NO_COVERAGE: the slow job runs these without coverage, in parallel with the unit job
//   portable    every test file but the solver one (it needs uv) and the timing files: the macOS job runs these, sharded
//   timing      test/*-timing.test.* : ratio checks between input sizes that read a clock; they run serially (--test-concurrency=1), never in
//               parallel with other files, and `npm test` runs them after everything else (the slow job runs them on one Python leg)
//   nontiming   every other test file (what `npm test` runs first, in parallel)
// A new test file joins the coverage group by default. A file is added to NO_COVERAGE only after measuring that the coverage group alone
// still reaches the same lib/ and src/ coverage (test/ci-tests.test.ts pins the list and the measurement).
// Usage: node scripts/ci-tests.ts coverage|nocoverage|portable|timing|nontiming. Exit 2 on a bad argument.
import fs from 'node:fs';
import path from 'node:path';

/** slow files that reach no lib/ or src/ code the rest of the suite does not: the solver is Python, the icon and evals code lives elsewhere */
export const NO_COVERAGE = Object.freeze([
  'test/solver.test.ts', 'test/icon.test.ts',
  'test/evals-bashwrite.test.ts', 'test/evals-native.test.ts', 'test/evals-real.test.ts', 'test/evals-report.test.ts',
  'test/evals-runp.test.ts', 'test/evals-schema.test.ts',
]);
const SOLVER = 'test/solver.test.ts';

export const TIMING = /^test\/[^/]+-timing\.test\.(mjs|ts)$/;
export type GroupName = 'coverage' | 'nocoverage' | 'portable' | 'timing' | 'nontiming';
export const GROUP_NAMES: readonly GroupName[] = ['coverage', 'nocoverage', 'portable', 'timing', 'nontiming'];

/** Splits test file paths (test/*.test.mjs or .ts) into the groups above; each list is sorted. */
export function groups(files: string[]): Record<GroupName, string[]> {
  const s = [...files].sort();
  const nontiming = s.filter((f) => !TIMING.test(f));
  return {
    coverage: nontiming.filter((f) => !NO_COVERAGE.includes(f)),
    nocoverage: nontiming.filter((f) => NO_COVERAGE.includes(f)),
    portable: nontiming.filter((f) => f !== SOLVER),
    timing: s.filter((f) => TIMING.test(f)),
    nontiming,
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !GROUP_NAMES.includes(args[0] as GroupName)) {
    console.error('usage: node scripts/ci-tests.ts coverage|nocoverage|portable|timing|nontiming');
    process.exit(2);
  }
  const root = path.join(import.meta.dirname, '..');
  const files = fs.readdirSync(path.join(root, 'test')).filter((f) => /\.test\.(mjs|ts)$/.test(f)).map((f) => `test/${f}`);
  const g = groups(files)[args[0] as GroupName]; // args[0] was checked against the group names above
  process.stdout.write(`${g.join('\n')}\n`);
}
