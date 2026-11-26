// Node URI form `pg:<type>/<pct(id)>` (amendment 3.1): examples, canonical single-pass decode, grammar, and a negative control per rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import { nodeUri, parseNodeUri } from '../lib/graph/uri.ts';
import { rng } from './fixtures/gen.ts';

const EXAMPLES: ReadonlyArray<[string, string, string]> = [
  ['person', 'Ana Silva', 'pg:person/Ana%20Silva'],
  ['plantask', 'docs/p.md#Task 3', 'pg:plantask/docs%2Fp.md%23Task%203'],
  ['ticket', 'ABC-123', 'pg:ticket/ABC-123'],
  ['sprint', 'S3', 'pg:sprint/S3'],
  ['openitem', 'ABC-1|decision', 'pg:openitem/ABC-1%7Cdecision'],
];

test('examples of 3.1 encode and parse both ways', () => {
  for (const [type, id, uri] of EXAMPLES) {
    assert.equal(nodeUri(type, id), uri);
    assert.deepEqual(parseNodeUri(uri), { type, id });
  }
});

test('each reserved character, control and non-ASCII character is percent-encoded as UTF-8', () => {
  assert.equal(nodeUri('doc', '/#|? '), 'pg:doc/%2F%23%7C%3F%20');
  assert.equal(nodeUri('doc', 'a%b'), 'pg:doc/a%25b');
  assert.equal(nodeUri('person', 'Zoë'), 'pg:person/Zo%C3%AB');
  assert.equal(nodeUri('person', '\u{1F600}'), 'pg:person/%F0%9F%98%80');
  assert.deepEqual(parseNodeUri('pg:doc/100%25'), { type: 'doc', id: '100%' });
  // negative control: a raw reserved or non-ASCII character is not the canonical spelling
  for (const raw of ['pg:doc/a b', 'pg:doc/a#b', 'pg:doc/a|b', 'pg:doc/a?b', 'pg:doc/a/b', 'pg:doc/Zoë', 'pg:doc/a%b']) assert.equal(parseNodeUri(raw), null, raw);
});

test('round trip fuzz: a valid id survives, an invalid one throws, nothing in between', () => {
  const r = rng(7);
  const pool = ['%', '2e', '%2e%2e', '%252f', '%25', '/', '#', '|', '?', ' ', '..', 'é', '\u{1F600}', '\uD800', '\uDC00', '\u0000', '\u0085', '\u202E', '\u2028', 'a', 'Z', '-', ':', '日本'];
  let ok = 0;
  let thrown = 0;
  for (let i = 0; i < 4000; i++) {
    let id = '';
    const n = Math.floor(r() * 12);
    for (let j = 0; j < n; j++) id += r() < 0.7 ? pool[Math.floor(r() * pool.length)] : String.fromCharCode(Math.floor(r() * 0x2500));
    let uri: string | null = null;
    try {
      uri = nodeUri('ticket', id);
    } catch {
      thrown++;
    }
    if (uri === null) continue;
    ok++;
    assert.deepEqual(parseNodeUri(uri), { type: 'ticket', id }, JSON.stringify(id));
    assert.match(uri, /^pg:ticket\/[\x21-\x7E]+$/); // ASCII only, no space
  }
  assert.ok(ok > 500 && thrown > 500, `fuzz covers both outcomes (${ok} ok, ${thrown} thrown)`);
});

test('fuzz over arbitrary URI strings: anything accepted is canonical', () => {
  const r = rng(11);
  const alphabet = ['%', '2', 'e', 'E', 'F', '5', '0', '9', 'C', '3', 'A', 'B', 'x', '-', '.', ' ', '#', '%2E', '%C3%A9', '%25'];
  let accepted = 0;
  for (let i = 0; i < 6000; i++) {
    let s = 'pg:ticket/';
    const n = Math.floor(r() * 8);
    for (let j = 0; j < n; j++) s += alphabet[Math.floor(r() * alphabet.length)];
    const p = parseNodeUri(s);
    if (p) {
      accepted++;
      assert.equal(nodeUri(p.type, p.id), s);
    }
  }
  assert.ok(accepted > 50, `some strings are accepted (${accepted})`);
});

test('200-character ids pass, 201 are refused', () => {
  const id = 'a'.repeat(200);
  assert.deepEqual(parseNodeUri(nodeUri('doc', id)), { type: 'doc', id });
  assert.throws(() => nodeUri('doc', 'a'.repeat(201)));
  assert.equal(parseNodeUri(`pg:doc/${'a'.repeat(201)}`), null);
  // the limit counts characters, not encoded bytes: 200 non-ASCII characters are fine
  const wide = 'é'.repeat(200);
  assert.deepEqual(parseNodeUri(nodeUri('doc', wide)), { type: 'doc', id: wide });
  assert.throws(() => nodeUri('doc', '\u{1F600}'.repeat(201)));
});

