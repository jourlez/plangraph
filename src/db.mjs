// The SQLite index: schema, build, open. The index is derived from the JSONL text and git-ignored.
// - node:sqlite is loaded on first use (process.getBuiltinModule, synchronous and lazy), never at import time, so commands that do not
//   need the index never touch it, and an old Node gets one ENV error (exit 3) instead of a crash.
// - SQL identifiers come only from constants: the column list of each table is lib/store.mjs SCHEMAS[file].order (frozen here); record
//   keys never reach a statement. Fields outside that list are kept, as canonical JSON, in the `extra` column.
// - buildIndex parses every file first, writes a temp file beside the index, checks its integrity, and renames it over the old index
//   only when everything loaded: a failed build keeps the old index. The same bytes that were parsed are hashed into a source fingerprint
//   (sha256 over the sorted index source files), stored in table index_meta under key source_fingerprint.
// - openIndex({ dir }) recomputes the fingerprint: a mismatch (or an index without one, such as one built by the old bin/brain) sets
//   handle.stale = true and turns on PRAGMA query_only.
// - Content integrity: buildIndex also stores a sha256 digest of the index CONTENT (every row of every table, index_meta included except the
//   digest row itself, in a canonical order: primary key, then every column) under index_meta key content_digest. openIndex recomputes it
//   (streaming, one row at a time) and refuses a mismatch as DATA with the `brain build` hint, so a row edited directly inside brain.sqlite is
//   never served. An index without a digest (an older build) is flagged stale (query-only) and index writes refuse it. The legitimate index
//   writers (whatif --write, schedule-load, stampFingerprint) re-stamp the digest with stampContent before COMMIT. The digest is unkeyed: it
//   detects direct edits, not a forger who recomputes it (docs/CONTRACT.md).
// The fingerprint lives in its own table, not in `meta`: `meta` mirrors meta.jsonl and is exported back to text, so a fingerprint row
// there would leak into meta.jsonl (and collide with a user key of the same name).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SCHEMAS } from '../lib/store.mjs';
import { parseJsonl, readDataCapped, IngestError, DATA_REFUSALS } from '../lib/jsonl.mjs';
import { validators } from '../lib/schema.mjs';
import { BrainError } from './errors.mjs';
import { nodeSupported, floorMessage } from './floor.mjs';

export const INDEX_FILE = 'brain.sqlite';
export const NO_BRAIN_MESSAGE = 'no brain directory: run `brain init`';
export const FINGERPRINT_KEY = 'source_fingerprint';
export const CONTENT_KEY = 'content_digest';
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const IDENT = /^[a-z][a-z0-9_]*$/;

// [table, file, primary key, INTEGER columns, upsert]. learnings and refs are INSERT OR REPLACE (a later line with the same id wins),
// as in bin/brain; the other tables refuse a duplicate primary key.
/** @type {Array<[string, string, string[], string[], boolean]>} */
const DEFS = [
  ['ticket', 'tickets.jsonl', ['key'], ['sp', 'v2_sprint'], false],
  ['schedule', 'schedule.jsonl', ['version', 'key'], ['sprint'], false],
  ['edge', 'edges.jsonl', ['consumer', 'producer'], [], false],
  ['evidence', 'evidence.jsonl', [], [], false],
  ['finding', 'findings.jsonl', [], [], false],
  ['meta', 'meta.jsonl', ['k'], [], false],
  ['learning', 'learnings.jsonl', ['id'], [], true],
  ['ref', 'refs.jsonl', ['key'], [], true],
];
const toObj = (/** @type {unknown} */ v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : v);
const same = (/** @type {any} */ v) => v;
// Per-table record preparation, as bin/brain does it: tickets..meta store object values as JSON text; learnings and refs get defaults.
/** @type {Map<string, [(r: any) => any, (v: any) => any]>} */
// schedule: `version` defaults to `current` (docs/FORMAT.md, lib/model.mjs); the default is applied HERE, before the insert, so the index,
// every `version='current'` query and export agree on a row that omits it (export then writes it explicitly).
const PREP = new Map([
  ['schedule', [(r) => ({ ...r, version: r.version ?? SCHEMAS['schedule.jsonl'].defaults.version }), toObj]],
  ['learning', [(r) => ({ ...r, why: r.why || '', source: r.source || '' }), same]],
  ['ref', [(r) => ({ ...r, plans: JSON.stringify(r.plans || []), files: JSON.stringify(r.files || {}), fp_files: r.fp_files || '', jira_updated: r.jira_updated || '', audited_at: r.audited_at || '' }), same]],
]);

