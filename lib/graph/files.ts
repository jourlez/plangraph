// The graph files (docs/FORMAT.md section 6): seven hand-authored or scanned files next to the v1 files. Pure reading and validation, no
// writes. One reader, parseGraphFile, checks every graph file: field shapes (lib/schema.ts), the open grammars of node types and
// relations, ids, endpoints, and duplicate keys. Extension types (`x-<sys>.<kind>`), extension relations (`x-<sys>/<rel>`) and unknown
// `sys` values of xrefs are accepted and counted, never an error: a newer tool may write them, an older one must still read the directory.
import path from 'node:path';
import { parseJsonl, presentDataFile, readDataCapped, IngestError, DATA_REFUSALS } from '../jsonl.ts';
import { validators } from '../schema.ts';
import type { Rec } from '../schema.ts';
import { canonLine } from '../store.ts';
import { oneLine } from '../sanitize.ts';

/** The seven graph files, in the order the card and the index list them. */
export const GRAPH_FILES = Object.freeze(['people', 'sprints', 'epics', 'repos', 'capacity', 'links', 'xrefs'].map((n) => `${n}.jsonl`));

// ---------- node types and relations (open grammars) ----------
/** Core node types. `plan` and `doc` are derived (no file); `plantask` and `openitem` have no node file either. */
export const CORE_NODE_TYPES = Object.freeze(['ticket', 'person', 'sprint', 'epic', 'plantask', 'openitem', 'plan', 'doc', 'repo'] as const);
type CoreNodeType = (typeof CORE_NODE_TYPES)[number];
/** An extension node type: `x-<sys>.<kind>`, each part `[a-z][a-z0-9-]{0,23}`. Opaque: no rule reads it. */
export const EXT_TYPE_RE = /^x-[a-z][a-z0-9-]{0,23}\.[a-z][a-z0-9-]{0,23}$/;
export type NodeType = CoreNodeType | `x-${string}.${string}`;
export const isNodeType = (s: unknown): s is NodeType => typeof s === 'string' && ((CORE_NODE_TYPES as readonly string[]).includes(s) || EXT_TYPE_RE.test(s));
const isExtType = (s: unknown): boolean => typeof s === 'string' && EXT_TYPE_RE.test(s);

/** Relations a person may write in links.jsonl. Informational or trace: no blocker, capacity, solver or verify rule reads them. */
export const RELATIONS = Object.freeze(['relates_to', 'depends_on', 'touches'] as const);
/** Relations that exist only as views over another file; a links.jsonl row with one of them is a data error. */
export const DERIVED_RELATIONS = Object.freeze(['needs', 'assigned_to', 'scheduled_in', 'belongs_to', 'implements', 'held_by', 'part_of', 'specified_by', 'tracked_by', 'owned_by'] as const);
export type DerivedRel = (typeof DERIVED_RELATIONS)[number];
/** The file that holds each derived relation (the fact is stored there, once). */
export const V1_HOME: Readonly<Record<DerivedRel, string>> = Object.freeze({
  needs: 'edges.jsonl', assigned_to: 'schedule.jsonl', scheduled_in: 'schedule.jsonl', belongs_to: 'tickets.jsonl', implements: 'refs.jsonl', held_by: 'open-items.jsonl',
  part_of: 'refs.jsonl or repos.jsonl', specified_by: 'refs.jsonl', tracked_by: 'xrefs.jsonl', owned_by: 'repos.jsonl',
});
/** An extension relation: `x-<sys>/<rel>`. Informational by grammar. */
export const EXT_REL_RE = /^x-[a-z][a-z0-9-]{0,23}\/[a-z][a-z0-9_-]{0,23}$/;
export type Semantics = 'order' | 'load' | 'slot' | 'gate' | 'group' | 'trace' | 'identity' | 'info';
/** What each relation means to the rules. Only order, load, slot and gate are read by blockers, capacity, the solver and verify. */
export const REL_SEMANTICS: Readonly<Record<DerivedRel | (typeof RELATIONS)[number], Semantics>> = Object.freeze({
  needs: 'order', assigned_to: 'load', scheduled_in: 'slot', held_by: 'gate', belongs_to: 'group',
  implements: 'trace', part_of: 'trace', specified_by: 'trace', touches: 'trace', tracked_by: 'identity',
  relates_to: 'info', depends_on: 'info', owned_by: 'info',
});

