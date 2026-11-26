// lib/history/git.ts: mine a repository's git history into module facts (churn, authors, coupling, bus factor, hotspots).
// Streaming `git log -M --numstat -z` (never the 30 second sync runner), a cursor for incremental runs, a rename map so a moved file stays
// one module, `.mailmap` (applied by git itself) and `.git-blame-ignore-revs`. Author emails are hashed on read and never stored; names
// are never read. Facts are advisory: they are rebuilt from the log and never committed (cache/git.jsonl is a 0600 cache file).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnLines } from '../gitsafe.ts';
import { writeAtomicSafe } from '../fsafe.ts';
import { readCapped } from '../jsonl.ts';
import { resolve as resolveIdentity } from '../identity.ts';
import { PlangraphError } from '../../src/errors.ts';
import { LOG_FORMAT, LogParser } from './parse.ts';
import type { CommitFact } from './parse.ts';
import type { Ctx } from '../../src/context.ts';

export interface ModuleFact {
  repo: string; path: string; commits: number; churn: number; authors: { person: string; share: number }[]; last: string;
  coupled: string[]; hotspot: boolean; bus1: boolean; window: number; min_cochange: number; hot_percentile: number;
}
export interface BuildOpts { repo: string; now: Date; windowDays: number; minCochange: number; maxModules: number; hotPercentile: number; identity?: { byRef: Record<string, string> } | undefined }
export interface IngestOpts { repo?: string; since?: number; full?: boolean; identity?: { byRef: Record<string, string> } }
type GitRun = (...args: string[]) => string;

const MAX_LOG_BYTES = 64 * 1024 * 1024;
const BIG_COMMIT = 50; // a commit touching more files than this adds no coupling pairs (mass edits say nothing about coupling)
const MAX_PAIRS = 2_000_000;
const MAX_COUPLED = 10;
const OTHER = 'other';
const DAY = 86400;

export const isShallow = (git: GitRun): boolean => { try { return git('rev-parse', '--is-shallow-repository').trim() === 'true'; } catch { return false; } };
export function isPartial(git: GitRun): boolean {
  try { if (git('config', '--get', 'extensions.partialclone').trim()) return true; } catch { /* unset */ }
  try { return /\btrue\s*$/m.test(git('config', '--get-regexp', '^remote\\..*\\.promisor$')); } catch { return false; }
}

const round3 = (x: number): number => Math.round(x * 1000) / 1000;

