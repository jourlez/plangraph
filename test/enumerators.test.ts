// Every tool that finds source files by extension must still find them after the .mjs to .ts rename (otherwise it reports green having
// checked nothing). Each enumerator is run for real and must find at least the files it found before the migration, whatever the extension.
// The minimums are the per-directory counts recorded in the commit body of "add differential baseline harness" (215 tracked .mjs files in all:
// evals 13, lib 21, lib/integrations 3, mcp 1, scripts 6, src 9, src/commands 10, test 123 incl. fixtures, test/assure 25, test/helpers 4)
// plus the figures measured on 2026-11-23 for the test-file count (121 test/*.test.mjs) and the files tsc lists (209 outside node_modules).
// Covered: scripts/ci-tests (and the npm test script and CI wiring that make a .test.ts file run), scripts/mutate-all, scripts/typecheck
// (the tsconfig include), the walker of test/packaging, the file list of test/public-clean.
// NOT covered: the mutation tokenizer on TypeScript syntax (a later task of the migration owns it).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { isSource } from '../scripts/mutate-all.ts';
import { isSourceFile, sourceFilesIn } from './helpers/source-files.ts';

const ROOT = path.join(import.meta.dirname, '..');
const MIN = { lib: 21, 'lib/integrations': 3, src: 9, 'src/commands': 10, mcp: 1, scripts: 6, evals: 13, testTop: 121, assure: 25, helpers: 4, tscListed: 209 };
// a nested `node --test` must not inherit the parent runner's reporter channel
const { NODE_TEST_CONTEXT: _ctx, ...CLEAN_ENV } = process.env;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-enum-'));
const rm = (d: string) => fs.rmSync(d, { recursive: true, force: true });
const SRC = /\.(mjs|ts)$|^src\/floor\.js$/;
const countIn = (dir: string) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).filter((e) => e.isFile() && SRC.test(`${dir}/${e.name}`)).length;

test('the minimums hold for the tree itself, whatever the extension', () => {
  for (const d of ['lib', 'lib/integrations', 'src', 'src/commands', 'mcp', 'scripts', 'evals', 'test/assure', 'test/helpers']) {
    assert.ok(countIn(d) >= MIN[((d.replace('test/', '')) as keyof typeof MIN)], `${d}: fewer source files than before the migration`); // as keyof: d is one of the MIN keys
  }
  const nonTest = MIN.lib + MIN['lib/integrations'] + MIN.src + MIN['src/commands'] + MIN.mcp + MIN.scripts + MIN.evals;
  assert.ok(sourceFilesIn(ROOT, ['evals', 'lib', 'mcp', 'scripts', 'src']).length >= nonTest, 'source files outside test/');
});

test('scripts/ci-tests lists every test file of either extension in coverage plus nocoverage, and portable', () => {
  const run = (g: string) => spawnSync(process.execPath, ['scripts/ci-tests.ts', g], { cwd: ROOT, encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
  const cov = run('coverage'), noCov = run('nocoverage'), portable = run('portable');
  assert.ok(cov.length + noCov.length >= MIN.testTop, `coverage + nocoverage list ${cov.length + noCov.length} files`);
  assert.ok(portable.length >= MIN.testTop - 1);
  assert.ok(noCov.length >= 8, 'the no-coverage list is still found');
});

test('a new test/*.test.ts file runs in npm test, in the CI coverage and portable groups, and in the shape the CI jobs call', () => {
  const dir = tmp();
  try {
    fs.mkdirSync(path.join(dir, 'scripts')); fs.mkdirSync(path.join(dir, 'test'));
    fs.copyFileSync(path.join(ROOT, 'scripts/ci-tests.ts'), path.join(dir, 'scripts/ci-tests.ts'));
    fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(dir, 'package.json'));
    fs.writeFileSync(path.join(dir, 'test/zz-probe.test.ts'), "import test from 'node:test';\nconst answer: number = 42;\ntest('zz-probe ran as typescript', () => { if (answer !== 42) throw new Error('no'); });\n");
    fs.writeFileSync(path.join(dir, 'test/zz-old.test.mjs'), "import test from 'node:test';\ntest('zz-old ran as javascript', () => {});\n");
    for (const g of ['coverage', 'portable']) {
      const r = spawnSync(process.execPath, ['scripts/ci-tests.ts', g], { cwd: dir, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(r.stdout.split('\n').filter(Boolean), ['test/zz-old.test.mjs', 'test/zz-probe.test.ts'], g);
    }
    const nc = spawnSync(process.execPath, ['scripts/ci-tests.ts', 'nocoverage'], { cwd: dir, encoding: 'utf8' });
    assert.equal(nc.stdout, '\n', 'a new file is never in the no-coverage group by default');
    // the CI jobs pass the listed files to node --test as plain arguments (workflow text pinned below)
    const files = ['test/zz-old.test.mjs', 'test/zz-probe.test.ts'];
    let r = spawnSync(process.execPath, ['--test', ...files], { cwd: dir, encoding: 'utf8', env: CLEAN_ENV });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /zz-probe ran as typescript/);
    // and `npm test` expands the quoted glob itself
    const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts;
    assert.equal(scripts.test, 'node --test "test/*.test.{mjs,ts}"');
    r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['test', '--ignore-scripts'], { cwd: dir, encoding: 'utf8', env: CLEAN_ENV });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /zz-probe ran as typescript/);
    assert.match(r.stdout, /zz-old ran as javascript/);
  } finally { rm(dir); }
  const ci = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  for (const g of ['nocoverage', 'portable']) assert.match(ci, new RegExp(`node scripts/ci-tests\\.(mjs|ts) ${g}`), `CI job for ${g}`);
  // the coverage group is reached through scripts/test-coverage.ts, which takes it from scripts/ci-tests.ts
  assert.match(ci, /node scripts\/test-coverage\.ts --group coverage/, 'CI job for coverage');
  assert.match(fs.readFileSync(path.join(ROOT, 'scripts/test-coverage.ts'), 'utf8'), /groups\(all\)\.coverage/, 'the script takes the coverage group from ci-tests');
});