// ---------- the id rule ----------
const ID_MAX = 200;
const ID_BAD = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/; // C0, DEL, C1, line breaks, bidirectional marks
/** Why an id breaks the id rule (at most 200 characters; no control, bidirectional or line-break character), or null. Rows already in a
 * file only produce a warning; a command that writes a new row refuses it. */
export function idProblem(id: string): string | null {
  if (id.length > ID_MAX && [...id].length > ID_MAX) return `is longer than ${ID_MAX} characters`; // UTF-16 units are never fewer than characters
  return ID_BAD.test(id) ? 'holds a control, bidirectional or line-break character' : null;
}

// ---------- xrefs ----------
/** The `sys` of an xref: a lower-case name, optionally `:<alias>` or `:<owner>/<name>` (no host, no URL, no `..`). */
const SYS_RE = /^[a-z][a-z0-9-]{0,23}(?::[A-Za-z0-9._-]{1,100}(?:\/[A-Za-z0-9._-]{1,100})?)?$/;
const KNOWN_SYS = new Set(['jira', 'github', 'gitlab', 'bitbucket', 'linear', 'confluence', 'ci', 'local', 'sp']);
/** The generic `xid` rule: `[A-Za-z0-9._:/#@ -]{1,200}`, no `..`, no URL, nothing shaped like an email address. */
const XID_RE = /^[A-Za-z0-9._:/#@ -]{1,200}$/;
export const sysOk = (s: string): boolean => SYS_RE.test(s) && !s.includes('..');
export const xidOk = (s: string): boolean => XID_RE.test(s) && !s.includes('..') && !s.includes('://') && !/^[^@ ]+@[^@ ]+\.[^@ ]+$/.test(s);
const sysKnown = (s: string): boolean => KNOWN_SYS.has(s.split(':')[0] as string) && (s.includes(':') || s === 'sp'); // split always returns one item

// ---------- rows ----------
/** Row types: the known fields, plus whatever else a newer tool wrote (kept, never read). */
export type Person = { id: string; name?: string; active?: boolean; schema_version?: number; [k: string]: unknown };
export type Sprint = { n: number; name?: string; start?: string; end?: string; state?: string; schema_version?: number; [k: string]: unknown };
export type Epic = { id: string; name?: string; schema_version?: number; [k: string]: unknown };
export type Repo = { id: string; name?: string; role?: string; langs?: string[]; pm?: string; runtime?: string; frameworks?: string[]; cmds?: Record<string, string>; entry?: string[]; deploy?: string; owners?: string[]; paths?: Array<{ glob: string; sub: string }>; src?: string; fp?: string; scanned_at?: string; scanner?: string; schema_version?: number; [k: string]: unknown };
export type CapacityRow = { person: string; sprint: number; sp: number; review_h?: number; schema_version?: number; [k: string]: unknown };
export type Link = { from: string; from_type: NodeType; rel: string; to: string; to_type: NodeType; attrs?: Record<string, unknown>; schema_version?: number; [k: string]: unknown };
export type Xref = { type: NodeType; id: string; sys: string; xid: string; src?: string; seen?: string; note?: string; schema_version?: number; [k: string]: unknown };
export type GraphFiles = {
  people: readonly Person[]; sprints: readonly Sprint[]; epics: readonly Epic[]; repos: readonly Repo[]; capacity: readonly CapacityRow[]; links: readonly Link[]; xrefs: readonly Xref[];
  /** rows that hold an extension type, relation or sys: accepted, never read (`plangraph doctor` prints `ext ignored N`) */
  ext: number;
  /** ids outside the id rule in rows that were already there (a warning, never an error) */
  warnings: readonly string[];
};

export type GraphDataErrorCode = 'LINK_UNKNOWN_REL' | 'LINK_DERIVED_REL' | 'DUPLICATE_NODE' | 'XREF_BAD_ID';
/** What a read collects besides the rows: id-rule warnings and the number of rows with an extension. */
export type GraphNotes = { warnings: string[]; ext: number };

const KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'people.jsonl': ['id'], 'sprints.jsonl': ['n'], 'epics.jsonl': ['id'], 'repos.jsonl': ['id'], 'capacity.jsonl': ['person', 'sprint'], 'xrefs.jsonl': ['type', 'id', 'sys', 'xid'],
});
const ID_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'people.jsonl': ['id'], 'epics.jsonl': ['id'], 'repos.jsonl': ['id'], 'capacity.jsonl': ['person'], 'links.jsonl': ['from', 'to'], 'xrefs.jsonl': ['id'],
});
const SPRINT_ENDPOINT = /^S-?\d{1,15}$/;

