// Unit tests of the whole-library mutation harness (scripts/mutate-all.mjs): tokenizer, mutant generation per operator, what is never
// mutated (comments, JSDoc, regex literals, module specifiers), deterministic selection (seed, limit, shard), option parsing, the
// test mapping derived from imports, and the equivalents allowlist shape.
// NOT covered here: running mutants against tests (spawning node --test per mutant is the long run; `npm run mutate:smoke` exercises it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tokenize, mutantsFor, applyMutant, parseArgs, select, testMap, importsOf, checkEquivalents, isEquivalent, mutantId } from '../scripts/mutate-all.mjs';

const ROOT = path.join(import.meta.dirname, '..');
/** @param {string} src */
const muts = (src) => mutantsFor('x.mjs', src);
/** @param {string} src @param {string} op */
const applied = (src, op) => muts(src).filter((m) => m.op === op).map((m) => applyMutant(src, m));

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
  const src = fs.readFileSync(path.join(ROOT, 'lib/verify.mjs'), 'utf8');
  const a = mutantsFor('lib/verify.mjs', src), b = mutantsFor('lib/verify.mjs', src);
  assert.deepEqual(a.map(mutantId), b.map(mutantId));
  assert.ok(a.length > 100);
  assert.equal(new Set(a.map(mutantId)).size, a.length, 'no duplicate mutants');
  for (const m of a) assert.notEqual(applyMutant(src, m), src, `${m.op} at line ${m.line} is a no-op`);
  for (let k = 1; k < a.length; k++) assert.ok(a[k - 1].start <= a[k].start);
});

test('every target file tokenizes, and no mutant touches a comment or regex token', () => {
  for (const dir of ['lib', 'lib/integrations', 'src', 'src/commands']) {
    for (const f of fs.readdirSync(path.join(ROOT, dir)).filter((x) => x.endsWith('.mjs'))) {
      const rel = `${dir}/${f}`, src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      const frozen = tokenize(src).filter((x) => x.type === 'comment' || x.type === 'regex');
      for (const m of mutantsFor(rel, src)) {
        assert.ok(!frozen.some((x) => m.start < x.end && x.start < m.end && !(m.start <= x.start && m.end >= x.end)), `${rel}:${m.line} ${m.op} cuts into a comment or regex`);
        if (m.op !== 'negate' && m.op !== 'guard' && m.op !== 'throw' && m.op !== 'return') assert.ok(!frozen.some((x) => m.start >= x.start && m.end <= x.end), `${rel}:${m.line} mutates inside a comment or regex`);
      }
    }
  }
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
  for (const [bad, re] of /** @type {Array<[string[], RegExp]>} */ ([[['--shard', '5/4'], /--shard/], [['--shard', '0/4'], /--shard/], [['--limit', '0'], /--limit/],
    [['--limit', '-1'], /--limit/], [['--jobs', '1.5'], /--jobs/], [['--files', ''], /--files/], [['--json'], /--json/], [['--nope'], /unknown option --nope/]])) {
    assert.throws(() => parseArgs(bad), re);
  }
});

test('importsOf and testMap: direct importers are tier 1, transitive and CLI-spawning tests tier 2', () => {
  assert.deepEqual(importsOf("import a from './a.mjs';\nexport { b } from '../b.mjs';\nconst c = await import('./c.mjs');\nimport fs from 'node:fs';"), ['./a.mjs', '../b.mjs', './c.mjs']);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mutate-all-map-'));
  try {
    const w = (/** @type {string} */ f, /** @type {string} */ s) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), s); };
    w('lib/a.mjs', 'export const a = 1;\n');
    w('lib/b.mjs', "import { a } from './a.mjs';\nexport const b = a;\n");
    w('src/cli.mjs', "import { b } from '../lib/b.mjs';\nexport const main = () => b;\n");
    w('bin/brain', "const { main } = await import('../src/cli.mjs');\n");
    w('test/a.test.mjs', "import { a } from '../lib/a.mjs';\n");
    w('test/b.test.mjs', "import { b } from '../lib/b.mjs';\n");
    w('test/cli.test.mjs', "const BIN = path.join(ROOT, 'bin', 'brain');\n");
    w('test/none.test.mjs', "import fs from 'node:fs';\n");
    const m = testMap(dir, ['lib/a.mjs', 'lib/b.mjs', 'src/cli.mjs'], ['test/a.test.mjs', 'test/b.test.mjs', 'test/cli.test.mjs', 'test/none.test.mjs']);
    assert.deepEqual(m.get('lib/a.mjs'), { direct: ['test/a.test.mjs'], extended: ['test/b.test.mjs', 'test/cli.test.mjs'] });
    assert.deepEqual(m.get('lib/b.mjs'), { direct: ['test/b.test.mjs'], extended: ['test/cli.test.mjs'] });
    assert.deepEqual(m.get('src/cli.mjs'), { direct: [], extended: ['test/cli.test.mjs'] });
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
