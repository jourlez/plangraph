// Behavior tests for lib/jira/redact.ts, written to kill the mutants of the trust-root run: every form a registered secret can take in a log
// (raw, percent-encoded, JSON-escaped, base64 at any offset, hex, case-changed), the length limits of each rule, and the header and token
// patterns, all against exact output.
// NOT covered: the redaction of real Jira errors (test/redact-forms.test.ts, test/jira.test.ts). The registry is process-wide, so every secret here is unique to this file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerSecret, redact } from '../lib/jira/redact.ts';

const R = '[redacted]';

test('non-text input and nothing registered', () => {
  assert.equal(redact(null), ''); assert.equal(redact(undefined), ''); assert.equal(redact(42), '42'); assert.equal(redact(''), ''); assert.equal(redact(new Error('boom msg')), 'boom msg');
  assert.equal(redact({ toString: () => 'obj' }), 'obj');
  assert.equal(redact('plain text'), 'plain text');
});

test('a plain secret of 6 or more characters is replaced everywhere, longer secrets first; shorter ones and non-strings are ignored', () => {
  registerSecret('kQ7#zx', 'kQ7#zxLonger9', 'short', 42, null, undefined, {}, { raw: 5 }, [], '');
  assert.equal(redact('a kQ7#zx b'), `a ${R} b`);
  assert.equal(redact('a kQ7#zxLonger9 b'), `a ${R} b`, 'the longer secret is replaced whole, not its prefix');
  assert.equal(redact('kQ7#zx kQ7#zx'), `${R} ${R}`);
  assert.equal(redact('a short b'), 'a short b'); assert.equal(redact('a 42 null undefined b'), 'a 42 null undefined b');
  registerSecret('exactly5'.slice(0, 5)); assert.equal(redact('exact'), 'exact');
  registerSecret('sixsix'); assert.equal(redact('xx sixsix yy'), `xx ${R} yy`);
});

test('the forms a secret takes in a log: percent-encoded, JSON-escaped, base64, base64url, hex, lower-case percent', () => {
  const sec = 'p@ss/w"rd+9?&=';
  registerSecret(sec);
  const b = Buffer.from(sec);
  const forms = [sec, encodeURIComponent(sec), JSON.stringify(sec).slice(1, -1), b.toString('base64'), b.toString('base64url'), b.toString('hex'), b.toString('hex').toUpperCase(),
    encodeURIComponent(sec).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()), b.toString('hex').replace(/../g, '%$&'), b.toString('hex').toUpperCase().replace(/../g, '%$&')];
  for (const f of forms) assert.equal(redact(`[${f}]`), `[${R}]`, f);
});

test('a secret inside a longer base64 blob, at each of the three byte offsets, in both alphabets', () => {
  const sec = 'blobSecret-ZZ9+/aa!~xy';
  registerSecret(sec);
  for (const pad of ['', 'Q', 'QQ']) {
    for (const [pre, post] of [['', ''], ['a', 'b'], ['ab', 'cd'], ['abc', 'xyz']]) {
      const blob = Buffer.from(pre + pad + sec + post);
      for (const enc of [blob.toString('base64'), blob.toString('base64url')]) assert.equal(redact(`<${enc}>`).includes(sec), false);
      const raw = blob.toString('base64'), core = Buffer.from(sec).toString('base64');
      void raw; void core;
    }
  }
  const at1 = Buffer.concat([Buffer.alloc(1, 0x41), Buffer.from(sec), Buffer.alloc(2, 0x42)]).toString('base64');
  const at2 = Buffer.concat([Buffer.alloc(2, 0x41), Buffer.from(sec), Buffer.alloc(1, 0x42)]).toString('base64');
  for (const enc of [at1, at2]) { const out = redact(enc); assert.ok(out.includes(R), enc); assert.ok(out.length < enc.length); }
  const urlSafe = Buffer.concat([Buffer.from([0xfb, 0xff]), Buffer.from('blobSecret-ZZ9+/aa!~xy'), Buffer.from([0xfb, 0xef])]).toString('base64url');
  assert.ok(redact(urlSafe).includes(R));
});

test('a short secret has no base64 core (under 12 characters); a long one does', () => {
  registerSecret('ab12!x'); // 6 bytes: its base64 core is shorter than 12 characters and is not registered
  const blob = Buffer.concat([Buffer.from('QQ'), Buffer.from('ab12!x'), Buffer.from('ZZ')]).toString('base64');
  assert.equal(redact(blob), blob);
});

