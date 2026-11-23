// Property (d): lib/merge.ts mergeJsonl on ALL combinations of base/ours/theirs over a small record domain, against a clean-room
// oracle of the rules in docs/FORMAT.md section 4, plus algebraic properties that need no oracle:
//   exact: merged text and conflict keys equal the oracle's (record-level rules, field-level 3-way, set fields elementwise, a NEW duplicate
//          key is a conflict, absent and null are different values in a plain field, output canonical and sorted);
//   swap symmetry: merge(b, o, t) and merge(b, t, o) have the same conflict keys and the same clean text, conflict blocks mirrored;
//   idempotence: merge(x, x, x) = canon(x); merge(b, x, x) = merge(b, b, x) = merge(b, x, b) = canon(x) unless x holds a duplicate key that
//          base does not hold identically (then that key is a conflict, as documented);
//   disjoint edits: when ours and theirs change disjoint (key, field) cells (set elements count per element), there is no conflict;
//   no silent loss: every field value, set element, added or deleted record that one side changed is in the result, or its key is a
//          reported conflict;
//   determinism: the same call twice gives the same bytes.
// Schema: refs.jsonl (primary key `key`, set field `plans`, plain field `fp_files`), the only shipped schema with a set field.
// NOT covered: more than 2 keys, values outside the domain (objects inside sets, numbers beyond 2^53), the evidence/unknown-file set
// semantics (hash identity), conflict marker text beyond the block structure, bin/brain-merge file handling.
import assert from 'node:assert/strict';
import { mergeJsonl } from '../../lib/merge.ts';
import { SCHEMAS } from '../../lib/store.ts';
import { product } from './enum.ts';
import type { Level } from './enum.ts';

type Rec = Record<string, unknown>;
/** one refs.jsonl record as the property builds it: the key, and the plans / fp_files fields whose presence and shape are varied */
interface MRec { key: string; plans?: unknown; fp_files?: unknown; [f: string]: unknown }
type Row = { k: string; lines: string[]; conflict?: undefined } | { k: string; conflict: [string[], string[]]; lines?: undefined };
interface Block { o: string[]; t: string[]; side: 'o' | 't' }
interface Dom { plans: unknown[]; fp: unknown[]; dup: boolean }

const SPEC = SCHEMAS['refs.jsonl'];
const ABSENT = Symbol('absent');

// ---- clean-room canonical form for this domain (FORMAT section 1): known fields in schema order, then unknown sorted; sets sorted+deduped
const ORDER = ['key', 'plans', 'files', 'fp_files', 'jira_updated', 'audited_at'];
const val = (v: unknown, isSet?: boolean): string => (Array.isArray(v) ? '[' + (isSet ? [...new Set(v.map((x) => JSON.stringify(x)))].sort() : v.map((x) => JSON.stringify(x))).join(',') + ']' : JSON.stringify(v));
function line(r: Rec): string {
  const ks = Object.keys(r).filter((k) => r[k] !== undefined);
  const known = ORDER.filter((k) => ks.includes(k)), rest = ks.filter((k) => !ORDER.includes(k)).sort();
  return '{' + [...known, ...rest].map((k) => JSON.stringify(k) + ':' + val(r[k], k === 'plans')).join(',') + '}';
}
const canonSide = (recs: MRec[]): Map<string, string[]> => { const by = new Map<string, Set<string>>(); for (const r of recs) { if (!by.has(r.key)) by.set(r.key, new Set()); (by.get(r.key) as Set<string>).add(line(r)); } return new Map([...by].map(([k, s]) => [k, [...s].sort()])); };
const textOf = (recs: MRec[]): string => { const all = [...canonSide(recs)].sort((a, b) => (a[0] < b[0] ? -1 : 1)).flatMap(([, ls]) => ls); return all.length ? all.join('\n') + '\n' : ''; };
const eq = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

