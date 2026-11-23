// Behavior tests for lib/merge.mjs written to kill mutants that survived scripts/mutate-all.mjs: a null side is an empty side, parse
// errors name the side (base, ours, theirs) and the file name (default "file"), and rows whose sort keys tie (a caller spec with a sort
// function coarser than the id) are ordered by their first line, for plain rows and for conflict blocks alike.
// NOT covered: the merge rules themselves (test/merge.test.mjs and its reference model in test/merge-reference.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeJsonl } from '../lib/merge.mjs';
import { rng } from './fixtures/gen.mjs';

const key = (/** @type {any} */ r) => r.k;
const jl = (/** @type {object[]} */ rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

test('a null side is treated as an empty side', () => {
  assert.deepEqual(mergeJsonl({ base: /** @type {any} */ (null), ours: jl([{ k: 'a' }]), theirs: jl([{ k: 'a' }]) }, key), { text: '{"k":"a"}\n', conflicts: [] });
  assert.deepEqual(mergeJsonl({ base: jl([{ k: 'a' }]), ours: /** @type {any} */ (null), theirs: jl([{ k: 'a' }]) }, key), { text: '', conflicts: [] }, 'null ours = ours deleted the row');
});

test('parse errors name the side and the file', () => {
  const msg = (/** @type {() => unknown} */ fn) => { try { fn(); } catch (e) { return String(/** @type {Error} */ (e).message).split(':').slice(0, 2).join(':'); } return 'no error'; };
  assert.equal(msg(() => mergeJsonl({ ours: '{bad' }, key)), 'file (ours):1');
  assert.equal(msg(() => mergeJsonl({ base: 'x' }, key)), 'file (base):1');
  assert.equal(msg(() => mergeJsonl({ theirs: '\nx' }, key)), 'file (theirs):2');
  assert.equal(msg(() => mergeJsonl({ base: 'x' }, key, { name: 'edges.jsonl' })), 'edges.jsonl (base):1');
  assert.equal(msg(() => mergeJsonl({ theirs: 'x' }, key, { name: 'edges.jsonl' })), 'edges.jsonl (theirs):1');
});

test('rows with tied sort keys are ordered by their first line, whatever the order the ids were met', () => {
  const spec = { id: key, sort: (/** @type {any} */ r) => r.g };
  const r = mergeJsonl({ base: jl([{ k: 'c', g: 1 }]), ours: jl([{ k: 'c', g: 1 }, { k: 'b', g: 1 }, { k: 'z', g: 0 }]), theirs: jl([{ k: 'c', g: 1 }, { k: 'a', g: 1 }, { k: 'z', g: 0 }]) }, spec);
  assert.equal(r.text, jl([{ g: 0, k: 'z' }, { g: 1, k: 'a' }, { g: 1, k: 'b' }, { g: 1, k: 'c' }]));
  const rev = mergeJsonl({ base: jl([{ k: 'y', g: 2 }]), ours: jl([{ k: 'y', g: 2 }, { k: 'b', g: 1 }]), theirs: jl([{ k: 'y', g: 2 }, { k: 'a', g: 1 }]) }, spec);
  assert.equal(rev.text, jl([{ g: 1, k: 'a' }, { g: 1, k: 'b' }, { g: 2, k: 'y' }]), 'a later-met row with a smaller sort key goes first');
});

test('conflict blocks with tied sort keys are ordered by their ours line', () => {
  const spec = { id: key, sort: (/** @type {any} */ r) => r.g };
  const ours = jl([{ k: 'b', g: 1, v: 1 }, { k: 'a', g: 1, v: 1 }]), theirs = jl([{ k: 'b', g: 1, v: 2 }, { k: 'a', g: 1, v: 2 }]);
  const { text, conflicts } = mergeJsonl({ base: '', ours, theirs }, spec);
  assert.equal(text, ['<<<<<<< ours', '{"g":1,"k":"a","v":1}', '=======', '{"g":1,"k":"a","v":2}', '>>>>>>> theirs', '<<<<<<< ours', '{"g":1,"k":"b","v":1}', '=======', '{"g":1,"k":"b","v":2}', '>>>>>>> theirs', ''].join('\n'));
  assert.deepEqual(conflicts.map((c) => [c.key, c.detail]), [['a', 'added differently on both sides'], ['b', 'added differently on both sides']]);
  const mixed = mergeJsonl({ base: '', ours: jl([{ k: 'b', g: 1, v: 1 }, { k: 'a', g: 1 }]), theirs: jl([{ k: 'b', g: 1, v: 2 }, { k: 'a', g: 1 }]) }, spec);
  assert.ok(mixed.text.startsWith('{"g":1,"k":"a"}\n<<<<<<< ours\n'), 'a plain row and a conflict block tie-break on the plain line versus the ours line');
});

// Property (independent of the implementation): the merged text is a sequence of blocks (a plain line, or a conflict block); with a sort
// key that ties, blocks must come in order of (sort key, first line), where a conflict block's first line is its first ours line or ''.
test('property: with tied sort keys, merged blocks are ordered by their first line in any meeting order', () => {
  const spec = { id: key, sort: (/** @type {any} */ r) => r.g };
  const r = rng(77);
  for (let round = 0; round < 300; round++) {
    const ids = ['a', 'b', 'c', 'd'].filter(() => r() < 0.8);
    /** @type {any[]} */ const base = [], ours = [], theirs = [];
    for (const k of ids) {
      const g = Math.floor(r() * 2), kind = Math.floor(r() * 6);
      const rec = { k, g, v: 0 };
      if (kind === 0) { base.push(rec); ours.push(rec); theirs.push(rec); } // unchanged
      else if (kind === 1) { base.push(rec); ours.push({ ...rec, v: 1 }); theirs.push(rec); } // ours edits
      else if (kind === 2) { base.push(rec); ours.push({ ...rec, v: 1 }); theirs.push({ ...rec, v: 2 }); } // both edit: conflict
      else if (kind === 3) { base.push(rec); theirs.push({ ...rec, v: 2 }); } // deleted in ours, edited in theirs: conflict with empty ours
      else if (kind === 4) { ours.push({ ...rec, v: 1 }); theirs.push({ ...rec, v: 2 }); } // added differently: conflict
      else { ours.push(rec); } // added in ours only
    }
    const shuffle = (/** @type {any[]} */ a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
    const side = (/** @type {any[]} */ rows) => (rows.length ? jl(shuffle(rows)) : '');
    const { text } = mergeJsonl({ base: side(base), ours: side(ours), theirs: side(theirs) }, spec);
    const lines = text.split('\n').filter(Boolean);
    /** @type {string[]} */ const blocks = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] === '<<<<<<< ours') { const end = lines.indexOf('=======', i); blocks.push(end > i + 1 ? lines[i + 1] : ''); i = lines.indexOf('>>>>>>> theirs', i); }
      else blocks.push(lines[i]);
    }
    for (let i = 1; i < blocks.length; i++) {
      if (!blocks[i - 1] || !blocks[i]) continue; // an empty-ours block has no line of its own to compare (its sort key is checked by the merge tests)
      const a = JSON.parse(blocks[i - 1]), b = JSON.parse(blocks[i]);
      assert.ok(a.g < b.g || (a.g === b.g && blocks[i - 1] < blocks[i]), `round ${round}: ${blocks[i - 1]} before ${blocks[i]}\n${text}`);
    }
  }
});

