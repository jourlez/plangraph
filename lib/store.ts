// Canonical serialization, format versioning and locks. See docs/FORMAT.md.
// Node built-ins only. Uses fs/child_process (store layer); no console output, no process.exit.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeAtomicSafe } from './fsafe.ts';
import { parseJsonl, readDataCapped, presentDataFile, IngestError, DATA_REFUSALS } from './jsonl.ts';

export const FORMAT_VERSION = 2; // what this tool writes (2: entity files, docs/FORMAT.md)
export type FormatErrorCode = 'BAD_FORMAT' | 'TOO_NEW' | 'PRE_1_0';
export class FormatError extends Error { declare code: FormatErrorCode; constructor(code: FormatErrorCode, msg: string) { super(msg); this.code = code; } }

const sha = (s: string, n = 32): string => crypto.createHash('sha256').update(s).digest('hex').slice(0, n);
export const keyStr = (parts: readonly unknown[]): string => parts.map((x) => String(x ?? '')).join('\x00');
export const showKey = (k: string): string => k.replace(/\x00/g, ' | ');

// ---------- schemas (fixed field order per file; unknown fields are kept and appended sorted) ----------
/** A parsed JSONL record (any JSON object). */
export type Rec = Record<string, unknown>;
/** A record's identity or sort key. */
export type KeyFn = (r: Rec) => string;
/** A file's schema: known fields in order, declared set fields, defaults for absent fields, identity and sort keys. */
export interface Schema { file: string; order: string[]; sets: string[]; defaults: Record<string, unknown>; id: KeyFn; sort: KeyFn }
/** A spec that identifies records: a schema (or any partial one with an id key), a key function, or nothing (fallback). */
export type KeySpec = (Partial<Schema> & { id: KeyFn }) | KeyFn | null | undefined;
/** specOf of a KeySpec: field order, sets and defaults filled in, id and sort always present (sort defaults to id). */
export type Spec = Omit<Schema, 'file'> & { file?: string };
/** specOf of any SpecInput: field order, sets and defaults filled in; sort is id's fallback, so it is undefined when neither is given. */
export type LooseSpec = Omit<Partial<Schema>, 'sort'> & Pick<Schema, 'order' | 'sets' | 'defaults'> & { sort?: KeyFn | undefined };
/** What a catch reads from a thrown value: Node and lib errors carry a string code (whatever was thrown is read the same way as before). */
type Coded = Error & { code?: string };
/** What specOf accepts: a KeySpec, or a partial schema without an id (such as a field order for canonLine). */
export type SpecInput = Partial<Schema> | KeyFn | null | undefined;
const byFields = (fields: readonly string[]): KeyFn => (r) => keyStr(fields.map((f) => r[f]));
// canonValue, not JSON.stringify: an object value hashes the same whatever its key order, so canon(parse(canon(x))) is stable (for
// strings, numbers and null both give the same bytes, so existing ids do not change).
const evHash = (r: Rec): string => sha(canonValue([r.key ?? null, r.source ?? null, r.verdict ?? null, r.resolution ?? null, r.needs ?? null]));
const mk = (file: string, key: string[], order: string[], extra: Partial<Schema> = {}): Schema => ({ file, order, sets: [], defaults: {}, id: byFields(key), sort: byFields(key), ...extra });
// A file with no natural key is a set: the whole canonical record is its identity (also FALLBACK, and links.jsonl).
const wholeRecord: KeyFn = (r) => sha(canonLine(r, { order: [], sets: [] }));
export const SCHEMAS: Record<string, Schema> = {
  'tickets.jsonl': mk('tickets.jsonl', ['key'], ['key', 'summary', 'epic', 'sp', 'jira_status', 'v2_owner', 'v2_sprint', 'verdict', 'verdict_source', 'first_verdict', 'impl_status'], { defaults: { summary: '', epic: '', jira_status: '', verdict: '', verdict_source: '', first_verdict: '' } }),
  'edges.jsonl': mk('edges.jsonl', ['consumer', 'producer'], ['consumer', 'producer', 'kind', 'note'], { defaults: { kind: 'plan_need', note: '' } }),
  'schedule.jsonl': mk('schedule.jsonl', ['version', 'key'], ['version', 'key', 'owner', 'sprint'], { defaults: { version: 'current' } }),
  // evidence has no natural unique key: identity is a content hash (a "change" is a delete plus an add; the file is a set)
  'evidence.jsonl': mk('evidence.jsonl', [], ['key', 'source', 'verdict', 'resolution', 'needs'], { defaults: { resolution: '', needs: '' }, id: evHash, sort: (r) => keyStr([r.key, r.source, evHash(r)]) }),
  'findings.jsonl': mk('findings.jsonl', ['key', 'kind', 'text'], ['key', 'kind', 'text']),
  'meta.jsonl': mk('meta.jsonl', ['k'], ['k', 'v']),
  'learnings.jsonl': mk('learnings.jsonl', ['id'], ['id', 'kind', 'topic', 'text', 'why', 'source'], { defaults: { why: '', source: '' } }),
  'refs.jsonl': mk('refs.jsonl', ['key'], ['key', 'plans', 'files', 'fp_files', 'jira_updated', 'audited_at'], { sets: ['plans'], defaults: { plans: [], files: {}, fp_files: '', jira_updated: '', audited_at: '' } }),
  'open-items.jsonl': mk('open-items.jsonl', ['key', 'kind'], ['key', 'kind', 'status']),
  // graph files (docs/FORMAT.md section 6). Node files are keyed per file and store no `type` field; a row may carry `schema_version` and any
  // field a newer tool wrote (kept, appended sorted). Arrays that are sets merge elementwise and are written sorted.
  'people.jsonl': mk('people.jsonl', ['id'], ['id', 'name', 'active']),
  'sprints.jsonl': mk('sprints.jsonl', ['n'], ['n', 'name', 'start', 'end', 'state']),
  'epics.jsonl': mk('epics.jsonl', ['id'], ['id', 'name']),
  'repos.jsonl': mk('repos.jsonl', ['id'], ['id', 'name', 'role', 'langs', 'pm', 'runtime', 'frameworks', 'cmds', 'entry', 'deploy', 'owners', 'paths', 'src', 'fp', 'scanned_at', 'scanner'], { sets: ['langs', 'frameworks', 'entry', 'owners', 'paths'] }),
  // requirement, decision and team nodes (docs/FORMAT.md): their list fields are sets (the `.pg` file repeats the field name once per element)
  'requirements.jsonl': mk('requirements.jsonl', ['id'], ['id', 'text', 'kind', 'status', 'source', 'acceptance', 'priority'], { sets: ['acceptance'] }),
  'decisions.jsonl': mk('decisions.jsonl', ['id'], ['id', 'title', 'status', 'date', 'affects', 'source', 'derivation'], { sets: ['affects'] }),
  'teams.jsonl': mk('teams.jsonl', ['id'], ['id', 'name', 'members', 'owns'], { sets: ['members', 'owns'] }),
  'capacity.jsonl': mk('capacity.jsonl', ['person', 'sprint'], ['person', 'sprint', 'sp', 'review_h']),
  'links.jsonl': mk('links.jsonl', [], ['from', 'from_type', 'rel', 'to', 'to_type', 'attrs'], { id: wholeRecord, sort: wholeRecord }),
  // an xref is one fact about one node: the key is the whole reference (one node may have many)
  'xrefs.jsonl': mk('xrefs.jsonl', ['type', 'id', 'sys', 'xid'], ['type', 'id', 'sys', 'xid', 'src', 'seen', 'note']),
};
// Unknown *.jsonl: the whole canonical record is its identity (set semantics: never lose a line, never invent a conflict).
const FALLBACK: Schema = { file: '*', order: [], sets: [], defaults: {}, id: wholeRecord, sort: wholeRecord };
export const schemaFor = (fileName: string): Schema => SCHEMAS[path.basename(fileName)] || FALLBACK;
// A spec is a schema, a key function (id and sort by it), or nothing (fallback).
export function specOf(x: KeySpec): Spec;
export function specOf(x: SpecInput): LooseSpec;
export function specOf(x: SpecInput): LooseSpec {
  if (!x) return FALLBACK;
  if (typeof x === 'function') return { file: '', order: [], sets: [], defaults: {}, id: x, sort: x };
  return { order: [], sets: [], defaults: {}, ...x, sort: x.sort || x.id };
}
export const withDefaults = (schema: { defaults?: Record<string, unknown> }, rec: Rec): Rec => { const o = { ...rec }; for (const [k, v] of Object.entries(schema.defaults || {})) if (o[k] === undefined) o[k] = structuredClone(v); return o; };

