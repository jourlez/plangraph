// Tests of scripts/repin.ts: whole-token substitution, pin and equivalent re-pinning (survive, unmapped, ambiguous), the literal writer, the token check
// and the CLI exit code, on fixture repositories in a temporary directory.
// NOT covered: the real repository's pins (Task R runs the tool on them and `npm run mutate` proves the re-pinned pins still kill).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { mutantsFor } from '../scripts/mutate-all.ts';
import { applySubst, oddPinRows, repinPin, repinEquivalent, quoteLike, pinRows, writePins, run, significantTokens } from '../scripts/repin.ts';

const S: Array<[string, string]> = [['brain', 'plangraph'], ['BRAIN_', 'PLANGRAPH_'], ['project-brain', 'plangraph']];

test('applySubst replaces whole tokens only and never inside brainstorm', () => {
  assert.equal(applySubst('brain.x(brain)', S), 'plangraph.x(plangraph)');
  assert.equal(applySubst('brainstorm brain_rules_version rebrain Brain', S), 'brainstorm brain_rules_version rebrain Brain');
  assert.equal(applySubst('superpowers:brainstorming', S), 'superpowers:brainstorming');
});

test('applySubst takes the longest old name first and treats a trailing underscore as a prefix', () => {
  assert.equal(applySubst('~/.config/project-brain/x', S), '~/.config/plangraph/x');
  assert.equal(applySubst('process.env.BRAIN_DIR', S), 'process.env.PLANGRAPH_DIR');
  assert.equal(applySubst('a-brain-b', S), 'a-plangraph-b');
});

test('a pin that survives a substitution maps, and its replacement follows', () => {
  const before = 'const a = 1;\nif (brain.n < 3) go();\n';
  const after = 'const a = 1;\nif (plangraph.n < 3) go();\n';
  const v = repinPin(['lib/a.ts', 'if (brain.n < 3)', 'if (brain.n <= 3)', ['test/brain.test.ts']], before, after, S);
  assert.deepEqual(v, { status: 'mapped', value: ['lib/a.ts', 'if (plangraph.n < 3)', 'if (plangraph.n <= 3)', ['test/plangraph.test.ts']] });
});

test('a pin whose substituted text is gone is unmapped', () => {
  const before = 'if (brain.n < 3) go();\n';
  const v = repinPin(['lib/a.ts', 'if (brain.n < 3)', 'x', []], before, 'if (plangraph.n <= 3) go();\n', S);
  assert.equal(v.status, 'unmapped');
  assert.equal(repinPin(['lib/a.ts', 'if (brain.n < 3)', 'x', []], before, null, S).status, 'unmapped');
});

test('a pin that becomes ambiguous after the substitution is reported, not guessed', () => {
  const before = 'f(brain.x());\nf(plangraph.x());\n';
  const after = 'f(plangraph.x());\nf(plangraph.x());\n';
  const v = repinPin(['lib/a.ts', 'f(brain.x());', 'f(0);', []], before, after, S);
  assert.equal(v.status, 'ambiguous');
});

test('a pin that was not unique in the old file is unmapped', () => {
  assert.equal(repinPin(['lib/a.ts', 'x', 'y', []], 'x x', 'x x', []).status, 'unmapped');
});

const SRC = (name: string) => `export const ok = (${name}: number) => ${name} < 3;\nexport const other = (${name}: number) => ${name} < 4;\n`;

test('an equivalent maps when line and mutated match exactly one generated mutant', () => {
  const before = SRC('brain');
  const m = mutantsFor('lib/a.ts', before).find((x) => x.lineText.endsWith('brain < 3;') && x.mutatedLine.includes('<='));
  assert.ok(m, 'fixture must generate a <= mutant');
  const after = SRC('plangraph');
  const v = repinEquivalent({ file: 'lib/a.ts', line: m.lineText, mutated: m.mutatedLine, why: 'because' }, after, S);
  assert.equal(v.status, 'mapped');
  if (v.status === 'mapped') {
    assert.equal(v.value.line, m.lineText.replace('brain', 'plangraph').replace('brain', 'plangraph'));
    assert.equal(v.value.why, 'because');
  }
});