test('scripts/mutate-all finds at least the target files it found before (and src/floor.js), and isSource accepts the migration extensions', () => {
  const r = spawnSync(process.execPath, ['scripts/mutate-all.ts', '--list'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 });
  assert.equal(r.status, 0, r.stderr);
  const files = new Set(r.stdout.split('\n').map((l) => /^(\S+?):\d+ \[/.exec(l)?.[1]).filter(Boolean));
  assert.ok(files.size >= MIN.lib + MIN['lib/integrations'] + (MIN.src - 1) + MIN['src/commands'] + MIN.mcp - 1, `mutants found in ${files.size} files`);
  assert.ok(files.has('src/floor.js'), 'the plain-JS floor guard is still a mutation target');
  for (const f of ['lib/x.mjs', 'lib/x.ts', 'src/floor.js', 'test/a.test.ts']) assert.equal(isSource(f), true, f);
  for (const f of ['lib/x.js', 'lib/x.json', 'src/other.js', 'lib/x.mts', 'README.md']) assert.equal(isSource(f), false, f);
});

test('scripts/typecheck: the tsconfig include lists .ts and src/floor.js (no .mjs file is left) and tsc lists at least as many files as before', () => {
  const tsc = path.join(ROOT, 'node_modules/.bin/tsc');
  if (!fs.existsSync(tsc)) return; // dev dependencies not installed (the typecheck script itself exits 2 then)
  const listed = execFileSync(tsc, ['--listFilesOnly', '-p', 'tsconfig.json'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 }).split('\n').filter((f) => f && !f.includes('/node_modules/'));
  assert.ok(listed.length >= MIN.tscListed, `tsc lists ${listed.length} files`);
  const dir = tmp();
  try {
    for (const f of ['lib/a.ts', 'lib/b.mjs', 'src/floor.js', 'test/t.test.ts']) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), 'export const x = 1;\n'); }
    fs.mkdirSync(path.join(dir, 'test/types-fixtures')); fs.writeFileSync(path.join(dir, 'test/types-fixtures/bad.ts'), 'export const y: number = "no";\n');
    fs.copyFileSync(path.join(ROOT, 'tsconfig.json'), path.join(dir, 'tsconfig.json'));
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'));
    const out = execFileSync(tsc, ['--listFilesOnly', '-p', 'tsconfig.json'], { cwd: dir, encoding: 'utf8' }).split('\n').filter((f) => f && !f.includes('/node_modules/')).map((f) => path.relative(fs.realpathSync(dir), fs.realpathSync(f)));
    assert.deepEqual(out.sort(), ['lib/a.ts', 'src/floor.js', 'test/t.test.ts']);
  } finally { rm(dir); }
});

test('test/packaging walker (sourceFilesIn) and test/public-clean file list see .ts and .js files, not only .mjs', () => {
  const dir = tmp();
  try {
    for (const f of ['lib/a.mjs', 'lib/b.ts', 'src/floor.js', 'src/other.js', 'lib/data.json', 'lib/sub/c.ts']) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), '\n'); }
    assert.deepEqual(sourceFilesIn(dir, ['lib', 'src']), ['lib/a.mjs', 'lib/b.ts', 'lib/sub/c.ts', 'src/floor.js', 'src/other.js']);
    assert.equal(isSourceFile('src/commands/x.ts'), true);
    assert.equal(isSourceFile('src/commands/x.js'), false);
  } finally { rm(dir); }
  assert.match(fs.readFileSync(path.join(ROOT, 'test/packaging.test.ts'), 'utf8'), /sourceFilesIn\(root, \['lib', 'src', 'scripts', 'mcp'\]\)/, 'the packaging walker uses the shared helper');
  assert.ok(sourceFilesIn(ROOT, ['lib', 'src', 'scripts', 'mcp']).length >= MIN.lib + MIN['lib/integrations'] + MIN.src + MIN['src/commands'] + MIN.mcp + MIN.scripts);
  // public-clean takes every tracked file (git ls-files, no extension filter): a leak planted in .ts, .js and .mjs files is reported
  const repo = tmp();
  try {
    const git = (a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
    git(['init', '-q']);
    fs.mkdirSync(path.join(repo, 'test'));
    fs.copyFileSync(path.join(ROOT, 'test/public-clean.test.ts'), path.join(repo, 'test/public-clean.test.ts'));
    fs.writeFileSync(path.join(repo, 'package.json'), '{ "type": "module" }\n');
    const leak = `// ${['/Us', 'ers/x'].join('')}\nexport const x = 1;\n`;
    for (const f of ['a.ts', 'b.js', 'c.mjs']) fs.writeFileSync(path.join(repo, f), leak);
    git(['add', '-A']);
    const r = spawnSync(process.execPath, ['--test', 'test/public-clean.test.ts'], { cwd: repo, encoding: 'utf8', env: CLEAN_ENV });
    assert.notEqual(r.status, 0, 'planted leaks must fail the guard');
    for (const f of ['a.ts', 'b.js', 'c.mjs']) assert.ok(r.stdout.includes(`${f}:1 [local-home-path]`), `${f} reported`);
    assert.ok(!r.stdout.includes(['/Us', 'ers/x'].join('')), 'the value is never printed');
  } finally { rm(repo); }
});