// ---------- canonical serialization ----------
// Values: object keys sorted (plain code-unit order), arrays keep order unless the field is a declared set (then sorted + deduped).
// Serialization is manual so a "__proto__" field cannot corrupt anything. Numbers go through JSON.stringify (1.0 -> 1; beyond 2^53 precision
// is lost on the FIRST parse, after which the round trip is stable).
export function canonValue(v: unknown, isSet = false): string {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) {
    let items = v.map((x: unknown) => canonValue(x));
    if (isSet) items = [...new Set(items)].sort();
    return '[' + items.join(',') + ']';
  }
  if (typeof v === 'object') return '{' + Object.keys(v).filter((k) => (v as Rec)[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canonValue((v as Rec)[k])).join(',') + '}'; // typeof just tested it: a non-null, non-array object, read by its own keys
  return JSON.stringify(v);
}
export function canonLine(obj: Readonly<Rec>, spec?: SpecInput): string {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) throw new TypeError('record must be a JSON object');
  const s = specOf(spec), set = new Set(s.sets || []);
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined);
  const known = (s.order || []).filter((k) => keys.includes(k));
  const rest = keys.filter((k) => !(s.order || []).includes(k)).sort();
  return '{' + [...known, ...rest].map((k) => JSON.stringify(k) + ':' + canonValue(obj[k], set.has(k))).join(',') + '}';
}
export function canonFile(records: readonly Rec[], spec?: KeySpec): string {
  const s = specOf(spec);
  const rows = records.map((r): [string, string] => [s.sort(r), canonLine(r, s)]);
  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const out: string[] = [];
  for (const [, line] of rows) if (out[out.length - 1] !== line) out.push(line); // an identical line twice is one record
  return out.length ? out.join('\n') + '\n' : '';
}
// Text -> records via the shared parser (lib/jsonl.ts): file:line errors, conflict markers, CRLF/BOM/blank lines tolerated, no content echoed.
export const parseJsonlText = (text: string, name = 'input'): Rec[] => parseJsonl(text, name);
export const canonText = (text: string, spec?: KeySpec, name?: string): string => canonFile(parseJsonlText(text, name), spec);
export function readRecords(dir: string, file: string, { defaults = true }: { defaults?: boolean } = {}): Rec[] {
  const f = path.join(dir, file); if (!presentDataFile(f)) return []; // a symlink is refused, as in build
  const s = schemaFor(file); let text: string;
  try { text = readDataCapped(f, 64 * 1024 * 1024); }
  catch (e) { if (DATA_REFUSALS.has((e as Coded).code as string)) throw new IngestError(`${path.basename(f)}: ${(e as Coded).message}`); throw e; } // whatever was thrown: a code it lacks is not a refusal
  const recs = parseJsonlText(text, path.basename(f));
  return defaults ? recs.map((r) => withDefaults(s, r)) : recs;
}