/** The line number of each record (blank lines are not records; parseJsonl already accepted every line). */
function lineNumbers(text: string): number[] {
  const out: number[] = [];
  const lines = text.replace(/^\ufeff/, '').split('\n');
  for (let i = 0; i < lines.length; i++) if ((lines[i] as string).trim()) out.push(i + 1); // i is inside the array
  return out;
}

/** Reads and checks the text of one graph file. Throws IngestError (a data error, exit 2) naming `<file>:<line>:`; a code-bearing error
 * starts with its code (LINK_UNKNOWN_REL, LINK_DERIVED_REL, DUPLICATE_NODE, XREF_BAD_ID). Non-canonical order is not an error (an older
 * merge driver rewrites these files in its own order); an identical row twice is one row. `notes` collects warnings and the extension count. */
export function parseGraphFile(name: string, text: string, notes?: GraphNotes): readonly Rec[] {
  const base = path.basename(name);
  if (!GRAPH_FILES.includes(base)) throw new TypeError(`not a graph file: ${oneLine(base, 60)}`);
  const recs = parseJsonl(text, name, { validate: validators[base] as (r: Rec) => string | null });
  const lines = lineNumbers(text), errs: string[] = [], keyOf = KEYS[base], seen = new Map<string, string>(), out: Rec[] = [];
  const bad = (i: number, msg: string, code?: GraphDataErrorCode) => errs.push(`${code ? `${code} ` : ''}${name}:${lines[i]}: ${msg}`);
  const warn = (i: number, field: string, why: string) => notes?.warnings.push(`${name}:${lines[i]}: "${field}" ${why}`);
  recs.forEach((r, i) => {
    let ext = false;
    for (const f of ID_FIELDS[base] ?? []) {
      const p = idProblem(r[f] as string); // the field shape check made every id field a non-empty string
      if (p) warn(i, f, `${p} (the id rule applies to new rows)`);
    }
    if (base === 'links.jsonl') ext = checkLink(r, (m, c) => bad(i, m, c));
    else if (base === 'xrefs.jsonl') ext = checkXref(r, (m, c) => bad(i, m, c));
    if (ext && notes) notes.ext++;
    if (keyOf) {
      const k = keyOf.map((f) => String(r[f])).join('\x00'), line = canonLine(r), prev = seen.get(k);
      if (prev === undefined) { seen.set(k, line); out.push(r); }
      else if (prev !== line) bad(i, `duplicate ${keyOf.length > 1 ? 'key' : keyOf[0]} ${oneLine(keyOf.map((f) => String(r[f])).join(' | '), 80)} (a merge by an older plangraph can leave two rows; keep one row, then run plangraph build)`, 'DUPLICATE_NODE');
    } else out.push(r);
  });
  if (errs.length) throw new IngestError(errs, 'IngestError', { total: errs.length });
  return out;
}