/** @typedef {{ name: string, file: string, columns: readonly string[], upsert: boolean, known: Set<string>, text: Set<string>, scalar: readonly string[],
 *   columnList: string, placeholders: string, ddl: string, prep: [(r: any) => any, (v: any) => any], order: string }} TableSpec */
// Columns whose record values are converted by PREP before the insert (refs.plans is an array, refs.files an object): not scalar-checked.
const PREPPED = new Map([['ref', new Set(['plans', 'files'])]]);
/** @type {Map<string, Readonly<TableSpec>>} */
export const TABLES = new Map(DEFS.map(([name, file, pk, ints, upsert]) => {
  const columns = Object.freeze([...SCHEMAS[file].order]);
  for (const c of [name, ...columns]) if (!IDENT.test(c) || c === 'extra') throw new Error(`bad identifier in schema: ${c}`);
  const all = [...columns, 'extra'];
  const types = columns.map((c) => `${c} ${ints.includes(c) ? 'INTEGER' : 'TEXT'}`);
  return [name, Object.freeze({
    name, file, columns, upsert,
    known: new Set(columns),
    text: new Set(columns.filter((c) => !ints.includes(c))),
    scalar: Object.freeze(columns.filter((c) => !ints.includes(c) && !PREPPED.get(name)?.has(c))),
    columnList: all.join(','),
    placeholders: all.map(() => '?').join(','),
    ddl: [...types, 'extra TEXT', ...(pk.length ? [`PRIMARY KEY(${pk.join(',')})`] : [])].join(', '),
    prep: PREP.get(name) ?? /** @type {[(r: any) => any, (v: any) => any]} */ ([same, toObj]),
    // canonical digest order: the primary key, then every other column (rows that tie on all of them are identical, so order is total)
    order: [...pk, ...all.filter((c) => !pk.includes(c))].join(','),
  })];
}));
Object.freeze(TABLES);
const SOURCE_FILES = Object.freeze([...TABLES.values()].map((t) => t.file).toSorted());
const DDL = [...TABLES.values()].map((t) => `CREATE TABLE ${t.name}(${t.ddl});`).join('\n')
  + '\nCREATE INDEX edge_p ON edge(producer); CREATE INDEX ev_k ON evidence(key);\nCREATE TABLE index_meta(k TEXT PRIMARY KEY, v TEXT);';

// ---------- node:sqlite, lazily ----------
/** @type {typeof import('node:sqlite') | undefined} */
let sqlite;
/** Load node:sqlite once (the one import line; node:sqlite prints no warning on Node 24.2+). Throws BrainError ENV (exit 3) on Node < 24.2. */
export function loadSqlite({ version = process.versions.node } = {}) {
  if (!nodeSupported(version)) throw new BrainError('ENV', floorMessage(version));
  if (sqlite) return sqlite;
  sqlite = process.getBuiltinModule('node:sqlite');
  return sqlite;
}

