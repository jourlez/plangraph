// Canonical serialization, format versioning + migrations, locks, merge-driver install/doctor. See docs/FORMAT.md.
// Node built-ins only. Uses fs/child_process (store layer); no console output, no process.exit.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeAtomicSafe } from './fsafe.mjs';
import { parseJsonl, readCapped, presentDataFile, IngestError } from './jsonl.mjs';

export const FORMAT_VERSION = 1; // what this tool writes
export const MIN_FORMAT = 1; // oldest directory this tool reads without migrating
export class FormatError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

const sha = (s, n = 32) => crypto.createHash('sha256').update(s).digest('hex').slice(0, n);
export const keyStr = (parts) => parts.map((x) => String(x ?? '')).join('\x00');
export const showKey = (k) => k.replace(/\x00/g, ' | ');

// ---------- schemas (fixed field order per file; unknown fields are kept and appended sorted) ----------
const byFields = (fields) => (r) => keyStr(fields.map((f) => r[f]));
// canonValue, not JSON.stringify: an object value hashes the same whatever its key order, so canon(parse(canon(x))) is stable (for
// strings, numbers and null both give the same bytes, so existing ids do not change).
const evHash = (r) => sha(canonValue([r.key ?? null, r.source ?? null, r.verdict ?? null, r.resolution ?? null, r.needs ?? null]));
const mk = (file, key, order, extra = {}) => ({ file, order, sets: [], defaults: {}, id: byFields(key), sort: byFields(key), ...extra });
/** @type {Record<string, { order: string[], [k: string]: any }>} */
export const SCHEMAS = {
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
const FALLBACK = { file: '*', order: [], sets: [], defaults: {}, id: (r) => sha(canonLine(r, { order: [], sets: [] })), sort: (r) => sha(canonLine(r, { order: [], sets: [] })) };
export const schemaFor = (fileName) => SCHEMAS[path.basename(fileName)] || FALLBACK;
// A spec is a schema, a key function (id and sort by it), or nothing (fallback).
export function specOf(x) {
  if (!x) return FALLBACK;
  if (typeof x === 'function') return { file: '', order: [], sets: [], defaults: {}, id: x, sort: x };
  return { order: [], sets: [], defaults: {}, ...x, sort: x.sort || x.id };
}
export const withDefaults = (schema, rec) => { const o = { ...rec }; for (const [k, v] of Object.entries(schema.defaults || {})) if (o[k] === undefined) o[k] = structuredClone(v); return o; };

// ---------- canonical serialization ----------
// Values: object keys sorted (plain code-unit order), arrays keep order unless the field is a declared set (then sorted + deduped).
// Serialization is manual so a "__proto__" field cannot corrupt anything. Numbers go through JSON.stringify (1.0 -> 1; beyond 2^53 precision
// is lost on the FIRST parse, after which the round trip is stable).
export function canonValue(v, isSet = false) {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) {
    let items = v.map((x) => canonValue(x));
    if (isSet) items = [...new Set(items)].sort();
    return '[' + items.join(',') + ']';
  }
  if (typeof v === 'object') return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canonValue(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
export function canonLine(obj, spec) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) throw new TypeError('record must be a JSON object');
  const s = specOf(spec), set = new Set(s.sets || []);
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined);
  const known = (s.order || []).filter((k) => keys.includes(k));
  const rest = keys.filter((k) => !(s.order || []).includes(k)).sort();
  return '{' + [...known, ...rest].map((k) => JSON.stringify(k) + ':' + canonValue(obj[k], set.has(k))).join(',') + '}';
}
export function canonFile(records, spec) {
  const s = specOf(spec);
  const rows = records.map((r) => [s.sort(r), canonLine(r, s)]);
  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const out = [];
  for (const [, line] of rows) if (out[out.length - 1] !== line) out.push(line); // an identical line twice is one record
  return out.length ? out.join('\n') + '\n' : '';
}
// Text -> records via the shared parser (lib/jsonl.mjs): file:line errors, conflict markers, CRLF/BOM/blank lines tolerated, no content echoed.
export const parseJsonlText = (text, name = 'input') => parseJsonl(text, name);
export const canonText = (text, spec, name) => canonFile(parseJsonlText(text, name), spec);
export function readRecords(dir, file, { defaults = true } = {}) {
  const f = path.join(dir, file); if (!presentDataFile(f)) return []; // a symlink is refused, as in build
  const s = schemaFor(file); let text;
  try { text = readCapped(f, 64 * 1024 * 1024); }
  catch (e) { if (e.code === 'TOO_LARGE' || e.code === 'NOT_A_FILE') throw new IngestError(`${path.basename(f)}: ${e.message}`); throw e; }
  const recs = parseJsonlText(text, path.basename(f));
  return defaults ? recs.map((r) => withDefaults(s, r)) : recs;
}

