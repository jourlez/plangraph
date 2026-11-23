// Splits test/*.test.mjs into the groups the parallel CI jobs run (.github/workflows/ci.yml), one file per line:
//   coverage    every test file but NO_COVERAGE: the unit job runs these with the coverage floors
//   nocoverage  NO_COVERAGE: the slow job runs these without coverage, in parallel with the unit job
//   portable    every test file but the solver one (it needs uv): the macOS job runs these, sharded
// A new test file joins the coverage group by default. A file is added to NO_COVERAGE only after measuring that the coverage group alone
// still reaches the same lib/ and src/ coverage (test/ci-tests.test.mjs pins the list and the measurement).
// Usage: node scripts/ci-tests.mjs coverage|nocoverage|portable. Exit 2 on a bad argument.
import fs from 'node:fs';
import path from 'node:path';

/** slow files that reach no lib/ or src/ code the rest of the suite does not: the solver is Python, the icon and evals code lives elsewhere */
export const NO_COVERAGE = Object.freeze([
  'test/solver.test.mjs', 'test/icon.test.mjs',
  'test/evals-bashwrite.test.mjs', 'test/evals-native.test.mjs', 'test/evals-real.test.mjs', 'test/evals-report.test.mjs',
  'test/evals-runp.test.mjs', 'test/evals-schema.test.mjs',
]);
const SOLVER = 'test/solver.test.mjs';

/** @param {string[]} files test/*.test.mjs paths @returns {{ coverage: string[], nocoverage: string[], portable: string[] }} */
export function groups(files) {
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
    console.error('usage: node scripts/ci-tests.mjs coverage|nocoverage|portable');
    process.exit(2);
  }
  const root = path.join(import.meta.dirname, '..');
  const files = fs.readdirSync(path.join(root, 'test')).filter((f) => f.endsWith('.test.mjs')).map((f) => `test/${f}`);
  const g = groups(files)[/** @type {'coverage'|'nocoverage'|'portable'} */ (args[0])];
  process.stdout.write(`${g.join('\n')}\n`);
}
