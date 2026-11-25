// Canonical serialization, format versioning + migrations, locks, merge-driver install/doctor. See docs/FORMAT.md.
// Node built-ins only. Uses fs/child_process (store layer); no console output, no process.exit.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeAtomicSafe } from './fsafe.ts';
import { parseJsonl, readDataCapped, presentDataFile, IngestError, DATA_REFUSALS } from './jsonl.ts';

export const FORMAT_VERSION = 1; // what this tool writes
export const MIN_FORMAT = 1; // oldest directory this tool reads without migrating
export type FormatErrorCode = 'BAD_FORMAT' | 'TOO_NEW' | 'NEEDS_MIGRATION' | 'NO_PATH';
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
};
// Unknown *.jsonl: the whole canonical record is its identity (set semantics: never lose a line, never invent a conflict).
const FALLBACK: Schema = { file: '*', order: [], sets: [], defaults: {}, id: (r) => sha(canonLine(r, { order: [], sets: [] })), sort: (r) => sha(canonLine(r, { order: [], sets: [] })) };
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

// ---------- format version + migrations ----------
export const FORMAT_FILE = 'format.json';
// format.json is small and repo-controlled: read through readCapped (one fd, regular files only, 64 KiB cap), a symlink refused (a dangling
// one is not "legacy"). Messages name the file only, never its path or content (a JSON engine message embeds a snippet of the text).
const FORMAT_MAX = 64 * 1024;
/** format.json as JSON.parse returns it: unchecked until readFormat tests both version fields. */
interface RawFormat { format_version?: unknown; min_reader?: unknown; [k: string]: unknown }
/** format.json after readFormat: both integers tested (min_reader defaulted), unknown fields kept; legacy when the file is missing. */
export interface FormatInfo { format_version: number; min_reader: number; legacy: boolean; [k: string]: unknown }
export function readFormat(dir: string): FormatInfo {
  const f = path.join(dir, FORMAT_FILE), bad = (m: string) => new FormatError('BAD_FORMAT', `${FORMAT_FILE}: ${m}`);
  let st: fs.Stats; try { st = fs.lstatSync(f); } catch (e) { if ((e as Coded).code === 'ENOENT') return { format_version: 0, min_reader: 0, legacy: true }; throw e; } // whatever was thrown: its fields are read as before
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
  return { ...j, min_reader: min, legacy: false } as FormatInfo; // format_version and min_reader were both tested as integers above
}
export function writeFormat(dir: string, { format_version, min_reader }: { format_version: number; min_reader: number }): void {
  const { legacy, ...old } = ((): Partial<FormatInfo> => { try { return readFormat(dir); } catch { return {}; } })(); // keep unknown fields
  writeAtomic(path.join(dir, FORMAT_FILE), canonLine({ ...old, format_version, min_reader }, { order: ['format_version', 'min_reader'] }) + '\n');
}
// supported = {version, min}. mode 'write' (default): any newer directory is a hard error. mode 'read': a newer directory is readable
// when its min_reader <= our version (additive changes only; unknown fields are ignored).
export interface FormatCheck { version: number; min_reader: number; legacy: boolean; status: 'newer-readable' | 'ok' }
export function checkFormat(dir: string, supported: { version: number; min: number } = { version: FORMAT_VERSION, min: MIN_FORMAT }, { mode = 'write' }: { mode?: 'read' | 'write' } = {}): FormatCheck {
  const f = readFormat(dir);
  const tooNew = mode === 'read' ? f.min_reader > supported.version : f.format_version > supported.version;
  if (tooNew) throw new FormatError('TOO_NEW', `${dir}: data format ${f.format_version} (needs reader >= ${f.min_reader}) is newer than this tool supports (${supported.version}): upgrade the brain tool`);
  if (f.format_version < supported.min) throw new FormatError('NEEDS_MIGRATION', `${dir}: data format ${f.format_version} is older than ${supported.min}: run \`brain migrate --write\``);
  return { version: f.format_version, min_reader: f.min_reader, legacy: f.legacy, status: f.format_version > supported.version ? 'newer-readable' : 'ok' };
}