/** The checks of one links.jsonl row; returns whether it uses an extension. */
function checkLink(r: Rec, bad: (msg: string, code?: GraphDataErrorCode) => void): boolean {
  let ext = false;
  for (const f of ['from_type', 'to_type'] as const) {
    if (!isNodeType(r[f])) bad(`"${f}" must be a node type (${CORE_NODE_TYPES.join(', ')} or x-<sys>.<kind>)`);
    else if (isExtType(r[f])) ext = true;
  }
  const rel = r.rel as string; // the field shape check made it a non-empty string
  if ((RELATIONS as readonly string[]).includes(rel)) { /* hand-authored relation */ }
  else if ((DERIVED_RELATIONS as readonly string[]).includes(rel)) bad(`"rel" ${oneLine(rel, 40)} is derived, not stored; it lives in ${V1_HOME[rel as DerivedRel]}`, 'LINK_DERIVED_REL');
  else if (rel.startsWith('x-')) { if (EXT_REL_RE.test(rel)) ext = true; else bad('"rel" must be x-<sys>/<rel> when it starts with x-'); }
  else bad(`"rel" ${oneLine(rel, 40)} is not a relation of links.jsonl (${RELATIONS.join(', ')} or x-<sys>/<rel>)`, 'LINK_UNKNOWN_REL');
  for (const [f, t] of [['from', r.from_type], ['to', r.to_type]] as const) {
    const v = r[f] as string;
    if (t === 'sprint' && !SPRINT_ENDPOINT.test(v)) bad(`"${f}" must be S<n> for a sprint`);
    else if (t === 'openitem' && v.split('|').length !== 2) bad(`"${f}" must be <key>|<kind> for an openitem`);
  }
  return ext;
}

/** The checks of one xrefs.jsonl row; returns whether it uses an extension (an extension type or a `sys` this version does not know). */
function checkXref(r: Rec, bad: (msg: string, code?: GraphDataErrorCode) => void): boolean {
  let ext = false;
  if (!isNodeType(r.type)) bad(`"type" must be a node type (${CORE_NODE_TYPES.join(', ')} or x-<sys>.<kind>)`);
  else if (isExtType(r.type)) ext = true;
  const sys = r.sys as string, xid = r.xid as string; // the field shape check made both non-empty strings
  if (!sysOk(sys)) bad('"sys" must be <name>, <name>:<alias> or <name>:<owner>/<repo> (lower-case name, no host, no URL)', 'XREF_BAD_ID');
  else if (!sysKnown(sys)) ext = true;
  if (!xidOk(xid)) bad('"xid" must be 1 to 200 characters of A-Z a-z 0-9 . _ : / # @ space - with no "..", no URL and no email address', 'XREF_BAD_ID');
  return ext;
}

const CAP = 64 * 1024 * 1024;
/** Every graph file of a plan directory (a missing file gives no rows; a symlink or a non-regular file is refused, as for the v1 files). */
export function readGraphFiles(dir: string): GraphFiles {
  const notes: GraphNotes = { warnings: [], ext: 0 }, got: Record<string, readonly Rec[]> = {};
  for (const f of GRAPH_FILES) {
    const p = path.join(dir, f);
    if (!presentDataFile(p)) { got[f] = []; continue; }
    let text: string;
    try { text = readDataCapped(p, CAP); } catch (e) { if (DATA_REFUSALS.has((e as { code?: string }).code as string)) throw new IngestError(`${f}: ${(e as Error).message}`); throw e; } // whatever was thrown: its code is read
    got[f] = parseGraphFile(f, text, notes);
  }
  const of = <T>(f: string): readonly T[] => got[f] as unknown as readonly T[]; // parseGraphFile returned rows of that file, shape-checked
  return { people: of('people.jsonl'), sprints: of('sprints.jsonl'), epics: of('epics.jsonl'), repos: of('repos.jsonl'), capacity: of('capacity.jsonl'), links: of('links.jsonl'), xrefs: of('xrefs.jsonl'), ext: notes.ext, warnings: notes.warnings };
}
