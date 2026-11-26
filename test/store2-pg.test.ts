// lib/store2/pg.ts: the comma-free .pg line format. formatPg and parsePg round-trip, and parsePg never throws on content.
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatPg, parsePg, canon, COLLECTION_FIELDS } from '../lib/store2/pg.ts';
import type { Node } from '../lib/store2/pg.ts';
import { nodePath } from '../lib/store2/layout.ts';

const PATH = (id: string) => nodePath('/r', 'ticket', id);
const parse = (t: string, id = 'T-1') => parsePg(t, PATH(id));

function rng(seed: number) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; }; }

test('format: id first, then fields sorted by name, one line each, LF, trailing newline, no commas at line ends', () => {
  const t = formatPg({ id: 'T-1', title: 'x', owner: 'ana', sprint: 2 });
  assert.equal(t, 'id "T-1"\nowner "ana"\nsprint 2\ntitle "x"\n');
});

test('a collection field repeats its name once per element, elements sorted by canonical JSON', () => {
  const t = formatPg({ id: 'T-1', links: [{ to: 'b', rel: 'needs' }, { rel: 'a', to: 'z' }], members: ['p2', 'p1'] });
  assert.equal(t, 'id "T-1"\nlinks {"rel":"a","to":"z"}\nlinks {"rel":"needs","to":"b"}\nmembers "p1"\nmembers "p2"\n');
  for (const f of ['links', 'xrefs', 'acceptance', 'members', 'owns', 'affects']) assert.ok(COLLECTION_FIELDS.has(f));
});

test('one added link changes exactly one line', () => {
  const a = formatPg({ id: 'T-1', links: [{ rel: 'b', to: 'B' }, { rel: 'f', to: 'F' }] }).split('\n');
  const b = formatPg({ id: 'T-1', links: [{ rel: 'b', to: 'B' }, { rel: 'c', to: 'C' }, { rel: 'f', to: 'F' }] }).split('\n');
  assert.equal(b.length - a.length, 1);
  assert.deepEqual(b.filter((l) => !a.includes(l)), ['links {"rel":"c","to":"C"}']);
});

test('a single-element collection stays an array, an unknown field is kept and sorted with the rest', () => {
  const n = { id: 'T-1', links: [{ rel: 'a', to: 'b' }], zeta: [1, 2], x_extra: { k: 1 }, aaa: null };
  const r = parse(formatPg(n)) as { node: Node };
  assert.deepEqual(r.node, n);
  assert.deepEqual(formatPg(n).split('\n').map((l) => l.split(' ')[0]), ['id', 'aaa', 'links', 'x_extra', 'zeta', '']);
});

test('property: 200 random nodes round-trip byte-exactly and value-exactly', () => {
  const r = rng(7), pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
  const strs = ['', 'a', 'Ana', 'a b', 'quo"te', 'back\\slash', 'line\nbreak', 'tab\t', 'é漢字😀', ' x', '\u0000nul', '<<<<<<< x', '{"a":1}', 'x'.repeat(300)];
  const scalar = (): unknown => pick([() => pick(strs), () => Math.floor(r() * 1000) - 500, () => r() < 0.5, () => null, () => 1.5, () => ({ b: pick(strs), a: [1, pick(strs)] }), () => [pick(strs), 2]])();
  for (let i = 0; i < 200; i++) {
    const n: Node = { id: pick(['T-1', 'Ana', 'x y', 'é', 'a\nb']) + i };
    for (const f of ['title', 'owner', 'size', 'note', 'zz', 'schema_version', 'src', 'valid_to', 'custom_1']) if (r() < 0.5) n[f] = scalar();
    for (const f of COLLECTION_FIELDS) if (r() < 0.4) n[f] = Array.from({ length: 1 + Math.floor(r() * 4) }, () => ({ k: pick(strs), n: Math.floor(r() * 9) }));
    const text = formatPg(n), back = parse(text, n.id);
    assert.ok('node' in back, `${JSON.stringify(n)} -> ${JSON.stringify(back)}`);
    assert.equal(formatPg(back.node), text);
    const want: Node = { ...n };
    for (const f of COLLECTION_FIELDS) if (Array.isArray(want[f])) want[f] = [...(want[f] as unknown[])].sort((x, y) => (canon(x) < canon(y) ? -1 : canon(x) > canon(y) ? 1 : 0));
    assert.deepEqual(back.node, want);
  }
});

test('parse: conflict markers give CONFLICT_MARKERS with the line of the first marker', () => {
  const t = 'id "T-1"\nowner "a"\n<<<<<<< HEAD\nsprint 2\n=======\nsprint 3\n>>>>>>> x\n';
  assert.deepEqual(parse(t), { problem: 'CONFLICT_MARKERS', line: 3 });
});

test('parse: a bad line gives BAD_LINE with its number (no id line, bad JSON, blank line, bad name, duplicate id, giant line, NUL, CR-free garbage)', () => {
  const cases: Array<[string, number]> = [
    ['title "x"\n', 1], ['id "T-1"\nowner ana\n', 2], ['id "T-1"\n\nowner "a"\n', 2], ['id "T-1"\n9bad 1\n', 2], ['id "T-1"\nid "T-1"\n', 2],
    ['id "T-1"\nowner\n', 2], ['id T-1\n', 1], ['id 5\n', 1], ['id ""\n', 1], ['id "T-1"\n__proto__ 1\n', 2],
    [`id "T-1"\nnote "${'x'.repeat(9000)}"\n`, 2], ['id "T-1"\nnote "a\u0000b"\n', 2], ['', 1], ['id "T-1"\nowner "a" "b"\n', 2],
  ];
  for (const [t, line] of cases) assert.deepEqual(parse(t), { problem: 'BAD_LINE', line }, JSON.stringify(t.slice(0, 40)));
});

test('parse: an id whose hash is not the one in the file name gives ID_MISMATCH', () => {
  assert.deepEqual(parsePg('id "T-2"\n', PATH('T-1')), { problem: 'ID_MISMATCH', line: 1 });
  assert.deepEqual(parsePg('id "T-1"\n', '/r/nodes/ticket/ab/no-hash.pg'), { problem: 'ID_MISMATCH', line: 1 });
});

test('parse: tolerates CRLF and a missing trailing newline (check reports NOT_CANONICAL), and never throws on random bytes', () => {
  const r = parse('id "T-1"\r\nowner "a"');
  assert.ok('node' in r);
  const rand = rng(3);
  for (let i = 0; i < 300; i++) {
    const len = Math.floor(rand() * 120), chars = Array.from({ length: len }, () => String.fromCharCode(Math.floor(rand() * 128)));
    const t = chars.join('');
    assert.doesNotThrow(() => parse(t));
    assert.doesNotThrow(() => parse(`id "T-1"\n${t}`));
  }
});
