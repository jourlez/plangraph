// Reference-model fuzzing of lib/merge.ts: an independent Map-based three-way merger (no shared code with lib/merge.ts or
// lib/store.ts canonicalization) is compared with the real merger on 20000 seeded cases, including duplicate keys within a side, fields
// named like Object.prototype members, and the exact conflict detail text. NOT covered: set fields holding non-arrays beyond null/absent, records with more than
// seven fields. Replacing the set-element key with JSON.stringify is an equivalent mutant (elements are re-parsed from canonical lines).
import test from 'node:test';
import assert from 'node:assert/strict';
import { rng } from './fixtures/gen.ts';
import { mergeJsonl } from '../lib/merge.ts';

// Field names that exist on every object (constructor, toString) or mean something special (__proto__) are used on purpose: a merger that
// reads inherited properties, or assigns through the prototype setter, gives a different answer for them.
type R = Record<string, unknown>;
type Rng = () => number;
const EXTRA = ['constructor', 'toString', '__proto__'];
const SETF = ['s', 'toString']; // set fields in the spec and in the reference
const SPEC = { file: 'fuzz.jsonl', order: ['k', 'a', 'b', 's'], sets: SETF, defaults: {}, id: (r: R) => String(r.k), sort: (r: R) => String(r.k) };
const ABSENT = Symbol('absent');
const put = (o: object, f: string, v: unknown) => Object.defineProperty(o, f, { value: v, enumerable: true, writable: true, configurable: true }); // never o[f] = v: __proto__ would set the prototype

// ---- the reference: plain Maps, own canonical form ----
const canon = (v: unknown): string => (Array.isArray(v) ? '[' + v.map(canon).join(',') + ']' : v !== null && typeof v === 'object' ? '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon((v as R)[k])).join(',') + '}' : JSON.stringify(v)); // typeof just tested it
const setOf = (v: unknown) => new Map((Array.isArray(v) ? v : []).map((x: unknown): [string, unknown] => [canon(x), x]));
const val = (r: R | undefined, f: string): unknown => (r && Object.hasOwn(r, f) ? r[f] : ABSENT);
function refField(f: string, b: unknown, o: unknown, t: unknown): { v?: unknown; set?: Map<string, unknown>; conflict?: boolean } {
  if (SETF.includes(f)) {
    const B = setOf(b), O = setOf(o), T = setOf(t);
    const form = (x: unknown) => (Array.isArray(x) ? 'arr:' + [...setOf(x).keys()].sort().join('|') : 'none'); // absent and null are both "no value"; [] is an (empty) array
    if (form(o) === form(t)) return { v: o === ABSENT ? t : o }; // identical set values; a present null wins over an absent field, so the result never depends on which side is ours
    const out = new Map<string, unknown>();
    for (const [k, x] of [...O, ...T]) if (!(B.has(k) && !(O.has(k) && T.has(k)))) out.set(k, x);
    return { v: [...out.values()], set: out };
  }
  const c = (x: unknown) => (x === ABSENT ? '\0absent' : canon(x));
  if (c(o) === c(t)) return { v: o };
  if (c(o) === c(b)) return { v: t };
  if (c(t) === c(b)) return { v: o };
  return { conflict: true };
}
// the reference's view of a record: sets sorted and deduped, everything canonical
const view = (r: R) => canon(Object.fromEntries(Object.entries(r).map(([f, v]) => [f, SETF.includes(f) && Array.isArray(v) ? [...setOf(v).keys()].sort().map((k) => JSON.parse(k)) : v])));
// one side: key -> Map(view -> record) (an identical record twice is one record; different records under one key are a duplicate key)
const sideMap = (recs: readonly R[]) => { const m = new Map<unknown, Map<string, R>>(); for (const r of recs) { if (!m.has(r.k)) m.set(r.k, new Map()); (m.get(r.k) as Map<string, R>).set(view(r), r); } return m; }; // set just before
const lst = (m: Map<string, R> | undefined) => (m ? [...m.keys()].sort() : []);
const eqL = (x: readonly string[], y: readonly string[]) => x.length === y.length && x.every((v, i) => v === y[i]);
// returns { recs: Map key -> sorted views, conflicts: Map key -> detail }
function refMerge(base: readonly R[], ours: readonly R[], theirs: readonly R[]) {
  const B = sideMap(base), O = sideMap(ours), T = sideMap(theirs);
  const recs = new Map<unknown, string[]>(), conflicts = new Map<unknown, string>();
  for (const k of new Set([...B.keys(), ...O.keys(), ...T.keys()])) {
    const b = lst(B.get(k)), o = lst(O.get(k)), t = lst(T.get(k));
    const clash = (d: string) => conflicts.set(k, d);
    const take = (lines: string[]) => (lines.length > 1 && !eqL(lines, b) ? clash('duplicate key in the result') : lines.length && recs.set(k, lines));
    if (eqL(o, t)) take(o);
    else if (eqL(o, b)) take(t);
    else if (eqL(t, b)) take(o);
    else if (o.length > 1 || t.length > 1 || b.length > 1) clash('duplicate key in a side');
    else if (!o.length) clash(b.length ? 'deleted in ours, edited in theirs' : 'conflict');
    else if (!t.length) clash('deleted in theirs, edited in ours');
    else if (!b.length) clash('added differently on both sides');
    else {
      const [br, or, tr] = [B, O, T].map((m) => [...(m.get(k) as Map<string, R>).values()][0]); // every side has exactly one record here
      const rec: R = {}, bad: string[] = [];
      for (const f of [...new Set([...Object.keys(br), ...Object.keys(or), ...Object.keys(tr)])].sort()) {
        const r = refField(f, val(br, f), val(or, f), val(tr, f));
        if (r.conflict) bad.push(f); else if (r.v !== ABSENT) put(rec, f, r.v);
      }
      if (bad.length) clash(`both sides changed field${bad.length > 1 ? 's' : ''} ${bad.join(', ')}`); else recs.set(k, [view(rec)]);
    }
  }
  return { recs, conflicts };
}

