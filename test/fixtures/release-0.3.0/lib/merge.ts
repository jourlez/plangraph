// Three-way JSONL merge by primary key. Pure: strings/records in, {text, conflicts} out. See docs/FORMAT.md.
import { canonLine, canonValue, parseJsonlText, specOf, showKey } from './store.ts';
import type { KeySpec, Rec, Spec } from './store.ts';

/** One side of a merge: JSONL text, or already-parsed records. */
export type Side = string | readonly Rec[];
/** A conflict: the record key (shown) and both sides' canonical lines. */
export interface MergeConflict { key: string; detail: string; ours: string[]; theirs: string[] }
const recsOf = (x: Side | null | undefined, name: string): readonly Rec[] => (Array.isArray(x) ? x : parseJsonlText(x as string | null | undefined ?? '', name)); // not an array: text, or nothing
// id -> sorted unique canonical lines (more than one line = duplicate key in that side)
function index(x: Side | null | undefined, spec: Spec, name: string): Map<string, { sort: string; lines: string[] }> {
  const m = new Map<string, { sort: string; lines: Set<string> }>();
  for (const r of recsOf(x, name)) {
    const id = spec.id(r), line = canonLine(r, spec);
    if (!m.has(id)) m.set(id, { sort: spec.sort(r), lines: new Set() });
    (m.get(id) as { sort: string; lines: Set<string> }).lines.add(line); // set just above
  }
  return new Map([...m].map(([id, v]) => [id, { sort: v.sort, lines: [...v.lines].sort() }]));
}
const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

// 3-way merge of one field. Returns {v} or {conflict:true}. Set fields merge elementwise (union minus removals).
// An absent field and a field set to null are different values: collapsing them made the result depend on which side is "ours" (git rebase swaps them).
const own = (r: Rec, f: string): unknown => (Object.hasOwn(r, f) ? r[f] : undefined); // never read inherited properties (constructor, toString, __proto__)
const cv = (v: unknown, isSet: boolean): string => (!isSet && v === undefined ? '\u0000absent' : canonValue(v, isSet));
function mergeField(f: string, b: unknown, o: unknown, t: unknown, isSet: boolean): { v: unknown; conflict?: never } | { conflict: true; v?: never } {
  const sb = cv(b, isSet), so = cv(o, isSet), st = cv(t, isSet);
  if (so === st) return { v: o === undefined ? t : o }; // absent vs null in a set field canonicalize equal: keep the present value so the result does not depend on the side order
  if (!isSet) { if (so === sb) return { v: t }; if (st === sb) return { v: o }; return { conflict: true }; }
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []), key = (x: unknown) => canonValue(x);
  const B = new Set(arr(b).map(key)), O = new Map(arr(o).map((x) => [key(x), x])), T = new Map(arr(t).map((x) => [key(x), x]));
  const out: unknown[] = [];
  for (const [k, x] of new Map([...O, ...T])) if (!(B.has(k) && (!O.has(k) || !T.has(k)))) out.push(x);
  return { v: out };
}
function mergeRecord(b: Rec, o: Rec, t: Rec, spec: Spec): { bad: string[]; rec?: never } | { rec: Rec; bad?: never } {
  const set = new Set(spec.sets || []), out: Rec = {}, bad: string[] = [];
  for (const f of [...new Set([...Object.keys(b), ...Object.keys(o), ...Object.keys(t)])].sort()) {
    const r = mergeField(f, own(b, f), own(o, f), own(t, f), set.has(f));
    if (r.conflict) bad.push(f); else if (r.v !== undefined) Object.defineProperty(out, f, { value: r.v, enumerable: true, writable: true, configurable: true });
  }
  return bad.length ? { bad } : { rec: out };
}

/** sides: text or records (a null side reads as empty); keyFn: a schema, a key function, or nothing (whole-record identity). */
export function mergeJsonl({ base = '', ours = '', theirs = '' }: { base?: Side | null; ours?: Side | null; theirs?: Side | null }, keyFn?: KeySpec, opts: { name?: string } = {}): { text: string; conflicts: MergeConflict[] } {
  const spec = specOf(keyFn), name = opts.name || 'file';
  const B = index(base, spec, name + ' (base)'), O = index(ours, spec, name + ' (ours)'), T = index(theirs, spec, name + ' (theirs)');
  const rows: Array<{ sort: string; lines: string[]; conflict: { ours: string[]; theirs: string[] } | null }> = [], conflicts: MergeConflict[] = [];
  const emptyL: { lines: string[] } = { lines: [] };
  for (const id of new Set([...B.keys(), ...O.keys(), ...T.keys()])) {
    const b = B.get(id) || emptyL, o = O.get(id) || emptyL, t = T.get(id) || emptyL;
    const sort = (O.get(id) || T.get(id) || B.get(id) as { sort: string }).sort; // id came from one of the three
    const clash = (detail: string) => { conflicts.push({ key: showKey(id), detail, ours: o.lines, theirs: t.lines }); rows.push({ sort, lines: [], conflict: { ours: o.lines, theirs: t.lines } }); };
    const take = (lines: string[]) => (lines.length > 1 && !same(lines, b.lines) ? clash('duplicate key in the result') : rows.push({ sort, lines, conflict: null })); // a NEW duplicate key is never silently kept
    if (same(o.lines, t.lines)) take(o.lines);
    else if (same(o.lines, b.lines)) take(t.lines); // only theirs changed (or deleted)
    else if (same(t.lines, b.lines)) take(o.lines); // only ours changed (or deleted)
    else if (o.lines.length > 1 || t.lines.length > 1 || b.lines.length > 1) clash('duplicate key in a side');
    else if (!o.lines.length) clash(b.lines.length ? 'deleted in ours, edited in theirs' : 'conflict');
    else if (!t.lines.length) clash('deleted in theirs, edited in ours');
    else if (!b.lines.length) clash('added differently on both sides');
    else {
      const r = mergeRecord(JSON.parse(b.lines[0] as string), JSON.parse(o.lines[0] as string), JSON.parse(t.lines[0] as string), spec); // the branches above leave exactly one line on each side
      if (r.bad) clash(`both sides changed field${r.bad.length > 1 ? 's' : ''} ${r.bad.join(', ')}`);
      else take([canonLine(r.rec, spec)]);
    }
  }
  rows.sort((a, c) => (a.sort < c.sort ? -1 : a.sort > c.sort ? 1 : (a.lines[0] ?? (a.conflict as { ours: string[] }).ours[0] ?? '') < (c.lines[0] ?? (c.conflict as { ours: string[] }).ours[0] ?? '') ? -1 : 1)); // sort ties need two ids with one sort key: the built-in specs sort by id (unchecked, pre-existing)
  const out: string[] = []; let prev: string | undefined;
  for (const r of rows) {
    if (r.conflict) { out.push('<<<<<<< ours', ...r.conflict.ours, '=======', ...r.conflict.theirs, '>>>>>>> theirs'); prev = undefined; continue; }
    for (const l of r.lines) { if (l !== prev) out.push(l); prev = l; }
  }
  conflicts.sort((a, c) => (a.key < c.key ? -1 : a.key > c.key ? 1 : 0));
  return { text: out.length ? out.join('\n') + '\n' : '', conflicts };
}
