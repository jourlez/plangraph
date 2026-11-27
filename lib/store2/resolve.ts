// Repair of mechanical merge conflicts (spec 4.0 rule 2). A conflict hunk whose lines all belong to collection fields (links, xrefs,
// acceptance, members, owns, affects) is resolved by union; with a diff3 base section, a line that one side deleted stays deleted.
// A hunk that touches a scalar field leaves the whole file untouched and is reported with its field. Result files are canonical.
import path from 'node:path';
import { readDataCapped } from '../jsonl.ts';
import { withTxn } from './txn.ts';
import { listKinds, listNodeFiles, MAX_NODE_BYTES } from './nodes.ts';
import { COLLECTION_FIELDS, canon, formatPg, parsePg } from './pg.ts';

export interface Left { path: string; field: string; line: number }
const OPEN = /^<{7}( |$)/, BASE = /^\|{7}( |$)/, MID = /^={7}$/, CLOSE = /^>{7}( |$)/;
const NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const fieldOf = (row: string): string => { const f = row.split(' ')[0] as string; return NAME.test(f) ? f : '?'; }; // split always yields one element

/** The text with each conflict hunk replaced by its union, or the first thing that stops it: [field, line]. */
function unionHunks(rows: string[]): string[] | [string, number] {
  const out: string[] = [];
  let i = 0;
  while (i < rows.length) {
    const row = rows[i] as string; // i < rows.length
    if (CLOSE.test(row) || MID.test(row) || BASE.test(row)) return ['?', i + 1]; // a marker outside a hunk
    if (!OPEN.test(row)) { out.push(row); i++; continue; }
    const start = i + 1, ours: string[] = [], theirs: string[] = [];
    let base: string[] | null = null, side = ours, j = i + 1, closed = false;
    for (; j < rows.length; j++) {
      const r = rows[j] as string; // j < rows.length
      if (OPEN.test(r)) break;
      if (BASE.test(r) && side === ours) { base = []; side = base; }
      else if (MID.test(r) && side !== theirs) side = theirs;
      else if (CLOSE.test(r) && side === theirs) { closed = true; break; }
      else side.push(r);
    }
    if (!closed) return ['?', start];
    const all = [...ours, ...(base ?? []), ...theirs], scalar = all.find((r) => !COLLECTION_FIELDS.has(fieldOf(r)));
    if (scalar !== undefined) return [fieldOf(scalar), start];
    const keep = (r: string) => !base || !base.includes(r) || (ours.includes(r) && theirs.includes(r)); // a base line one side dropped is a deletion
    for (const r of [...new Set([...ours, ...theirs])]) if (keep(r)) out.push(r);
    i = j + 1;
  }
  return out;
}

// The key of an element inside its collection: two different elements with one key are one value changed on both sides, not two values.
const ELEMENT_KEY: Readonly<Record<string, readonly string[]>> = { capacity: ['sprint'], links: ['rel', 'to'], xrefs: ['sys', 'xid'] };
const keyOf = (e: unknown, cols: readonly string[]): string => canon(cols.map((c) => (e && typeof e === 'object' ? (e as Record<string, unknown>)[c] : undefined) ?? null));
/** The first collection that holds two different elements with one key, or null. */
function duplicateKey(node: Record<string, unknown>): string | null {
  for (const [f, cols] of Object.entries(ELEMENT_KEY)) {
    if (!Array.isArray(node[f])) continue;
    const seen = new Set<string>();
    for (const e of node[f] as unknown[]) { const k = keyOf(e, cols); if (seen.has(k)) return f; seen.add(k); }
  }
  return null;
}

function plan(root: string): { resolved: string[]; left: Left[]; writes: Array<{ rel: string; text: string }> } {
  const resolved: string[] = [], left: Left[] = [], writes: Array<{ rel: string; text: string }> = [];
  for (const kind of listKinds(root)) {
    for (const abs of listNodeFiles(root, kind)) {
      let text: string;
      try { text = readDataCapped(abs, MAX_NODE_BYTES); } catch { continue; } // an unreadable file is check's business
      const rows = text.split('\n');
      if (rows[rows.length - 1] === '') rows.pop();
      if (!rows.some((r) => OPEN.test(r) || MID.test(r) || CLOSE.test(r))) continue;
      const rel = path.relative(root, abs), u = unionHunks(rows);
      if (typeof u[0] === 'string' && u.length === 2 && typeof u[1] === 'number') { left.push({ path: rel, field: u[0], line: u[1] }); continue; }
      const parsed = parsePg(`${(u as string[]).join('\n')}\n`, abs);
      if (!('node' in parsed)) { left.push({ path: rel, field: fieldOf((u as string[])[parsed.line - 1] ?? ''), line: parsed.line }); continue; }
      const node = { ...parsed.node };
      for (const f of COLLECTION_FIELDS) if (Array.isArray(node[f])) node[f] = [...new Map((node[f] as unknown[]).map((e) => [canon(e), e])).values()];
      const dup = duplicateKey(node);
      if (dup !== null) { left.push({ path: rel, field: dup, line: rows.findIndex((r) => OPEN.test(r)) + 1 }); continue; } // a scalar conflict in disguise
      writes.push({ rel: rel.split(path.sep).join('/'), text: formatPg(node) });
      resolved.push(rel);
    }
  }
  return { resolved: resolved.sort(), left: left.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)), writes };
}

export function resolveConflicts(root: string): { resolved: string[]; left: Left[] } {
  let r = plan(root);
  if (r.writes.length) withTxn(root, (tx) => { r = plan(root); for (const w of r.writes) tx.write(w.rel, w.text); }); // planned again under the store lock, written in one transaction
  return { resolved: r.resolved, left: r.left };
}
