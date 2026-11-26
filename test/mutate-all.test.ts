// Unit tests of the whole-library mutation harness (scripts/mutate-all.ts): tokenizer, mutant generation per operator, what is never
// mutated (comments, JSDoc, regex literals, module specifiers), deterministic selection (seed, limit, shard), option parsing, the
// test mapping derived from imports, and the equivalents allowlist shape.
// NOT covered here: running mutants against tests (spawning node --test per mutant is the long run; `npm run mutate:smoke` exercises it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tokenize, mutantsFor, applyMutant, parseArgs, select, testMap, importsOf, checkEquivalents, isEquivalent, mutantId, isSource, makeCopy, scoreOf, timeoutsOf, tailLines, redReport } from '../scripts/mutate-all.ts';

const ROOT = path.join(import.meta.dirname, '..');
/** @param {string} src */
const muts = (src: string) => mutantsFor('x.mjs', src);
/** @param {string} src @param {string} op */
const applied = (src: string, op: string) => muts(src).filter((m) => m.op === op).map((m) => applyMutant(src, m));

test('tokenize: strings, templates with nested substitutions, comments, regex vs division, numbers', () => {
  const src = "const a = 'x\\'y' + `t${b + `in${c}`}e` / 2; // c\n/* d */ const r = /a\\/[/]b/g.test(s), q = (n) / 2;";
  const t = tokenize(src);
  assert.deepEqual(t.filter((x) => x.type === 'string').map((x) => x.value), ["'x\\'y'"]);
  assert.deepEqual(t.filter((x) => x.type === 'regex').map((x) => x.value), ['/a\\/[/]b/g']);
  assert.deepEqual(t.filter((x) => x.type === 'comment').map((x) => x.value), ['// c', '/* d */']);
  assert.deepEqual(t.filter((x) => x.type === 'template').map((x) => x.value), ['`t${', '`in${', '}`', '}e`']);
  assert.equal(t.filter((x) => x.value === '/').length, 2, 'both divisions are punctuators');
  assert.equal(t.find((x) => x.value === 'const' && x.line === 2)?.nl, true, 'a line break before a comment carries over to the next token');
  assert.throws(() => tokenize("'open"), /unterminated string/);
  assert.throws(() => tokenize('`open'), /unterminated template/);
  assert.throws(() => tokenize('/* open'), /unterminated comment/);
});

test('mutants: each operator produces the documented replacement', () => {
  assert.deepEqual(applied('if (a < b) f();', 'relational'), ['if (a <= b) f();']);
  assert.deepEqual(applied('x = a === b;', 'relational'), ['x = a !== b;']);
  assert.deepEqual(applied('x = a + b * c;', 'arithmetic'), ['x = a - b * c;', 'x = a + b / c;']);
  assert.deepEqual(applied('x = a && !b;', 'logical'), ['x = a || !b;', 'x = a && b;']);
  assert.deepEqual(applied('x = true;', 'boolean'), ['x = false;']);
  assert.deepEqual(applied('if (a > 1) { f(); }', 'negate'), ['if (!(a > 1)) { f(); }']);
  assert.deepEqual(applied('if (!a) { f(); }', 'negate'), [], 'negating !a duplicates removing the !');
  assert.deepEqual(applied('if (!a || b) { f(); }', 'negate'), ['if (!(!a || b)) { f(); }']);
  assert.deepEqual(applied('function f() { return g(1, 2); }', 'return'), ['function f() { return null; }']);
  assert.deepEqual(applied('function f() { return null; }', 'return'), ['function f() { return 0; }']);
  assert.deepEqual(applied("function f() { return 'ab'; }", 'return'), ["function f() { return ''; }"]);
  assert.deepEqual(applied("x = 'ab'; y = '';", 'string'), ["x = ''; y = '';", "x = 'ab'; y = 'mutant';"]);
  assert.deepEqual(applied('x = 7 + 1 + 0x10 + 1.5;', 'number'), ['x = 8 + 1 + 0x10 + 1.5;', 'x = 7 + 0 + 0x10 + 1.5;']);
  assert.deepEqual(applied('if (bad) throw new Error("x");', 'guard'), ['if (false) throw new Error("x");']);
  assert.deepEqual(applied('if (bad) throw new Error("x");', 'throw'), [], 'a guarded throw is covered by the guard mutant');
  assert.deepEqual(applied('function f() { throw new Error("x"); }', 'throw'), ['function f() { ; }']);
  assert.deepEqual(applied('for (;;) { if (a) continue; }', 'guard'), ['for (;;) { if (false) continue; }']);
});

