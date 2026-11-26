// The SQLite index: schema, build, open. The index is derived from the JSONL text and git-ignored.
// - node:sqlite is loaded on first use (process.getBuiltinModule, synchronous and lazy), never at import time, so commands that do not
//   need the index never touch it, and an old Node gets one ENV error (exit 3) instead of a crash.
// - SQL identifiers come only from constants: the column list of each table is lib/store.ts SCHEMAS[file].order (frozen here); record
//   keys never reach a statement. Fields outside that list are kept, as canonical JSON, in the `extra` column.
// - buildIndex parses every file first, writes a temp file beside the index, checks its integrity, and renames it over the old index
//   only when everything loaded: a failed build keeps the old index. The same bytes that were parsed are hashed into a source fingerprint
//   (sha256 over the sorted index source files), stored in table index_meta under key source_fingerprint.
// - openIndex({ dir }) recomputes the fingerprint: a mismatch (or an index without one, such as one built by the old bin/plangraph) sets
//   handle.stale = true and turns on PRAGMA query_only.
// - Content integrity: buildIndex also stores a sha256 digest of the index CONTENT (every row of every table, index_meta included except the
//   digest row itself, in a canonical order: primary key, then every column) under index_meta key content_digest. openIndex recomputes it
//   (streaming, one row at a time) and refuses a mismatch as DATA with the `plangraph build` hint, so a row edited directly inside plangraph.sqlite is
//   never served. An index without a digest (an older build) is flagged stale (query-only) and index writes refuse it. The legitimate index
//   writers (whatif --write, schedule-load, stampFingerprint) re-stamp the digest with stampContent before COMMIT. The digest is unkeyed: it
//   detects direct edits, not a forger who recomputes it (docs/CONTRACT.md).
// - Graph data (docs/FORMAT.md section 7): seven more tables (person, sprint, epic, repo, capacity, link, xref) from the graph files, and
//   two views, g_nodes and g_links (lib/graph/views.ts), whose `sql` must be byte-equal to the DDL this build writes. An index built by
//   0.3.0 (the eight v1 tables, no view) is a known older schema: its digest is checked over the 0.3.0 table list, it opens stale and
//   query-only (handle.older), and an index writer refuses it with STALE. Every column name in the SQL built here is double-quoted
//   (`from` and `to` are SQL keywords). A graph file adds bytes to the source fingerprint only when it is present, so a directory with
//   none keeps its 0.3.0 fingerprint.
// - Observations (0.5.0): the table `obs` holds the rows of the uncommitted cache <dir>/cache/<provider>.jsonl (lib/graph/provider.ts CACHE_FILES).
//   A cache file adds bytes to the source fingerprint only when it is present, so a directory without a cache keeps its fingerprint. An index
//   built before `obs` existed (0.4.0) has an unexpected schema: `plangraph build` rebuilds it. The table is advisory data, read by no solver.
// The fingerprint lives in its own table, not in `meta`: `meta` mirrors meta.jsonl and is exported back to text, so a fingerprint row
// there would leak into meta.jsonl (and collide with a user key of the same name).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SCHEMAS } from '../lib/store.ts';
import type { Schema } from '../lib/store.ts';
import { parseJsonl, readDataCapped, IngestError, DATA_REFUSALS } from '../lib/jsonl.ts';
import { validators } from '../lib/schema.ts';
import { GRAPH_FILES, parseGraphFile } from '../lib/graph/files.ts';
import { GRAPH_VIEWS } from '../lib/graph/views.ts';
import { CACHE_FILES, OBS_COLUMNS, obsProblem } from '../lib/graph/obs.ts';
import { PlangraphError } from './errors.ts';
import { nodeSupported, floorMessage } from './floor.js';
import type { DatabaseSync, StatementSync, SQLInputValue } from 'node:sqlite';

export const INDEX_FILE = 'plangraph.sqlite';
export const NO_PLANGRAPH_MESSAGE = 'no plan directory: run `plangraph init`';
export const FINGERPRINT_KEY = 'source_fingerprint';
export const CONTENT_KEY = 'content_digest';
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const IDENT = /^[a-z][a-z0-9_]*$/;

