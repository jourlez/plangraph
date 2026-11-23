// Splits test/*.test.mjs and test/*.test.ts (both, during the .mjs to .ts migration) into the groups the parallel CI jobs run (.github/workflows/ci.yml), one file per line:
//   coverage    every test file but NO_COVERAGE: the unit job runs these with the coverage floors
//   nocoverage  NO_COVERAGE: the slow job runs these without coverage, in parallel with the unit job
//   portable    every test file but the solver one (it needs uv): the macOS job runs these, sharded
// A new test file joins the coverage group by default. A file is added to NO_COVERAGE only after measuring that the coverage group alone
// still reaches the same lib/ and src/ coverage (test/ci-tests.test.ts pins the list and the measurement).
// Usage: node scripts/ci-tests.ts coverage|nocoverage|portable. Exit 2 on a bad argument.
import fs from 'node:fs';
import path from 'node:path';

/** slow files that reach no lib/ or src/ code the rest of the suite does not: the solver is Python, the icon and evals code lives elsewhere */
export const NO_COVERAGE = Object.freeze([
  'test/solver.test.ts', 'test/icon.test.ts',
  'test/evals-bashwrite.test.ts', 'test/evals-native.test.ts', 'test/evals-real.test.ts', 'test/evals-report.test.ts',
  'test/evals-runp.test.ts', 'test/evals-schema.test.ts',
]);
const SOLVER = 'test/solver.test.ts';

/** @param {string[]} files test/*.test.mjs paths @returns {{ coverage: string[], nocoverage: string[], portable: string[] }} */
export function groups(files: string[]): { coverage: string[]; nocoverage: string[]; portable: string[] } {
  const s = [...files].sort();
  return {
    coverage: s.filter((f) => !NO_COVERAGE.includes(f)),
    nocoverage: s.filter((f) => NO_COVERAGE.includes(f)),
    portable: s.filter((f) => f !== SOLVER),
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !['coverage', 'nocoverage', 'portable'].includes(args[0])) {
    console.error('usage: node scripts/ci-tests.ts coverage|nocoverage|portable');
    process.exit(2);
  }
  const root = path.join(import.meta.dirname, '..');
  const files = fs.readdirSync(path.join(root, 'test')).filter((f) => /\.test\.(mjs|ts)$/.test(f)).map((f) => `test/${f}`);
  const g = groups(files)[args[0] as 'coverage' | 'nocoverage' | 'portable']; // args[0] was checked against the three names above
  process.stdout.write(`${g.join('\n')}\n`);
}