test('mutants: comments, JSDoc, regex literals, module specifiers and use strict are never mutated', () => {
  const src = "'use strict';\nimport * as a from './a.mjs';\nimport './side.mjs';\nexport * from './b.mjs';\n/** @param {number} n a < b */\n// x === y\nconst r = /a+b|c/g;\nconst m = await import('./c.mjs');\n";
  assert.deepEqual(muts(src), []);
});

test('mutants: deterministic order and stable ids; every listed mutant changes the source', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib/verify.ts'), 'utf8');
  const a = mutantsFor('lib/verify.ts', src), b = mutantsFor('lib/verify.ts', src);
  assert.deepEqual(a.map(mutantId), b.map(mutantId));
  assert.ok(a.length > 100);
  assert.equal(new Set(a.map(mutantId)).size, a.length, 'no duplicate mutants');
  for (const m of a) assert.notEqual(applyMutant(src, m), src, `${m.op} at line ${m.line} is a no-op`);
  for (let k = 1; k < a.length; k++) assert.ok(a[k - 1].start <= a[k].start);
});

test('every target file tokenizes, and no mutant touches a comment or regex token', () => {
  let tokenized = 0;
  for (const dir of ['lib', 'lib/integrations', 'src', 'src/commands']) {
    for (const f of fs.readdirSync(path.join(ROOT, dir)).filter((x) => x.endsWith('.ts'))) {
      const rel = `${dir}/${f}`, src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      const toks = tokenize(src);
      assert.ok(toks.length > 0, `${rel}: the tokenizer produced no tokens`);
      const frozen = toks.filter((x) => x.type === 'comment' || x.type === 'regex');
      tokenized++;
      for (const m of mutantsFor(rel, src)) {
        assert.ok(!frozen.some((x) => m.start < x.end && x.start < m.end && !(m.start <= x.start && m.end >= x.end)), `${rel}:${m.line} ${m.op} cuts into a comment or regex`);
        if (m.op !== 'negate' && m.op !== 'guard' && m.op !== 'throw' && m.op !== 'return') assert.ok(!frozen.some((x) => m.start >= x.start && m.end <= x.end), `${rel}:${m.line} mutates inside a comment or regex`);
      }
    }
  }
  assert.ok(tokenized > 0, 'no target file was found, so nothing was tokenized');
});

test('select: seeded sample is reproducible, shards partition the selection', () => {
  const items = Array.from({ length: 100 }, (_, k) => k);
  const base = parseArgs([]);
  const s1 = select(items, { ...base, limit: 10, seed: 7 }), s2 = select(items, { ...base, limit: 10, seed: 7 });
  assert.deepEqual(s1, s2);
  assert.equal(s1.length, 10);
  assert.deepEqual([...s1].sort((a, b) => a - b), s1, 'kept in source order');
  assert.notDeepEqual(select(items, { ...base, limit: 10, seed: 8 }), s1);
  const shards = [1, 2, 3].map((n) => select(items, { ...base, shard: [n, 3] }));
  assert.deepEqual(shards.flat().sort((a, b) => a - b), items);
  assert.equal(shards[0].length, 34);
});

test('parseArgs: options and their errors', () => {
  const o = parseArgs(['--files', 'lib/a.mjs,lib/b.mjs', '--limit', '40', '--seed', '3', '--shard', '2/4', '--jobs', '6', '--fresh', '--informational', '--json', 'out.json']);
  assert.deepEqual(o.files, ['lib/a.mjs', 'lib/b.mjs']);
  assert.deepEqual([o.limit, o.seed, o.shard, o.jobs, o.fresh, o.informational, o.json], [40, 3, [2, 4], 6, true, true, 'out.json']);
  for (const [bad, re] of (([[['--shard', '5/4'], /--shard/], [['--shard', '0/4'], /--shard/], [['--limit', '0'], /--limit/],
    [['--limit', '-1'], /--limit/], [['--jobs', '1.5'], /--jobs/], [['--files', ''], /--files/], [['--json'], /--json/], [['--nope'], /unknown option --nope/]]) as Array<[string[], RegExp]>)) {
    assert.throws(() => parseArgs(bad), re);
  }
});

