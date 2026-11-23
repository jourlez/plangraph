// Behavior tests for lib/sanitize.mjs and lib/schema.mjs written to kill mutants that survived scripts/mutate-all.mjs: the default cap
// of 2000, never splitting a surrogate pair at a cut of 1, fenceInline's default width and quote replacement, and guardOutput on opener
// lines whose declared length does not lead to a closing tag (they must be neutralized, never trusted); schema number checks reject
// non-finite numbers handed in by a caller.
// NOT covered: the full sanitizer tables (test/sanitize.test.mjs, test/security*.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { sanitizeText, fenceInline, guardOutput } from '../lib/sanitize.mjs';
import { validators } from '../lib/schema.mjs';

test('sanitizeText: default cap 2000, and a cut at 1 never keeps half a surrogate pair', () => {
  assert.equal(sanitizeText('a'.repeat(2000)), 'a'.repeat(2000));
  assert.equal(sanitizeText('a'.repeat(2001)), `${'a'.repeat(2000)}…[+1 chars]`);
  assert.equal(sanitizeText('😀😀', { max: 1 }), '…[+4 chars]');
  assert.equal(sanitizeText('😀😀', { max: 3 }), '😀…[+2 chars]');
});

test('fenceInline: default width 60, double quotes become single quotes, the nonce hashes the shown text', () => {
  const body = `${'w'.repeat(60)}…[+40 chars]`;
  const h = crypto.createHash('sha256').update(body).digest('hex').slice(0, 8);
  assert.equal(fenceInline('w'.repeat(100)), `<untrusted n="${h}">${body}</untrusted>`);
  const q = fenceInline('say "hi"');
  assert.ok(q.includes(">say 'hi'</untrusted>"), q);
});

test('guardOutput: an opener whose length does not end at a closing tag is neutralized and the rest is still guarded', () => {
  const wrongLen = ['<untrusted src="a" n="b" len="1">', 'x', 'not-the-close', '<untrusted src="evil" n="c" len="3">'].join('\n');
  assert.equal(guardOutput(wrongLen), ['<\\untrusted src="a" n="b" len="1">', 'x', 'not-the-close', '<\\untrusted src="evil" n="c" len="3">'].join('\n'));
  const noTarget = ['<untrusted src="a" n="b" len="999">', 'body', '</untrusted>', 'after <untrusted>'].join('\n');
  assert.equal(guardOutput(noTarget), ['<\\untrusted src="a" n="b" len="999">', 'body', '<\\/untrusted>', 'after <\\untrusted>'].join('\n'));
  const good = ['<untrusted src="a" n="b" len="4">', 'body', '</untrusted>', 'tail <untrusted'].join('\n');
  assert.equal(guardOutput(good), ['<untrusted src="a" n="b" len="4">', 'body', '</untrusted>', 'tail <\\untrusted'].join('\n'));
});

test('schema: a number field rejects non-finite numbers handed in by a caller', () => {
  assert.equal(validators['tickets.jsonl']({ key: 'A', v2_sprint: Infinity }), '"v2_sprint" must be a number');
  assert.equal(validators['tickets.jsonl']({ key: 'A', sp: NaN }), '"sp" must be a number');
  assert.equal(validators['schedule.jsonl']({ key: 'A', sprint: -Infinity }), '"sprint" must be a number');
});

test('schema: every optional string field and the refs object fields are checked', () => {
  assert.equal(validators['tickets.jsonl']({ key: 'A', v2_owner: 5 }), '"v2_owner" must be a string');
  assert.equal(validators['schedule.jsonl']({ key: 'A', owner: 5 }), '"owner" must be a string');
  assert.equal(validators['schedule.jsonl']({ key: 'A', version: 5 }), '"version" must be a string');
  assert.equal(validators['refs.jsonl']({ key: 'A', files: [] }), '"files" must be an object');
  assert.equal(validators['refs.jsonl']({ key: 'A', files: 'x' }), '"files" must be an object');
  assert.equal(validators['refs.jsonl']({ key: 'A', files: {}, plans: [] }), null);
});