// A migration: {from, to, min_reader?, plan(dir, read) -> [{file, text}]}. plan is pure: read(name) returns the file text as it will be
// after earlier steps (or null). It lists only files whose text changes, so a re-run after a crash plans only what is left.
/** One file a migration step rewrites, with its new text. */
export interface MigrationOp { file: string; text: string }
/** read(name): the file text as earlier steps left it, or null when missing. */
export interface Migration { from: number; to: number; min_reader?: number; describe?: string; plan(dir: string, read: (name: string) => string | null): MigrationOp[] }
export const migrations: Migration[] = [{
  from: 0, to: 1, min_reader: 1, describe: 'add format.json, canonicalize every known jsonl file',
  plan(dir, read) {
    const ops: MigrationOp[] = [];
    for (const name of Object.keys(SCHEMAS).sort()) {
      const cur = read(name); if (cur === null) continue;
      const next = canonText(cur, SCHEMAS[name], name); // errors name the file only, never its absolute path
      if (next !== cur) ops.push({ file: name, text: next });
    }
    return ops;
  },
}];
const chain = (from: number, target: number, ms: readonly Migration[]): Migration[] => {
  const steps: Migration[] = []; let v = from;
  while (v < target) { const m = ms.find((x) => x.from === v); if (!m) throw new FormatError('NO_PATH', `no migration from format ${v}`); steps.push(m); v = m.to; }
  return steps;
};
// A data file read for a migration: lstat first (a symlink is refused, never followed), then one capped read of a regular file (a FIFO
// or device is refused without blocking). Missing -> null. Refusals are IngestError (exit 2) naming the base file only, as in build.
const MIGRATE_MAX = 64 * 1024 * 1024;
function readDataFile(dir: string, name: string): string | null {
  const f = path.join(dir, name), base = path.basename(name); let st: fs.Stats;
  try { st = fs.lstatSync(f); } catch (e) { if ((e as Coded).code === 'ENOENT') return null; throw e; } // whatever was thrown: its fields are read as before
  if (st.isSymbolicLink()) throw new IngestError(`${base}: is a symlink, not a regular file`);
  try { return readDataCapped(f, MIGRATE_MAX); } catch (e) {
    if (DATA_REFUSALS.has((e as Coded).code as string)) throw new IngestError(`${base}: ${(e as Coded).message}`); // whatever was thrown: its fields are read as before
    throw e;
  }
}
function planSteps(dir: string, { migrations: ms = migrations }: { migrations?: readonly Migration[] } = {}) {
  const f = readFormat(dir), top = Math.max(...ms.map((m) => m.to), 0);
  if (f.format_version > top) throw new FormatError('TOO_NEW', `${dir}: data format ${f.format_version} is newer than this tool supports (${top}): upgrade the brain tool`);
  const overlay = new Map<string, string>();
  const read = (name: string): string | null => (overlay.has(name) ? overlay.get(name) as string : readDataFile(dir, name)); // has() was just tested
  const steps = chain(f.format_version, top, ms).map((m) => {
    const ops = m.plan(dir, read).sort((a, b) => (a.file < b.file ? -1 : 1));
    for (const o of ops) overlay.set(o.file, o.text);
    return { from: m.from, to: m.to, min_reader: m.min_reader ?? m.to, describe: m.describe || '', ops };
  });
  return { from: f.format_version, to: top, steps };
}
// Dry-run summary (no texts).
export interface MigrationPlan { from: number; to: number; pending: boolean; steps: Array<{ from: number; to: number; describe: string; files: string[] }> }
export function planMigration(dir: string, o?: { migrations?: readonly Migration[] }): MigrationPlan {
  const p = planSteps(dir, o);
  return { from: p.from, to: p.to, pending: p.steps.length > 0, steps: p.steps.map((s) => ({ from: s.from, to: s.to, describe: s.describe, files: s.ops.map((x) => x.file) })) };
}
// Dry-run unless write. Per step: write each changed file atomically (temp + rename), then bump format.json LAST. A crash leaves a
// directory that is still a valid old-format one; re-running recomputes the remaining work and converges. onWrite(file) is a test hook.
export function runMigration(dir: string, { write = false, onWrite, ...o }: { write?: boolean; onWrite?: (file: string) => void; migrations?: readonly Migration[] } = {}): MigrationPlan & { written: boolean } {
  const summary = planMigration(dir, o);
  if (!write || !summary.pending) return { ...summary, written: false };
  return withLock(path.join(dir, '.migrate.lock'), () => {
    const fresh = planSteps(dir, o); // re-plan under the lock: another process may have finished already
    for (const s of fresh.steps) {
      for (const op of s.ops) { onWrite?.(op.file); writeAtomic(path.join(dir, op.file), op.text); }
      onWrite?.(FORMAT_FILE); writeFormat(dir, { format_version: s.to, min_reader: s.min_reader });
    }
    return { ...summary, written: fresh.steps.length > 0 };
  });
}