test('importsOf and testMap: direct importers are tier 1, transitive and CLI-spawning tests tier 2', () => {
  assert.deepEqual(importsOf("import a from './a.mjs';\nexport { b } from '../b.mjs';\nconst c = await import('./c.mjs');\nimport fs from 'node:fs';"), ['./a.mjs', '../b.mjs', './c.mjs']);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mutate-all-map-'));
  try {
    const w = (f: string, s: string) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), s); };
    w('lib/a.mjs', 'export const a = 1;\n');
    w('lib/b.mjs', "import { a } from './a.mjs';\nexport const b = a;\n");
    w('src/cli.ts', "import { b } from '../lib/b.mjs';\nexport const main = () => b;\n");
    w('bin/plangraph', "const { main } = await import('../src/cli.ts');\n");
    w('test/a.test.mjs', "import { a } from '../lib/a.mjs';\n");
    w('test/b.test.mjs', "import { b } from '../lib/b.mjs';\n");
    w('test/cli.test.mjs', "const BIN = path.join(ROOT, 'bin', 'plangraph');\n");
    w('test/none.test.mjs', "import fs from 'node:fs';\n");
    const m = testMap(dir, ['lib/a.mjs', 'lib/b.mjs', 'src/cli.ts'], ['test/a.test.mjs', 'test/b.test.mjs', 'test/cli.test.mjs', 'test/none.test.mjs']);
    assert.deepEqual(m.get('lib/a.mjs'), { direct: ['test/a.test.mjs'], extended: ['test/b.test.mjs', 'test/cli.test.mjs'] });
    assert.deepEqual(m.get('lib/b.mjs'), { direct: ['test/b.test.mjs'], extended: ['test/cli.test.mjs'] });
    assert.deepEqual(m.get('src/cli.ts'), { direct: [], extended: ['test/cli.test.mjs'] });
    w('src/cmd.mjs', "import { b } from '../lib/b.mjs';\nexport const run = () => b;\n");
    w('src/main.mjs', "import { run } from './cmd.mjs';\nexport const main = () => run();\n");
    w('test/cmd.test.mjs', "import { run } from '../src/cmd.mjs';\n");
    w('test/main.test.mjs', "import { main } from '../src/main.mjs';\n");
    const n = testMap(dir, ['src/cmd.mjs', 'lib/b.mjs'], ['test/b.test.mjs', 'test/cmd.test.mjs', 'test/main.test.mjs']);
    assert.deepEqual(n.get('src/cmd.mjs'), { direct: ['test/cmd.test.mjs', 'test/main.test.mjs'], extended: [] }, 'a src module also gets its in-process importers in tier 1');
    assert.deepEqual(n.get('lib/b.mjs'), { direct: ['test/b.test.mjs'], extended: ['test/cmd.test.mjs', 'test/main.test.mjs'] }, 'a lib module keeps only its direct importers in tier 1');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('equivalents allowlist: shape is checked, matching is on file plus original and mutated line text, every entry is justified', () => {
  assert.throws(() => checkEquivalents({}), /JSON array/);
  assert.throws(() => checkEquivalents([{ file: 'a', line: 'b', mutated: 'c' }]), /why/);
  const list = checkEquivalents([{ file: 'x.mjs', line: 'x = a < b;', mutated: 'x = a <= b;', why: 'a and b are never equal here' }]);
  const [m] = muts('x = a < b;');
  assert.equal(isEquivalent(m, list), true);
  assert.equal(isEquivalent({ ...m, file: 'y.mjs' }, list), false);
  const real = checkEquivalents(JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/mutate/equivalent.json'), 'utf8')));
  for (const e of real) assert.ok(e.why.length >= 20 && !e.why.includes('\n'), `${e.file}: a one-line justification is required`);
});

// ---------------------------------------------------------------- runner behaviour (Task 22A)
const run = (cwd: string, args: string[], cmd = process.execPath) => spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 1 << 26 });
/** a tiny git repository holding the runner, one library file and the given test files @param {Record<string, string>} tests */
function fixtureRepo(tests: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mutate-fixture-'));
  const put = (f: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), text); };
  put('scripts/mutate-all.ts', fs.readFileSync(path.join(ROOT, 'scripts/mutate-all.ts'), 'utf8'));
  put('scripts/mutate/equivalent.json', '[]\n');
  put('package.json', '{"type":"module"}\n');
  put('lib/a.ts', 'export const f = (x: number): number => x + 1;\n');
  for (const [f, t] of Object.entries(tests)) put(`test/${f}`, t);
  run(dir, ['init', '-q'], 'git'); run(dir, ['add', '-A'], 'git');
  return dir;
}
const head = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { f } from '../lib/a.ts';\n";

