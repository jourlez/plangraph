// Guard of scripts/mutate/equivalent.json against drift of the source lines it records: every entry's line text must occur exactly once
// as a trimmed line of its file, and every entry must match a mutant the harness generates today (the same file, line and mutated text
// that scripts/mutate-all.ts compares in isEquivalent and in its STALE EQUIVALENT report).
// NOT covered here: whether an entry is really equivalent (a reviewer's call, recorded in `why`), and running any mutant.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mutantsFor, isEquivalent, checkEquivalents } from '../scripts/mutate-all.ts';

const ROOT = path.join(import.meta.dirname, '..');
const LIST = checkEquivalents(JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/mutate/equivalent.json'), 'utf8')));

// Entries whose line was already gone from its file at the pre-annotation commit 407fa26: the code they describe was changed
// earlier, so no mutant matches them. Listed by index into the array; a new stale entry fails the count below.
const STALE_AT_BASE = [30, 44, 45, 46, 157, 158, 164, 185, 226];
// Entries whose line text occurs twice in its file (both at the base and now): the harness matches by text, so the entry covers both.
const DUPLICATE_LINES = [193, 195];

const lines = new Map<string, string[]>();
const linesOf = (file: string) => {
  let l = lines.get(file);
  if (!l) lines.set(file, l = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n').map((x) => x.trim()));
  return l;
};

test('every equivalent entry names a line that occurs exactly once in its file, except the listed stale and duplicate ones', () => {
  const missing: number[] = [], duplicated: number[] = [];
  LIST.forEach((e, id) => {
    const n = linesOf(e.file).filter((x) => x === e.line).length;
    if (n === 0) missing.push(id);
    else if (n > 1) duplicated.push(id);
  });
  assert.deepEqual(missing, STALE_AT_BASE, 'an entry whose line is gone must be rewritten to the current line text');
  assert.equal(missing.length, 9);
  assert.deepEqual(duplicated, DUPLICATE_LINES);
});

test('every equivalent entry matches a mutant the harness generates now, except the listed stale ones', () => {
  const mutants = new Map<string, ReturnType<typeof mutantsFor>>();
  const unmatched: number[] = [];
  LIST.forEach((e, id) => {
    let ms = mutants.get(e.file);
    if (!ms) mutants.set(e.file, ms = mutantsFor(e.file, fs.readFileSync(path.join(ROOT, e.file), 'utf8')));
    if (!ms.some((m) => isEquivalent(m, [e]))) unmatched.push(id);
  });
  assert.deepEqual(unmatched, STALE_AT_BASE, 'the mutated text must be the one mutantsFor derives from the current line');
});