/** Commits are newest first (git log order). A rename in a commit maps the old path to the new one for every OLDER commit. */
export function buildModules(commits: readonly CommitFact[], o: BuildOpts): ModuleFact[] {
  const cutoff = o.now.getTime() - o.windowDays * DAY * 1000;
  const alias = new Map<string, string>();
  const canon = (p: string): string => { let x = p; for (let i = 0; i < 64; i++) { const n = alias.get(x); if (n === undefined || n === x) break; x = n; } return x; };
  interface Acc { commits: number; churn: number; last: string; authors: Map<string, number> }
  const mods = new Map<string, Acc>();
  const pairs = new Map<string, number>();
  for (const c of commits) {
    const touched = new Map<string, number>();
    for (const f of c.files) {
      const p = canon(f.path);
      if (f.renamedFrom !== undefined) alias.set(f.renamedFrom, p);
      touched.set(p, (touched.get(p) ?? 0) + f.added + f.deleted);
    }
    if (Date.parse(c.at) < cutoff) continue;
    for (const [p, churn] of touched) {
      let m = mods.get(p);
      if (!m) mods.set(p, (m = { commits: 0, churn: 0, last: c.at, authors: new Map() }));
      m.commits++; m.churn += churn; if (c.at > m.last) m.last = c.at;
      m.authors.set(c.author, (m.authors.get(c.author) ?? 0) + 1);
    }
    if (touched.size > 1 && touched.size <= BIG_COMMIT) {
      const ps = [...touched.keys()].sort();
      for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
        const k = `${ps[i]}\0${ps[j]}`, n = pairs.get(k);
        if (n !== undefined) pairs.set(k, n + 1); else if (pairs.size < MAX_PAIRS) pairs.set(k, 1);
      }
    }
  }
  const partners = new Map<string, [string, number][]>();
  for (const [k, n] of pairs) {
    if (n < o.minCochange) continue;
    const [a, b] = k.split('\0') as [string, string];
    (partners.get(a) ?? partners.set(a, []).get(a) as [string, number][]).push([b, n]);
    (partners.get(b) ?? partners.set(b, []).get(b) as [string, number][]).push([a, n]);
  }
  const kept = [...mods].sort((x, y) => y[1].churn - x[1].churn || y[1].commits - x[1].commits || (x[0] < y[0] ? -1 : 1)).slice(0, o.maxModules);
  const n = kept.length;
  const lower = (vals: number[]): ((v: number) => number) => { const s = [...vals].sort((a, b) => a - b); return (v) => { let lo = 0, hi = s.length; while (lo < hi) { const mid = (lo + hi) >> 1; if ((s[mid] as number) < v) lo = mid + 1; else hi = mid; } return lo / n; }; };
  const rc = lower(kept.map(([, m]) => m.churn)), rk = lower(kept.map(([, m]) => m.commits));
  const scores = kept.map(([, m]) => rc(m.churn) * rk(m.commits));
  const threshold = n ? [...scores].sort((a, b) => a - b)[Math.max(0, Math.ceil((o.hotPercentile / 100) * n) - 1)] as number : 0;
  const idmap = o.identity ?? { byRef: {} };
  const out: ModuleFact[] = kept.map(([p, m], i) => {
    const byPerson = new Map<string, number>();
    for (const [ref, cnt] of m.authors) { const who = resolveIdentity({ version: 1, byRef: idmap.byRef }, ref) ?? OTHER; byPerson.set(who, (byPerson.get(who) ?? 0) + cnt); }
    const authors = [...byPerson].map(([person, cnt]) => ({ person, share: round3(cnt / m.commits) })).sort((a, b) => b.share - a.share || (a.person < b.person ? -1 : 1));
    const coupled = (partners.get(p) ?? []).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, MAX_COUPLED).map(([q]) => q);
    const s = scores[i] as number;
    return { repo: o.repo, path: p, commits: m.commits, churn: m.churn, authors, last: m.last, coupled, hotspot: s > 0 && s >= threshold, bus1: m.authors.size === 1, window: o.windowDays, min_cochange: o.minCochange, hot_percentile: o.hotPercentile };
  });
  return out.sort((a, b) => (a.repo === b.repo ? 0 : a.repo < b.repo ? -1 : 1) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// ---------- ingest ----------
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : d);
const readSmall = (root: string, name: string): string => { try { return readCapped(path.join(root, name), 1 << 20); } catch { return ''; } };
const ignoredRevs = (text: string): Set<string> => new Set(text.split('\n').map((l) => l.replace(/#.*/, '').trim()).filter((l) => /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(l)));

// cache/git.cursor: line 1 the head sha, line 2 meta (what the facts depend on besides the log), then one compact commit per line.
// Incremental runs reuse the stored commits; any change of meta (window, mailmap, ignore list) forces a full rebuild.
const encode = (c: CommitFact): string => JSON.stringify([c.sha, c.at, c.author, c.files.map((f) => (f.renamedFrom === undefined ? [f.path, f.added, f.deleted] : [f.path, f.added, f.deleted, f.renamedFrom]))]);
function decode(line: string): CommitFact | null {
  try {
    const [sha, at, author, files] = JSON.parse(line) as [string, string, string, [string, number, number, string?][]];
    if (typeof sha !== 'string' || typeof at !== 'string' || typeof author !== 'string' || !Array.isArray(files)) return null;
    return { sha, at, author, files: files.map(([p, a, d, from]) => (from === undefined ? { path: p, added: a, deleted: d } : { path: p, added: a, deleted: d, renamedFrom: from })) };
  } catch { return null; }
}
function readCursor(file: string): { sha: string; meta: string; commits: CommitFact[] } | null {
  let text: string;
  try { text = readCapped(file, 256 * 1024 * 1024); } catch { return null; }
  const lines = text.split('\n');
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(lines[0] ?? '') || !lines[1]) return null;
  const commits: CommitFact[] = [];
  for (const l of lines.slice(2)) { if (!l) continue; const c = decode(l); if (!c) return null; commits.push(c); }
  return { sha: lines[0] as string, meta: lines[1], commits };
}

export async function ingestGit(ctx: Pick<Ctx, 'root' | 'dir' | 'git' | 'now' | 'config' | 'io'>, opts: IngestOpts = {}): Promise<{ written: number; cursor: string; commits: number; incremental: boolean }> {
  const git = ctx.git;
  if (isShallow(git)) throw new PlangraphError('DATA', 'shallow clone: run git fetch --unshallow');
  if (isPartial(git)) ctx.io.err('partial clone: only commit data is read, no file contents are fetched');
  const hist = ((ctx.config() as { history?: Record<string, unknown> }).history ?? {}) as Record<string, unknown>;
  const windowDays = opts.since ?? num(hist.window_days, 365);
  const minCochange = num(hist.min_cochange, 5), maxModules = num(hist.max_modules, 300), hotPercentile = Math.min(100, num(hist.hot_percentile, 90));
  const repo = opts.repo ?? 'self';
  const now = ctx.now();
  const cutoffMs = now.getTime() - windowDays * DAY * 1000;
  const mailmap = readSmall(ctx.root, '.mailmap'), ignoreText = readSmall(ctx.root, '.git-blame-ignore-revs');
  const ignore = ignoredRevs(ignoreText);
  const meta = JSON.stringify({ v: 1, window: windowDays, dep: crypto.createHash('sha256').update(mailmap).update('\0').update(ignoreText).digest('hex').slice(0, 16) });
  const cacheDir = path.join(ctx.dir, 'cache');
  const cursorFile = path.join(cacheDir, 'git.cursor'), factsFile = path.join(cacheDir, 'git.jsonl');

  let head = '';
  try { head = git('rev-parse', '--verify', '-q', 'HEAD').trim(); } catch { head = ''; }
  const write = (text: string, file: string) => writeAtomicSafe(file, text, { root: ctx.root, mode: 0o600 });
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  if (!head) { write('', factsFile); return { written: 0, cursor: '', commits: 0, incremental: false }; }

  let stored: CommitFact[] = [], range = 'HEAD', incremental = false;
  const cur = opts.full ? null : readCursor(cursorFile);
  if (cur && cur.meta === meta) {
    let anc = false;
    try { git('merge-base', '--is-ancestor', cur.sha, 'HEAD'); anc = true; } catch { anc = false; }
    if (anc) { incremental = true; stored = cur.commits; range = `${cur.sha}..HEAD`; }
  }
  const parser = new LogParser();
  const argv = ['-C', ctx.root, '-c', 'core.quotepath=false', 'log', '-M', '--numstat', '-z', `--format=${LOG_FORMAT}`];
  if (!incremental) argv.push(`--since=${Math.floor(cutoffMs / 1000) - DAY}`);
  argv.push(range, '--');
  await spawnLines('git', argv, (tok) => parser.push(tok), { delimiter: '\0', maxBytes: MAX_LOG_BYTES });

  const keep = (c: CommitFact): boolean => !ignore.has(c.sha) && Date.parse(c.at) >= cutoffMs;
  const commits = [...parser.commits.filter(keep), ...stored.filter(keep)];
  const modules = buildModules(commits, { repo, now, windowDays, minCochange, maxModules, hotPercentile, ...(opts.identity ? { identity: opts.identity } : {}) });
  write(modules.map((m) => `${JSON.stringify(m)}\n`).join(''), factsFile);
  write(`${head}\n${meta}\n${commits.map((c) => `${encode(c)}\n`).join('')}`, cursorFile);
  return { written: modules.length, cursor: head, commits: commits.length, incremental };
}