test('a raw token: any letter case as a whole when 12 to 15 characters, any 16-character piece when longer', () => {
  registerSecret({ raw: 'RawTokn-12ch' }); // 12 characters
  assert.equal(redact('x rawtokn-12ch y'), `x ${R} y`); assert.equal(redact('x RAWTOKN-12CH y'), `x ${R} y`); assert.equal(redact('x RawTokn-12c y'), 'x RawTokn-12c y');
  registerSecret({ raw: 'ElevenChar' }); // 10 characters: below 12, only the plain forms
  assert.equal(redact('x elevenchar y'), 'x elevenchar y'); assert.equal(redact('x ElevenChar y'), `x ${R} y`);
  registerSecret({ raw: 'Fifteen-Chars15' }); // 15 characters: whole, any case
  assert.equal(redact('x fifteen-chars15 y'), `x ${R} y`);
  assert.equal(redact('x fifteen-chars1 y'), 'x fifteen-chars1 y');
  const tok = 'LongRawToken-AbCdEf0123456789-End';
  registerSecret({ raw: tok });
  const lower = tok.toLowerCase();
  assert.equal(redact(`x ${lower} y`), `x ${R} y`);
  assert.equal(redact(`x ${tok.toUpperCase()} y`), `x ${R} y`);
  assert.equal(redact(`x ${lower.slice(5, 21)} y`), `x ${R} y`, 'a 16-character piece');
  assert.equal(redact(`x ${lower.slice(5, 20)} y`), `x ${lower.slice(5, 20)} y`, 'a 15-character piece is not enough');
  assert.equal(redact(`x ${lower.slice(0, 16)}-and-${lower.slice(10, 26)} y`), `x ${R}-and-${R} y`);
  assert.equal(redact(`${lower.slice(0, 20)}${lower.slice(14, 33)}`), R, 'overlapping windows become one range');
  assert.equal(redact(`${lower.slice(0, 16)}${lower.slice(16, 32)}`), R, 'touching windows become one range');
  assert.equal(redact(`${lower.slice(0, 16)}~${lower.slice(16, 32)}`), `${R}~${R}`);
  // a 16-character token is itself exactly one window
  registerSecret({ raw: 'SixteenCharTok-16' });
  assert.equal(redact('xsixteenchartok-16x'), `x${R}x`);
  // case folding is ASCII only: a character whose lower case has another length does not shift the offsets
  assert.equal(redact(`İ ${lower.slice(0, 16)}`), `İ ${R}`);
  assert.equal(redact('ab'), 'ab'); assert.equal(redact('x'), 'x');
});

test('the heads filter does not hide windows that start with the same two characters as another', () => {
  const tok = 'headsAAbbCC11223344556677';
  registerSecret({ raw: tok });
  const t = tok.toLowerCase();
  assert.equal(redact(`${t.slice(0, 16)}`), R); assert.equal(redact(`${t.slice(2, 18)}`), R); assert.equal(redact(`${t.slice(t.length - 16)}`), R);
  assert.equal(redact(`${t.slice(0, 15)}Z`), `${t.slice(0, 15)}Z`);
  assert.equal(redact(`${t.slice(0, 1)}${t.slice(2, 17)}`), `${t.slice(0, 1)}${t.slice(2, 17)}`);
});

test('authorization headers, Basic and Bearer values and the Atlassian token prefix are redacted without a registered secret', () => {
  assert.equal(redact('Authorization: Basic dXNlcjpwYXNz'), `Authorization: ${R}`);
  assert.equal(redact('authorization=Bearer abc.def-ghi'), `authorization=${R}`);
  assert.equal(redact('{"Authorization":"Bearer tok123"}'), `{"Authorization":"${R}"}`);
  assert.equal(redact("authorization: 'Basic abcDEF12'"), `authorization: '${R}'`);
  assert.equal(redact('AUTHORIZATION : secretvalue rest'), `AUTHORIZATION : ${R} rest`);
  assert.equal(redact('Authorization: Basic'), `Authorization: ${R}`);
  assert.equal(redact('header Basic abcdefgh12345 end'), `header Basic ${R} end`);
  assert.equal(redact('header Bearer a.b-c_d~e+f/g= end'), `header Bearer ${R} end`);
  assert.equal(redact('Bearer short'), 'Bearer short', 'under 8 characters is not a credential');
  assert.equal(redact('Bearer 1234567'), 'Bearer 1234567'); assert.equal(redact('Bearer 12345678'), `Bearer ${R}`);
  assert.equal(redact('xBasic abcdefgh12345'), 'xBasic abcdefgh12345');
  assert.equal(redact('see ATATT3xFfGF0abcdefghijklmnop.-_= ok'), `see ${R} ok`);
  assert.equal(redact('see ATXTTabcdefghijklmnop12 ok'), `see ${R} ok`);
  assert.equal(redact('see ATATTabcdefghijklmno ok'), 'see ATATTabcdefghijklmno ok', 'under 16 characters after the prefix');
  assert.equal(redact('see ATATTabcdefghijklmnop ok'), `see ${R} ok`);
  assert.equal(redact('see AT1TTabcdefghijklmnop ok'), 'see AT1TTabcdefghijklmnop ok');
  assert.equal(redact('see xATATTabcdefghijklmnop'), 'see xATATTabcdefghijklmnop');
});