// field-level 3-way of one plain or set field; values are ABSENT or a JSON value
function field(b: unknown, o: unknown, t: unknown, isSet: boolean): { v?: unknown; conflict?: boolean } {
  const c = (v: unknown): string => (v === ABSENT ? (isSet ? 'null' : '<absent>') : isSet ? (v === null ? 'null' : val(v, true)) : JSON.stringify(v));
  if (c(o) === c(t)) return { v: o === ABSENT ? t : o };
  if (!isSet) { if (c(o) === c(b)) return { v: t }; if (c(t) === c(b)) return { v: o }; return { conflict: true }; }
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []), B = new Set(arr(b)), O = new Set(arr(o)), T = new Set(arr(t));
  const out: unknown[] = [];
  for (const x of [...O, ...T]) if (!out.includes(x) && !(B.has(x) && (!O.has(x) || !T.has(x)))) out.push(x);
  return { v: out };
}
export function oracleMerge(base: MRec[], ours: MRec[], theirs: MRec[]): { text: string; conflicts: string[] } {
  const B = canonSide(base), O = canonSide(ours), T = canonSide(theirs), rows: Row[] = [], conflicts: string[] = [];
  for (const k of [...new Set([...B.keys(), ...O.keys(), ...T.keys()])].sort()) {
    const b = B.get(k) || [], o = O.get(k) || [], t = T.get(k) || [];
    const clash = () => { conflicts.push(k); rows.push({ k, conflict: [o, t] }); };
    const take = (ls: string[]): unknown => (ls.length > 1 && !eq(ls, b) ? clash() : rows.push({ k, lines: ls }));
    if (eq(o, t)) take(o); else if (eq(o, b)) take(t); else if (eq(t, b)) take(o);
    else if (o.length > 1 || t.length > 1 || b.length > 1 || !o.length || !t.length || !b.length) clash();
    else {
      const rb = JSON.parse(b[0]), ro = JSON.parse(o[0]), rt = JSON.parse(t[0]), out = {} as MRec; /* key is set by the loop below, like the empty object it was */ let bad = false;
      for (const f of new Set([...Object.keys(rb), ...Object.keys(ro), ...Object.keys(rt)])) {
        const g = (r: Rec): unknown => (Object.hasOwn(r, f) ? r[f] : ABSENT), m = field(g(rb), g(ro), g(rt), f === 'plans');
        if (m.conflict) bad = true; else if (m.v !== ABSENT) out[f] = m.v;
      }
      if (bad) clash(); else take([line(out)]);
    }
  }
  const text: string[] = [];
  for (const r of rows) { if (r.conflict) text.push('<<<<<<< ours', ...r.conflict[0], '=======', ...r.conflict[1], '>>>>>>> theirs'); else text.push(...r.lines); }
  return { text: text.length ? text.join('\n') + '\n' : '', conflicts };
}

// ---- domain ----
const states = (k: string, plansDom: unknown[], fpDom: unknown[], dup: boolean): MRec[][] => {
  const out: MRec[][] = [[]];
  for (const plans of plansDom) for (const fp of fpDom) { const r: MRec = { key: k }; if (plans !== ABSENT) r.plans = plans; if (fp !== ABSENT) r.fp_files = fp; out.push([r]); }
  if (dup) out.push([{ key: k, fp_files: 'a' }, { key: k, fp_files: 'b' }]);
  return out;
};
export const BOUNDS: Record<Level, { one: Dom; two: Dom }> = {
  full: { one: { plans: [ABSENT, null, [], ['p1'], ['p1', 'p2'], ['p2']], fp: [ABSENT, null, 'a', 'b'], dup: true }, two: { plans: [ABSENT, ['p1']], fp: [ABSENT, 'a', 'b'], dup: false } },
  quick: { one: { plans: [ABSENT, [], ['p1'], ['p1', 'p2']], fp: [ABSENT, null, 'a'], dup: true }, two: { plans: [ABSENT], fp: [ABSENT, 'a'], dup: false } },
};