const OBS_FILE = 'cache/obs'; // the name of the table's source in TABLES; the real files are CACHE_FILES
// [table, file, primary key, INTEGER columns, upsert]. learnings and refs are INSERT OR REPLACE (a later line with the same id wins),
// as in bin/plangraph; the other tables refuse a duplicate primary key.
const DEFS: Array<[string, string, string[], string[], boolean]> = [
  ['ticket', 'tickets.jsonl', ['key'], ['sp', 'v2_sprint'], false],
  ['schedule', 'schedule.jsonl', ['version', 'key'], ['sprint'], false],
  ['edge', 'edges.jsonl', ['consumer', 'producer'], [], false],
  ['evidence', 'evidence.jsonl', [], [], false],
  ['finding', 'findings.jsonl', [], [], false],
  ['meta', 'meta.jsonl', ['k'], [], false],
  ['learning', 'learnings.jsonl', ['id'], [], true],
  ['ref', 'refs.jsonl', ['key'], [], true],
  // graph files: nodes keyed per file, links a set (no key), xrefs keyed by the whole reference
  ['person', 'people.jsonl', ['id'], [], false],
  ['sprint', 'sprints.jsonl', ['n'], ['n'], false],
  ['epic', 'epics.jsonl', ['id'], [], false],
  ['repo', 'repos.jsonl', ['id'], [], false],
  ['capacity', 'capacity.jsonl', ['person', 'sprint'], ['sprint', 'sp', 'review_h'], false], // sp and review_h keep INTEGER affinity (a fractional value stays a number, as ticket.sp)
  ['link', 'links.jsonl', [], [], false],
  ['xref', 'xrefs.jsonl', ['type', 'id', 'sys', 'xid'], [], false],
  ['obs', OBS_FILE, ['sys', 'xid'], [], false], // rows of every cache/<provider>.jsonl; no file of its own, so it is never exported
];
const V1_TABLE_COUNT = 8; // the first eight rows of DEFS are the tables of format 1 (an index built by 0.3.0 holds exactly these)
const q = (c: string): string => `"${c}"`; // every column name in SQL is quoted
const toObj = (v: unknown) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : v);
const same = (v: unknown) => v;
/** Per-table record preparation: the record as inserted, and the conversion of each known-column value. */
type Prep = [(r: Record<string, unknown>) => Record<string, unknown>, (v: unknown) => unknown];
// Per-table record preparation, as bin/plangraph does it: tickets..meta store object values as JSON text; learnings and refs get defaults.
// schedule: `version` defaults to `current` (docs/FORMAT.md, lib/model.ts); the default is applied HERE, before the insert, so the index,
// every `version='current'` query and export agree on a row that omits it (export then writes it explicitly).
// Graph tables: a boolean, an object or an array in a known column is stored as canonical JSON text (node:sqlite binds neither), so the same
// object with a different key order is the same text.
const canonConv = (v: unknown): unknown => (v !== null && typeof v === 'object' ? canonJson(v) : typeof v === 'boolean' ? String(v) : v);
const keep = (r: Record<string, unknown>): Record<string, unknown> => r;
const PREP = new Map<string, Prep>([
  ['person', [keep, canonConv]],
  ['link', [keep, canonConv]],
  ['repo', [keep, canonConv]],
  ['obs', [keep, canonConv]],
  ['schedule', [(r) => ({ ...r, version: r.version ?? (SCHEMAS['schedule.jsonl'] as Schema).defaults.version }), toObj]], // a key SCHEMAS literally declares
  ['learning', [(r) => ({ ...r, why: r.why || '', source: r.source || '' }), same]],
  ['ref', [(r) => ({ ...r, plans: JSON.stringify(r.plans || []), files: JSON.stringify(r.files || {}), fp_files: r.fp_files || '', jira_updated: r.jira_updated || '', audited_at: r.audited_at || '' }), same]],
]);

export interface TableSpec { name: string; file: string; columns: readonly string[]; upsert: boolean; known: Set<string>; text: Set<string>; scalar: readonly string[];
  columnList: string; placeholders: string; ddl: string; prep: Prep; order: string }
// Columns whose record values are converted by PREP before the insert (refs.plans is an array, refs.files an object): not scalar-checked.
const PREPPED = new Map([['ref', new Set(['plans', 'files'])], ['person', new Set(['active'])], ['link', new Set(['attrs'])], ['repo', new Set(['langs', 'frameworks', 'cmds', 'entry', 'owners', 'paths'])], ['obs', new Set(['fields', 'links'])]]);
export const TABLES = new Map<string, Readonly<TableSpec>>(DEFS.map(([name, file, pk, ints, upsert]) => {
  const columns = Object.freeze(file === OBS_FILE ? [...OBS_COLUMNS] : [...(SCHEMAS[file] as Schema).order]); // file is one of DEFS' own schema keys
  for (const c of [name, ...columns]) if (!IDENT.test(c) || c === 'extra') throw new Error(`bad identifier in schema: ${c}`);
  const all = [...columns, 'extra'];
  const types = columns.map((c: string) => `${q(c)} ${ints.includes(c) ? 'INTEGER' : 'TEXT'}`);
  return [name, Object.freeze({
    name, file, columns, upsert,
    known: new Set<string>(columns),
    text: new Set<string>(columns.filter((c: string) => !ints.includes(c))),
    scalar: Object.freeze(columns.filter((c: string) => !ints.includes(c) && !PREPPED.get(name)?.has(c))),
    columnList: all.map(q).join(','),
    placeholders: all.map(() => '?').join(','),
    ddl: [...types, '"extra" TEXT', ...(pk.length ? [`PRIMARY KEY(${pk.map(q).join(',')})`] : [])].join(', '),
    prep: PREP.get(name) ?? ([same, toObj] as Prep), // the default preparation pair
    // canonical digest order: the primary key, then every other column (rows that tie on all of them are identical, so order is total)
    order: [...pk, ...all.filter((c) => !pk.includes(c))].map(q).join(','),
  })];
}));
Object.freeze(TABLES);
const SOURCE_FILES = Object.freeze([...[...TABLES.values()].map((t) => t.file).filter((f) => f !== OBS_FILE), ...CACHE_FILES].toSorted());
const GRAPH_SET: ReadonlySet<string> = new Set([...GRAPH_FILES, ...CACHE_FILES]); // files that add bytes to the fingerprint only when present
const V1_TABLES = Object.freeze([...TABLES.values()].slice(0, V1_TABLE_COUNT));
const GRAPH_TABLE_NAMES = Object.freeze([...TABLES.values()].slice(V1_TABLE_COUNT).map((t) => t.name));
const DDL = [...TABLES.values()].map((t) => `CREATE TABLE ${t.name}(${t.ddl});`).join('\n')
  + '\nCREATE INDEX edge_p ON edge(producer); CREATE INDEX ev_k ON evidence(key);\nCREATE TABLE index_meta(k TEXT PRIMARY KEY, v TEXT);\n'
  + GRAPH_VIEWS.map(([, sql]) => `${sql};`).join('\n');

