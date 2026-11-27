// lib/store2/layout.ts: file names of entity nodes (spec 4.0 rule 1): hash-suffixed so ids that differ only in case never share a name.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { nodePath, slug, idHash, newId } from '../lib/store2/layout.ts';

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

test('nodePath is nodes/<kind>/<h2>/<slug>~<h12>.pg with h12 the first 12 hex of sha256(exact id)', () => {
  const p = nodePath('/r', 'ticket', 'ABC-12'), h = sha('ABC-12');
  assert.equal(p, path.join('/r', 'nodes', 'ticket', h.slice(0, 2), `abc-12~${h.slice(0, 12)}.pg`));
  assert.equal(idHash('ABC-12'), h.slice(0, 12));
});

test('ids that differ only in case get different file names, also when compared ignoring case', () => {
  const a = nodePath('/r', 'person', 'Ana'), b = nodePath('/r', 'person', 'ana');
  assert.notEqual(a, b);
  assert.notEqual(a.toLowerCase(), b.toLowerCase());
});

test('slug lower-cases, replaces every character outside [a-z0-9._-] with _ and keeps at most 60 characters', () => {
  assert.equal(slug('Sp:Plan/1 é'), 'sp_plan_1__');
  assert.equal(slug('a.b_c-d'), 'a.b_c-d');
  assert.equal(slug('x'.repeat(100)).length, 60);
  assert.equal(slug(''), '');
});

test('a hostile id cannot leave its directory: path separators and dots become part of one file name', () => {
  const p = nodePath('/r', 'ticket', '../../etc/passwd');
  assert.ok(p.startsWith(path.join('/r', 'nodes', 'ticket') + path.sep));
  assert.equal(path.dirname(path.dirname(p)), path.join('/r', 'nodes', 'ticket'));
  assert.doesNotMatch(path.basename(p), /[\/\\]/);
});

test('nodePath refuses a kind that is not a plain lower-case word', () => {
  for (const k of ['', '..', 'a/b', 'A', 'x y', '.hidden']) assert.throws(() => nodePath('/r', k, 'x'), /kind/);
});

test('newId is the kind prefix plus 6 hex of sha256(seed), stable, and extended by 2 hex per collision', () => {
  const id = newId('requirement', 'docs/spec.md#a first line');
  assert.match(id, /^R-[0-9a-f]{6}$/);
  assert.equal(id, newId('requirement', 'docs/spec.md#a first line'));
  assert.equal(id, `R-${sha('docs/spec.md#a first line').slice(0, 6)}`);
  const taken = new Set([id]);
  const two = newId('requirement', 'docs/spec.md#a first line', (x) => taken.has(x));
  assert.equal(two, `R-${sha('docs/spec.md#a first line').slice(0, 8)}`);
  taken.add(two);
  assert.equal(newId('requirement', 'docs/spec.md#a first line', (x) => taken.has(x)).length, 'R-'.length + 10);
  assert.match(newId('decision', 's'), /^D-[0-9a-f]{6}$/);
  assert.match(newId('team', 's'), /^TEAM-[0-9a-f]{6}$/);
});