// ---------- atomic writes and locks ----------
/** @param {string} file @param {string} text @param {{ root?: string }} [opts] */
export function writeAtomic(file, text, { root } = {}) { writeAtomicSafe(file, text, { root }); }
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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
const pidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};
const readLock = (lockPath) => {
  let fd;
  try { fd = fs.openSync(lockPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); const j = JSON.parse(fs.readFileSync(fd, 'utf8')); return j && typeof j === 'object' ? j : null; }
  catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
};
// Returns true when the stale lock was removed (retry the create now), false when the caller should wait and retry.
function stealStale(lockPath, staleMs, onStealDecision) {
  const guard = `${lockPath}.steal`; let gfd;
  try { gfd = fs.openSync(guard, 'wx'); fs.writeSync(gfd, JSON.stringify({ pid: process.pid })); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    try { const gst = fs.lstatSync(guard); if (Date.now() - gst.mtimeMs > staleMs && !pidAlive(readLock(guard)?.pid)) fs.rmSync(guard, { force: true }); } catch { /* gone */ }
    return false;
  }
  try {
    let st; try { st = fs.lstatSync(lockPath); } catch (e) { if (e.code === 'ENOENT') return true; throw e; }
    if (st.isSymbolicLink()) throw Object.assign(new Error(`lock path is a symlink: ${path.basename(lockPath)}`), { code: 'SYMLINK' });
    const owner = readLock(lockPath);
    if (!(Date.now() - st.mtimeMs > staleMs && !(owner && pidAlive(owner.pid)))) return false; // changed since the first look: not stale any more
    onStealDecision?.();
    const stale = `${lockPath}.stale-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    try { fs.renameSync(lockPath, stale); } catch (e) { if (e.code === 'ENOENT') return true; throw e; }
    const st2 = fs.lstatSync(stale), now = readLock(stale);
    const same = st2.ino === st.ino && st2.dev === st.dev && (now?.pid ?? null) === (owner?.pid ?? null) && (now?.token ?? null) === (owner?.token ?? null);
    if (same) { fs.rmSync(stale, { force: true }); return true; }
    try { fs.linkSync(stale, lockPath); } catch { /* the path was taken meanwhile: leave theirs; ours stays under its stale name */ }
    try { if (fs.lstatSync(lockPath).ino === st2.ino) fs.rmSync(stale, { force: true }); } catch { /* nothing at the path */ }
    return false;
  } finally { fs.closeSync(gfd); fs.rmSync(guard, { force: true }); }
}
/** Take the lock; the returned object releases it on dispose (`using lock = acquireLock(p)`), only if the token is still ours. */
/** @param {string} lockPath @param {{ retries?: number, waitMs?: number, staleMs?: number, onStealDecision?: (decision: any) => void }} [opts] */
export function acquireLock(lockPath, { retries = 100, waitMs = 20, staleMs = 30000, onStealDecision } = {}) {
  const token = crypto.randomBytes(12).toString('hex');
  for (let i = 0; ; i++) {
    try { const fd = fs.openSync(lockPath, 'wx'); fs.writeSync(fd, JSON.stringify({ pid: process.pid, token })); fs.closeSync(fd); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let st; try { st = fs.lstatSync(lockPath); } catch (e2) { if (e2.code !== 'ENOENT') throw e2; st = null; }
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
export function withLock(lockPath, fn, opts) {
  using _lock = acquireLock(lockPath, opts);
  return fn();
}

// ---------- format version + migrations ----------
export const FORMAT_FILE = 'format.json';
// format.json is small and repo-controlled: read through readCapped (one fd, regular files only, 64 KiB cap), a symlink refused (a dangling
// one is not "legacy"). Messages name the file only, never its path or content (a JSON engine message embeds a snippet of the text).
const FORMAT_MAX = 64 * 1024;
export function readFormat(dir) {
  const f = path.join(dir, FORMAT_FILE), bad = (m) => new FormatError('BAD_FORMAT', `${FORMAT_FILE}: ${m}`);
  let st; try { st = fs.lstatSync(f); } catch (e) { if (e.code === 'ENOENT') return { format_version: 0, min_reader: 0, legacy: true }; throw e; }
  if (st.isSymbolicLink()) throw bad('is a symlink');
  let text;
  try { text = readCapped(f, FORMAT_MAX); } catch (e) {
    if (e.code === 'NOT_A_FILE' || e.code === 'EISDIR') throw bad('not a regular file');
    if (e.code === 'TOO_LARGE') throw bad('too large');
    throw e;
  }
  let j; try { j = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw bad('not valid JSON'); }
  if (!j || typeof j !== 'object' || Array.isArray(j) || !Number.isInteger(j.format_version) || j.format_version < 0) throw bad('format_version must be a non-negative integer');
  const min = j.min_reader === undefined ? j.format_version : j.min_reader; // missing optional field: default
  if (!Number.isInteger(min) || min < 0 || min > j.format_version) throw bad('min_reader must be an integer <= format_version');
  return { ...j, min_reader: min, legacy: false };
}
export function writeFormat(dir, { format_version, min_reader }) {
  const { legacy, ...old } = (() => { try { return readFormat(dir); } catch { return {}; } })(); // keep unknown fields
  writeAtomic(path.join(dir, FORMAT_FILE), canonLine({ ...old, format_version, min_reader }, { order: ['format_version', 'min_reader'] }) + '\n');
}
// supported = {version, min}. mode 'write' (default): any newer directory is a hard error. mode 'read': a newer directory is readable
// when its min_reader <= our version (additive changes only; unknown fields are ignored).
export function checkFormat(dir, supported = { version: FORMAT_VERSION, min: MIN_FORMAT }, { mode = 'write' } = {}) {
  const f = readFormat(dir);
  const tooNew = mode === 'read' ? f.min_reader > supported.version : f.format_version > supported.version;
  if (tooNew) throw new FormatError('TOO_NEW', `${dir}: data format ${f.format_version} (needs reader >= ${f.min_reader}) is newer than this tool supports (${supported.version}): upgrade the brain tool`);
  if (f.format_version < supported.min) throw new FormatError('NEEDS_MIGRATION', `${dir}: data format ${f.format_version} is older than ${supported.min}: run \`brain migrate --write\``);
  return { version: f.format_version, min_reader: f.min_reader, legacy: f.legacy, status: f.format_version > supported.version ? 'newer-readable' : 'ok' };
}