// ---------- atomic writes and locks ----------
export function writeAtomic(file: string, text: string, { root }: { root?: string } = {}): void { writeAtomicSafe(file, text, { root }); }
const sleepMs = (ms: number): string => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// Lock file: exclusive create, content {pid, token}. A lock is stolen only when its owner pid is dead AND the file is older than
// staleMs (a live owner is never robbed, however slow); unparseable content counts as stale by age alone. Release removes the file
// only if the token is still ours, so a lock that was stolen and retaken is left alone. Failure to acquire throws "...locked...".
// The lock path is only ever examined with lstat/O_NOFOLLOW: a symlink there is an error ("lock path is a symlink"), never followed.
// Stealing is serialized by a short-lived guard file `<lock>.steal` (exclusive create): only the guard holder may remove a stale lock, so a
// contender that decided "dead owner" on an old file cannot delete a fresh lock another contender has since created (the file stays in
// place until the guard holder removes it, so nobody can create the lock in between). Inside the guard the decision is made again from
// the current file, and the removal is a rename to a unique name in the same directory, then a re-read and compare (inode, pid, token).
// A mismatch means a live owner's file was moved instead: it is put back with a no-clobber link (never deleted) and we retry from the top.
// Only a verified stale file is removed, and only then is the exclusive create retried. A guard left by a crashed stealer is removed once
// it is older than staleMs and its pid is dead (the only remaining unguarded window, and only after a crash mid-steal).
// Every loop iteration counts against `retries`. `onStealDecision` is TEST ONLY: called after the dead-owner decision and before the
// rename, to interleave a competing owner.
const pidAlive = (pid: unknown): boolean => {
  if (!Number.isInteger(pid) || (pid as number) <= 0) return false; // Number.isInteger is the check
  try { process.kill(pid as number, 0); return true; } catch (e) { return (e as Coded).code === 'EPERM'; } // whatever was thrown: its fields are read as before
};
/** A lock or guard file's content: parsed JSON, unchecked (pid goes through pidAlive, token is compared). */
interface RawLock { pid?: unknown; token?: unknown } // unchecked: JSON.parse result, every field is tested afterwards
const readLock = (lockPath: string): RawLock | null => {
  let fd: number | undefined;
  try { fd = fs.openSync(lockPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); const j = JSON.parse(fs.readFileSync(fd, 'utf8')); return j && typeof j === 'object' ? j : null; }
  catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
};
// Returns true when the stale lock was removed (retry the create now), false when the caller should wait and retry.
function stealStale(lockPath: string, staleMs: number, onStealDecision?: () => void): boolean {
  const guard = `${lockPath}.steal`; let gfd: number;
  try { gfd = fs.openSync(guard, 'wx'); fs.writeSync(gfd, JSON.stringify({ pid: process.pid })); }
  catch (e) {
    if ((e as Coded).code !== 'EEXIST') throw e; // whatever was thrown: its fields are read as before
    try { const gst = fs.lstatSync(guard); if (Date.now() - gst.mtimeMs > staleMs && !pidAlive(readLock(guard)?.pid)) fs.rmSync(guard, { force: true }); } catch { /* gone */ }
    return false;
  }
  try {
    let st: fs.Stats; try { st = fs.lstatSync(lockPath); } catch (e) { if ((e as Coded).code === 'ENOENT') return true; throw e; } // whatever was thrown: its fields are read as before
    if (st.isSymbolicLink()) throw Object.assign(new Error(`lock path is a symlink: ${path.basename(lockPath)}`), { code: 'SYMLINK' });
    const owner = readLock(lockPath);
    if (!(Date.now() - st.mtimeMs > staleMs && !(owner && pidAlive(owner.pid)))) return false; // changed since the first look: not stale any more
    onStealDecision?.();
    const stale = `${lockPath}.stale-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    try { fs.renameSync(lockPath, stale); } catch (e) { if ((e as Coded).code === 'ENOENT') return true; throw e; } // whatever was thrown: its fields are read as before
    const st2 = fs.lstatSync(stale), now = readLock(stale);
    const same = st2.ino === st.ino && st2.dev === st.dev && (now?.pid ?? null) === (owner?.pid ?? null) && (now?.token ?? null) === (owner?.token ?? null);
    if (same) { fs.rmSync(stale, { force: true }); return true; }
    try { fs.linkSync(stale, lockPath); } catch { /* the path was taken meanwhile: leave theirs; ours stays under its stale name */ }
    try { if (fs.lstatSync(lockPath).ino === st2.ino) fs.rmSync(stale, { force: true }); } catch { /* nothing at the path */ }
    return false; // a live owner was put back: the caller waits and retries
  } finally { fs.closeSync(gfd); fs.rmSync(guard, { force: true }); }
}
/** Take the lock; the returned object releases it on dispose (`using lock = acquireLock(p)`), only if the token is still ours. */
export interface LockOptions { retries?: number; waitMs?: number; staleMs?: number; onStealDecision?: () => void }
export function acquireLock(lockPath: string, { retries = 100, waitMs = 20, staleMs = 30000, onStealDecision }: LockOptions = {}): Disposable {
  const token = crypto.randomBytes(12).toString('hex');
  for (let i = 0; ; i++) {
    try { const fd = fs.openSync(lockPath, 'wx'); fs.writeSync(fd, JSON.stringify({ pid: process.pid, token })); fs.closeSync(fd); break; }
    catch (e) {
      if ((e as Coded).code !== 'EEXIST') throw e; // whatever was thrown: its fields are read as before
      let st: fs.Stats | null; try { st = fs.lstatSync(lockPath); } catch (e2) { if ((e2 as Coded).code !== 'ENOENT') throw e2; st = null; } // whatever was thrown: its fields are read as before
      if (st?.isSymbolicLink()) throw Object.assign(new Error(`lock path is a symlink: ${path.basename(lockPath)}`), { code: 'SYMLINK' });
      const owner = st ? readLock(lockPath) : null;
      const locked = () => new Error(`could not take lock ${path.basename(lockPath)}: locked${owner && owner.pid ? ` by pid ${owner.pid}` : ''}`); // the file name only, never a path
      if (!st) { if (i >= retries) throw locked(); continue; } // vanished: try again, but never forever
      if (Date.now() - st.mtimeMs > staleMs && !(owner && pidAlive(owner.pid))) {
        if (stealStale(lockPath, staleMs, onStealDecision)) continue;
      }
      if (i >= retries) throw locked();
      sleepMs(waitMs);
    }
  }
  return { [Symbol.dispose]() { if (readLock(lockPath)?.token === token) fs.rmSync(lockPath, { force: true }); } };
}
export function withLock<T>(lockPath: string, fn: () => T, opts?: LockOptions): T {
  using _lock = acquireLock(lockPath, opts);
  return fn();
}

// ---------- format version ----------
export const FORMAT_FILE = 'format.json';
// format.json is small and repo-controlled: read through readCapped (one fd, regular files only, 64 KiB cap), a symlink refused. Messages name the file only, never its path or content (a JSON engine message embeds a snippet of the text).
const FORMAT_MAX = 64 * 1024;
/** format.json as JSON.parse returns it: unchecked until readFormat tests both version fields. */
interface RawFormat { format_version?: unknown; min_reader?: unknown; [k: string]: unknown }
/** format.json after readFormat: both integers tested (min_reader defaulted), unknown fields kept; a missing file reads as format 0. */
export interface FormatInfo { format_version: number; min_reader: number; [k: string]: unknown }
export function readFormat(dir: string): FormatInfo {
  const f = path.join(dir, FORMAT_FILE), bad = (m: string) => new FormatError('BAD_FORMAT', `${FORMAT_FILE}: ${m}`);
  let st: fs.Stats; try { st = fs.lstatSync(f); } catch (e) { if ((e as Coded).code === 'ENOENT') return { format_version: 0, min_reader: 0 }; throw e; } // whatever was thrown: its fields are read as before
  if (st.isSymbolicLink()) throw bad('is a symlink');
  let text: string;
  try { text = readDataCapped(f, FORMAT_MAX); } catch (e) {
    if ((e as Coded).code === 'SYMLINK') throw bad('is a symlink'); // whatever was thrown: its fields are read as before
    if ((e as Coded).code === 'SWAPPED') throw bad('was replaced while it was read'); // whatever was thrown: its fields are read as before
    if ((e as Coded).code === 'NOT_A_FILE' || (e as Coded).code === 'EISDIR') throw bad('not a regular file'); // whatever was thrown: its fields are read as before
    if ((e as Coded).code === 'TOO_LARGE') throw bad('too large'); // whatever was thrown: its fields are read as before
    throw e;
  }
  let j: RawFormat | null; try { j = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw bad('not valid JSON'); } // unchecked: JSON.parse result, every field is tested afterwards
  if (!j || typeof j !== 'object' || Array.isArray(j) || !Number.isInteger(j.format_version) || (j.format_version as number) < 0) throw bad('format_version must be a non-negative integer'); // Number.isInteger is the check
  const min = j.min_reader === undefined ? j.format_version : j.min_reader; // missing optional field: default
  if (!Number.isInteger(min) || (min as number) < 0 || (min as number) > (j.format_version as number)) throw bad('min_reader must be an integer <= format_version'); // Number.isInteger is the check (both)
  return { ...j, min_reader: min } as FormatInfo; // format_version and min_reader were both tested as integers above
}
export function writeFormat(dir: string, { format_version, min_reader, storage }: { format_version: number; min_reader: number; storage?: string }): void {
  const old = ((): Partial<FormatInfo> => { try { return readFormat(dir); } catch { return {}; } })(); // keep unknown fields
  writeAtomic(path.join(dir, FORMAT_FILE), canonLine({ ...old, format_version, min_reader, ...(storage === undefined ? {} : { storage }) }, { order: ['format_version', 'min_reader', 'storage'] }) + '\n');
}
// supported = {version, min}. mode 'write' (default): any newer directory is a hard error. mode 'read': a newer directory is readable
// when its min_reader <= our version (additive changes only; unknown fields are ignored).
export interface FormatCheck { version: number; min_reader: number; status: 'newer-readable' | 'ok' }
/** The refusal text for a directory written by a pre-1.0 tool (format below 2, or no stamp beside old-layout files). */
export const PRE_1_0_MESSAGE = 'unsupported pre-1.0 directory: recreate it with plangraph takeover';
/** The plan files of the old (one JSONL file per kind) layout; meta.jsonl is also a file of the entity layout and is not one of them. */
export const OLD_LAYOUT_FILES: readonly string[] = Object.freeze(Object.keys(SCHEMAS).filter((f) => f !== 'meta.jsonl'));
const hasOldLayout = (dir: string): boolean => OLD_LAYOUT_FILES.some((f) => { try { fs.lstatSync(path.join(dir, f)); return true; } catch { return false; } }); // lstat: only presence matters, nothing is read
export function checkFormat(dir: string, supported: { version: number } = { version: FORMAT_VERSION }, { mode = 'write' }: { mode?: 'read' | 'write' } = {}): FormatCheck {
  const f = readFormat(dir);
  if (f.format_version < 2 && (f.format_version > 0 || hasOldLayout(dir))) throw new FormatError('PRE_1_0', PRE_1_0_MESSAGE);
  const tooNew = mode === 'read' ? f.min_reader > supported.version : f.format_version > supported.version;
  if (tooNew) throw new FormatError('TOO_NEW', `${dir}: data format ${f.format_version} (needs reader >= ${f.min_reader}) is newer than this tool supports (${supported.version}): upgrade the plangraph tool`);
  return { version: f.format_version, min_reader: f.min_reader, status: f.format_version > supported.version ? 'newer-readable' : 'ok' };
}

// ---------- plan directory names ----------
/** A plan directory name that may go into hook output: A-Z a-z 0-9 . _ / - only. */
export const SAFE_ATTR_DIR = /^[A-Za-z0-9._/-]+$/;
