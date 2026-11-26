// Append-only batch files for the plan directory (spec 4.0 rule 3): task events, sealed run files, immutable schedule versions.
// `root` is the plan directory. All writes go through withTxn (lib/store2/txn.ts), all reads through readDataCapped (never follow a symlink).
//   events/<yyyy-mm>/<actor>.<bh8>.<dd>.jsonl    one writer per file; bh8 = first 8 hex of sha256(branch name at write time, `nogit` if none)
//   events/<yyyy-mm>/_compact.<h8>.jsonl         compaction output; its lines carry `actor` and `bh8` themselves
//   runs/<kind>/<yyyy-mm>/<h8>.jsonl             h8 = first 8 hex of sha256(file content): identical runs are one file
//   schedules/v<n>-<h8>.jsonl, schedules/CURRENT immutable versions and the one-line pointer (two branches changing it conflict, on purpose)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { makeGit } from '../gitsafe.ts';
import { readDataCapped } from '../jsonl.ts';
import { withTxn } from './txn.ts';

export const sha8 = (s: string): string => crypto.createHash('sha256').update(s).digest('hex').slice(0, 8);
const MAX_FILE = 64 << 20, MAX_LINE = 1 << 20;

/** Canonical JSON: keys sorted at every level, undefined members dropped. */
export function canon(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(',')}}`;
}
const iso = (d: Date): string => new Date(Math.floor(d.getTime() / 1000) * 1000).toISOString().replace('.000Z', 'Z');
const lines = (rows: readonly unknown[]): string[] => rows.map(canon);
const text = (ls: readonly string[]): string => (ls.length ? `${ls.join('\n')}\n` : '');

/** First 8 hex of sha256 of the current branch name; the literal `nogit` outside git, with no commits-free HEAD name, or on a detached HEAD. */
export function branchHash(root: string, branch?: string): string {
  if (branch !== undefined) return sha8(branch);
  let name = 'nogit';
  try { name = makeGit(root, { timeoutMs: 5000 })('-c', 'core.fsmonitor=false', 'symbolic-ref', '--short', '-q', 'HEAD').trim() || 'nogit'; } catch { /* not a repository, detached HEAD or no git */ }
  return sha8(name);
}

const ls = (dir: string): string[] => { try { return fs.readdirSync(dir).sort(); } catch { return []; } };
const isDir = (p: string): boolean => { try { return fs.lstatSync(p).isDirectory(); } catch { return false; } };
const MONTH = /^\d{4}-\d{2}$/;
const PLAIN = /^([a-z0-9_-]+)\.([0-9a-f]{8})\.(\d{2})\.jsonl$/, COMPACT = /^_compact\.([0-9a-f]{8})\.jsonl$/, RUN = /^[0-9a-f]{8}\.jsonl$/;

export interface EventInput { task: string; to: string; by: string; evidence?: string[]; note?: string; [k: string]: unknown }
export interface Event extends EventInput { at: string; seq: number; actor: string; bh8: string }
export type Row = Record<string, unknown>;

/** One batch file read for checking or merging: its parsed rows with line numbers, and the lines that could not be used. */
export interface BatchFile { rel: string; kind: 'plain' | 'compact'; actor: string; bh8: string; rows: { row: Row; line: number; raw: string }[]; bad: number[]; unreadable: boolean }

function readRows(abs: string): { rows: { row: Row; line: number; raw: string }[]; bad: number[]; unreadable: boolean } {
  let t: string;
  try { t = readDataCapped(abs, MAX_FILE); } catch { return { rows: [], bad: [], unreadable: true }; }
  const rows: { row: Row; line: number; raw: string }[] = [], bad: number[] = [];
  t.split('\n').forEach((raw, i) => {
    if (!raw) return;
    if (raw.length > MAX_LINE || /^(<<<<<<<|=======|>>>>>>>)/.test(raw)) { bad.push(i + 1); return; }
    try { const v: unknown = JSON.parse(raw); if (v && typeof v === 'object' && !Array.isArray(v)) rows.push({ row: v as Row, line: i + 1, raw }); else bad.push(i + 1); } catch { bad.push(i + 1); }
  });
  return { rows, bad, unreadable: false };
}
const validEvent = (r: Row): boolean => typeof r.at === 'string' && Number.isInteger(r.seq) && typeof r.task === 'string' && typeof r.to === 'string' && typeof r.by === 'string';

/** Every event batch file under events/, in name order. Symlinks and odd names are ignored here (check reports them). */
export function eventFiles(root: string): BatchFile[] {
  const out: BatchFile[] = [];
  for (const m of ls(path.join(root, 'events'))) {
    if (!MONTH.test(m) || !isDir(path.join(root, 'events', m))) continue;
    for (const n of ls(path.join(root, 'events', m))) {
      const rel = `events/${m}/${n}`, pm = PLAIN.exec(n), cm = COMPACT.exec(n);
      if (!pm && !cm) continue;
      out.push({ rel, kind: pm ? 'plain' : 'compact', actor: pm ? (pm[1] as string) : '', bh8: pm ? (pm[2] as string) : '', ...readRows(path.join(root, rel)) });
    }
  }
  return out;
}

const byOrder = (a: Event, b: Event): number => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0) || a.seq - b.seq || (a.actor < b.actor ? -1 : a.actor > b.actor ? 1 : 0) || (a.bh8 < b.bh8 ? -1 : a.bh8 > b.bh8 ? 1 : 0);
const dedupeKey = (e: Event): string => canon([e.task, e.to, e.by, e.at, e.seq]);

function toEvents(fl: readonly BatchFile[]): Event[] {
  const all: Event[] = [];
  for (const f of fl) for (const { row } of f.rows) {
    if (!validEvent(row)) continue;
    const actor = f.kind === 'plain' ? f.actor : typeof row.actor === 'string' ? row.actor : '', bh8 = f.kind === 'plain' ? f.bh8 : typeof row.bh8 === 'string' ? row.bh8 : '';
    all.push({ ...row, actor, bh8 } as Event);
  }
  all.sort(byOrder);
  const seen = new Set<string>();
  return all.filter((e) => { const k = dedupeKey(e); if (seen.has(k)) return false; seen.add(k); return true; });
}

/** All events sorted by (at, seq, actor, bh8), de-duplicated by (task, to, by, at, seq). A bad line or file is skipped, never thrown on.
 *  `fileOrder` is a test seam: it may reorder the files before they are merged; the result must not depend on it. */
export function readEvents(root: string, opts: { fileOrder?: (files: string[]) => string[] } = {}): Event[] {
  const fl = eventFiles(root);
  if (opts.fileOrder) { const order = opts.fileOrder(fl.map((f) => f.rel)); const pos = new Map(order.map((r, i) => [r, i])); fl.sort((a, b) => (pos.get(a.rel) ?? 0) - (pos.get(b.rel) ?? 0)); }
  return toEvents(fl);
}

const actorName = (a: string): string => String(a).toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 40) || '_';

/** Append one event. `at` = max(wall clock to the second, latest `at` already on disk); `seq` = 1 + the highest `seq` seen at that same `at`
 *  (0 if none), so an event written after reading another always sorts after it, whatever the actors' names. `now` and `branch` are test seams. */
export function appendEvent(root: string, actor: string, e: EventInput, opts: { now?: Date; branch?: string } = {}): Event {
  const bh8 = branchHash(root, opts.branch), name = actorName(actor);
  let result: Event | undefined;
  withTxn(root, (tx) => {
    const seen = readEvents(root);
    const wall = iso(opts.now ?? new Date());
    const latest = seen.length ? (seen[seen.length - 1] as Event).at : '';
    const at = wall > latest ? wall : latest;
    let seq = -1;
    for (const s of seen) if (s.at === at && s.seq > seq) seq = s.seq;
    const { at: _a, seq: _s, actor: _c, bh8: _b, ...rest } = e as Event;
    const row = { ...rest, at, seq: seq + 1 };
    const rel = `events/${at.slice(0, 7)}/${name}.${bh8}.${at.slice(8, 10)}.jsonl`;
    let old = '';
    try { old = readDataCapped(path.join(root, rel), MAX_FILE); } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; } // whatever was thrown: read its code
    if (old && !old.endsWith('\n')) old += '\n';
    tx.write(rel, `${old}${canon(row)}\n`);
    result = { ...row, actor: name, bh8 } as Event;
  });
  return result as Event;
}

// ---------- runs ----------
const KIND = /^[a-z][a-z0-9_-]{0,39}$/;
const checkKind = (k: string): string => { if (!KIND.test(k)) throw Object.assign(new Error('run kind must be lower-case letters, digits, - or _'), { code: 'BAD_KIND' }); return k; };

/** Write one sealed run file; returns its path. Rows are canonical JSON, sorted and de-duplicated, so identical runs share one file
 *  (also across months: an existing file with the same hash wins). */
export function writeRun(root: string, kind: string, rows: readonly Row[], opts: { now?: Date } = {}): string {
  checkKind(kind);
  const body = text([...new Set(lines(rows))].sort()), h8 = sha8(body);
  let rel = '';
  withTxn(root, (tx) => {
    const dir = path.join(root, 'runs', kind);
    for (const m of ls(dir)) if (MONTH.test(m) && fs.existsSync(path.join(dir, m, `${h8}.jsonl`))) { rel = `runs/${kind}/${m}/${h8}.jsonl`; return; }
    rel = `runs/${kind}/${iso(opts.now ?? new Date()).slice(0, 7)}/${h8}.jsonl`;
    tx.write(rel, body);
  });
  return rel;
}

export function runFiles(root: string, kind: string): BatchFile[] {
  const out: BatchFile[] = [];
  const dir = path.join(root, 'runs', checkKind(kind));
  for (const m of ls(dir)) {
    if (!MONTH.test(m) || !isDir(path.join(dir, m))) continue;
    for (const n of ls(path.join(dir, m))) if (RUN.test(n)) out.push({ rel: `runs/${kind}/${m}/${n}`, kind: 'plain', actor: '', bh8: '', ...readRows(path.join(dir, m, n)) });
  }
  return out;
}
export function runKinds(root: string): string[] { return ls(path.join(root, 'runs')).filter((k) => KIND.test(k) && isDir(path.join(root, 'runs', k))); }

/** Rows of every run file of one kind, files in name order, rows in file order. */
export function readRuns(root: string, kind: string): Row[] { return runFiles(root, kind).flatMap((f) => f.rows.map((r) => r.row)); }

// ---------- schedules ----------
const VERSION = /^v(\d+)-([0-9a-f]{8})$/;
const versions = (root: string): string[] => ls(path.join(root, 'schedules')).filter((n) => n.endsWith('.jsonl')).map((n) => n.slice(0, -6)).filter((n) => VERSION.test(n));

/** Write an immutable schedule version `v<n>-<h8 of content>` (n = highest existing n + 1); the same content gives the same version. */
export function writeSchedule(root: string, rows: readonly Row[]): string {
  const body = text([...new Set(lines(rows))].sort()), h8 = sha8(body);
  let version = '';
  withTxn(root, (tx) => {
    const existing = versions(root);
    const same = existing.find((v) => (VERSION.exec(v) as RegExpExecArray)[2] === h8 && readDataCapped(path.join(root, 'schedules', `${v}.jsonl`), MAX_FILE) === body);
    if (same) { version = same; return; }
    const n = existing.reduce((m, v) => Math.max(m, Number((VERSION.exec(v) as RegExpExecArray)[1])), 0) + 1;
    version = `v${n}-${h8}`;
    tx.write(`schedules/${version}.jsonl`, body);
  });
  return version;
}
export const scheduleVersions = versions;
export const readSchedule = (root: string, version: string): Row[] => {
  if (!VERSION.test(version)) throw Object.assign(new Error('bad schedule version name'), { code: 'BAD_VERSION' });
  return readRows(path.join(root, 'schedules', `${version}.jsonl`)).rows.map((r) => r.row);
};

/** The version named by schedules/CURRENT, or null when the file is missing or does not hold one version name. */
export function currentVersion(root: string): string | null {
  try { const t = readDataCapped(path.join(root, 'schedules', 'CURRENT'), 4096).trim(); return VERSION.test(t) ? t : null; } catch { return null; }
}
export function setCurrent(root: string, version: string): void {
  if (!VERSION.test(version)) throw Object.assign(new Error('bad schedule version name'), { code: 'BAD_VERSION' });
  if (!fs.existsSync(path.join(root, 'schedules', `${version}.jsonl`))) throw Object.assign(new Error(`no such schedule version: ${version}`), { code: 'BAD_VERSION' });
  withTxn(root, (tx) => { tx.write('schedules/CURRENT', `${version}\n`); });
}

// ---------- compaction ----------
export interface CompactResult { merged: string[]; skipped: string[] }

/** Merge sealed months (before the current month) into one content-hashed file per month and kind. Runs only with CI=true or opts.ci, so two
 *  clones cannot race (CI runs it on the default branch). A month with a bad line, a conflict marker or an unreadable file is left alone. */
export function compact(root: string, opts: { ci?: boolean; now?: Date } = {}): CompactResult {
  if (!opts.ci && process.env.CI !== 'true') throw Object.assign(new Error('compact runs only in CI on the default branch: set CI=true or pass --ci'), { code: 'REFUSED' });
  const current = iso(opts.now ?? new Date()).slice(0, 7);
  const merged: string[] = [], skipped: string[] = [];
  withTxn(root, (tx) => {
    const byMonth = new Map<string, BatchFile[]>();
    for (const f of eventFiles(root)) { const m = f.rel.split('/')[1] as string; byMonth.set(m, [...(byMonth.get(m) ?? []), f]); }
    for (const [m, fl] of [...byMonth].sort()) {
      if (m >= current || (fl.length === 1 && (fl[0] as BatchFile).kind === 'compact')) continue;
      if (fl.some((f) => f.bad.length || f.unreadable || f.rows.some((r) => !validEvent(r.row)))) { skipped.push(`events/${m}`); continue; }
      const evs = toEvents(fl).map((e) => ({ ...e }));
      const body = text(evs.map((e) => canon(e))), rel = `events/${m}/_compact.${sha8(body)}.jsonl`;
      for (const f of fl) if (f.rel !== rel) tx.remove(f.rel);
      tx.write(rel, body); merged.push(rel);
    }
    for (const kind of runKinds(root)) {
      const byM = new Map<string, BatchFile[]>();
      for (const f of runFiles(root, kind)) { const m = f.rel.split('/')[2] as string; byM.set(m, [...(byM.get(m) ?? []), f]); }
      for (const [m, fl] of [...byM].sort()) {
        if (m >= current || fl.length < 2) continue;
        if (fl.some((f) => f.bad.length || f.unreadable)) { skipped.push(`runs/${kind}/${m}`); continue; }
        const body = text([...new Set(fl.flatMap((f) => f.rows.map((r) => canon(r.row))))].sort()), rel = `runs/${kind}/${m}/${sha8(body)}.jsonl`;
        for (const f of fl) if (f.rel !== rel) tx.remove(f.rel);
        tx.write(rel, body); merged.push(rel);
      }
    }
    // a no-op transaction when nothing needed merging; an unchanged compact file is rewritten with identical bytes
  });
  return { merged, skipped };
}