// ---- generators ----
const VALS = [ABSENT, null, 'x', 'y', '', 0, 1, true, ['x'], ['y', 'x'], [], { z: 1 }];
const SETS = [ABSENT, null, [], ['p'], ['q'], ['p', 'q'], ['q', 'p', 'p'], [['n']]];
const pickOf = (r: Rng, a: readonly unknown[]): unknown => a[Math.floor(r() * a.length)];
function genRec(r: Rng, k: unknown): R {
  const rec: R = { k };
  for (const [f, pool] of [['a', VALS], ['b', VALS], ['s', SETS]] as Array<[string, readonly unknown[]]>) { const v = pickOf(r, pool); if (v !== ABSENT) rec[f] = structuredClone(v); } // literal tuples
  for (const f of EXTRA) if (r() < 0.3) { const v = pickOf(r, f === 'toString' ? SETS : VALS); if (v !== ABSENT) put(rec, f, structuredClone(v)); }
  return rec;
}
const mutate = (r: Rng, rec: R) => { // a small edit of an existing record so same-record merges are common
  const x = genRec(r, rec.k), out = { ...rec };
  for (const f of ['a', 'b', 's', ...EXTRA]) if (r() < 0.35) { if (Object.hasOwn(x, f)) put(out, f, x[f]); else delete out[f]; }
  return out;
};
function genSide(r: Rng, base: readonly R[], keys: readonly string[]): R[] {
  const side: R[] = [];
  for (const k of keys) {
    const bs = base.filter((x) => x.k === k), x = r();
    if (bs.length) { if (x < 0.15) continue; for (const b of bs) side.push(r() < 0.5 ? b : mutate(r, b)); } else if (x < 0.5) side.push(genRec(r, k));
    if (r() < 0.12) side.push(bs.length ? mutate(r, bs[0]) : genRec(r, k)); // a second, different record under the same key
  }
  return side;
}
const line = (recs: readonly R[]) => recs.map((x) => JSON.stringify(x)).join('\n') + (recs.length ? '\n' : '');
const run = (b: readonly R[], o: readonly R[], t: readonly R[]) => mergeJsonl({ base: line(b), ours: line(o), theirs: line(t) }, SPEC);
function parseOut(text: string) { // key -> sorted views of the records outside conflict blocks
  const recs = new Map<unknown, string[]>(); let inC = false;
  for (const l of text.split('\n')) { if (l.startsWith('<<<<<<<')) inC = true; else if (l.startsWith('>>>>>>>')) inC = false; else if (!inC && l && l !== '=======') { const o = JSON.parse(l); if (!recs.has(o.k)) recs.set(o.k, []); (recs.get(o.k) as string[]).push(view(o)); } } // set just before
  for (const v of recs.values()) v.sort();
  return recs;
}

