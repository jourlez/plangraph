// Behavior tests for lib/gitsafe.mjs written to kill mutants that survived scripts/mutate-all.mjs: non-string inputs, the exact length
// limits (200 for refs and templates, 500 for paths), exact error messages with the 60-character excerpt, makeGit capturing stdout and
// stderr, and heading templates: '#' runs, fixed counts, escaped literals, the ^ anchor with multi-line text, and the a <= b rule.
// NOT covered: git timeouts (makeGit's timeout is passed through to execFileSync and not exercised).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkRef, checkRepoPath, makeGit, compileHeading } from '../lib/gitsafe.mjs';

/** @param {() => unknown} fn @param {string} message */
const throwsExactly = (fn, message) => assert.throws(fn, (/** @type {any} */ e) => e instanceof TypeError && e.message === message, message);

test('checkRef: non-strings, the 200-character limit and the exact message excerpt', () => {
  throwsExactly(() => checkRef(5), 'invalid git ref: "5"');
  throwsExactly(() => checkRef(null), 'invalid git ref: "null"');
  assert.equal(checkRef('a'.repeat(200)), 'a'.repeat(200));
  const long = 'a'.repeat(201);
  throwsExactly(() => checkRef(long), `invalid git ref: ${JSON.stringify(long).slice(0, 60)}`);
  throwsExactly(() => checkRef('bad ref'), 'invalid git ref: "bad ref"');
  const spaced = `x y${'b'.repeat(80)}`;
  throwsExactly(() => checkRef(spaced), `invalid git ref: "x y${'b'.repeat(56)}`);
});

test('checkRepoPath: non-strings, empty, the 500-character limit and the exact message excerpt', () => {
  throwsExactly(() => checkRepoPath(5), 'invalid repo path: "5"');
  throwsExactly(() => checkRepoPath(''), 'invalid repo path: ""');
  assert.equal(checkRepoPath('a'.repeat(500)), 'a'.repeat(500));
  throwsExactly(() => checkRepoPath('a'.repeat(501)), `invalid repo path: "${'a'.repeat(59)}`);
  throwsExactly(() => checkRepoPath('/etc/passwd'), 'invalid repo path: "/etc/passwd"');
});

/** @type {string[]} */ const made = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

test('makeGit: returns stdout, and a failing command carries git stderr on the error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitsafe-k-')); made.push(dir);
  execFileSync('git', ['init', '-q', dir], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
  const git = makeGit(dir);
  assert.equal(git('rev-parse', '--is-inside-work-tree'), 'true\n');
  assert.throws(() => git('rev-parse', '--verify', 'no-such-ref^{commit}'), (/** @type {any} */ e) => /fatal|Needed a single revision/.test(String(e.stderr)) && e.status !== 0);
});

test('compileHeading: type and length limits with exact messages', () => {
  throwsExactly(() => compileHeading(5), 'ref_heading: must be a string of at most 200 characters');
  assert.ok(compileHeading(`${'a'.repeat(196)}{id}`));
  throwsExactly(() => compileHeading(`${'a'.repeat(197)}{id}`), 'ref_heading: must be a string of at most 200 characters');
  throwsExactly(() => compileHeading('Task (id)'), 'ref_heading: only literal text, #{a,b} repetitions and one {id} are allowed (for example "^#{2,3} Task {id}:")');
  throwsExactly(() => compileHeading('#{3,2} Task {id}'), 'ref_heading: #{a,b} needs a <= b');
  throwsExactly(() => compileHeading('#{12,3} Task {id}'), 'ref_heading: #{a,b} needs a <= b');
  assert.ok(compileHeading('#{2,2} Task {id}'), 'a == b is a fixed run, allowed');
});

test('compileHeading: a bare # is literal, #{n} is a fixed run, literals are escaped', () => {
  const bare = compileHeading('# Task {id}');
  assert.deepEqual(bare.find('# Task 5', '5'), { start: 0, end: 8 });
  assert.equal(bare.find('x Task 5', '5'), null, 'the # is required');
  const fixed = compileHeading('^#{2} Task {id}');
  assert.deepEqual(fixed.find('## Task 1', '1'), { start: 0, end: 9 });
  assert.equal(fixed.find('# Task 1', '1'), null);
  const dot = compileHeading('Task {id}.');
  assert.equal(dot.find('Task 5x', '5'), null, 'a literal dot is not a wildcard');
  assert.deepEqual(dot.find('Task 5.', '5'), { start: 0, end: 7 });
  const dash = compileHeading('Task-{id}');
  assert.equal(dash.find('TaskX5', '5'), null);
});

test('compileHeading: ^ anchors at a line start, also for nextIndex; no ^ matches mid-line', () => {
  const a = compileHeading('^# Task {id}');
  assert.equal(a.find('see # Task 1', '1'), null);
  assert.deepEqual(a.find('intro\n# Task 1', '1'), { start: 6, end: 14 });
  assert.equal(a.nextIndex('intro\n# Task 2'), 6);
  assert.equal(a.nextIndex('see # Task 2'), -1);
  const u = compileHeading('Task {id}');
  assert.deepEqual(u.find('see Task 1', '1'), { start: 4, end: 10 });
  assert.equal(u.nextIndex('see Task 3'), 4);
});
