// The type-check ratchet (scripts/typecheck.mjs): parsing tsc output, the strict scope filter and the baseline comparison. Pure
// functions only: tsc itself is a devDependency and is not needed (or run) here; `npm run typecheck` runs it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTsc, scoped, compare } from '../scripts/typecheck.mjs';

const OUT = [
  "src/a.mjs(3,5): error TS7006: Parameter 'x' implicitly has an 'any' type.",
  "src/a.mjs(9,1): error TS2339: Property 'y' does not exist on type '{}'.",
  '  Type number is not assignable to type string.', // continuation line: not an error of its own
  "lib/b c.mjs(1,1): error TS2322: Type 'x' is not assignable.", // a space in the path is kept
  'src/commands/q.mjs(10,2): error TS18046: e is of type unknown.',
  "error TS5023: Unknown compiler option 'zzz'.",
  'src/a.mjs(4,4): warning: not an error line',
  '',
].join('\n');

test('parseTsc counts error lines per file; continuation lines and non-errors are ignored; a positionless error counts as (tsc)', () => {
  assert.deepEqual([...parseTsc(OUT)], [['src/a.mjs', 2], ['lib/b c.mjs', 1], ['src/commands/q.mjs', 1], ['(tsc)', 1]]);
  assert.deepEqual([...parseTsc('')], []);
  assert.deepEqual([...parseTsc('src/a.mjs(1,1): error TS1: x\r\nsrc/a.mjs(2,1): error TS1: y\r\n')], [['src/a.mjs', 2]]);
});

test('scoped keeps only files matching the strict include globs, plus (tsc)', () => {
  const c = parseTsc(OUT);
  assert.deepEqual([...scoped(c, ['src/**/*.mjs'])], [['src/a.mjs', 2], ['src/commands/q.mjs', 1], ['(tsc)', 1]]);
  assert.deepEqual([...scoped(c, ['lib/sanitize.mjs'])], [['(tsc)', 1]]);
  assert.deepEqual([...scoped(new Map([['lib/sanitize.mjs.bak', 1], ['lib/sanitize.mjs', 2]]), ['lib/sanitize.mjs'])], [['lib/sanitize.mjs', 2]]);
});

test('compare: any rise above the baseline (or a new file with errors) is a rise; a lower count is a drop; equal is neither', () => {
  const cur = new Map([['src/a.mjs', 2], ['src/new.mjs', 1], ['lib/x.mjs', 3]]);
  const r = compare({ 'src/a.mjs': 2, 'lib/x.mjs': 5, 'lib/gone.mjs': 1 }, cur);
  assert.deepEqual(r.rises, [['src/new.mjs', 0, 1]]);
  assert.deepEqual(r.drops, [['lib/gone.mjs', 1, 0], ['lib/x.mjs', 5, 3]]);
  assert.deepEqual(compare({}, new Map()), { rises: [], drops: [] });
  assert.deepEqual(compare({}, new Map([['src/a.mjs', 1]])).rises, [['src/a.mjs', 0, 1]], 'a zero baseline fails on the first error');
  assert.deepEqual(compare({ constructor: 0 }, new Map([['constructor', 1]])).rises, [['constructor', 0, 1]], 'prototype names are plain keys');
});