const strip = (text: string): string => { const out: string[] = []; let skip = false; for (const l of text.split('\n')) { if (l === '<<<<<<< ours') skip = true; else if (l === '>>>>>>> theirs') skip = false; else if (!skip) out.push(l); } return out.join('\n'); };
const blocks = (text: string): Block[] => { const out: Block[] = []; let cur: Block | null = null; for (const l of text.split('\n')) { if (l === '<<<<<<< ours') cur = { o: [], t: [], side: 'o' }; else if (l === '=======' && cur) cur.side = 't'; else if (l === '>>>>>>> theirs') { out.push(cur as Block); cur = null; } else if (cur) cur[cur.side].push(l); } return out; };
const recMap = (text: string): Map<string, MRec> => { const m = new Map<string, MRec>(); for (const l of strip(text).split('\n')) if (l) { const r = JSON.parse(l); m.set(r.key, r); } return m; };
const fail: (what: string, x: unknown) => never = (what, x) => assert.fail(`merge: ${what}\n${JSON.stringify(x)}`);

function checkOne(b: MRec[], o: MRec[], t: MRec[]) {
  const run = (x: MRec[], y: MRec[], z: MRec[]) => mergeJsonl({ base: x, ours: y, theirs: z }, SPEC);
  const r = run(b, o, t), keys = r.conflicts.map((c) => c.key);
  const want = oracleMerge(b, o, t);
  if (r.text !== want.text || keys.join('|') !== want.conflicts.join('|')) fail('differs from the oracle', { b, o, t, lib: r.text, keys, oracle: want });
  const again = run(b, o, t);
  if (again.text !== r.text || JSON.stringify(again.conflicts) !== JSON.stringify(r.conflicts)) fail('not deterministic', { b, o, t });
  const sw = run(b, t, o);
  if (sw.conflicts.map((c) => c.key).join('|') !== keys.join('|') || strip(sw.text) !== strip(r.text)) fail('ours/theirs swap changes the clean result', { b, o, t, r: r.text, sw: sw.text });
  const bl = blocks(r.text), bs = blocks(sw.text);
  if (bl.length !== bs.length || bl.some((x, i) => !eq(x.o, bs[i].t) || !eq(x.t, bs[i].o))) fail('conflict blocks are not mirrored by the swap', { b, o, t });
  // no silent loss
  const res = recMap(r.text), conf = new Set(keys), B = canonSide(b);
  for (const [side, S] of [['ours', o], ['theirs', t]] as Array<[string, MRec[]]>) {
    const SM = canonSide(S);
    for (const k of new Set([...B.keys(), ...SM.keys()])) {
      if (conf.has(k)) continue;
      const bl2 = B.get(k) || [], sl = SM.get(k) || [];
      if (eq(bl2, sl)) continue;
      if (!sl.length) { if (res.has(k)) fail(`${side} deleted ${k} but it survived`, { b, o, t, text: r.text }); continue; }
      if (!res.has(k)) fail(`${side} edited ${k} but it vanished`, { b, o, t, text: r.text });
      if (sl.length > 1 || bl2.length > 1) continue; // a duplicate key in a side: whole-record rules only
      const sr = JSON.parse(sl[0]), br = bl2.length ? JSON.parse(bl2[0]) : {}, rr = res.get(k) as MRec; /* res.has(k) was checked above */
      for (const f of new Set([...Object.keys(sr), ...Object.keys(br)])) {
        if (f === 'plans') {
          const A = new Set(Array.isArray(sr.plans) ? sr.plans : []), Bp = new Set(Array.isArray(br.plans) ? br.plans : []), R = new Set(Array.isArray(rr.plans) ? rr.plans : []);
          for (const x of A) if (!Bp.has(x) && !R.has(x)) fail(`${side} added ${x} to ${k}.plans but it was lost`, { b, o, t, text: r.text });
          for (const x of Bp) if (!A.has(x) && R.has(x)) fail(`${side} removed ${x} from ${k}.plans but it came back`, { b, o, t, text: r.text });
        } else {
          const sv = Object.hasOwn(sr, f) ? JSON.stringify(sr[f]) : '<absent>', bv = Object.hasOwn(br, f) ? JSON.stringify(br[f]) : '<absent>', rv = Object.hasOwn(rr, f) ? JSON.stringify(rr[f]) : '<absent>';
          if (sv !== bv && rv !== sv) fail(`${side} set ${k}.${f} but the result lost it`, { b, o, t, text: r.text });
        }
      }
    }
  }
  return r;
}