test('dot-dot spelled with escapes and double encoding are refused', () => {
  for (const uri of ['pg:doc/%2e%2e', 'pg:doc/%2E%2E', 'pg:doc/%2e.', 'pg:doc/%252f', 'pg:doc/%252F', 'pg:doc/%2541', 'pg:doc/%41', 'pg:doc/a%2fb', 'pg:doc/a%2Fb%2f']) assert.equal(parseNodeUri(uri), null, uri);
  // negative control: the canonical spellings of the same payload values are accepted
  assert.deepEqual(parseNodeUri('pg:doc/..'), { type: 'doc', id: '..' });
  assert.deepEqual(parseNodeUri('pg:doc/a%2Fb'), { type: 'doc', id: 'a/b' });
  assert.deepEqual(parseNodeUri('pg:doc/%25'), { type: 'doc', id: '%' });
  // an id that spells an escape is refused on the way in too
  assert.throws(() => nodeUri('doc', '%2e%2e'));
  assert.throws(() => nodeUri('doc', '%252f'));
});

test('lowercase hex and unneeded escapes are refused (decoded value must re-encode to the input)', () => {
  assert.equal(parseNodeUri('pg:doc/a%2fb'), null);
  assert.equal(parseNodeUri('pg:doc/a%2Fb')?.id, 'a/b');
  assert.equal(parseNodeUri('pg:doc/Zo%c3%ab'), null);
  assert.equal(parseNodeUri('pg:doc/Zo%C3%AB')?.id, 'Zoë');
  assert.equal(parseNodeUri('pg:doc/%C3'), null); // malformed UTF-8
  assert.equal(parseNodeUri('pg:doc/%C0%AF'), null); // overlong
  assert.equal(parseNodeUri('pg:doc/%ED%A0%80'), null); // encoded surrogate
});

test('type grammar: core types and x-<sys>.<kind> only', () => {
  for (const t of ['ticket', 'person', 'sprint', 'epic', 'plantask', 'openitem', 'plan', 'doc', 'repo', 'x-github.pr', 'x-a.b', `x-${'a'.repeat(24)}.${'b'.repeat(24)}`]) {
    assert.deepEqual(parseNodeUri(`pg:${t}/x`), { type: t, id: 'x' }, t);
    assert.equal(nodeUri(t, 'x'), `pg:${t}/x`);
  }
  for (const t of ['widget', 'Ticket', 'x-', 'x-github', 'x-github.', 'x-.pr', 'x-1a.b', 'x-a.1b', 'x-A.b', `x-${'a'.repeat(25)}.b`, `x-a.${'b'.repeat(25)}`, 'x-a.b.c', 'x_a.b', 'y-a.b', '', 'ticket ']) {
    assert.equal(parseNodeUri(`pg:${t}/x`), null, JSON.stringify(t));
    assert.throws(() => nodeUri(t, 'x'), JSON.stringify(t));
  }
});

test('scheme and shape: missing scheme, missing slash, empty id, wrong scheme case', () => {
  for (const uri of ['ticket/ABC-1', 'PG:ticket/ABC-1', 'pg:ticket', 'pg:ticket/', 'pg:/x', 'pg:ticket/ABC-1/extra', '', 'pg:', 'pg:ticket/é']) assert.equal(parseNodeUri(uri), null, JSON.stringify(uri));
  assert.equal(parseNodeUri(undefined as unknown as string), null);
  assert.throws(() => nodeUri('ticket', ''));
});

test('ids with controls, bidi or line-break characters are refused', () => {
  const bad = ['\u0000', '\u0009', '\u000A', '\u000D', '\u001F', '\u007F', '\u0080', '\u0085', '\u009F', '\u061C', '\u200E', '\u200F', '\u2028', '\u2029', '\u202A', '\u202E', '\u2066', '\u2069'];
  for (const c of bad) {
    assert.throws(() => nodeUri('ticket', `a${c}b`), JSON.stringify(c));
    assert.equal(parseNodeUri(`pg:ticket/a${encodeURIComponent(c)}b`), null, JSON.stringify(c));
  }
  // negative control: neighbours outside the forbidden sets are fine
  for (const c of ['\u00A0', '¡', '\u2065', '\u206A', '\u200D', '\u2027', '\u202F']) assert.deepEqual(parseNodeUri(nodeUri('ticket', `a${c}b`)), { type: 'ticket', id: `a${c}b` }, JSON.stringify(c));
});

test('lone surrogates have no URI', () => {
  for (const id of ['\uD800', 'a\uDC00', '\uDBFF\uDBFF', '\uDC00\uD800']) assert.throws(() => nodeUri('doc', id), JSON.stringify(id));
  assert.deepEqual(parseNodeUri(nodeUri('doc', '😀')), { type: 'doc', id: '\u{1F600}' });
});