test('fuzz: 20000 seeded merges (duplicate keys, inherited-name fields) equal the Map-based reference model; conflict-free merges are symmetric', () => {
  const keys = ['k1', 'k2', 'k3', 'constructor', '__proto__'];
  let conflictCases = 0, mergedFields = 0, dupCases = 0, multiField = 0, protoFields = 0;
  for (let seed = 1; seed <= 20000; seed++) {
    const r = rng(seed), base: R[] = [];
    for (const k of keys) if (r() < 0.6) { base.push(genRec(r, k)); if (r() < 0.1) base.push(genRec(r, k)); }
    const ours = genSide(r, base, keys), theirs = genSide(r, base, keys);
    const want = refMerge(base, ours, theirs), got = run(base, ours, theirs);
    const gotRecs = parseOut(got.text), gotConf = new Map(got.conflicts.map((c): [string, string] => [c.key, c.detail]));
    const ctx = `seed ${seed}`;
    assert.deepEqual([...gotConf].sort(), [...want.conflicts].sort(), ctx + ' conflicts (key and detail)');
    assert.deepEqual([...gotRecs.keys()].sort(), [...want.recs.keys()].sort(), ctx + ' keys');
    for (const [k, vs] of want.recs) assert.deepEqual(gotRecs.get(k), vs, `${ctx} record ${k}`);
    if (want.conflicts.size) conflictCases++; else if (ours.length && theirs.length) mergedFields++;
    if ([...want.recs.values()].some((v) => v.length > 1) || [...want.conflicts.values()].some((d) => /duplicate/.test(d))) dupCases++;
    if ([...want.conflicts.values()].some((d) => /fields /.test(d))) multiField++;
    if ([...want.recs.values()].some((v) => v.some((x) => /"(constructor|toString|__proto__)"/.test(x)))) protoFields++;
    if (!want.conflicts.size) {
      const sw = run(base, theirs, ours);
      assert.deepEqual(sw.conflicts, [], ctx + ' swapped conflicts');
      assert.equal(sw.text, got.text, ctx + ' symmetric');
    }
  }
  assert.ok(conflictCases > 1000 && mergedFields > 1000, `fuzz must exercise both outcomes (${conflictCases} conflict cases, ${mergedFields} clean)`);
  assert.ok(dupCases > 500 && multiField > 50 && protoFields > 500, `fuzz must exercise duplicates (${dupCases}), multi-field conflicts (${multiField}) and inherited-name fields (${protoFields})`);
});

test('regression: a set field absent on one side and null on the other merges the same way when the sides are swapped', () => {
  // both sides edit the record (so fields are merged one by one); the s field is null on one side and absent on the other
  const b = '{"k":"a","a":1}\n', one = '{"k":"a","a":2,"s":null}\n', two = '{"k":"a","a":1,"b":5}\n', want = '{"k":"a","a":2,"b":5,"s":null}\n';
  const x = mergeJsonl({ base: b, ours: one, theirs: two }, SPEC), y = mergeJsonl({ base: b, ours: two, theirs: one }, SPEC);
  assert.deepEqual(x.conflicts, []);
  assert.equal(x.text, want);
  assert.equal(y.text, want);
});
