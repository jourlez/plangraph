// More behavior tests for lib/jira/redact.ts (see trust-kills-jira-redact.test.ts): the exact extent of a base64 core at each byte offset,
// the 12-character core limit, the url-safe alphabet, merged ranges of a short and a windowed token, and counted loops (a runaway fails at once).
// The registry is process-wide: every secret here is unique to this file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerSecret, redact } from '../lib/jira/redact.ts';

const R = '[redacted]';

test('a secret inside a base64 blob is replaced exactly where only its own bytes decide the characters', () => {
  const sec = 'Zq-9!blobExact+Secret';
  registerSecret(sec);
  const n = Buffer.byteLength(sec);
  for (let pre = 0; pre <= 8; pre++) {
    for (let post = 0; post <= 8; post++) {
      const blob = Buffer.concat([Buffer.from('abcdefghi'.slice(0, pre)), Buffer.from(sec), Buffer.from('JKLMNOPQR'.slice(0, post))]);
      const a = Math.ceil((8 * pre) / 6), b = Math.floor((8 * (pre + n)) / 6);
      for (const enc of [blob.toString('base64'), blob.toString('base64url')]) assert.equal(redact(enc), `${enc.slice(0, a)}${R}${enc.slice(b)}`, `${pre}/${post} ${enc}`);
    }
  }
});

test('the url-safe form of a core with + and / characters is replaced too', () => {
  const sec = '>>>???>>>???>>>???';
  registerSecret(sec);
  const blob = Buffer.concat([Buffer.from('abc'), Buffer.from(sec), Buffer.from('xyz')]);
  const std = blob.toString('base64'), url = blob.toString('base64url');
  assert.ok(std.includes('+') && std.includes('/') && url.includes('-') && url.includes('_'));
  assert.equal(redact(std), `${std.slice(0, 4)}${R}${std.slice(-4)}`); assert.equal(redact(url), `${url.slice(0, 4)}${R}${url.slice(-4)}`);
});

test('a core is registered from 12 characters up: a 9-byte secret has one at offset 0 only', () => {
  const sec = 'Tkn9-abc!'; // 9 bytes: 12 characters at offset 0, 11 at offsets 1 and 2
  registerSecret(sec);
  const at0 = Buffer.concat([Buffer.from('abc'), Buffer.from(sec), Buffer.from('xyz')]).toString('base64');
  assert.equal(redact(at0), `${at0.slice(0, 4)}${R}${at0.slice(-4)}`);
  const at1 = Buffer.concat([Buffer.from('a'), Buffer.from(sec), Buffer.from('xyz')]).toString('base64');
  assert.equal(redact(at1), at1, 'an 11-character core is too short to register');
  const at2 = Buffer.concat([Buffer.from('ab'), Buffer.from(sec), Buffer.from('xy')]).toString('base64');
  assert.equal(redact(at2), at2);
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
});

test('scanning is linear: a counted loop for the windows, the short tokens and the registration', (t) => {
  const real = String.prototype.charCodeAt, realIndexOf = String.prototype.indexOf;
  let watch = '', codes = 0, finds = 0;
  t.mock.method(String.prototype, 'charCodeAt', function (this: string, i: number) { if (watch && String(this) === watch && ++codes > 5000) throw new Error('runaway window scan'); return real.call(this, i); });
  t.mock.method(String.prototype, 'indexOf', function (this: string, ...a: [string, number?]) { if (watch && String(this) === watch && ++finds > 200) throw new Error('runaway token search'); return realIndexOf.apply(this, a); });
  const text = `${'q'.repeat(100)} shorttok-12x ${'z'.repeat(100)} shorttok-12x`;
  watch = text.toLowerCase(); redact(text);
  assert.ok(codes <= 2 * text.length + 10, `${codes} character reads for ${text.length} characters`);
  assert.ok(finds <= 10, `${finds} token searches`);
  codes = 0; watch = 'Registered-Counted-Raw-Token-0123456789'.toLowerCase();
  registerSecret({ raw: 'Registered-Counted-Raw-Token-0123456789' });
  assert.ok(codes <= 2 * watch.length + 10, `${codes} reads while registering`);
});
