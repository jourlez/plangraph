// More behavior tests for lib/jira/redact.ts (see trust-kills-jira-redact.test.ts): the exact extent of a base64 core at each byte offset,
// the 12-character core limit, the url-safe alphabet, merged ranges of a short and a windowed token, and counted loops (a runaway fails at once).
// The registry is process-wide: every secret here is unique to this file.
import './helpers/runaway.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerSecret, redact } from '../lib/jira/redact.ts';

const R = '[redacted]';

test('a secret inside a base64 blob is replaced exactly where only its own bytes decide the characters', () => {
  const sec = 'Zq-9!blobExact+Secret!'; // 22 bytes: not a multiple of 3, so no core equals the whole base64 form
  registerSecret(sec);
  const n = Buffer.byteLength(sec);
  for (let pre = 0; pre <= 8; pre++) {
    for (let post = 0; post <= 8; post++) {
      if (pre % 3 === 0 && post === 0) continue; // the secret's own whole base64 form is then the whole text and is replaced as such
      const blob = Buffer.concat([Buffer.from('abcdefghi'.slice(0, pre)), Buffer.from(sec), Buffer.from('JKLMNOPQR'.slice(0, post))]);
      const a = Math.ceil((8 * pre) / 6), b = Math.floor((8 * (pre + n)) / 6);
      for (const enc of [blob.toString('base64'), blob.toString('base64url')]) assert.equal(redact(enc), `${enc.slice(0, a)}${R}${enc.slice(b)}`, `${pre}/${post} ${enc}`);
    }
  }
});

test('the url-safe form of a core with + and / characters is replaced too', () => {
  const sec = '>>>???>>>???>>>???>'; // 19 bytes
  registerSecret(sec);
  const blob = Buffer.concat([Buffer.from('abc'), Buffer.from(sec), Buffer.from('xyz')]);
  const std = blob.toString('base64'), url = blob.toString('base64url');
  assert.ok(std.includes('+') && std.includes('/') && url.includes('-') && url.includes('_'));
  const n = Buffer.byteLength(sec), a = 4, b = Math.floor((8 * (3 + n)) / 6);
  assert.equal(redact(std), `${std.slice(0, a)}${R}${std.slice(b)}`); assert.equal(redact(url), `${url.slice(0, a)}${R}${url.slice(b)}`);
});

test('a core is registered from 12 characters up: a 10-byte secret has one at offset 1 only', () => {
  const sec = 'Tk10-abc!?'; // 10 bytes: cores of 13, 12 and 13 characters at offsets 0, 1 and 2; and a 9-byte one has 12, 11 and 11
  registerSecret(sec);
  const at = (pre: number) => Buffer.concat([Buffer.from('abcdef'.slice(0, pre)), Buffer.from(sec), Buffer.from('xyz')]).toString('base64');
  for (const pre of [0, 1, 2, 3, 4, 5]) assert.ok(redact(at(pre)).includes(R), `offset ${pre % 3}`);
  const sec9 = 'Tk9-abc!?'; registerSecret(sec9);
  const nine = (pre: number) => Buffer.concat([Buffer.from('abcdef'.slice(0, pre)), Buffer.from(sec9), Buffer.from('xyz')]).toString('base64');
  assert.ok(redact(nine(0)).includes(R)); assert.ok(redact(nine(3)).includes(R));
  assert.equal(redact(nine(1)), nine(1), 'an 11-character core is too short to register'); assert.equal(redact(nine(2)), nine(2)); assert.equal(redact(nine(4)), nine(4));
});

test('a short raw token and a windowed raw token in one text are merged in text order', () => {
  registerSecret({ raw: 'ShortTok-12x' }); // 12 characters
  const long = 'LongRawWindowTok-0123456789-Z';
  registerSecret({ raw: long });
  const piece = long.toLowerCase().slice(2, 24);
  assert.equal(redact(`a shorttok-12x b ${piece} c`), `a ${R} b ${R} c`);
  assert.equal(redact(`${piece} b shorttok-12x`), `${R} b ${R}`);
  assert.equal(redact(`${piece}shorttok-12x`), R, 'touching ranges are one');
  assert.equal(redact(`x shorttok-12x shorttok-12x ${piece}`), `x ${R} ${R} ${R}`);
  // a short token that overlaps the start of a window is merged with it, though it is found after the windows
  const tail = 'k-12xZzZzZzZzZzZzZzZzZzZz-End'; registerSecret({ raw: tail });
  assert.equal(redact(`>shorttok-12xzzzzzzzzzzzzzzzzzzz<`), `>${R}<`);
});

test('a short token at the end of a run of windows does not shorten the merged range', () => {
  registerSecret({ raw: 'InnerShort-12' }); // 13 characters
  const long = `${'y'.repeat(20)}${'InnerShort-12'.toLowerCase()}zz`; // 35 characters: its windows cover all of it, the short token sits near the end
  registerSecret({ raw: long });
  assert.equal(redact(`<${long}>`), `<${R}>`);
  assert.equal(redact(`<${long.toUpperCase()}>`), `<${R}>`);
});
