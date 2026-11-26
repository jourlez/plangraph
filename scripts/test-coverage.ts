// Runs the test suite under Node's built-in V8 coverage with the project's floors (the playbook's `test:coverage`).
//   node scripts/test-coverage.ts [--group all|coverage]
//     all       the non-timing files under coverage, then the timing files serially (--test-concurrency=1) without coverage (default; what
//               `npm run test:coverage` runs). The floors, coverage/lcov.info and the per-file floor apply to the non-timing run only.
//     coverage  the files of scripts/ci-tests.ts's coverage group (what the CI `unit` job runs; the slow files that reach no lib/ or src/ code
//               the rest of the suite does not are left to the `slow` job)
// After a passing run the per-file floor (scripts/coverage-floor.ts) applies to every tracked source file under lib, src and mcp.
// Coverage covers lib/**, src/** and mcp/**. The floors live here once. Besides the `spec` reporter on stdout it writes coverage/lcov.info.
// Exit code: the test run's, or 2 on a bad argument or when no test file is found.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { groups } from './ci-tests.ts';
import { belowFloor, formatBelowFloor, FLOOR } from './coverage-floor.ts';

const LINES = 99;
const BRANCHES = 95;
const FUNCTIONS = 98;
const ROOT = path.resolve(import.meta.dirname, '..');
const INCLUDES = ['lib/**', 'src/**', 'mcp/**'];
const LCOV = 'coverage/lcov.info';

/** The `node` arguments of one coverage run over the given test files. */
export function coverageArgs(files: string[]): string[] {
  return [
    '--test', '--experimental-test-coverage',
    ...INCLUDES.map((g) => `--test-coverage-include=${g}`),
    `--test-coverage-lines=${LINES}`, `--test-coverage-branches=${BRANCHES}`, `--test-coverage-functions=${FUNCTIONS}`,
    '--test-reporter=spec', '--test-reporter-destination=stdout',
    '--test-reporter=lcov', `--test-reporter-destination=${LCOV}`,
    ...files,
  ];
}

/** The per-file floor over coverage/lcov.info for every tracked source file under lib, src and mcp; prints the failing files; 0 when none fails. */
function checkPerFileFloor(): number {
  const tracked = execFileSync('git', ['ls-files', 'lib', 'src', 'mcp'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter((f) => /\.(mjs|ts)$/.test(f) || /^src\/[^/]+\.js$/.test(f));
  const rows = belowFloor(fs.readFileSync(path.join(ROOT, LCOV), 'utf8'), FLOOR, tracked, ROOT);
  if (!rows.length) return 0;
  process.stderr.write(`${formatBelowFloor(rows, FLOOR)}\n`);
  return 1;
}

export async function main(argv: string[]): Promise<number> {
  let group = 'all';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--group' && i + 1 < argv.length) group = argv[++i] ?? '';
    else { process.stderr.write('usage: node scripts/test-coverage.ts [--group all|coverage]\n'); return 2; }
  }
  if (group !== 'all' && group !== 'coverage') { process.stderr.write('usage: node scripts/test-coverage.ts [--group all|coverage]\n'); return 2; }
  const all = fs.readdirSync(path.join(ROOT, 'test')).filter((f) => /\.test\.(mjs|ts)$/.test(f)).map((f) => `test/${f}`);
  const g = groups(all);
  const files = group === 'all' ? g.nontiming : g.coverage;
  if (!files.length) { process.stderr.write('test-coverage: no test files found\n'); return 2; }
  fs.mkdirSync(path.join(ROOT, 'coverage'), { recursive: true });
  const r = spawnSync(process.execPath, coverageArgs(files), { cwd: ROOT, stdio: 'inherit' });
  let status = r.status ?? 1;
  if (status === 0) status = checkPerFileFloor();
  if (status !== 0 || group !== 'all' || !g.timing.length) return status;
  // timing files never run in parallel with the rest, and carry no coverage flags
  return spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...g.timing], { cwd: ROOT, stdio: 'inherit' }).status ?? 1;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
