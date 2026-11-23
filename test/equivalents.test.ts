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

// Every entry names a line that occurs exactly once in its file: the harness matches by line text, so a line that occurs twice would let one
// reviewed reason cover a second, unreviewed occurrence (as entry 195 once did for lib/store.ts `return false;`). Make the line unique
// (a trailing comment is enough) before adding an entry for it.

const lines = new Map<string, string[]>();
const linesOf = (file: string) => {
  let l = lines.get(file);
  if (!l) lines.set(file, l = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n').map((x) => x.trim()));
  return l;
};

test('every equivalent entry names a line that occurs exactly once in its file', () => {
  const missing: number[] = [], duplicated: number[] = [];
  LIST.forEach((e, id) => {
    const n = linesOf(e.file).filter((x) => x === e.line).length;
    if (n === 0) missing.push(id);
    else if (n > 1) duplicated.push(id);
  });
  assert.deepEqual(missing, [], 'an entry whose line is gone must be rewritten to the current line text or deleted');
  assert.deepEqual(duplicated, [], 'an entry whose line occurs twice covers an unreviewed occurrence');
});

test('no two equivalent entries record the same mutant', () => {
  const seen = new Map<string, number>(), dup: Array<[number, number]> = [];
  LIST.forEach((e, id) => { const k = JSON.stringify([e.file, e.line, e.mutated]); const was = seen.get(k); if (was !== undefined) dup.push([was, id]); else seen.set(k, id); });
  assert.deepEqual(dup, []);
});

test('every equivalent entry matches a mutant the harness generates now', () => {
  const mutants = new Map<string, ReturnType<typeof mutantsFor>>();
  const unmatched: number[] = [];
  LIST.forEach((e, id) => {
    let ms = mutants.get(e.file);
    if (!ms) mutants.set(e.file, ms = mutantsFor(e.file, fs.readFileSync(path.join(ROOT, e.file), 'utf8')));
    if (!ms.some((m) => isEquivalent(m, [e]))) unmatched.push(id);
  });
  assert.deepEqual(unmatched, [], 'the mutated text must be the one mutantsFor derives from the current line');
});