test('after substitution, an equivalent whose line collapses with another line is ambiguous', () => {
  const before = 'export const a = (brain: number) => brain < 3;\nexport const a = (plangraph: number) => plangraph < 3;\n';
  const after = 'export const a = (plangraph: number) => plangraph < 3;\nexport const a = (plangraph: number) => plangraph < 3;\n';
  const m = mutantsFor('lib/a.ts', before).find((x) => x.lineText.includes('(brain: number)') && x.mutatedLine.includes('<='));
  assert.ok(m);
  const e = { file: 'lib/a.ts', line: m.lineText, mutated: m.mutatedLine, why: 'w' };
  assert.equal(repinEquivalent(e, before, []).status, 'mapped', 'unique before the substitution');
  assert.equal(repinEquivalent(e, after, S).status, 'ambiguous');
});

test('an equivalent whose line is present but whose mutated text matches no mutant is unmapped', () => {
  const src = SRC('x');
  const m = mutantsFor('lib/a.ts', src)[0];
  const v = repinEquivalent({ file: 'lib/a.ts', line: m.lineText, mutated: `${m.mutatedLine} // nothing generates this`, why: 'w' }, src, []);
  assert.equal(v.status, 'unmapped');
});

test('a pin whose replacement equals its text after substitution is reported', () => {
  const v = repinPin(['lib/a.ts', 'brain.x()', 'plangraph.x()', []], 'brain.x()\n', 'plangraph.x()\n', S);
  assert.equal(v.status, 'unmapped');
});