// ---------- handle ----------
/** A database handle usable with `using`: closes on dispose (idempotent), caches prepared statements by key. */
export class IndexHandle {
  #db; #stmts = new Map();
  /** true: the text changed since the build (query_only is on); false: verified fresh; null: not verified. */
  /** @type {boolean | null} */ stale = null;
  /** sha256 hex of the text now / of the text the index was built from (null: not verified, or an index without one). */
  /** @type {string | null} */ fingerprint = null; /** @type {string | null} */ builtFingerprint = null;
  /** @param {any} db */
  constructor(db) { this.#db = db; }
  get isOpen() { return this.#db.isOpen; }
  /** @param {string} sql */
  exec(sql) { this.#db.exec(sql); }
  /** @param {string} sql */
  prepare(sql) { return this.#db.prepare(sql); }
  /** @param {string} key @param {string} sql */
  cached(key, sql) { let s = this.#stmts.get(key); if (!s) { s = this.#db.prepare(sql); this.#stmts.set(key, s); } return s; }
  /** @param {string} sql @param {...unknown} a @returns {any[]} */
  all(sql, ...a) { return this.cached(sql, sql).all(...a); }
  /** @param {string} sql @param {...unknown} a @returns {any} */
  get(sql, ...a) { return this.cached(sql, sql).get(...a); }
  close() { this.#stmts.clear(); if (this.#db.isOpen) this.#db.close(); }
  [Symbol.dispose]() { this.close(); }
}

// ---------- records ----------
// Canonical JSON (sorted keys, undefined dropped), written by hand so "__proto__" stays a plain key. Same bytes as bin/brain canonJson.
/** @type {(v: any) => string} */
const canonJson = (v) => (v === null || v === undefined ? 'null' : Array.isArray(v) ? `[${v.map(canonJson).join(',')}]`
  : typeof v === 'object' ? `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonJson(v[k])}`).join(',')}}` : JSON.stringify(v));
// Known-column values in the constant column order, then the canonical JSON of every field a column cannot give back exactly (null when
// there is none): unknown fields, an explicit null in a known column (NULL there means "absent"), and a number in a TEXT column (the
// column holds its JSON text, e.g. "123", for queries; export restores the number). So build then export is byte-stable.
/** @param {Readonly<TableSpec>} t @param {Record<string, unknown>} rec */
function rowOf(t, rec) {
  const [pre, conv] = t.prep, r = pre(rec);
  const vals = t.columns.map((c) => (!Object.hasOwn(r, c) ? null : typeof r[c] === 'number' && t.text.has(c) ? JSON.stringify(r[c]) : conv(r[c])));
  const rest = Object.create(null); let any = false;
  for (const k of Object.keys(r)) {
    if (r[k] === undefined || (t.known.has(k) && !(r[k] === null || (typeof r[k] === 'number' && t.text.has(k))))) continue;
    Object.defineProperty(rest, k, { value: r[k], enumerable: true, writable: true, configurable: true }); any = true;
  }
  vals.push(any ? canonJson(rest) : null);
  return vals;
}
// A known TEXT column holds a string or a number (or null / absent); anything else is a data error at file:line, naming the field only.
/** @param {Readonly<TableSpec>} t */
const scalarCheck = (t) => (/** @type {Record<string, unknown>} */ r) => {
  for (const c of t.scalar) { const v = r[c]; if (Object.hasOwn(r, c) && v !== null && v !== undefined && typeof v !== 'string' && typeof v !== 'number') return `"${c}" must be a string or a number`; }
  return null;
};
/** @param {Readonly<TableSpec>} t @returns {(r: any) => string | null} */
const validatorOf = (t) => { const v = Object.hasOwn(validators, t.file) ? validators[t.file] : null, sc = scalarCheck(t); return (r) => (v ? v(r) : null) || sc(r); };

// ---------- sources and fingerprint ----------
// Reads every index source once (capped, regular files only). Missing file -> null. Returns [[file, text|null]] sorted by file name.
/** @param {string} dir @returns {Array<[string, string | null]>} */
function readSources(dir) {
  return SOURCE_FILES.map((f) => {
    // A source file is a regular file inside the brain directory: a symlink (even to a file outside the repo) is refused before any read.
    let st = null; try { st = fs.lstatSync(path.join(dir, f)); } catch (/** @type {any} */ e) { if (e.code !== 'ENOENT') throw e; }
    if (st?.isSymbolicLink()) throw new IngestError(`${f}: is a symlink, not a regular file`);
    try { return [f, readDataCapped(path.join(dir, f), MAX_SOURCE_BYTES)]; } // O_NOFOLLOW + dev/ino check: no swap after the lstat
    catch (/** @type {any} */ e) {
      if (e.code === 'ENOENT') return [f, null];
      if (DATA_REFUSALS.has(e.code)) throw new IngestError(`${f}: ${e.message}`);
      throw e;
    }
  });
}
/** @param {Array<[string, string | null]>} sources */
function fingerprintOf(sources) {
  const h = crypto.createHash('sha256');
  for (const [f, text] of sources) {
    if (text === null) { h.update(`${f}\0-\0`); continue; }
    const b = Buffer.from(text, 'utf8');
    h.update(`${f}\0${b.length}\0`); h.update(b); h.update('\0');
  }
  return h.digest('hex');
}
/** sha256 (hex) over the sorted index source files of dir: name, byte length and bytes of each; a missing file differs from an empty one. */
export const sourceFingerprint = (/** @type {string} */ dir) => fingerprintOf(readSources(dir));

// ---------- content digest ----------
// sha256 over every table in the fixed TABLES order, then index_meta without the digest row: per table its name, then one SQLite json_array
// per row (a TEXT '3' and an INTEGER 3 differ; JSON escapes newlines, so the row separator is unambiguous; a BLOB, which json_array refuses,
// makes the digest fail, which openIndex treats as a mismatch). Rows are streamed and hashed in 64 KiB batches, so memory stays flat on a
// large index; the ORDER BY makes the digest independent of physical row order (VACUUM). SQL text comes only from the frozen table specs.
// Cost (docs/CONTRACT.md): about 5 ms at 1,400 tickets and 0.4 s at 100,000 tickets (533k rows) on the dev machine; a full digest, no sampling.
/** @param {IndexHandle} h @returns {string} */
export function contentDigest(h) {
  const hash = crypto.createHash('sha256');
  /** @param {string} name @param {string} sql @param {unknown[]} args */
  const feed = (name, sql, args) => {
    let buf = `${name}\0`;
    const st = h.prepare(sql); st.setReturnArrays(true);
    for (const row of st.iterate(...args)) { buf += `${row[0]}\n`; if (buf.length > 65536) { hash.update(buf); buf = ''; } }
    hash.update(buf);
  };
  for (const t of TABLES.values()) feed(t.name, `SELECT json_array(${t.columnList}) FROM ${t.name} ORDER BY ${t.order}`, []);
  feed('index_meta', 'SELECT json_array(k, v) FROM index_meta WHERE k <> ? ORDER BY k, v', [CONTENT_KEY]);
  return hash.digest('hex');
}
/** Store the content digest of the index as it is now (inside the caller's transaction, before COMMIT). Returns it. */
/** @param {IndexHandle} h */
export function stampContent(h) {
  const digest = contentDigest(h);
  h.prepare('INSERT OR REPLACE INTO index_meta(k, v) VALUES(?, ?)').run(CONTENT_KEY, digest);
  return digest;
}

// ---------- build ----------
export const TEMP_MAX_AGE_MS = 10 * 60 * 1000;
// Is the process with this pid alive? kill(pid, 0) sends nothing: ESRCH means gone, EPERM means alive but not ours.
/** @param {number} pid */
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (/** @type {any} */ e) { return e.code === 'EPERM'; }
}
/** Remove leftovers of crashed builds: `<index>.tmp-<pid>` files that are older than TEMP_MAX_AGE_MS or whose pid is dead (or is
 * this process: a build runs synchronously, so a temp file with our own pid is a leftover). A fresh temp file of another live build
 * is never touched, so two concurrent builds cannot delete each other's work. Only regular files with this exact prefix are removed. */
/** @param {string} where @param {string} prefix @param {number} [now] */
export function removeStaleTemps(where, prefix, now = Date.now()) {
  for (const f of fs.readdirSync(where)) {
    if (!f.startsWith(prefix)) continue;
    const p = path.join(where, f); let st;
    try { st = fs.lstatSync(p); } catch { continue; }
    if (!st.isFile()) continue;
    const tail = f.slice(prefix.length), pid = /^\d{1,10}$/.test(tail) ? Number(tail) : NaN;
    const old = now - st.mtimeMs > TEMP_MAX_AGE_MS;
    const dead = Number.isSafeInteger(pid) && pid > 0 && (pid === process.pid || !pidAlive(pid));
    if (old || dead) fs.rmSync(p, { force: true });
  }
}

// The INSERT of one table: built only from the frozen table spec and the verb, never from a record (no record parameter).
/** @type {(t: Readonly<TableSpec>, verb?: string) => string} */
const insertSql = (t, verb = 'INSERT') => `${verb} INTO ${t.name}(${t.columnList}) VALUES(${t.placeholders})`;

/** Build the index for ctx.dir into `file` (default <dir>/brain.sqlite). Throws IngestError on bad data, keeping the old index. */
/** @param {{ dir: string }} ctx @param {{ file?: string, now?: number }} [opts] */
export function buildIndex(ctx, { file = path.join(ctx.dir, INDEX_FILE), now = Date.now() } = {}) {
  let st = null;
  try { st = fs.statSync(ctx.dir); } catch (/** @type {any} */ e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e; }
  if (!st?.isDirectory()) throw new BrainError('DATA', 'no brain directory', { hint: 'run `brain init` first' });
  const { DatabaseSync } = loadSqlite();
  removeStaleTemps(path.dirname(file), `${path.basename(file)}.tmp-`, now);
  const sources = readSources(ctx.dir), text = new Map(sources);
  const fingerprint = fingerprintOf(sources);
  // parse everything before touching the database
  const rows = [...TABLES.values()].map((t) => /** @type {const} */ ([t, parseJsonl(text.get(t.file) ?? '', t.file, { validate: validatorOf(t) })]));
  const tmp = `${file}.tmp-${process.pid}`;
  // The temp path is created HERE, exclusively and without following a symlink, before SQLite opens it: a file or symlink planted at that
  // (predictable) name is refused and left alone, never written through. Its dev/ino is checked again before the rename. The descriptor stays
  // open until the rename is done: while it is open the inode cannot be freed, so no file created at that path meanwhile (even after a delete;
  // ext4 reuses a freed inode number at once) can have its number, and the dev/ino check is a guarantee. It is closed only after SQLite closed
  // its own (closing any descriptor of a file drops the process's POSIX locks on it, which SQLite holds while it is open).
  let mine, tfd;
  try { tfd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o644); mine = fs.fstatSync(tfd); }
  catch (/** @type {any} */ e) {
    if (e.code === 'EEXIST' || e.code === 'ELOOP') throw new BrainError('REFUSED', 'refusing to build the index: its temp path already exists and was not created by this build');
    throw e;
  }
  try {
    /** @type {Record<string, number>} */ const counts = {}; let digest = '';
    {
      using h = new IndexHandle(new DatabaseSync(tmp));
      h.exec('PRAGMA journal_mode=OFF'); h.exec(DDL); h.exec('BEGIN');
      for (const [t, recs] of rows) {
        const ins = h.cached(t.name, insertSql(t, t.upsert ? 'INSERT OR REPLACE' : 'INSERT')); // once per table
        recs.forEach((r, i) => {
          try { ins.run(...rowOf(t, r)); }
          catch (/** @type {any} */ e) { throw new IngestError(`${t.file}: record ${i + 1}: ${String(e.message).split('\n')[0].slice(0, 200)}`); }
        });
      }
      h.prepare('INSERT INTO index_meta(k, v) VALUES(?, ?)').run(FINGERPRINT_KEY, fingerprint);
      digest = stampContent(h);
      h.exec('COMMIT');
      if (h.get('PRAGMA integrity_check').integrity_check !== 'ok') throw new BrainError('DATA', 'index failed its integrity check');
      for (const t of TABLES.values()) counts[t.name] = h.get(`SELECT COUNT(*) c FROM ${t.name}`).c;
    } // closed here, before the rename
    const now = fs.lstatSync(tmp);
    if (!now.isFile() || now.dev !== mine.dev || now.ino !== mine.ino) throw new BrainError('REFUSED', 'refusing to build the index: its temp file was replaced during the build');
    fs.renameSync(tmp, file); // rename replaces a symlink at `file` itself, never its target
    return { file, counts, fingerprint, digest };
  } catch (e) {
    try { const now = fs.lstatSync(tmp); if (now.isFile() && now.ino === mine.ino && now.dev === mine.dev) fs.rmSync(tmp, { force: true }); } catch { /* gone */ }
    throw e;
  } finally { fs.closeSync(tfd); }
}

// ---------- schema check ----------
// An index is derived and git-ignored, but a committed or planted brain.sqlite is attacker-controlled, and its stored fingerprint can match
// the text. Before any query its sqlite_master must be exactly what buildIndex (or the old bin/brain build, which lacks index_meta) writes:
// every table of TABLES as a plain table with exactly its columns plus `extra` (no hidden or generated column), optionally index_meta(k, v),
// the indexes edge_p and ev_k, and the automatic primary-key indexes; no view, trigger, virtual table or any other object.
const EXPECTED_COLUMNS = new Map([...[...TABLES.values()].map((t) => /** @type {[string, string]} */ ([t.name, [...t.columns, 'extra'].join(',')])), ['index_meta', 'k,v']]);
const EXPECTED_INDEXES = new Map([['edge_p', 'edge'], ['ev_k', 'evidence']]);
/** @param {IndexHandle} h @returns {boolean} */
function schemaOk(h) {
  const objects = h.all('SELECT type, name, tbl_name, sql FROM sqlite_master');
  const tables = new Set();
  for (const o of objects) {
    if (o.type === 'table') {
      if (!EXPECTED_COLUMNS.has(o.name) || o.name !== o.tbl_name || typeof o.sql !== 'string' || /^\s*CREATE\s+VIRTUAL\b/i.test(o.sql)) return false;
      tables.add(o.name);
    } else if (o.type === 'index') {
      const auto = typeof o.name === 'string' && o.name.startsWith(`sqlite_autoindex_${o.tbl_name}_`) && o.sql === null;
      if (!(auto ? EXPECTED_COLUMNS.has(o.tbl_name) : EXPECTED_INDEXES.get(o.name) === o.tbl_name)) return false;
    } else return false; // view, trigger, anything else
  }
  for (const t of TABLES.keys()) if (!tables.has(t)) return false;
  for (const t of tables) {
    const info = h.all('SELECT name, hidden FROM pragma_table_xinfo(?)', t);
    if (info.some((c) => c.hidden !== 0) || info.map((c) => c.name).join(',') !== EXPECTED_COLUMNS.get(t)) return false;
  }
  return true;
}

// ---------- open ----------
/** Open an index. With `dir`, verify its source fingerprint: stale -> handle.stale = true and PRAGMA query_only = ON. */
/** @param {string} file @param {{ readOnly?: boolean, dir?: string }} [opts] */
export function openIndex(file, { readOnly = true, dir } = {}) {
  let lst = null; try { lst = fs.lstatSync(file); } catch (/** @type {any} */ e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e; }
  if (!lst) {
    // no brain directory at all: the first step is `brain init` (a `brain build` there would fail and say so itself)
    let dirOk = false; try { dirOk = fs.statSync(dir ?? path.dirname(file)).isDirectory(); } catch { /* missing */ }
    if (!dirOk) throw new BrainError('NO_BRAIN', NO_BRAIN_MESSAGE);
    throw new BrainError('NO_INDEX', 'no index: run `brain build`');
  }
  // a symlinked index (to a file anywhere, or dangling) is never opened; the SQLite build in Node refuses one too, this does not depend on it
  if (lst.isSymbolicLink()) throw new BrainError('DATA', 'the index is a symlink, not a regular file', { hint: 'run `brain build` to rebuild it' });
  const { DatabaseSync } = loadSqlite();
  let h;
  try {
    h = new IndexHandle(new DatabaseSync(file, { readOnly }));
    h.get('SELECT COUNT(*) n FROM sqlite_master'); // a non-SQLite or corrupt file fails here, not in the middle of a command
  } catch (e) {
    h?.close();
    throw new BrainError('DATA', 'the index is not a readable SQLite database', { hint: 'run `brain build` to rebuild it', cause: e });
  }
  let good = false;
  try { good = schemaOk(h); } catch { good = false; }
  if (!good) { h.close(); throw new BrainError('DATA', 'the index has an unexpected schema (not built by brain build)', { hint: 'run `brain build` to rebuild it' }); }
  try {
    const has = h.get("SELECT 1 x FROM sqlite_master WHERE type='table' AND name='index_meta'");
    const meta = (/** @type {string} */ k) => (has ? h.get('SELECT v FROM index_meta WHERE k=?', k)?.v : undefined);
    const want = meta(CONTENT_KEY);
    if (want === undefined) {
      if (!readOnly) throw new BrainError('DATA', 'the index has no integrity digest (built by an older brain)', { hint: 'run `brain build` to rebuild it' });
    } else {
      let got = null;
      try { got = contentDigest(h); } catch { got = null; } // a value SQLite cannot hand back (an out-of-range integer) is tampering too
      if (got !== want) throw new BrainError('DATA', 'the index content does not match its integrity digest (it was edited outside brain)', { hint: 'run `brain build` to rebuild it' });
    }
    if (dir !== undefined) {
      const stored = meta(FINGERPRINT_KEY);
      h.fingerprint = sourceFingerprint(dir); h.builtFingerprint = stored ?? null;
      h.stale = stored !== h.fingerprint || want === undefined;
      if (h.stale) h.exec('PRAGMA query_only = ON');
    }
  } catch (e) { h.close(); throw e; }
  return h;
}

// ---------- stamp ----------
/** Record that the index is current with the text in dir (after `brain export` wrote that text FROM this index): store the source
 * fingerprint in index_meta and re-stamp the content digest. Nothing else in the index changes. */
/** @param {string} file @param {string} dir */
export function stampFingerprint(file, dir) {
  const fingerprint = sourceFingerprint(dir);
  using h = openIndex(file, { readOnly: false }); // verifies the content digest first: a tampered index is never re-stamped
  h.exec('BEGIN');
  h.prepare('INSERT OR REPLACE INTO index_meta(k, v) VALUES(?, ?)').run(FINGERPRINT_KEY, fingerprint);
  stampContent(h); // the digest covers index_meta (the fingerprint row included)
  h.exec('COMMIT');
  return fingerprint;
}