test('isSource accepts src/entry.js, src/merge-entry.js and src/floor.js, still refuses lib/x.js', () => {
  for (const f of ['src/entry.js', 'src/merge-entry.js', 'src/floor.js', 'lib/x.ts']) assert.equal(isSource(f), true, f);
  for (const f of ['lib/x.js', 'src/other.js', 'src/sub/entry.js', 'entry.js']) assert.equal(isSource(f), false, f);
});

test('a red baseline names the failing test file and prints its not-ok block', () => {
  const dir = fixtureRepo({ 'a.test.ts': `${head}test('boom-marker', () => assert.equal(f(1), 99));\n`, 'b.test.ts': `${head}test('fine', () => assert.equal(f(1), 2));\n` });
  try {
    const r = run(dir, ['scripts/mutate-all.ts', '--files', 'lib/a.ts', '--fresh', '--state', path.join(dir, '.state')]);
    assert.match(r.stdout, /RED BASELINE test\/a\.test\.ts/);
    assert.match(r.stdout, /\| not ok 1 - boom-marker/);
    assert.doesNotMatch(r.stdout, /RED BASELINE test\/b\.test\.ts/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('every test file passes in a mutation copy: the copy is a git repository that lists its files and not node_modules', () => {
  const dir = fixtureRepo({ 'g.test.ts': `${head}import { execFileSync } from 'node:child_process';\ntest('git ls-files works', () => {\n  const files = execFileSync('git', ['ls-files'], { cwd: import.meta.dirname + '/..', encoding: 'utf8' }).split('\\n');\n  assert.ok(files.includes('lib/a.ts'));\n  assert.equal(f(1), 2);\n});\n` });
  fs.mkdirSync(path.join(dir, 'node_modules'));
  try {
    const dest = path.join(dir, '.copy');
    makeCopy(dir, ['lib/a.ts', 'test/g.test.ts', 'package.json'], dest);
    const ls = run(dest, ['ls-files'], 'git');
    assert.deepEqual(ls.stdout.split('\n').filter(Boolean).sort(), ['lib/a.ts', 'package.json', 'test/g.test.ts']);
    assert.ok(fs.statSync(path.join(dest, '.git', 'no-hooks')).isDirectory());
    assert.equal(run(dest, ['config', 'core.hooksPath'], 'git').stdout.trim(), path.join(dest, '.git', 'no-hooks'));
    const r = run(dir, ['scripts/mutate-all.ts', '--files', 'lib/a.ts', '--fresh', '--state', path.join(dir, '.state')]);
    assert.doesNotMatch(r.stdout, /RED BASELINE/);
    assert.equal(r.status, 0, r.stdout + r.stderr);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a timeout is not a kill: listed apart and left out of the score', () => {
  const row = { mutants: 10, killed: 6, timeout: 2, equivalent: 0, invalid: 0 };
  assert.equal(scoreOf(row), 75, '6 killed of 8 decided');
  assert.equal(scoreOf({ ...row, killed: 0, timeout: 10 }), 100, 'nothing decided scores like an empty file');
  const ms = [{ file: 'lib/a.ts', line: 3, op: 'relational' }, { file: 'lib/a.ts', line: 4, op: 'return' }];
  assert.deepEqual(timeoutsOf(ms, [{ status: 'killed' }, { status: 'timeout' }]), [{ file: 'lib/a.ts', line: 4, op: 'return' }]);
  assert.deepEqual(timeoutsOf(ms, [{ status: 'killed' }, { status: 'survived' }]), []);
});

test('tailLines and redReport keep the last lines and name the file', () => {
  assert.equal(tailLines('a\nb\nc\n', 2), 'b\nc');
  assert.deepEqual(redReport([['test/x.test.ts', 'not ok 1\n  boom']]), ['RED BASELINE test/x.test.ts: fails on the unmutated copy, left out of the mapping', '  | not ok 1', '  |   boom']);
  assert.match(redReport([['test/y.test.ts', undefined]])[1], /no output kept/);
});