test('tied rows met in ascending order stay ascending; conflict blocks met in ascending order too', () => {
  const spec = { id: key, sort: (/** @type {any} */ r) => r.g };
  assert.equal(mergeJsonl({ base: '', ours: jl([{ k: 'a', g: 1 }, { k: 'b', g: 1 }]), theirs: jl([{ k: 'a', g: 1 }, { k: 'b', g: 1 }]) }, spec).text, jl([{ g: 1, k: 'a' }, { g: 1, k: 'b' }]));
  const c = mergeJsonl({ base: '', ours: jl([{ k: 'a', g: 1, v: 1 }, { k: 'b', g: 1, v: 1 }]), theirs: jl([{ k: 'a', g: 1, v: 2 }, { k: 'b', g: 1, v: 2 }]) }, spec);
  assert.ok(c.text.indexOf('"k":"a","v":1') < c.text.indexOf('"k":"b","v":1'), c.text);
  const del = mergeJsonl({ base: jl([{ k: 'a', g: 1 }, { k: 'b', g: 1 }]), ours: jl([{ k: 'c', g: 1 }]), theirs: jl([{ k: 'a', g: 1, v: 2 }, { k: 'b', g: 1, v: 2 }, { k: 'c', g: 1 }]) }, spec);
  assert.ok(del.text.startsWith('<<<<<<< ours\n=======\n{"g":1,"k":"a","v":2}'), `deleted-in-ours blocks (empty ours line) sort before a plain row of the same key:\n${del.text}`);
  assert.ok(del.text.indexOf('"k":"a","v":2') < del.text.indexOf('"k":"b","v":2'));
});
