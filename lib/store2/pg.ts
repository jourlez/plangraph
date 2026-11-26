// The .pg entity file format (spec 4.0 rule 2). Line 1 `id <json string>`; then one line per field `<name> <json value>`, sorted by name;
// a collection field repeats its name once per element, elements sorted by canonical JSON. No commas, braces or blank lines at line
// ends, LF, trailing newline, each line at most 8 KiB. An unknown field is kept and sorted with the rest (an array value of a field
// that is not a collection stays one line). parsePg never throws on content: it returns the first problem with its line number.
import { idHash } from './layout.ts';

export interface Node { id: string; [field: string]: unknown }
export type PgProblem = 'CONFLICT_MARKERS' | 'BAD_LINE' | 'ID_MISMATCH';
export type ParseResult = { node: Node } | { problem: PgProblem; line: number };

/** Fields that repeat their name once per element; the value is always an array. */
export const COLLECTION_FIELDS: ReadonlySet<string> = new Set(['links', 'xrefs', 'acceptance', 'members', 'owns', 'affects']);
export const MAX_LINE = 8 * 1024;
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const MARKER_RE = /^(<{7}( |$)|={7}$|>{7}( |$)|\|{7}( |$))/;

/** JSON with object keys sorted at every level: one spelling per value. */
export function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => canon(x === undefined ? null : x)).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function formatPg(n: Node): string {
  const lines = [`id ${JSON.stringify(n.id)}`];
  for (const name of Object.keys(n).filter((k) => k !== 'id' && n[k] !== undefined).sort()) {
    if (!NAME_RE.test(name) || name === '__proto__') throw new TypeError(`field name not allowed: ${name.slice(0, 40)}`);
    const v = n[name];
    if (COLLECTION_FIELDS.has(name)) for (const e of (Array.isArray(v) ? v : [v]).map(canon).sort(cmp)) lines.push(`${name} ${e}`);
    else lines.push(`${name} ${canon(v)}`);
  }
  return `${lines.join('\n')}\n`;
}

const bad = (line: number): ParseResult => ({ problem: 'BAD_LINE', line });

/** Parse one .pg file. `file` is the path the text came from: its name must end in `~<h8>.pg` with h8 the hash of the id inside. */
export function parsePg(text: string, file: string): ParseResult {
  const rows = text.split('\n');
  if (rows[rows.length - 1] === '') rows.pop();
  for (let i = 0; i < rows.length; i++) if (MARKER_RE.test(rows[i] as string)) return { problem: 'CONFLICT_MARKERS', line: i + 1 };
  if (!rows.length) return bad(1);
  const node: Record<string, unknown> = {}, seen = new Set<string>();
  let id: string | undefined;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as string, at = i + 1;
    if (Buffer.byteLength(row) > MAX_LINE || row.includes('\u0000')) return bad(at);
    const sp = row.indexOf(' ');
    if (sp < 1) return bad(at);
    const name = row.slice(0, sp);
    let v: unknown;
    if (!NAME_RE.test(name) || name === '__proto__') return bad(at);
    try { v = JSON.parse(row.slice(sp + 1)); } catch { return bad(at); }
    if (i === 0) {
      if (name !== 'id' || typeof v !== 'string' || v === '') return bad(at);
      id = v; continue;
    }
    if (name === 'id') return bad(at);
    if (COLLECTION_FIELDS.has(name)) { const a = (node[name] ??= []) as unknown[]; a.push(v); }
    else if (seen.has(name)) return bad(at); // a repeated name is only for collection fields
    else node[name] = v;
    seen.add(name);
  }
  if (id === undefined) return bad(1);
  const m = /~([0-9a-f]{8})\.pg$/.exec(file);
  if (!m || m[1] !== idHash(id)) return { problem: 'ID_MISMATCH', line: 1 };
  return { node: { id, ...node } };
}
