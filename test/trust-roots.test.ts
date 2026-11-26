// The trust-root file list that the survivor-free mutation run covers (scripts/mutate/trust-roots.json): a plain array of repo paths, each of
// which must exist and be a file the mutation runner mutates. NOT covered: whether the run itself has zero survivors (node scripts/mutate-all.ts --files <the list>).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isSource } from '../scripts/mutate-all.ts';

const ROOT = path.join(import.meta.dirname, '..');
const LIST: unknown = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/mutate/trust-roots.json'), 'utf8'));

test('trust-roots.json is a non-empty array of unique repo paths', () => {
  assert.ok(Array.isArray(LIST) && LIST.length > 0);
  const l = LIST as string[];
  assert.ok(l.every((p) => typeof p === 'string' && !p.startsWith('/') && !p.includes('..')));
  assert.equal(new Set(l).size, l.length);
});

test('every listed trust-root file exists and is a mutated source file', () => {
  for (const p of LIST as string[]) {
    assert.ok(fs.statSync(path.join(ROOT, p)).isFile(), `${p} is missing`);
    assert.ok(isSource(p), `${p} is not a file the mutation runner mutates`);
  }
});