const hasNewDup = (b: MRec[], x: MRec[]): boolean => { const B = canonSide(b); return [...canonSide(x)].some(([k, ls]) => ls.length > 1 && !eq(ls, B.get(k) || [])); };
// (key, field) cells (set elements separately) where side x differs from base b; whole-record add/delete marks every cell of the key.
function cells(b: MRec[], x: MRec[]): Set<string> {
  const B = canonSide(b), X = canonSide(x), out = new Set<string>();
  for (const k of new Set([...B.keys(), ...X.keys()])) {
    const bl = B.get(k) || [], xl = X.get(k) || [];
    if (eq(bl, xl)) continue;
    if (bl.length !== 1 || xl.length !== 1) { out.add(`${k}|*`); continue; }
    const br = JSON.parse(bl[0]), xr = JSON.parse(xl[0]);
    for (const f of new Set([...Object.keys(br), ...Object.keys(xr)])) {
      if (f === 'plans') {
        const P = (r: Rec): string => (Object.hasOwn(r, 'plans') ? (r.plans === null ? 'null' : val(r.plans, true)) : '<a>');
        if (P(br) === P(xr)) continue;
        const A = new Set(Array.isArray(xr.plans) ? xr.plans : []), Bp = new Set(Array.isArray(br.plans) ? br.plans : []);
        let any = false;
        for (const e of new Set([...A, ...Bp])) if (A.has(e) !== Bp.has(e)) { out.add(`${k}|plans|${e}`); any = true; }
        if (!any) out.add(`${k}|plans|<shape>`); // null vs [] vs absent: same elements, different shape
      } else if ((Object.hasOwn(br, f) ? JSON.stringify(br[f]) : '<a>') !== (Object.hasOwn(xr, f) ? JSON.stringify(xr[f]) : '<a>')) out.add(`${k}|${f}`);
    }
  }
  return out;
}
const disjoint = (A: Set<string>, B: Set<string>): boolean => { for (const a of A) { const k = a.split('|')[0]; if (B.has(a) || B.has(`${k}|*`) || (a.endsWith('|*') && [...B].some((x) => x.startsWith(k + '|')))) return false; } return true; };

export function assureMerge(lvl: Level): { oneKey: number; twoKeys: number; idempotence: number; disjoint: number } {
  const D = BOUNDS[lvl], counts = { oneKey: 0, twoKeys: 0, idempotence: 0, disjoint: 0 };
  const visit = (b: MRec[], o: MRec[], t: MRec[], fam: 'oneKey' | 'twoKeys'): void => {
    const r = checkOne(b, o, t); counts[fam]++;
    const cb = cells(b, o), ct = cells(b, t);
    if (disjoint(cb, ct) && !hasNewDup(b, o) && !hasNewDup(b, t)) { counts.disjoint++; if (r.conflicts.length) fail('disjoint edits conflict', { b, o, t, conflicts: r.conflicts }); }
  };
  const S1 = states('K1', D.one.plans, D.one.fp, D.one.dup);
  product([S1, S1, S1], ([b, o, t]) => visit(b, o, t, 'oneKey'));
  for (const x of S1) for (const b of S1) {
    const want = canonSide(x), xx = mergeJsonl({ base: x, ours: x, theirs: x }, SPEC);
    if (xx.text !== textOf(x) || xx.conflicts.length) fail('merge(x,x,x) != canon(x)', { x });
    for (const [o, t] of [[x, x], [b, x], [x, b]]) {
      const r = mergeJsonl({ base: b, ours: o, theirs: t }, SPEC);
      if (hasNewDup(b, x)) { if (!r.conflicts.length) fail('new duplicate key kept silently', { b, o, t }); } else if (r.text !== textOf(x) || r.conflicts.length) fail('idempotence', { b, o, t, text: r.text, want: [...want] });
      counts.idempotence++;
    }
  }
  const S2a = states('K1', D.two.plans, D.two.fp, D.two.dup), S2b = states('K2', D.two.plans, D.two.fp, D.two.dup);
  const pairs: MRec[][] = []; for (const x of S2a) for (const y of S2b) pairs.push([...y, ...x]); // K2 first: input order must not matter
  product([pairs, pairs, pairs], ([b, o, t]) => visit(b, o, t, 'twoKeys'));
  return counts;
}