test('a pin with whole-token old names (a path, an env name, a dot directory) survives the two substitutions end to end', () => {
  const src = "const s = 'bin/brain-solve'; const d = process.env.BRAIN_DIR ?? '.brain/'; const k = 'brain_rules_version'; // brainstorm\n";
  const v = repinPin(['lib/a.ts', "process.env.BRAIN_DIR ?? '.brain/'", "process.env.BRAIN_DIR ?? '.brain/x'", []], src, applySubst(src, [['brain', 'plangraph'], ['BRAIN_', 'PLANGRAPH_']]), [['brain', 'plangraph'], ['BRAIN_', 'PLANGRAPH_']]);
  assert.deepEqual(v, { status: 'mapped', value: ['lib/a.ts', "process.env.PLANGRAPH_DIR ?? '.plangraph/'", "process.env.PLANGRAPH_DIR ?? '.plangraph/x'", []] });
  const d = fixtureWith(src, "['lib/a.ts', \"process.env.BRAIN_DIR ?? '.brain/'\", \"process.env.BRAIN_DIR ?? '.brain/x'\", ['test/a.test.ts']]");
  try {
    fs.writeFileSync(path.join(d, 'lib/a.ts'), applySubst(src, [['brain', 'plangraph'], ['BRAIN_', 'PLANGRAPH_']]));
    const r = run(['--before', 'HEAD', '--subst', 'brain=plangraph', '--subst', 'BRAIN_=PLANGRAPH_', '--write'], d);
    assert.deepEqual([r.mapped, r.unmapped, r.ambiguous], [1, 0, 0], r.problems.join('\n'));
    const m = fs.readFileSync(path.join(d, 'scripts/mutate.ts'), 'utf8');
    assert.ok(m.includes("process.env.PLANGRAPH_DIR ?? '.plangraph/'") && m.includes("'.plangraph/x'"), m);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('pin-like rows with a non-string cell are counted and make the run fail', () => {
  assert.equal(oddPinRows("const X = [\n  ['lib/a.ts', 'a', 'b', []],\n  ['lib/a.ts', 'a' + 'b', 'c', []],\n  ['lib/a.ts', 'a', `t`, []],\n];\n"), 2);
  assert.equal(oddPinRows("const X = [['lib/a.ts', 'a', 'b', []]];\n"), 0);
  const d = fixtureWith('x\n', "['lib/a.ts', 'x' + 'y', 'z', []]");
  try {
    const r = run(['--before', 'HEAD'], d);
    assert.equal(r.unmapped, 1);
    assert.match(r.problems.join('\n'), /non-string-literal/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('an equivalent whose line is gone is unmapped', () => {
  assert.equal(repinEquivalent({ file: 'lib/a.ts', line: 'gone', mutated: 'gone2', why: 'w' }, SRC('x'), []).status, 'unmapped');
});

test('quoteLike keeps the quote, switches when the value holds it, and escapes round-trip', () => {
  for (const v of ["a'b", 'a"b', "a'b\"c", 'x\ny\\z\0', '`t`']) {
    for (const like of ["'x'", '"x"']) {
      const lit = quoteLike(v, like);
      assert.equal(new Function(`return ${lit}`)(), v, lit);
    }
  }
  assert.equal(quoteLike('abc', '"x"'), '"abc"');
});

const MUT = `const M = 'test/m.test.ts';
const MUTATIONS = [
  ['lib/a.ts', 'if (brain.n < 3)', 'if (brain.n <= 3)', [M, 'test/brain.test.ts']],
  ['lib/a.ts', ".join('\\\\x00');", ".join('|');", ['test/a.test.ts']],
];
`;

test('pinRows reads the literals and writePins edits only the pin literals', () => {
  const rows = pinRows(MUT);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1].pin, ['lib/a.ts', ".join('\\x00');", ".join('|');", ['test/a.test.ts']]);
  const out = writePins(MUT, [['lib/a.ts', 'if (plangraph.n < 3)', 'if (plangraph.n <= 3)', ['test/plangraph.test.ts']], null]);
  assert.equal(out, MUT.replace('if (brain.n < 3)', 'if (plangraph.n < 3)').replace('if (brain.n <= 3)', 'if (plangraph.n <= 3)').replace("'test/brain.test.ts'", "'test/plangraph.test.ts'"));
  assert.throws(() => writePins(MUT, [null]), /pin rows/);
});

test('significantTokens ignores comments and layout', () => {
  assert.deepEqual(significantTokens('f(a, b); // c'), significantTokens('f(a,\n b);/* d */'));
  assert.notDeepEqual(significantTokens('a.b'), significantTokens("a['b']"));
});

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd, encoding: 'utf8' });
function fixture(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'repin-'));
  git(d, 'init', '-q');
  fs.mkdirSync(path.join(d, 'lib')); fs.mkdirSync(path.join(d, 'scripts/mutate'), { recursive: true });
  fs.writeFileSync(path.join(d, 'lib/a.ts'), SRC('brain'));
  fs.writeFileSync(path.join(d, 'scripts/mutate.ts'), `const MUTATIONS = [\n  ['lib/a.ts', 'brain < 3;', 'brain <= 3;', ['test/a.test.ts']],\n];\n`);
  const m = mutantsFor('lib/a.ts', SRC('brain')).find((x) => x.lineText.endsWith('brain < 4;') && x.mutatedLine.includes('<='));
  assert.ok(m);
  fs.writeFileSync(path.join(d, 'scripts/mutate/equivalent.json'), `${JSON.stringify([{ file: 'lib/a.ts', line: m.lineText, mutated: m.mutatedLine, why: 'w' }], null, 2)}\n`);
  git(d, 'add', '-A'); git(d, 'commit', '-q', '-m', 'one');
  return d;
}
function fixtureWith(libSrc: string, row: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'repin-'));
  git(d, 'init', '-q');
  fs.mkdirSync(path.join(d, 'lib')); fs.mkdirSync(path.join(d, 'scripts/mutate'), { recursive: true });
  fs.writeFileSync(path.join(d, 'lib/a.ts'), libSrc);
  fs.writeFileSync(path.join(d, 'scripts/mutate.ts'), `const MUTATIONS = [\n  ${row},\n];\n`);
  fs.writeFileSync(path.join(d, 'scripts/mutate/equivalent.json'), '[]\n');
  git(d, 'add', '-A'); git(d, 'commit', '-q', '-m', 'one');
  return d;
}
const sub = (d: string) => fs.writeFileSync(path.join(d, 'lib/a.ts'), SRC('plangraph'));