// ---------- git merge driver install / doctor ----------
const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' } });
const tryGit = (cwd: string, args: string[]): { ok: true; out: string; err?: never } | { ok: false; err: string; out?: never } => { try { return { ok: true, out: git(cwd, args) }; } catch (e) { return { ok: false, err: String((e as Coded & { stderr?: unknown }).stderr || (e as Coded).message) }; } }; // whatever was thrown: its fields are read as before
const DRIVER = 'plangraph-jsonl';
const VERSIONED = '/plugins/cache/';
const SAFE_ATTR_DIR = /^[A-Za-z0-9._/-]+$/;
const shq = (s: string): string => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
export function installMergeDriver(repoRoot: string, { dir = '.plangraph', driverPath = 'plangraph-merge' }: { dir?: string; driverPath?: string } = {}): { gitattributes: string; driver: string } {
  if (String(driverPath).includes(VERSIONED)) throw new TypeError(`refusing a versioned plugin-cache driver path (${VERSIONED} is deleted after a plugin update); pass the stable shim from ensureStableDriver`);
  // The dir becomes a gitattributes pattern line: only a plain name can go there (no newline, space, glob, comment or quote character).
  if (typeof dir !== 'string' || !SAFE_ATTR_DIR.test(dir)) throw new TypeError('refusing to write .gitattributes: the brain directory name must use only A-Z a-z 0-9 . _ / -');
  const line = `${dir}/*.jsonl merge=${DRIVER}`;
  const ga = path.join(repoRoot, '.gitattributes');
  const cur = readGitattributes(ga);
  if (!cur.split('\n').some((l) => l.trim() === line)) writeAtomic(ga, cur + (cur && !cur.endsWith('\n') ? '\n' : '') + line + '\n');
  git(repoRoot, ['config', `merge.${DRIVER}.name`, 'plangraph jsonl three-way merge']);
  git(repoRoot, ['config', `merge.${DRIVER}.driver`, `${shq(driverPath)} %O %A %B %P`]);
  return { gitattributes: line, driver: `${shq(driverPath)} %O %A %B %P` };
}
// .gitattributes is repo-controlled: lstat first (a symlink is refused, never followed), then one capped read of a regular file (a FIFO,
// device or directory is refused without blocking). Missing -> ''. A refusal throws code ATTR_REFUSED with a fixed message.
export const GITATTRIBUTES_MAX = 256 * 1024;
function readGitattributes(ga: string): string {
  const refused = (why: string) => Object.assign(new Error(`refusing to read .gitattributes: ${why}`), { code: 'ATTR_REFUSED', why });
  let st: fs.Stats; try { st = fs.lstatSync(ga); } catch (e) { if ((e as Coded).code === 'ENOENT') return ''; throw e; } // whatever was thrown: its fields are read as before
  if (st.isSymbolicLink()) throw refused('it is a symlink');
  if (!st.isFile()) throw refused('not a regular file');
  try { return readDataCapped(ga, GITATTRIBUTES_MAX); } catch (e) {
    if ((e as Coded).code === 'SYMLINK') throw refused('it is a symlink'); // whatever was thrown: its fields are read as before
    if ((e as Coded).code === 'SWAPPED') throw refused('it was replaced while it was read'); // whatever was thrown: its fields are read as before
    if ((e as Coded).code === 'TOO_LARGE') throw refused(`larger than ${GITATTRIBUTES_MAX} bytes`); // whatever was thrown: its fields are read as before
    if ((e as Coded).code === 'NOT_A_FILE') throw refused('not a regular file'); // whatever was thrown: its fields are read as before
    throw e;
  }
}
// nofollow: driver.target / driver.node in the data dir are files we wrote, never symlinks (the shim path itself may legitimately be one)
const readLine = (f: string, nofollow = false): string => { // reads at most 4096 bytes, never the whole file
  let fd: number | undefined;
  try { fd = fs.openSync(f, fs.constants.O_RDONLY | (nofollow ? fs.constants.O_NOFOLLOW || 0 : 0)); const buf = Buffer.alloc(4096); const n = fs.readSync(fd, buf, 0, 4096, 0); return buf.toString('utf8', 0, n).trim(); }
  catch { return ''; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
};
// Same file by real path (a symlinked install path to the same plugin is not "another install"); false when either cannot be resolved.
const sameFile = (a: string, b: string): boolean => { try { return fs.realpathSync.native(a) === fs.realpathSync.native(b); } catch { return false; } };
// expected: the brain-merge of the RUNNING plugin. After a plugin update the old versioned install may still exist, so a readable
// driver.target is not enough: one that resolves to a different file is reported, and `doctor --fix` / `card --heal` repoint it.
function shimProblems(dataDir: string, problems: string[], expected: string | undefined): void {
  const t = readLine(path.join(dataDir, 'driver.target'), true), n = readLine(path.join(dataDir, 'driver.node'), true);
  if (!t) problems.push(`merge driver shim has an unreadable or empty driver.target in ${dataDir}: run \`brain doctor --fix\``);
  else if (!fs.existsSync(t)) problems.push(`merge driver.target points to a missing file: ${t}: run \`brain doctor --fix\``);
  else if (expected && !sameFile(t, expected)) problems.push(`merge driver.target points to another plugin install, not the running one: ${t}: run \`brain doctor --fix\``);
  if (!n) problems.push(`merge driver shim has an unreadable or empty driver.node in ${dataDir}: run \`brain doctor --fix\``);
  else if (!fs.existsSync(n)) problems.push(`merge driver.node points to a missing file: ${n}: run \`brain doctor --fix\``);
}
// target (optional): the brain-merge the running plugin would install; when given, a shim whose driver.target is another file is a problem.
export interface MergeDriverDoctor { installed: boolean; attributes: boolean; config: boolean; executable: boolean; driver: string; problems: string[] }
export function doctorMergeDriver(repoRoot: string, { dir = '.plangraph', target }: { dir?: string; target?: string } = {}): MergeDriverDoctor {
  const problems: string[] = [];
  let text = '', refusedWhy = '';
  try { text = readGitattributes(path.join(repoRoot, '.gitattributes')); } catch (e) { if ((e as Coded).code !== 'ATTR_REFUSED') throw e; refusedWhy = (e as Coded & { why: string }).why; } // ATTR_REFUSED is only thrown by refused(), which sets why
  const attrs = text.split('\n').some((l) => l.trim() === `${dir}/*.jsonl merge=${DRIVER}`);
  if (refusedWhy) problems.push(`.gitattributes refused: ${refusedWhy}`);
  else if (!attrs) problems.push(`.gitattributes lacks "${dir}/*.jsonl merge=${DRIVER}"`);
  const cfg = tryGit(repoRoot, ['config', '--get', `merge.${DRIVER}.driver`]);
  const driver = cfg.ok ? cfg.out.trim() : '';
  if (!driver) problems.push(`git config merge.${DRIVER}.driver is not set (it is not versioned: run \`brain init\` or \`brain doctor --fix\` in every clone)`);
  let executable = false;
  if (driver) {
    const exe = (driver.match(/^'((?:[^']|'\\'')*)'|^(\S+)/) || []).slice(1).find(Boolean)?.replace(/'\\''/g, "'");
    executable = !!exe && (path.isAbsolute(exe) ? fs.existsSync(exe) : (process.env.PATH || '').split(path.delimiter).some((d) => fs.existsSync(path.join(d, exe))));
    if (!executable) problems.push(`merge driver executable not found: ${exe}`);
    if (exe?.includes(VERSIONED)) problems.push(`merge driver path is the versioned plugin cache (orphaned after a plugin update): run \`brain doctor --fix\``);
    else if (exe && path.isAbsolute(exe) && executable && readLine(exe).includes('driver.target')) shimProblems(path.join(path.dirname(exe), '..'), problems, target);
  }
  return { installed: attrs && !!driver && executable, attributes: !!attrs, config: !!driver, executable, driver, problems };
}