// A migration: {from, to, min_reader?, plan(dir, read) -> [{file, text}]}. plan is pure: read(name) returns the file text as it will be
// after earlier steps (or null). It lists only files whose text changes, so a re-run after a crash plans only what is left.
export const migrations = [{
  from: 0, to: 1, min_reader: 1, describe: 'add format.json, canonicalize every known jsonl file',
  plan(dir, read) {
    const ops = [];
    for (const name of Object.keys(SCHEMAS).sort()) {
      const cur = read(name); if (cur === null) continue;
      const next = canonText(cur, SCHEMAS[name], name); // errors name the file only, never its absolute path
      if (next !== cur) ops.push({ file: name, text: next });
    }
    return ops;
  },
}];
const chain = (from, target, ms) => {
  const steps = []; let v = from;
  while (v < target) { const m = ms.find((x) => x.from === v); if (!m) throw new FormatError('NO_PATH', `no migration from format ${v}`); steps.push(m); v = m.to; }
  return steps;
};
// A data file read for a migration: lstat first (a symlink is refused, never followed), then one capped read of a regular file (a FIFO
// or device is refused without blocking). Missing -> null. Refusals are IngestError (exit 2) naming the base file only, as in build.
const MIGRATE_MAX = 64 * 1024 * 1024;
function readDataFile(dir, name) {
  const f = path.join(dir, name), base = path.basename(name); let st;
  try { st = fs.lstatSync(f); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  if (st.isSymbolicLink()) throw new IngestError(`${base}: is a symlink, not a regular file`);
  try { return readCapped(f, MIGRATE_MAX); } catch (e) {
    if (e.code === 'TOO_LARGE' || e.code === 'NOT_A_FILE') throw new IngestError(`${base}: ${e.message}`);
    throw e;
  }
}
function planSteps(dir, { migrations: ms = migrations } = {}) {
  const f = readFormat(dir), top = Math.max(...ms.map((m) => m.to), 0);
  if (f.format_version > top) throw new FormatError('TOO_NEW', `${dir}: data format ${f.format_version} is newer than this tool supports (${top}): upgrade the brain tool`);
  const overlay = new Map();
  const read = (name) => (overlay.has(name) ? overlay.get(name) : readDataFile(dir, name));
  const steps = chain(f.format_version, top, ms).map((m) => {
    const ops = m.plan(dir, read).sort((a, b) => (a.file < b.file ? -1 : 1));
    for (const o of ops) overlay.set(o.file, o.text);
    return { from: m.from, to: m.to, min_reader: m.min_reader ?? m.to, describe: m.describe || '', ops };
  });
  return { from: f.format_version, to: top, steps };
}
// Dry-run summary (no texts).
export function planMigration(dir, o) {
  const p = planSteps(dir, o);
  return { from: p.from, to: p.to, pending: p.steps.length > 0, steps: p.steps.map((s) => ({ from: s.from, to: s.to, describe: s.describe, files: s.ops.map((x) => x.file) })) };
}
// Dry-run unless write. Per step: write each changed file atomically (temp + rename), then bump format.json LAST. A crash leaves a
// directory that is still a valid old-format one; re-running recomputes the remaining work and converges. onWrite(file) is a test hook.
/** @param {string} dir @param {{ write?: boolean, onWrite?: (file: string) => void, migrations?: any[] }} [opts] */
export function runMigration(dir, { write = false, onWrite, ...o } = {}) {
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
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' } });
const tryGit = (cwd, args) => { try { return { ok: true, out: git(cwd, args) }; } catch (e) { return { ok: false, err: String(e.stderr || e.message) }; } };
const DRIVER = 'brain-jsonl';
const VERSIONED = '/plugins/cache/';
const SAFE_ATTR_DIR = /^[A-Za-z0-9._/-]+$/;
const shq = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
export function installMergeDriver(repoRoot, { dir = '.brain', driverPath = 'brain-merge' } = {}) {
  if (String(driverPath).includes(VERSIONED)) throw new TypeError(`refusing a versioned plugin-cache driver path (${VERSIONED} is deleted after a plugin update); pass the stable shim from ensureStableDriver`);
  // The dir becomes a gitattributes pattern line: only a plain name can go there (no newline, space, glob, comment or quote character).
  if (typeof dir !== 'string' || !SAFE_ATTR_DIR.test(dir)) throw new TypeError('refusing to write .gitattributes: the brain directory name must use only A-Z a-z 0-9 . _ / -');
  const line = `${dir}/*.jsonl merge=${DRIVER}`;
  const ga = path.join(repoRoot, '.gitattributes');
  const cur = readGitattributes(ga);
  if (!cur.split('\n').some((l) => l.trim() === line)) writeAtomic(ga, cur + (cur && !cur.endsWith('\n') ? '\n' : '') + line + '\n');
  git(repoRoot, ['config', `merge.${DRIVER}.name`, 'project-brain jsonl three-way merge']);
  git(repoRoot, ['config', `merge.${DRIVER}.driver`, `${shq(driverPath)} %O %A %B %P`]);
  return { gitattributes: line, driver: `${shq(driverPath)} %O %A %B %P` };
}
// .gitattributes is repo-controlled: lstat first (a symlink is refused, never followed), then one capped read of a regular file (a FIFO,
// device or directory is refused without blocking). Missing -> ''. A refusal throws code ATTR_REFUSED with a fixed message.
export const GITATTRIBUTES_MAX = 256 * 1024;
function readGitattributes(ga) {
  const refused = (why) => Object.assign(new Error(`refusing to read .gitattributes: ${why}`), { code: 'ATTR_REFUSED', why });
  let st; try { st = fs.lstatSync(ga); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; }
  if (st.isSymbolicLink()) throw refused('it is a symlink');
  if (!st.isFile()) throw refused('not a regular file');
  try { return readCapped(ga, GITATTRIBUTES_MAX); } catch (e) {
    if (e.code === 'TOO_LARGE') throw refused(`larger than ${GITATTRIBUTES_MAX} bytes`);
    if (e.code === 'NOT_A_FILE') throw refused('not a regular file');
    throw e;
  }
}
const readLine = (f) => { // reads at most 4096 bytes, never the whole file
  let fd;
  try { fd = fs.openSync(f, 'r'); const buf = Buffer.alloc(4096); const n = fs.readSync(fd, buf, 0, 4096, 0); return buf.toString('utf8', 0, n).trim(); }
  catch { return ''; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
};
function shimProblems(dataDir, problems) {
  const t = readLine(path.join(dataDir, 'driver.target')), n = readLine(path.join(dataDir, 'driver.node'));
  if (!t) problems.push(`merge driver shim has an unreadable or empty driver.target in ${dataDir}: run \`brain doctor --fix\``);
  else if (!fs.existsSync(t)) problems.push(`merge driver.target points to a missing file: ${t}: run \`brain doctor --fix\``);
  if (!n) problems.push(`merge driver shim has an unreadable or empty driver.node in ${dataDir}: run \`brain doctor --fix\``);
  else if (!fs.existsSync(n)) problems.push(`merge driver.node points to a missing file: ${n}: run \`brain doctor --fix\``);
}
export function doctorMergeDriver(repoRoot, { dir = '.brain' } = {}) {
  const problems = [];
  let text = '', refusedWhy = '';
  try { text = readGitattributes(path.join(repoRoot, '.gitattributes')); } catch (e) { if (e.code !== 'ATTR_REFUSED') throw e; refusedWhy = e.why; }
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
    else if (exe && path.isAbsolute(exe) && executable && readLine(exe).includes('driver.target')) shimProblems(path.join(path.dirname(exe), '..'), problems);
  }
  return { installed: attrs && !!driver && executable, attributes: !!attrs, config: !!driver, executable, driver, problems };
}