test('run maps pins and equivalents across a substitution; --write emits the literals and two-space JSON with a newline', () => {
  const d = fixture(); sub(d);
  try {
    const dry = run(['--before', 'HEAD', '--subst', 'brain=plangraph'], d);
    assert.deepEqual([dry.mapped, dry.unmapped, dry.ambiguous, dry.tokenMismatch], [2, 0, 0, 0]);
    assert.ok(fs.readFileSync(path.join(d, 'scripts/mutate.ts'), 'utf8').includes('brain < 3;'), 'no --write: nothing changes');
    run(['--before', 'HEAD', '--subst', 'brain=plangraph', '--write'], d);
    assert.ok(fs.readFileSync(path.join(d, 'scripts/mutate.ts'), 'utf8').includes("['lib/a.ts', 'plangraph < 3;', 'plangraph <= 3;'"));
    const j = fs.readFileSync(path.join(d, 'scripts/mutate/equivalent.json'), 'utf8');
    assert.ok(j.endsWith('}\n]\n') && j.includes('\n  {\n    "file"'), j);
    assert.ok(j.includes('plangraph < 4;'));
    git(d, 'add', '-A'); git(d, 'commit', '-q', '-m', 'two');
    const again = run(['--before', 'HEAD'], d);
    assert.equal(again.mapped, 2, 'the written pins hold against the working tree');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('without a substitution a text edit under a pin is unmapped and nothing is written', () => {
  const d = fixture(); sub(d);
  try {
    const before = fs.readFileSync(path.join(d, 'scripts/mutate.ts'), 'utf8');
    const r = run(['--before', 'HEAD', '--write'], d);
    assert.equal(r.unmapped, 2);
    assert.equal(fs.readFileSync(path.join(d, 'scripts/mutate.ts'), 'utf8'), before);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('--check-tokens reports a changed token and passes a pure substitution', () => {
  const d = fixture(); sub(d);
  try {
    assert.equal(run(['--before', 'HEAD', '--subst', 'brain=plangraph', '--check-tokens', '--only', 'lib/*'], d).tokenMismatch, 0);
    fs.writeFileSync(path.join(d, 'lib/a.ts'), SRC('plangraph').replace('< 3', '< 5'));
    const r = run(['--before', 'HEAD', '--subst', 'brain=plangraph', '--check-tokens', '--only', 'lib/*'], d);
    assert.equal(r.tokenMismatch, 1);
    assert.deepEqual(r.problems.filter((p) => p.startsWith('token-mismatch')), ['token-mismatch: lib/a.ts']);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('--only limits the files compared and re-pinned', () => {
  const d = fixture(); sub(d);
  try {
    const r = run(['--before', 'HEAD', '--only', 'lib/other/*'], d);
    assert.deepEqual([r.mapped, r.unmapped], [0, 0]);
    assert.equal(run(['--before', 'HEAD', '--only', 'lib/*', '--subst', 'brain=plangraph'], d).mapped, 2);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('the CLI exits 1 and names the pin on an unmapped pin, 0 when all map, 2 on bad arguments', () => {
  const d = fixture(); sub(d);
  const cli = (...a: string[]) => spawnSync(process.execPath, [path.join(import.meta.dirname, '../scripts/repin.ts'), '--root', d, ...a], { encoding: 'utf8' });
  try {
    const bad = cli('--before', 'HEAD');
    assert.equal(bad.status, 1, bad.stderr);
    assert.match(bad.stdout, /unmapped: .*lib\/a\.ts/);
    assert.match(bad.stdout, /unmapped: 2/);
    const ok = cli('--before', 'HEAD', '--subst', 'brain=plangraph');
    assert.equal(ok.status, 0, ok.stdout);
    assert.match(ok.stdout, /mapped: 2\nunmapped: 0\ntoken-mismatch: 0\nambiguous: 0/);
    assert.equal(spawnSync(process.execPath, [path.join(import.meta.dirname, '../scripts/repin.ts')], { encoding: 'utf8' }).status, 2);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('the CLI reports an ambiguous pin as `ambiguous: 1` and exits 1; a --before starting with a dash exits 2', () => {
  const d = fixtureWith('f(brain.x());\nf(plangraph.x());\n', "['lib/a.ts', 'f(brain.x());', 'f(0);', []]");
  fs.writeFileSync(path.join(d, 'lib/a.ts'), 'f(plangraph.x());\nf(plangraph.x());\n');
  const cli = (...a: string[]) => spawnSync(process.execPath, [path.join(import.meta.dirname, '../scripts/repin.ts'), '--root', d, ...a], { encoding: 'utf8' });
  try {
    const r = cli('--before', 'HEAD', '--subst', 'brain=plangraph');
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /ambiguous: 1\n/);
    assert.match(r.stdout, /unmapped: 0\n/);
    const dash = cli('--before', '--output=x');
    assert.equal(dash.status, 2);
    assert.match(dash.stderr, /git ref/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
