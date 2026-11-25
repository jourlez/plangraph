import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkRef, checkRepoPath, compileHeading, makeGit } from '../lib/gitsafe.ts';
import { rng } from './fixtures/gen.ts';
import { budget, scaling, workScaling } from './helpers/perf.ts';

test('checkRef rejects option-shaped and traversal refs, accepts normal refs', () => {
  for (const bad of ['--output=/tmp/x', '-x', '--upload-pack=sh', 'a..b', '', ' HEAD', 'a b', 'ref\n', 'x:y/../z']) assert.throws(() => checkRef(bad), TypeError, bad);
  for (const ok of ['HEAD', 'origin/dev', 'HEAD~2', 'v1.2.3', 'abc1234', 'refs/heads/feature/x-1', 'main@{1}']) assert.equal(checkRef(ok), ok);
});
test('checkRepoPath rejects absolute, dot-dot and option-shaped paths', () => {
  for (const bad of ['/etc/passwd', '../x', 'a/../../b', '-rf', 'a\0b']) assert.throws(() => checkRepoPath(bad), TypeError, bad);
  assert.equal(checkRepoPath('docs/plan.md'), 'docs/plan.md');
});
test('compileHeading: default template matches level 2 and 3 task headings by exact id', () => {
  const h = compileHeading('^#{2,3} Task {id}:');
  const text = '# t\n\n### Task 12: a\nbody\n\n## Task 1: b\nx\n';
  const span = (id: string) => { const r = h.find(text, id); return r && text.slice(r.start, r.end); };
  assert.equal(span('12'), '### Task 12:'); assert.equal(span('1'), '## Task 1:');
  assert.equal(h.find(text, '2'), null, 'id 2 must not match 12');
});
test('compileHeading rejects regex features (ReDoS) and long templates, never hangs', () => {
  for (const bad of ['^(a+)+{id}$', '^.*{id}', '^a{id}|b', '^[a-z]+{id}', 'x'.repeat(201), '^no placeholder']) assert.throws(() => compileHeading(bad), TypeError, bad);
  for (const bad of ['^(x{id}', '^x{id}[', '^x{id}+', '^x{id}*', '^x{id}|y', '^x{id}?', '^x{id}\\']) assert.throws(() => compileHeading(bad), TypeError, bad);
});
test('compileHeading: the id is matched literally (dot, dash and underscore are not wildcards)', () => {
  const h = compileHeading('^#{2,3} Task {id}:');
  assert.deepEqual(h.find('### Task 1.2:', '1.2'), { start: 0, end: 13 });
  assert.equal(h.find('### Task 1x2:', '1.2'), null);
  assert.equal(h.find('### Task a-b:', 'a-b') !== null, true); assert.equal(h.find('### Task axb:', 'a-b'), null); assert.equal(h.find('### Task axb:', 'a_b'), null);
});
test('compileHeading: templates that would make RegExp throw are rejected with TypeError', () => {
  for (const bad of ['^Task {id})', '#{3,2}{id}', '#{0,0}{id}x)', '#{99,10}{id}']) assert.throws(() => compileHeading(bad), TypeError, bad);
});
test('compileHeading: any template over the allowed alphabet either throws TypeError or find() never throws and never hangs (2000 seeded templates)', () => {
  const alpha = ['^', '#', '#{2,3}', '#{3,2}', '#{0}', '#{1,}', '{', '}', '{id}', ' ', ':', '.', '-', '_', ')', '(', 'a', 'Task ', '9', '#{5,5}', '#{10,2}', '#{1,99}', '#{2}', '#{a,b}', '#{1,2}', '#{12,34}'];
  const quant = ['#{a,b}', '#{1,2}', '#{2,3}', '#{3}', '#{0,99}', '#{10,2}', '#{1,}', '#{,2}'];
  const r = rng(20240607), rnd = (n: number) => Math.floor(r() * n);
  const t0 = Date.now(); let compiled = 0, rejected = 0;
  for (let k = 0; k < 2000; k++) {
    let t = ''; const len = 1 + rnd(8);
    for (let i = 0; i < len; i++) t += k % 3 === 0 ? (rnd(3) === 0 ? quant[rnd(quant.length)] : alpha[rnd(alpha.length)]) : alpha[rnd(alpha.length)];
    const pos = rnd(4); // {id} at the start, middle, end, or not inserted (random alphabet may add one)
    if (pos === 0) t = '{id}' + t; else if (pos === 1) t = t.slice(0, rnd(t.length + 1)) + '{id}' + t.slice(rnd(t.length + 1)); else if (pos === 2) t += '{id}';
    let h: ReturnType<typeof compileHeading>; try { h = compileHeading(t); } catch (e) { assert.ok(e instanceof TypeError, `${t}: ${e}`); rejected++; continue; }
    compiled++;
    assert.doesNotThrow(() => { h.find('## Task 1: x\n', '1'); h.find('#'.repeat(5000) + 'x', '1.2-3_4'); h.nextIndex('x'); h.nextIndex('#'.repeat(5000)); }, t);
  }
  assert.ok(Date.now() - t0 < budget(2000), `fuzz took ${Date.now() - t0} ms`);
  assert.ok(compiled > 50 && rejected > 50, `fuzz must exercise both outcomes (compiled ${compiled}, rejected ${rejected})`);
});
test('compileHeading: at most one variable #{a,b} repetition (two adjacent ones backtrack: about 2 s per 1000 # with three of them)', () => {
  for (const bad of ['#{1,99}#{1,99} {id}', '#{1,99}#{1,99}#{1,99} {id}', '#{0,9}a#{2,3} {id}', '^#{2,3}#{1,2} Task {id}:']) assert.throws(() => compileHeading(bad), (/** @type {any} */ e) => e instanceof TypeError && /one #\{a,b\}/.test(e.message), bad);
  for (const ok of ['^#{2,3} Task {id}:', '#{3}#{1,99} {id}', '#{2}#{3}x{id}', '#{1,99}#### {id}', '#{5,5}#{1,2} {id}']) assert.doesNotThrow(() => compileHeading(ok), ok);
  const worst = compileHeading('#{1,99}#### {id}'), t0 = performance.now();
  worst.find(`${'#'.repeat(1 << 20)}x`, '1'); worst.nextIndex(`${'#'.repeat(1 << 20)}x`);
  assert.ok(performance.now() - t0 < budget(3000), `1 MiB of # against the worst allowed template took ${(performance.now() - t0).toFixed(0)} ms`);
});
// Size axis: find() and nextIndex() over hostile plan text of n and 4n characters (min of 3 each): linear gives about 4x, quadratic about 16x.
// Proved by a deliberately quadratic nextIndex (a search from every offset), which scripts/mutate.ts keeps applying.
test('compileHeading: find and nextIndex scale linearly with the text (n vs 4n, worst allowed templates, hostile texts)', () => {
  const hs = ['^#{2,3} Task {id}:', '#{0,99} {id}', '#{1,99}#### x{id}', 'Task {id}:', '{id}'].map((t) => compileHeading(t));
  const texts = [(n: number) => `${'#'.repeat(n)}x`, (n: number) => '## Task 1.\n'.repeat(Math.ceil(n / 11)), (n: number) => `${'#'.repeat(98)} `.repeat(Math.ceil(n / 99))];
  const s = scaling((n: number) => { for (const mk of texts) { const t = mk(n); for (const h of hs) { h.find(t, '1.2'); h.nextIndex(t); } } }, 40000) as NonNullable<ReturnType<typeof scaling>>; // scaling runs at least one attempt, so its best result is set
  assert.ok(s.ratio < s.maxRatio, `compileHeading scaling ratio ${s.ratio.toFixed(1)} (${s.small.toFixed(1)} ms at n, ${s.large.toFixed(1)} ms at 4n; linear ~4, quadratic ~16)`);
});
// The same size axis without a clock (test/helpers/perf.ts workScaling): the elements the Array and String built-ins touch, n vs 4n
// characters. Deterministic on every machine; the deliberately quadratic nextIndex in scripts/mutate.ts runs an indexOf from every offset.
test('compileHeading: find and nextIndex touch linearly many characters in the text (n vs 4n, built-in work count, no clock)', async () => {
  const hs = ['^#{2,3} Task {id}:', '#{0,99} {id}', '#{1,99}#### x{id}', 'Task {id}:', '{id}'].map((t) => compileHeading(t));
  const texts = [(n: number) => `${'#'.repeat(n)}x`, (n: number) => '## Task 1.\n'.repeat(Math.ceil(n / 11)), (n: number) => `${'#'.repeat(98)} `.repeat(Math.ceil(n / 99))];
  const s = await workScaling((n: number) => { for (const mk of texts) { const t = mk(n); for (const h of hs) { h.find(t, '1.2'); h.nextIndex(t); } } }, 40000);
  assert.ok(s.ratio < s.maxRatio, `compileHeading work ratio ${s.ratio.toFixed(2)} (${s.small} at n, ${s.large} at 4n; linear ~4, quadratic ~16)`);
});
test('makeGit pins LC_ALL=C and disables prompts for the git child, whatever the caller locale', () => {
  const dir = fs.mkdtempSync(path.join(process.env.PLANGRAPH_TEST_TMP || os.tmpdir(), 'gitsafe-env-'));
  const old = process.env.LC_ALL; process.env.LC_ALL = 'fr_FR.UTF-8';
  try {
    const git = makeGit(dir);
    // a git alias that runs printenv proves which environment the child really received
    assert.equal(git('-c', 'alias.e=!printenv LC_ALL', 'e').trim(), 'C');
    assert.equal(git('-c', 'alias.e=!printenv GIT_TERMINAL_PROMPT', 'e').trim(), '0');
  } finally { if (old === undefined) delete process.env.LC_ALL; else process.env.LC_ALL = old; fs.rmSync(dir, { recursive: true }); }
});

test('checkRepoPath rejects control characters (a newline in a path could forge a stderr line)', () => {
  for (const bad of ['docs/a\nb.md', 'docs/a\rb.md', 'docs/a\tb.md', 'docs/\u0007.md', 'docs/a\u007f.md']) assert.throws(() => checkRepoPath(bad), TypeError, JSON.stringify(bad));
  assert.equal(checkRepoPath('docs/with space.md'), 'docs/with space.md');
});
