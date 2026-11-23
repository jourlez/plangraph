// Three-way JSONL merge by primary key. Pure: strings/records in, {text, conflicts} out. See docs/FORMAT.md.
import { canonLine, canonValue, parseJsonlText, specOf, showKey } from './store.mjs';

const recsOf = (x, name) => (Array.isArray(x) ? x : parseJsonlText(x ?? '', name));
// id -> sorted unique canonical lines (more than one line = duplicate key in that side)
function index(x, spec, name) {
  const m = new Map();
  for (const r of recsOf(x, name)) {
    const id = spec.id(r), line = canonLine(r, spec);
    if (!m.has(id)) m.set(id, { sort: spec.sort(r), lines: new Set() });
    m.get(id).lines.add(line);
  }
  return new Map([...m].map(([id, v]) => [id, { sort: v.sort, lines: [...v.lines].sort() }]));
}
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// 3-way merge of one field. Returns {v} or {conflict:true}. Set fields merge elementwise (union minus removals).
// An absent field and a field set to null are different values: collapsing them made the result depend on which side is "ours" (git rebase swaps them).
const own = (r, f) => (Object.hasOwn(r, f) ? r[f] : undefined); // never read inherited properties (constructor, toString, __proto__)
const cv = (v, isSet) => (!isSet && v === undefined ? '\u0000absent' : canonValue(v, isSet));
function mergeField(f, b, o, t, isSet) {
  const sb = cv(b, isSet), so = cv(o, isSet), st = cv(t, isSet);
  if (so === st) return { v: o === undefined ? t : o }; // absent vs null in a set field canonicalize equal: keep the present value so the result does not depend on the side order
  if (!isSet) { if (so === sb) return { v: t }; if (st === sb) return { v: o }; return { conflict: true }; }
  const arr = (v) => (Array.isArray(v) ? v : []), key = (x) => canonValue(x);
  const B = new Set(arr(b).map(key)), O = new Map(arr(o).map((x) => [key(x), x])), T = new Map(arr(t).map((x) => [key(x), x]));
  const out = [];
  for (const [k, x] of new Map([...O, ...T])) if (!(B.has(k) && (!O.has(k) || !T.has(k)))) out.push(x);
  return { v: out };
}
function mergeRecord(b, o, t, spec) {
  const set = new Set(spec.sets || []), out = {}, bad = [];
  for (const f of [...new Set([...Object.keys(b), ...Object.keys(o), ...Object.keys(t)])].sort()) {
    const r = mergeField(f, own(b, f), own(o, f), own(t, f), set.has(f));
    if (r.conflict) bad.push(f); else if (r.v !== undefined) Object.defineProperty(out, f, { value: r.v, enumerable: true, writable: true, configurable: true });
  }
  return bad.length ? { bad } : { rec: out };
}

/** @param {{ base?: string | object[], ours?: string | object[], theirs?: string | object[] }} sides @param {any} keyFn @param {{ name?: string }} [opts] */
export function mergeJsonl({ base = '', ours = '', theirs = '' }, keyFn, opts = {}) {
  const spec = specOf(keyFn), name = opts.name || 'file';
  const B = index(base, spec, name + ' (base)'), O = index(ours, spec, name + ' (ours)'), T = index(theirs, spec, name + ' (theirs)');
  const rows = [], conflicts = [];
  const emptyL = { lines: [] };
  for (const id of new Set([...B.keys(), ...O.keys(), ...T.keys()])) {
    const b = B.get(id) || emptyL, o = O.get(id) || emptyL, t = T.get(id) || emptyL;
    const sort = (O.get(id) || T.get(id) || B.get(id)).sort;
    const clash = (detail) => { conflicts.push({ key: showKey(id), detail, ours: o.lines, theirs: t.lines }); rows.push({ sort, lines: [], conflict: { ours: o.lines, theirs: t.lines } }); };
    const take = (lines) => (lines.length > 1 && !same(lines, b.lines) ? clash('duplicate key in the result') : rows.push({ sort, lines, conflict: null })); // a NEW duplicate key is never silently kept
    if (same(o.lines, t.lines)) take(o.lines);
    else if (same(o.lines, b.lines)) take(t.lines); // only theirs changed (or deleted)
    else if (same(t.lines, b.lines)) take(o.lines); // only ours changed (or deleted)
    else if (o.lines.length > 1 || t.lines.length > 1 || b.lines.length > 1) clash('duplicate key in a side');
    else if (!o.lines.length) clash(b.lines.length ? 'deleted in ours, edited in theirs' : 'conflict');
    else if (!t.lines.length) clash('deleted in theirs, edited in ours');
    else if (!b.lines.length) clash('added differently on both sides');
    else {
      const r = mergeRecord(JSON.parse(b.lines[0]), JSON.parse(o.lines[0]), JSON.parse(t.lines[0]), spec);
      if (r.bad) clash(`both sides changed field${r.bad.length > 1 ? 's' : ''} ${r.bad.join(', ')}`);
      else take([canonLine(r.rec, spec)]);
    }
  }
  rows.sort((a, c) => (a.sort < c.sort ? -1 : a.sort > c.sort ? 1 : (a.lines[0] ?? a.conflict.ours[0] ?? '') < (c.lines[0] ?? c.conflict.ours[0] ?? '') ? -1 : 1));
  const out = []; let prev;
  for (const r of rows) {
    if (r.conflict) { out.push('<<<<<<< ours', ...r.conflict.ours, '=======', ...r.conflict.theirs, '>>>>>>> theirs'); prev = undefined; continue; }
    for (const l of r.lines) { if (l !== prev) out.push(l); prev = l; }
  }
  conflicts.sort((a, c) => (a.key < c.key ? -1 : a.key > c.key ? 1 : 0));
  return { text: out.length ? out.join('\n') + '\n' : '', conflicts };
}
