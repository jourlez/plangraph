// scripts/rename-check.ts: the command-word rules, and the check that compares a mapped old tree with the new one.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { check, mapPath, mapText } from '../scripts/rename-check.ts';
import { tmp } from './helpers/cli-fixture.ts';

const W = 'br' + 'ain';

test('mapText: the command word, files, skills, error names and prose', () => {
  const old = `${W}: 3 tickets\ntry: ${W} doctor --fix\nbin/${W}-merge ${W}-solve: x ${W}-solve-run mcp/${W}-mcp.ts\nno ${W} directory: run ${W} init\n`
    + `the ${W} directory, the ${W}'s data, the ${W} is up, use the ${W} skill; the project ${W}\n\`${W}-audit\` skill ${W}-report skill plangraph:${W}-plan plangraph:${W} "${W}-init" (?:${W}|${W}-onboard)\n`
    + `NO_${W.toUpperCase()} NO_${W.toUpperCase()}_MESSAGE ${W[0].toUpperCase()}${W.slice(1)}Error \\\\b${W}\\\\s+(?:init)`;
  assert.equal(mapText(old), 'plangraph: 3 tickets\ntry: plangraph doctor --fix\nbin/plangraph-merge plangraph-solve: x plangraph-solve-run mcp/plangraph-mcp.ts\nno plan directory: run plangraph init\n'
    + 'the plan directory, plangraph\'s data, plangraph is up, use the plangraph skill; plangraph\n`plangraph:audit` skill plangraph:report skill plangraph:plan plangraph:plangraph "init" (?:plangraph|onboard)\n'
    + 'NO_PLANGRAPH NO_PLANGRAPH_MESSAGE PlangraphError \\\\bplangraph\\\\s+(?:init)');
});

test('mapText keeps what the rename keeps', () => {
  const keep = `${W}storming ${W}_rules_version superpowers:${W}storming project-${W}x resolve${W[0].toUpperCase()}${W.slice(1)}Dir ${W}Dir`;
  assert.equal(mapText(keep), keep, 'only the whole word is replaced');
  assert.equal(mapText(`open-${W} project-${W}`), `open-${W} project-${W}`);
});

test('mapPath renames the golden, case and fixture files', () => {
  assert.equal(mapPath(`test/golden/err-no${W}-doctor.txt`), 'test/golden/err-noplangraph-doctor.txt');
  assert.equal(mapPath(`evals/cases/m-trigger-${W}-audit-yes.json`), 'evals/cases/m-trigger-audit-yes.json');
  assert.equal(mapPath(`evals/cases/m-trigger-${W}-yes.json`), 'evals/cases/m-trigger-plangraph-yes.json');
  assert.equal(mapPath(`test/fixtures/evals-p/pilot-a-${W}-127.jsonl`), 'test/fixtures/evals-p/pilot-a-plangraph-127.jsonl');
});

/** A repository with one commit holding old golden files, then the new tree beside it. */
function repo(oldFiles: Record<string, string>, newFiles: Record<string, string>) {
  const d = tmp();
  const git = (...a: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: d, encoding: 'utf8' });
  git('init', '-q');
  for (const [f, t] of Object.entries(oldFiles)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), t); }
  git('add', '-A'); git('commit', '-qm', 'old');
  for (const [f, t] of Object.entries(newFiles)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), t); }
  return d;
}

test('check: equal after mapping passes; a changed byte, a missing file and a deliberate file are told apart', () => {
  const d = repo(
    { 'test/golden/a.txt': `try: ${W} x\n`, 'test/golden/b.txt': `${W}\n`, 'test/golden/c.txt': `${W}\n`, [`test/golden/d-${W}.txt`]: 'd\n', 'src/x.ts': `${W}\n` },
    { 'test/golden/a.txt': 'try: plangraph x\n', 'test/golden/b.txt': 'plangraph \n', 'test/golden/d-plangraph.txt': 'd\n' },
  );
  fs.rmSync(path.join(d, 'test/golden/c.txt')); fs.rmSync(path.join(d, `test/golden/d-${W}.txt`));
  const r = check(d, 'HEAD', { deliberate: { 'test/golden/e.txt': 'recomputed' } });
  assert.deepEqual(r.same.sort(), ['test/golden/a.txt', 'test/golden/d-plangraph.txt']);
  assert.deepEqual(r.differ, ['test/golden/b.txt'], 'one extra space is a difference');
  assert.deepEqual(r.missing, ['test/golden/c.txt'], 'an absent file is reported');
  assert.deepEqual(r.deliberate, []);
  const e = repo({ 'test/golden/e.txt': 'old\n' }, { 'test/golden/e.txt': 'new, by hand\n' });
  assert.deepEqual(check(e, 'HEAD', { deliberate: { 'test/golden/e.txt': 'recomputed' } }).deliberate, ['test/golden/e.txt'], 'a listed file may differ');
  assert.deepEqual(check(e, 'HEAD').differ, ['test/golden/e.txt'], 'and an unlisted one may not');
});

test('check --write regenerates every file but the deliberate ones, and refuses an option as the ref', () => {
  const d = repo({ [`test/golden/a-${W}.txt`]: `${W} a\n`, [`test/golden/b-${W}.txt`]: `${W} b\n` }, {});
  const r = check(d, 'HEAD', { write: true, deliberate: { 'test/golden/b-plangraph.txt': 'kept by hand' } });
  assert.equal(fs.readFileSync(path.join(d, 'test/golden/a-plangraph.txt'), 'utf8'), 'plangraph a\n');
  assert.equal(fs.existsSync(path.join(d, 'test/golden/b-plangraph.txt')), false, 'a deliberate file is not written');
  assert.deepEqual([r.same, r.missing], [['test/golden/a-plangraph.txt'], ['test/golden/b-plangraph.txt']]);
  assert.throws(() => check(d, '--output=x'), /must be a git ref/);
});

test('mapText: the grader alternation of plugin skills becomes the new skill names', () => {
  assert.equal(mapText(`"(?:[\\\\w-]+:)?(?:${W}(?:-[a-z]+)?|whatif)"`), '"(?:[\\\\w-]+:)?(?:plangraph|audit|autopilot|init|onboard|plan|report|whatif)"');
});

test('check: a deliberate JSON key may differ, any other key may not, and the key order must hold', () => {
  const old = JSON.stringify({ a: `${W} 1`, b: `${W} 2`, c: 'same' });
  const mk = (cur: object) => repo({ 'test/golden/mutation-kills/x.json': old }, { 'test/golden/mutation-kills/x.json': JSON.stringify(cur) });
  const want = { 'test/golden/mutation-kills/x.json': { b: 'recomputed' } };
  assert.deepEqual(check(mk({ a: 'plangraph 1', b: 'changed', c: 'same' }), 'HEAD', { deliberate: want }).deliberate, ['test/golden/mutation-kills/x.json']);
  assert.deepEqual(check(mk({ a: 'plangraph 1', b: 'changed', c: 'DIFFERENT' }), 'HEAD', { deliberate: want }).differ, ['test/golden/mutation-kills/x.json']);
  assert.deepEqual(check(mk({ a: `${W} 1`, b: 'changed', c: 'same' }), 'HEAD', { deliberate: want }).differ, ['test/golden/mutation-kills/x.json'], 'an unmapped word in an unlisted key');
  assert.deepEqual(check(mk({ b: 'changed', a: 'plangraph 1', c: 'same' }), 'HEAD', { deliberate: want }).differ, ['test/golden/mutation-kills/x.json'], 'order');
});