// ---------- node:sqlite, lazily ----------
let sqlite: typeof import('node:sqlite') | undefined;
/** Load node:sqlite once (the one import line; node:sqlite prints no warning on Node 24.15+). Throws PlangraphError ENV (exit 3) on Node < 24.15. */
export function loadSqlite({ version = process.versions.node }: { version?: string } = {}): typeof import('node:sqlite') {
  if (!nodeSupported(version)) throw new PlangraphError('ENV', floorMessage(version));
  if (sqlite) return sqlite;
  sqlite = process.getBuiltinModule('node:sqlite');
  return sqlite;
}

// ---------- handle ----------
/** A database handle usable with `using`: closes on dispose (idempotent), caches prepared statements by key. */
export class IndexHandle {
  #db: DatabaseSync; #stmts = new Map<string, StatementSync>();
  /** true: the text changed since the build (query_only is on); false: verified fresh; null: not verified. */
  stale: boolean | null = null;
  /** sha256 hex of the text now / of the text the index was built from (null: not verified, or an index without one). The built one is read
   * from the index as stored (index_meta.v of an index without a digest is not verified), so readers convert it with String(). */
  fingerprint: string | null = null; builtFingerprint: unknown = null;
  /** true: built by a plangraph before the graph views existed (the 0.3.0 table list, no view): answers v1 questions, refuses writes. */
  older = false;
  constructor(db: DatabaseSync) { this.#db = db; }
  get isOpen(): boolean { return this.#db.isOpen; }
  exec(sql: string): void { this.#db.exec(sql); }
  prepare(sql: string): StatementSync { return this.#db.prepare(sql); }
  cached(key: string, sql: string): StatementSync { let s = this.#stmts.get(key); if (!s) { s = this.#db.prepare(sql); this.#stmts.set(key, s); } return s; }
  /** Rows of a query, unchecked (the caller narrows each row it reads). Bound values: node:sqlite refuses an unsupported type at run time. */
  all(sql: string, ...a: unknown[]): unknown[] { return this.cached(sql, sql).all(...(a as SQLInputValue[])); } // node:sqlite refuses an unsupported value at run time
  /** The first row of a query, or undefined; unchecked, as all(). */
  get(sql: string, ...a: unknown[]): unknown { return this.cached(sql, sql).get(...(a as SQLInputValue[])); } // node:sqlite refuses an unsupported value at run time
  close(): void { this.#stmts.clear(); if (this.#db.isOpen) this.#db.close(); }
  [Symbol.dispose]() { this.close(); }
}

// ---------- records ----------
// Canonical JSON (sorted keys, undefined dropped), written by hand so "__proto__" stays a plain key. Same bytes as bin/plangraph canonJson.
const canonJson = (v: unknown): string => (v === null || v === undefined ? 'null' : Array.isArray(v) ? `[${v.map(canonJson).join(',')}]`
  : typeof v === 'object' ? `{${Object.keys(v).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonJson((v as Record<string, unknown>)[k])}`).join(',')}}` : JSON.stringify(v)); // a non-null object: typeof checked
// Known-column values in the constant column order, then the canonical JSON of every field a column cannot give back exactly (null when
// there is none): unknown fields, an explicit null in a known column (NULL there means "absent"), and a number in a TEXT column (the
// column holds its JSON text, e.g. "123", for queries; export restores the number). So build then export is byte-stable.
function rowOf(t: Readonly<TableSpec>, rec: Record<string, unknown>): unknown[] {
  const [pre, conv] = t.prep, r = pre(rec);
  const vals: unknown[] = t.columns.map((c) => (!Object.hasOwn(r, c) ? null : typeof r[c] === 'number' && t.text.has(c) ? JSON.stringify(r[c]) : conv(r[c])));
  const rest: Record<string, unknown> = Object.create(null); let any = false;
  for (const k of Object.keys(r)) {
    if (r[k] === undefined || (t.known.has(k) && !(r[k] === null || (typeof r[k] === 'number' && t.text.has(k))))) continue;
    Object.defineProperty(rest, k, { value: r[k], enumerable: true, writable: true, configurable: true }); any = true;
  }
  vals.push(any ? canonJson(rest) : null);
  return vals;
}
// A known TEXT column holds a string or a number (or null / absent); anything else is a data error at file:line, naming the field only.
const scalarCheck = (t: Readonly<TableSpec>) => (r: Record<string, unknown>): string | null => {
  for (const c of t.scalar) { const v = r[c]; if (Object.hasOwn(r, c) && v !== null && v !== undefined && typeof v !== 'string' && typeof v !== 'number') return `"${c}" must be a string or a number`; }
  return null;
};
const validatorOf = (t: Readonly<TableSpec>): ((r: Record<string, unknown>) => string | null) => { const v = Object.hasOwn(validators, t.file) ? validators[t.file] : null, sc = scalarCheck(t); return (r) => (v ? v(r) : null) || sc(r); };

// ---------- sources and fingerprint ----------
// Reads every index source once (capped, regular files only). Missing file -> null. Returns [[file, text|null]] sorted by file name.
function readSources(dir: string): Array<[string, string | null]> {
  return SOURCE_FILES.map((f) => {
    // A source file is a regular file inside the plan directory: a symlink (even to a file outside the repo) is refused before any read.
    if (f.startsWith('cache/')) { let c = null; try { c = fs.lstatSync(path.join(dir, 'cache')); } catch { /* no cache */ } if (c?.isSymbolicLink()) throw new IngestError('cache: is a symlink, not a directory'); } // the cache directory itself is never followed
    let st = null; try { st = fs.lstatSync(path.join(dir, f)); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } // fs throws errno errors
    if (st?.isSymbolicLink()) throw new IngestError(`${f}: is a symlink, not a regular file`);
    try { return [f, readDataCapped(path.join(dir, f), MAX_SOURCE_BYTES)]; } // O_NOFOLLOW + dev/ino check: no swap after the lstat
    catch (e) { // fs errno errors and readDataCapped's coded refusals
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [f, null]; // fs and the readers throw errno-style errors with a code
      if (DATA_REFUSALS.has((e as { code: string }).code)) throw new IngestError(`${f}: ${(e as Error).message}`); // a missing code is simply not in the set
      throw e;
    }
  });
}
function fingerprintOf(sources: Array<[string, string | null]>): string {
  const h = crypto.createHash('sha256');
  for (const [f, text] of sources) {
    if (text === null) { if (!GRAPH_SET.has(f)) h.update(`${f}\0-\0`); continue; } // a missing graph file adds no bytes: a v1-only directory keeps its 0.3.0 fingerprint
    const b = Buffer.from(text, 'utf8');
    h.update(`${f}\0${b.length}\0`); h.update(b); h.update('\0');
  }
  return h.digest('hex');
}
/** sha256 (hex) over the sorted index source files of dir: name, byte length and bytes of each; a missing file differs from an empty one. */
export const sourceFingerprint = (dir: string): string => fingerprintOf(readSources(dir));

// ---------- content digest ----------
// sha256 over every table in the fixed TABLES order, then index_meta without the digest row: per table its name, then one SQLite json_array
// per row (a TEXT '3' and an INTEGER 3 differ; JSON escapes newlines, so the row separator is unambiguous; a BLOB, which json_array refuses,
// makes the digest fail, which openIndex treats as a mismatch). Rows are streamed and hashed in 64 KiB batches, so memory stays flat on a
// large index; the ORDER BY makes the digest independent of physical row order (VACUUM). SQL text comes only from the frozen table specs.
// Cost (docs/CONTRACT.md): about 5 ms at 1,400 tickets and 0.4 s at 100,000 tickets (533k rows) on the dev machine; a full digest, no sampling.
export function contentDigest(h: IndexHandle, tables: readonly Readonly<TableSpec>[] = [...TABLES.values()]): string {
  const hash = crypto.createHash('sha256');
  const feed = (name: string, sql: string, args: SQLInputValue[]) => {
    let buf = `${name}\0`;
    const st = h.prepare(sql); st.setReturnArrays(true);
    for (const row of st.iterate(...args)) { buf += `${row[0]}\n`; if (buf.length > 65536) { hash.update(buf); buf = ''; } }
    hash.update(buf);
  };
  for (const t of tables) feed(t.name, `SELECT json_array(${t.columnList}) FROM ${t.name} ORDER BY ${t.order}`, []);
  feed('index_meta', 'SELECT json_array(k, v) FROM index_meta WHERE k <> ? ORDER BY k, v', [CONTENT_KEY]);
  return hash.digest('hex');
}
/** Store the content digest of the index as it is now (inside the caller's transaction, before COMMIT). Returns it. */
export function stampContent(h: IndexHandle): string {
  const digest = contentDigest(h);
  h.prepare('INSERT OR REPLACE INTO index_meta(k, v) VALUES(?, ?)').run(CONTENT_KEY, digest);
  return digest;
}

// ---------- build ----------
export const TEMP_MAX_AGE_MS = 10 * 60 * 1000;
// Is the process with this pid alive? kill(pid, 0) sends nothing: ESRCH means gone, EPERM means alive but not ours.
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } // process.kill throws errno errors
}
/** Remove leftovers of crashed builds: `<index>.tmp-<pid>` files that are older than TEMP_MAX_AGE_MS or whose pid is dead (or is
 * this process: a build runs synchronously, so a temp file with our own pid is a leftover). A fresh temp file of another live build
 * is never touched, so two concurrent builds cannot delete each other's work. Only regular files with this exact prefix are removed. */
export function removeStaleTemps(where: string, prefix: string, now: number = Date.now()): void {
  for (const f of fs.readdirSync(where)) {
    if (!f.startsWith(prefix)) continue;
    const p = path.join(where, f); let st: fs.Stats;
    try { st = fs.lstatSync(p); } catch { continue; }
    if (!st.isFile()) continue;
    const tail = f.slice(prefix.length), pid = /^\d{1,10}$/.test(tail) ? Number(tail) : NaN;
    const old = now - st.mtimeMs > TEMP_MAX_AGE_MS;
    const dead = Number.isSafeInteger(pid) && pid > 0 && (pid === process.pid || !pidAlive(pid));
    if (old || dead) fs.rmSync(p, { force: true });
  }
}

// ---------- SQLite sidecars ----------
// SQLite keeps a rollback journal (`<db>-journal`) or WAL files (`<db>-wal`, `<db>-shm`) beside a database. A HOT journal found at open is
// replayed into the database on the first read-write open (and makes every read-only open fail), whatever database it came from: a planted
// or committed `plangraph.sqlite-journal` could turn a freshly built index into an attacker's copy with a valid digest. plangraph never uses WAL and
// its own writes (journal_mode DELETE) remove their journal on commit, so a sidecar beside the index is never legitimate when an index
// command starts: openIndex refuses it (DATA, `plangraph build`) before SQLite sees the file, and buildIndex removes regular ones (they belong to
// a prior or foreign index and must never be replayed) and refuses a symlink or non-file (REFUSED: removing it is left to a person).
export const SIDECARS = Object.freeze(['-journal', '-wal', '-shm']);
/** Existing sidecars of `base` as [path, lstat]. */
export function sidecarsOf(base: string): Array<[string, fs.Stats]> {
  const found: Array<[string, fs.Stats]> = [];
  for (const s of SIDECARS) {
    let st = null; try { st = fs.lstatSync(base + s); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT' && (e as NodeJS.ErrnoException).code !== 'ENOTDIR') throw e; } // fs throws errno errors
    if (st) found.push([base + s, st]);
  }
  return found;
}
/** Refuse (REFUSED) a sidecar of `base` that is not a regular file; with remove, delete the regular ones (unlink: a symlink swapped in after
 * the lstat is removed itself, never followed). */
function clearSidecars(base: string, remove: boolean): void {
  for (const [p, st] of sidecarsOf(base)) {
    if (!st.isFile()) throw new PlangraphError('REFUSED', `refusing to build the index: ${path.basename(p)} is ${st.isSymbolicLink() ? 'a symlink' : 'not a regular file'}; remove it by hand, then run \`plangraph build\``);
    if (remove) fs.rmSync(p, { force: true });
  }
}

// The INSERT of one table: built only from the frozen table spec and the verb, never from a record (no record parameter).
const insertSql = (t: Readonly<TableSpec>, verb = 'INSERT') => `${verb} INTO ${t.name}(${t.columnList}) VALUES(${t.placeholders})`;

/** The rows of a graph file: one reader (parseGraphFile: shapes, grammars, duplicate keys), then the column-type check every table gets. */
function graphRows(t: Readonly<TableSpec>, text: string): readonly Record<string, unknown>[] {
  const recs = parseGraphFile(t.file, text), sc = scalarCheck(t);
  recs.forEach((r, i) => { const m = sc(r); if (m) throw new IngestError(`${t.file}: record ${i + 1}: ${m}`); });
  return recs;
}

/** The rows of every cache file, in file order; each row is checked like any input (obsProblem), a duplicate sys+xid is refused by the table's key. */
function obsRows(text: ReadonlyMap<string, string | null>): readonly Record<string, unknown>[] {
  return CACHE_FILES.flatMap((f) => parseJsonl(text.get(f) ?? '', f, { validate: obsProblem }));
}

/** Build the index for ctx.dir into `file` (default <dir>/plangraph.sqlite). Throws IngestError on bad data, keeping the old index. */
export function buildIndex(ctx: { dir: string }, { file = path.join(ctx.dir, INDEX_FILE), now = Date.now() }: { file?: string; now?: number } = {}): { file: string; counts: Record<string, number>; fingerprint: string; digest: string } {
  let st = null;
  try { st = fs.statSync(ctx.dir); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT' && (e as NodeJS.ErrnoException).code !== 'ENOTDIR') throw e; } // fs throws errno errors
  if (!st?.isDirectory()) throw new PlangraphError('DATA', 'no plan directory', { hint: 'run `plangraph init` first' });
  const { DatabaseSync } = loadSqlite();
  removeStaleTemps(path.dirname(file), `${path.basename(file)}.tmp-`, now);
  clearSidecars(file, false); // fail fast on a symlinked or non-file sidecar; regular ones are removed only right before the rename
  const sources = readSources(ctx.dir), text = new Map(sources);
  const fingerprint = fingerprintOf(sources);
  // parse everything before touching the database
  const rows = [...TABLES.values()].map((t) => ([t, t.file === OBS_FILE ? obsRows(text) : GRAPH_SET.has(t.file) ? graphRows(t, text.get(t.file) ?? '') : parseJsonl(text.get(t.file) ?? '', t.file, { validate: validatorOf(t) })] as const));
  const tmp = `${file}.tmp-${process.pid}`;
  // The temp path is created HERE, exclusively and without following a symlink, before SQLite opens it. removeStaleTemps above already
  // unlinked a REGULAR file at this name (our own pid: a leftover of a crashed build); a symlink or other non-file there, or any file that
  // appears at the name after that, is refused and left alone, never written through. Its dev/ino is checked again before the rename. The descriptor stays
  // open until the rename is done: while it is open the inode cannot be freed, so no file created at that path meanwhile (even after a delete;
  // ext4 reuses a freed inode number at once) can have its number, and the dev/ino check is a guarantee. It is closed only after SQLite closed
  // its own (closing any descriptor of a file drops the process's POSIX locks on it, which SQLite holds while it is open).
  let mine: fs.Stats, tfd: number;
  try { tfd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o644); mine = fs.fstatSync(tfd); }
  catch (e) { // fs throws errno errors
    if ((e as NodeJS.ErrnoException).code === 'EEXIST' || (e as NodeJS.ErrnoException).code === 'ELOOP') throw new PlangraphError('REFUSED', 'refusing to build the index: its temp path already exists and was not created by this build'); // fs and the readers throw errno-style errors with a code
    throw e;
  }
  try {
    const counts: Record<string, number> = {}; let digest = '';
    clearSidecars(tmp, true); // a leftover journal at the temp name would be replayed into the build
    {
      using h = new IndexHandle(new DatabaseSync(tmp));
      // journal_mode OFF, set before the first write: SQLite creates no journal (and no WAL) for the temp file at all, so none can be renamed
      // or replayed onto the final name; the build is all-or-nothing anyway (a failed build deletes the temp file).
      h.exec('PRAGMA journal_mode=OFF'); h.exec(DDL); h.exec('BEGIN');
      for (const [t, recs] of rows) {
        const ins = h.cached(t.name, insertSql(t, t.upsert ? 'INSERT OR REPLACE' : 'INSERT')); // once per table
        recs.forEach((r, i) => {
          try { ins.run(...(rowOf(t, r) as SQLInputValue[])); } // node:sqlite refuses an unsupported value: reported below
          catch (e) { throw new IngestError(`${t.file}: record ${i + 1}: ${(String((e as Error).message).split('\n')[0] as string).slice(0, 200)}`); } // node:sqlite throws an Error; split always returns at least one item
        });
      }
      h.prepare('INSERT INTO index_meta(k, v) VALUES(?, ?)').run(FINGERPRINT_KEY, fingerprint);
      digest = stampContent(h);
      h.exec('COMMIT');
      if ((h.get('PRAGMA integrity_check') as { integrity_check: unknown }).integrity_check !== 'ok') throw new PlangraphError('DATA', 'index failed its integrity check'); // the columns this SELECT names
      for (const t of TABLES.values()) counts[t.name] = (h.get(`SELECT COUNT(*) c FROM ${t.name}`) as { c: number }).c; // the pragma and COUNT(*) always return one row
    } // closed here, before the rename
    const now = fs.lstatSync(tmp);
    if (!now.isFile() || now.dev !== mine.dev || now.ino !== mine.ino) throw new PlangraphError('REFUSED', 'refusing to build the index: its temp file was replaced during the build');
    clearSidecars(tmp, true);
    clearSidecars(file, true); // a journal of the old (or a planted) index must never be replayed into the new one
    fs.renameSync(tmp, file); // rename replaces a symlink at `file` itself, never its target
    return { file, counts, fingerprint, digest };
  } catch (e) {
    try { const now = fs.lstatSync(tmp); if (now.isFile() && now.ino === mine.ino && now.dev === mine.dev) fs.rmSync(tmp, { force: true }); } catch { /* gone */ }
    throw e;
  } finally { fs.closeSync(tfd); }
}

// ---------- schema check ----------
// An index is derived and git-ignored, but a committed or planted plangraph.sqlite is attacker-controlled, and its stored fingerprint can match
// the text. Before any query its sqlite_master must be exactly what buildIndex (or the old bin/plangraph build, which lacks index_meta) writes:
// every table of TABLES as a plain table with exactly its columns plus `extra` (no hidden or generated column), optionally index_meta(k, v),
// the indexes edge_p and ev_k, the automatic primary-key indexes, and exactly the two views g_nodes and g_links with `sql` byte-equal to
// lib/graph/views.ts; no other view, no trigger, virtual table or any other object. The one other accepted shape is the schema of 0.3.0 and
// of the old bin/plangraph (only the eight v1 tables, no view): 'older', opened stale and query-only (see openIndex).
export const EXPECTED_COLUMNS = new Map([...[...TABLES.values()].map((t) => ([t.name, [...t.columns, 'extra'].join(',')] as [string, string])), ['index_meta', 'k,v']]); // a [table name, column list] pair
export const EXPECTED_INDEXES = new Map([['edge_p', 'edge'], ['ev_k', 'evidence']]);
const EXPECTED_VIEWS = new Map(GRAPH_VIEWS);
function schemaKind(h: IndexHandle): 'current' | 'older' | null {
  const objects = h.all('SELECT type, name, tbl_name, sql FROM sqlite_master') as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>; // sqlite_master's schema
  const current = objects.some((o) => o.type === 'table' && GRAPH_TABLE_NAMES.includes(o.name)); // any graph table: the full schema is required
  const family = new Map([...EXPECTED_COLUMNS].filter(([n]) => current || n === 'index_meta' || V1_TABLES.some((t) => t.name === n)));
  const tables = new Set<string>(), views = new Set<string>();
  for (const o of objects) {
    if (o.type === 'table') {
      if (!family.has(o.name) || o.name !== o.tbl_name || typeof o.sql !== 'string' || /^\s*CREATE\s+VIRTUAL\b/i.test(o.sql)) return null;
      tables.add(o.name);
    } else if (o.type === 'index') {
      const auto = typeof o.name === 'string' && o.name.startsWith(`sqlite_autoindex_${o.tbl_name}_`) && o.sql === null;
      if (!(auto ? family.has(o.tbl_name) : EXPECTED_INDEXES.get(o.name) === o.tbl_name)) return null;
    } else if (o.type === 'view' && current) {
      if (o.name !== o.tbl_name || EXPECTED_VIEWS.get(o.name) !== o.sql) return null; // a view whose body differs could forge every answer
      views.add(o.name);
    } else return null; // trigger, a view in an older schema, anything else
  }
  for (const t of family.keys()) if (t !== 'index_meta' && !tables.has(t)) return null;
  if (current && views.size !== EXPECTED_VIEWS.size) return null;
  for (const t of tables) {
    const info = h.all('SELECT name, hidden FROM pragma_table_xinfo(?)', t) as Array<{ name: string; hidden: number }>; // the pragma's columns
    if (info.some((c) => c.hidden !== 0) || info.map((c) => c.name).join(',') !== EXPECTED_COLUMNS.get(t)) return null;
  }
  return current ? 'current' : 'older';
}

// ---------- open ----------
/** Open an index. With `dir`, verify its source fingerprint: stale -> handle.stale = true and PRAGMA query_only = ON. */
export function openIndex(file: string, { readOnly = true, dir }: { readOnly?: boolean; dir?: string | undefined } = {}): IndexHandle {
  let lst = null; try { lst = fs.lstatSync(file); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT' && (e as NodeJS.ErrnoException).code !== 'ENOTDIR') throw e; } // fs throws errno errors
  if (!lst) {
    // no plan directory at all: the first step is `plangraph init` (a `plangraph build` there would fail and say so itself)
    let dirOk = false; try { dirOk = fs.statSync(dir ?? path.dirname(file)).isDirectory(); } catch { /* missing */ }
    if (!dirOk) throw new PlangraphError('NO_PLANGRAPH', NO_PLANGRAPH_MESSAGE);
    throw new PlangraphError('NO_INDEX', 'no index: run `plangraph build`');
  }
  // a symlinked index (to a file anywhere, or dangling) is never opened; the SQLite build in Node refuses one too, this does not depend on it
  if (lst.isSymbolicLink()) throw new PlangraphError('DATA', 'the index is a symlink, not a regular file', { hint: 'run `plangraph build` to rebuild it' });
  // SQLite opens without O_NONBLOCK: a FIFO at the index path would block the open forever (every index command, the session hook). Only a
  // regular file is handed to SQLite: lstat, then open it ourselves O_RDONLY|O_NONBLOCK|O_NOFOLLOW (never blocks, never follows), fstat must be
  // a regular file with the lstat's device and inode, close. Residual (docs/CONTRACT.md): the path is swapped between this check and SQLite's
  // own open by path.
  const notFile = () => new PlangraphError('DATA', 'the index is not a regular file', { hint: 'run `plangraph build` to rebuild it' });
  if (!lst.isFile()) throw notFile();
  {
    let fd: number;
    try { fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0) | (fs.constants.O_NOFOLLOW || 0)); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ELOOP' || (e as NodeJS.ErrnoException).code === 'EMLINK') throw new PlangraphError('DATA', 'the index is a symlink, not a regular file', { hint: 'run `plangraph build` to rebuild it' }); // fs and the readers throw errno-style errors with a code
      throw new PlangraphError('DATA', 'the index is not a readable SQLite database', { hint: 'run `plangraph build` to rebuild it', cause: e }); }
    try { const st = fs.fstatSync(fd); if (!st.isFile() || st.dev !== lst.dev || st.ino !== lst.ino) throw notFile(); }
    finally { fs.closeSync(fd); }
  }
  // a sidecar is never handed to SQLite: a hot journal would be replayed (read-write) or fail the open (read-only); see SIDECARS
  const side = sidecarsOf(file);
  if (side.length) throw new PlangraphError('DATA', `the index has a SQLite journal file beside it (${path.basename((side[0] as [string, fs.Stats])[0])}); it is never replayed`, { hint: 'run `plangraph build` to rebuild it' }); // side.length was checked
  const { DatabaseSync } = loadSqlite();
  let h: IndexHandle | undefined;
  try {
    h = new IndexHandle(new DatabaseSync(file, { readOnly }));
    h.get('SELECT COUNT(*) n FROM sqlite_master'); // a non-SQLite or corrupt file fails here, not in the middle of a command
  } catch (e) {
    h?.close();
    throw new PlangraphError('DATA', 'the index is not a readable SQLite database', { hint: 'run `plangraph build` to rebuild it', cause: e });
  }
  let kind: 'current' | 'older' | null = null;
  try { kind = schemaKind(h); } catch { kind = null; }
  const older = kind === 'older';
  if (!kind) { h.close(); throw new PlangraphError('DATA', 'the index has an unexpected schema (not built by plangraph build)', { hint: 'run `plangraph build` to rebuild it' }); }
  try {
    const has = h.get("SELECT 1 x FROM sqlite_master WHERE type='table' AND name='index_meta'");
    const meta = (k: string) => (has ? (h.get('SELECT v FROM index_meta WHERE k=?', k) as { v: unknown } | undefined)?.v : undefined); // one row or none
    const want = meta(CONTENT_KEY);
    if (want === undefined) {
      if (!readOnly) throw new PlangraphError('DATA', 'the index has no integrity digest (built by an older plangraph)', { hint: 'run `plangraph build` to rebuild it' });
    } else {
      let got = null;
      try { got = contentDigest(h, older ? V1_TABLES : undefined); } catch { got = null; } // an older index holds the 0.3.0 table list only // a value SQLite cannot hand back (an out-of-range integer) is tampering too
      if (got !== want) throw new PlangraphError('DATA', 'the index content does not match its integrity digest (it was edited outside plangraph)', { hint: 'run `plangraph build` to rebuild it' });
    }
    if (older && !readOnly) throw new PlangraphError('STALE', 'the index was built by an older plangraph', { hint: 'run `plangraph build`' }); // before any write
    if (dir !== undefined) {
      const stored = meta(FINGERPRINT_KEY);
      h.fingerprint = sourceFingerprint(dir); h.builtFingerprint = stored ?? null;
      h.stale = stored !== h.fingerprint || want === undefined;
    }
    if (older) { h.older = true; h.stale = true; } // the text may be unchanged: the index still lacks the graph tables, so it counts as stale
    if (h.stale) h.exec('PRAGMA query_only = ON');
  } catch (e) { h.close(); throw e; }
  return h;
}

// ---------- stamp ----------
/** Record that the index is current with the text in dir (after `plangraph export` wrote that text FROM this index): store the source
 * fingerprint in index_meta and re-stamp the content digest. Nothing else in the index changes. */
export function stampFingerprint(file: string, dir: string): string {
  const fingerprint = sourceFingerprint(dir);
  using h = openIndex(file, { readOnly: false }); // verifies the content digest first: a tampered index is never re-stamped
  h.exec('BEGIN');
  h.prepare('INSERT OR REPLACE INTO index_meta(k, v) VALUES(?, ?)').run(FINGERPRINT_KEY, fingerprint);
  stampContent(h); // the digest covers index_meta (the fingerprint row included)
  h.exec('COMMIT');
  return fingerprint;
}
