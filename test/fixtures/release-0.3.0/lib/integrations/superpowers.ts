// lib/integrations/superpowers.ts: ingest superpowers implementation plans and SDD ledgers into plangraph records.
// See docs/INTEGRATIONS.md ("Ingesting superpowers plans") and docs/research/integrations/superpowers.md sections 2, 5 and 7.
// parsePlan, parseLedger and ingestPlan are pure. findLedgers and readSpFile read through the fs object they are handed (read-only:
// superpowers' files are never written, and nothing found in a plan or ledger is ever executed). No printing, no process.exit.
import fs from 'node:fs';
import path from 'node:path';

import { IngestError, readCapped } from '../jsonl.ts';
import { oneLine } from '../sanitize.ts';
import { checkRepoPath } from '../gitsafe.ts';
import type { Edge, ImplStatus, ScheduleRow, Ticket } from '../model.ts';
import type { PlanRef, RefsRow } from '../stale.ts';

/** One task of a parsed plan. */
export interface SpTask {
  id: string; alias: string | null; title: string; level: number; line: number; files: string[]; consumes: string[]; produces: string[]; steps: number; ticked: number;
  refs: string[]; points: number | null;
}
/** A plan's header fields (a type alias, so the header-field loop can write it by name). */
export type PlanHeader = { title: string; goal: string; architecture: string; techStack: string; spec: string | null; banner: boolean };
/** parsePlan's answer. */
export interface ParsedPlan { slug: string; path: string; format: string; header: PlanHeader; globalConstraints: string[]; reviewFocus: string[]; tasks: SpTask[]; warnings: string[] }
/** One task status derived from a ledger. */
export interface LedgerEntry { task: string; status: ImplStatus; commits?: string; notes: string[] }
/** A ruling, parked or deferred line; task is null for a plan-level line. */
export interface LedgerNote { task: string | null; text: string; line: number }
/** parseLedger's answer (also mergeLedgers'). */
export interface ParsedLedger {
  plan: string | null; entries: LedgerEntry[]; rulings: LedgerNote[]; parked: LedgerNote[]; deferred: LedgerNote[]; mentioned: string[]; unclassified: number;
  firstUnclassified: number; warnings: string[];
}
/** A task's state while a ledger is scanned. */
interface LedgerTaskState { task: string; status: ImplStatus | null; done: boolean; commits: string | null; notes: string[] }
/** A finding record as sp-ingest writes it. */
export interface SpFinding { key: string; kind: string; text: string; [extra: string]: unknown }
/** The plan records sp-ingest reads and rewrites. */
export interface SpRecords { tickets: readonly Ticket[]; edges: readonly Edge[]; findings: readonly SpFinding[]; refs: readonly RefsRow[]; schedule: readonly ScheduleRow[] }
/** ingestPlan options. plan is required: plan.slug throws without it, as it always did. */
export interface IngestOpts { plan: ParsedPlan; ledger?: ParsedLedger | null; existing?: Partial<SpRecords>; owner?: string; sprint?: number | null }
/** ingestPlan's summary. */
export interface SpIngestReport {
  key: string; format: string; tasks: number; edges: number; findings: number; statuses: number; ledger: boolean; kept: number; unclassified: number; firstUnclassified: number;
  removed: number; seeded: number; seededPoints: number; seededWithPoints: number; orphanSchedule: number; warnings: string[]; planWarnings: string[]; ledgerWarnings: string[];
}
/** ingestPlan's answer: the full desired content of each file, and a summary. */
export interface IngestResult { tickets: Ticket[]; edges: Edge[]; findings: SpFinding[]; refs: RefsRow[]; schedule: ScheduleRow[]; report: SpIngestReport }
/** One ledger found on disk. */
export interface FoundLedger { path: string; layout: 'per-plan' | 'flat'; root: string }

export { IMPL_STATUSES } from '../schema.ts';
export const PLAN_KINDS = ['sp_constraint', 'sp_review_focus'];
export const LEDGER_KINDS = ['sp_ruling', 'sp_parked', 'sp_deferred'];
export const EDGE_KIND = 'sp_needs';
// idChars and slugChars cap the parts of a key `sp:<slug>/<id>` (so a key is at most 3 + 48 + 1 + 24 = 76 characters).
export const LIMITS = { planBytes: 8 << 20, ledgerBytes: 2 << 20, tasks: 500, ledgerLines: 2000, summary: 200, finding: 500, note: 120, idChars: 24, slugChars: 48 };

const fail = (msgs: string | string[]) => new IngestError(Array.isArray(msgs) ? msgs : [msgs], 'SpIngestError');
const ID = '[A-Za-z0-9]+(?:\\.[A-Za-z0-9]+)*';
const hasDigit = (id: string): boolean => /[0-9]/.test(id);
const lt = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// ---------- linear-time line scanning ----------
// Every line of a plan or ledger can be megabytes long and is written by someone else, so the parses that used backtracking regexes
// with nested or adjacent quantifiers (H1, Task headings and titles, ledger task lines, identity lines, parked lines) are plain
// left-to-right scans here. The remaining regexes are anchored with no ambiguous adjacent quantifiers; lines are normalized first
// (lone CR, U+2028 and U+2029 become spaces) so `.` matches every character of a line and no `.*$` can fail and backtrack.
const WS1 = /^\s$/;
const isWs = (c: string | undefined): boolean => c === ' ' || c === '\t' || (c !== undefined && c !== '' && WS1.test(c));
const isAlnum = (c: string | undefined): boolean => c !== undefined && ((c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z'));
const isWord = (c: string | undefined): boolean => isAlnum(c) || c === '_';
const isDash = (c: string | undefined): boolean => c === '-' || c === '—';
const normLine = (l: string): string => l.replace(/[\r\u2028\u2029]/g, ' ');
// ASCII case-insensitive comparison of s at i with a lowercase word (no toLowerCase: it can change string length and shift indexes).
const eqCI = (s: string, i: number, w: string): boolean => { if (i < 0 || i + w.length > s.length) return false; for (let k = 0; k < w.length; k++) { const c = s.charCodeAt(i + k), d = w.charCodeAt(k); if (c !== d && !(d >= 97 && d <= 122 && c === d - 32)) return false; } return true; };
const wordAt = (s: string, i: number, w: string): boolean => eqCI(s, i, w) && !isWord(s[i - 1]) && !isWord(s[i + w.length]);
// End of a task id starting at i (`[A-Za-z0-9]+(\.[A-Za-z0-9]+)*`, longest match), or i when there is none.
function scanId(s: string, i: number): number {
  let j = i; while (isAlnum(s[j])) j++;
  if (j === i) return i;
  while (s[j] === '.' && isAlnum(s[j + 1])) { j++; while (isAlnum(s[j])) j++; }
  return j;
}
const skipWs = (s: string, i: number): number => { while (isWs(s[i])) i++; return i; };

// `# Title` -> the title (trailing # and spaces stripped, a trailing " Implementation Plan" dropped), or null when not an H1.
function h1Title(l: string): string | null {
  if (l[0] !== '#' || l.length < 3 || !isWs(l[1])) return null;
  let t = l.slice(1).trim(), e = t.length;
  while (e > 0 && (t[e - 1] === '#' || isWs(t[e - 1]))) e--;
  t = t.slice(0, e);
  const SUF = 'implementation plan';
  if (t.length > SUF.length && eqCI(t, t.length - SUF.length, SUF) && isWs(t[t.length - SUF.length - 1])) t = t.slice(0, -SUF.length).trimEnd();
  return t;
}
// `## Task <id>[: title]` (levels 2 to 4, spaces or tabs) -> { level, id, rest } or null.
function taskHeading(l: string): { level: number; id: string; rest: string } | null {
  let i = 0; while (l[i] === '#') i++;
  if (i < 2 || i > 4) return null;
  const level = i; while (l[i] === ' ' || l[i] === '\t') i++;
  if (i === level || !l.startsWith('Task', i)) return null;
  const b = (i += 4); while (l[i] === ' ' || l[i] === '\t') i++;
  if (i === b) return null;
  const e = scanId(l, i); if (e === i) return null;
  if (e < l.length && l[e] !== ':' && !isWs(l[e])) return null;
  return { level, id: l.slice(i, e), rest: l.slice(e) };
}
// The text after a task id: optional ':', optional `[label]` (1 to 20 characters), optional ':' after the label, then the title.
function taskTitle(rest: string): { alias: string | null; title: string } {
  let t = rest.trim(), alias: string | null = null;
  if (t[0] === ':') t = t.slice(1).trimStart();
  if (t[0] === '[') {
    const close = t.indexOf(']', 1);
    if (close > 1 && close <= 21) { alias = t.slice(1, close); t = t.slice(close + 1).trimStart(); if (t[0] === ':') t = t.slice(1).trimStart(); }
  }
  return { alias, title: t };
}

// ---------- plan ----------
const RX = {
  banner: /^>\s*\*\*For agentic workers:\*\*.*\bsuperpowers:(subagent-driven-development|executing-plans)\b/,
  field: /^\*\*(Goal|Architecture|Tech Stack|Spec):\*\*\s*(.*)$/i,
  section: /^#{2}\s+(Global Constraints|Review Focus)\s*$/i,
  heading: /^(#{1,6})\s/,
  hrule: /^---\s*$/,
  bullet: /^\s*[-*]\s+(.+)$/,
  filesHdr: /^\*\*Files:\*\*\s*(.*)$/i,
  fileItem: /^\s*[-*]\s+(Create|Modify|Test|Delete|Rename|Move):\s*`([^`]+)`/i,
  ifaceHdr: /^\*\*Interfaces:\*\*\s*(.*)$/i,
  ifaceItem: /^\s*[-*]\s+(?:\*\*)?(Consumes|Produces)(?:\*\*)?:(?:\*\*)?\s*(.*)$/i,
  step: /^\s*[-*]\s+\[([ xX])\]\s+(?:\*\*)?Step\s+\d+/,
  points: /^\s*(?:[-*]\s+)?\*{0,2}Points:\*{0,2}\s*(\d+(?:\.\d+)?)\s*$/i,
  label: /^\*\*[A-Za-z][\w ]{0,30}:\*\*/,
  taskRef: new RegExp(`\\bTask\\s+(${ID})\\b`, 'g'),
  taskShaped: /^#{2,4}\s+\S+\s+[A-Za-z]?\d/,
};
const CODE_EXT = /\.(md|mjs|cjs|js|jsx|ts|tsx|json|jsonl|py|sh|txt|ya?ml|toml|csv|css|html|sql|go|rs|rb|java|lock|cfg|ini)$/i;
const fenceOpen = (l: string): (RegExpExecArray & { 1: string }) | null => /^ {0,3}(`{3,}|~{3,})/.exec(l) as (RegExpExecArray & { 1: string }) | null; // group 1 is not optional

// Every line of `lines` with the CommonMark fence state and HTML comments removed: skip[i] is true for fence lines and everything
// between, and for lines that are entirely inside `<!-- ... -->` (possibly multi-line); text[i] is the line with inline comment parts
// cut out. A comment opener inside a fence or an inline code span opens nothing, and a fence inside a comment is not a fence. Linear (indexOf scans).
function blockMap(lines: string[]): { skip: boolean[]; text: string[]; unclosed: number; unclosedComment: number; swallowed: Array<[number, number]> } {
  const skip: boolean[] = new Array(lines.length).fill(false), text = lines.slice(), swallowed: Array<[number, number]> = []; let open: { ch: string; len: number; line: number } | null = null, comment = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] as string; // i < lines.length
    if (open) {
      skip[i] = true;
      const m = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(l);
      if (m && (m[1] as string)[0] === open.ch && (m[1] as string).length >= open.len) open = null; // group 1 is not optional
      continue;
    }
    if (!comment) {
      const m = fenceOpen(l);
      if (m && !(m[1][0] === '`' && l.slice(l.indexOf(m[1]) + m[1].length).includes('`'))) { open = { ch: m[1][0] as string, len: m[1].length, line: i + 1 }; skip[i] = true; continue; } // a fence run has at least 3 characters
      if (!l.includes('<!--')) continue;
    }
    if (comment && /^ {0,3}#{2,4}\s+Task\b/.test(l) && !swallowed.some((x) => x[0] === comment)) swallowed.push([comment, i + 1]);
    let out = '', pos = 0, runs: Array<[number, number]> | null = null, r = 0, ptr: Map<number, number> | null = null;
    while (pos < l.length) {
      if (comment) { const e = l.indexOf('-->', pos); if (e < 0) break; comment = 0; pos = e + 3; continue; }
      if (runs === null) { // backtick runs of the line, once: [start, length]; ptr[len] = index into the runs of that length
        runs = []; ptr = new Map();
        for (let k = l.indexOf('`'); k >= 0; ) { let e = k; while (l[e] === '`') e++; runs.push([k, e - k]); k = l.indexOf('`', e); }
      }
      while (r < runs.length && (runs[r] as [number, number])[0] < pos) r++; // r < runs.length is tested first
      const b = l.indexOf('<!--', pos);
      if (b < 0 && r >= runs.length) { out += l.slice(pos); break; }
      if (r < runs.length && (b < 0 || (runs[r] as [number, number])[0] < b)) { // a code span (CommonMark: closed by a run of equal length) or literal backticks; r < runs.length is tested first
        const [st, n] = runs[r] as [number, number]; let j = (ptr as Map<number, number>).get(n) ?? r + 1; // r < runs.length; ptr is set with runs
        while (j < runs.length && !((runs[j] as [number, number])[1] === n && (runs[j] as [number, number])[0] > st)) j++; // j < runs.length is tested first
        (ptr as Map<number, number>).set(n, j); // set with runs
        const end = j < runs.length ? (runs[j] as [number, number])[0] + n : st + n; // j < runs.length is tested
        out += l.slice(pos, end); pos = end; continue;
      }
      out += l.slice(pos, b); comment = i + 1; pos = b + 4;
    }
    if (out.trim()) text[i] = out; else skip[i] = true;
  }
  return { skip, text, unclosed: open ? open.line : 0, unclosedComment: comment, swallowed };
}

// Repo-relative path from a plan token: line range stripped, then checkRepoPath. Returns null (and a warning) when refused.
function cleanPath(raw: unknown, where: string, warnings: string[]): string | null {
  const p = String(raw).trim().replace(/:(\d+)(?:-(\d+))?$/, '');
  if (/[*?[\]]/.test(p)) { warnings.push(`${where}: glob not recorded as a file`); return null; }
  try { return checkRepoPath(p); } catch { warnings.push(`${where}: refused path ${oneLine(p, 60)}`); return null; }
}
const inlineFiles = (text: unknown): string[] => [...String(text).matchAll(/`([^`\s(]+)`/g)].map((m) => m[1] as string).filter((t) => t.includes('/') || CODE_EXT.test(t)); // group 1 always matches
// Identifiers a task declares in its Produces text: a backticked token that starts with an identifier followed by ( or : or the closing backtick.
const producedSymbols = (texts: string[]): Set<string> => new Set(texts.flatMap((t) => [...t.matchAll(/`([A-Za-z_$][\w$.]*)\s*(?:\(|:|`)/g)].map((m) => m[1] as string))); // group 1 always matches
// Identifiers a task names in its Consumes text: an exact backticked identifier.
const consumedSymbols = (texts: string[]): Set<string> => new Set(texts.flatMap((t) => [...t.matchAll(/`([A-Za-z_$][\w$.]*)`/g)].map((m) => m[1] as string))); // group 1 always matches

// parsePlan(text, name): name is the plan path (repo-relative; its basename gives the slug). Pure. Throws SpIngestError on an unclosed
// fence, duplicate task ids, zero Task headings, too many tasks, or a file name that cannot be a key. Plan text is sanitized here.
export function parsePlan(text: unknown, name: unknown): ParsedPlan {
  const src = String(text ?? '').replace(/^﻿/, '');
  const base = path.posix.basename(String(name || '').replace(/\\/g, '/'));
  const slug = base.replace(/\.md$/i, '');
  if (slug.length > LIMITS.slugChars) throw fail(`plan file name longer than ${LIMITS.slugChars} characters (the name is part of every key)`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slug) || slug.includes('..')) throw fail(`plan file name cannot be used as a key: ${oneLine(base, 60)}`);
  const { skip, text: lines, unclosed, unclosedComment, swallowed } = blockMap(src.split(/\r?\n/).map(normLine));
  if (unclosed) throw fail(`${oneLine(base, 80)}: unclosed fence at line ${unclosed}`);
  if (unclosedComment) throw fail(`${oneLine(base, 80)}: unclosed HTML comment at line ${unclosedComment}`);

  const warnings: string[] = [], header: PlanHeader = { title: '', goal: '', architecture: '', techStack: '', spec: null, banner: false };
  const globalConstraints: string[] = [], reviewFocus: string[] = [], tasks: SpTask[] = [];
  for (const [start, at] of swallowed.slice(0, 20)) warnings.push(`HTML comment starting at line ${start} swallows a task heading (line ${at}): tasks inside comments are not ingested`);
  let section: string[] | null = null, task: SpTask | null = null, mode: string | null = null, item: number | [string[], number] | null = null, headerSeen = false;
  const shaped: number[] = [];
  const closeTask = () => { if (task) tasks.push(task); task = null; mode = null; item = null; };
  for (let i = 0; i < lines.length; i++) {
    if (skip[i]) continue;
    const l = lines[i] as string; // i < lines.length
    if (!headerSeen && l.trim()) { headerSeen = true; const h1 = h1Title(l); if (h1 !== null) { header.title = oneLine(h1, LIMITS.summary); continue; } }
    const t = taskHeading(l);
    if (t && hasDigit(t.id)) {
      const { level, id } = t;
      if (task && level > task.level && id.startsWith(task.id) && id !== task.id) continue; // `#### Task 7a` stays inside `### Task 7`
      if (id.length > LIMITS.idChars) throw fail(`${oneLine(base, 80)}: task ${tasks.length + (task ? 2 : 1)} (line ${i + 1}): id longer than ${LIMITS.idChars} characters`);
      closeTask(); section = null;
      const tm = taskTitle(t.rest);
      task = { id, alias: tm.alias ? oneLine(tm.alias, 20) : null, title: oneLine(tm.title, LIMITS.summary), level, line: i + 1, files: [], consumes: [], produces: [], steps: 0, ticked: 0, refs: [], points: null };
      continue;
    }
    const h = RX.heading.exec(l);
    if (h) {
      if (RX.taskShaped.test(l)) shaped.push(i + 1);
      if (task && (h[1] as string).length <= task.level) closeTask(); // group 1 of RX.heading is not optional
      const s = RX.section.exec(l); section = s ? (/^global/i.test(s[1] as string) ? globalConstraints : reviewFocus) : null; item = null; // group 1 of RX.section is not optional
      continue;
    }
    if (RX.hrule.test(l)) { section = null; item = null; if (!task) continue; }
    if (section) {
      const b = RX.bullet.exec(l);
      if (b) { section.push(b[1] as string); item = section.length - 1; } // group 1 of RX.bullet is not optional
      else if (item !== null && /^\s+\S/.test(l)) section[item as number] += ' ' + l.trim(); // in a section, item is an index
      else if (!l.trim()) item = null;
      continue;
    }
    if (!task) {
      if (RX.banner.test(l)) header.banner = true;
      const f = RX.field.exec(l);
      if (f) { const k = ({ goal: 'goal', architecture: 'architecture', 'tech stack': 'techStack', spec: 'spec' } as Record<string, string>)[(f[1] as string).toLowerCase()] as string; (header as Record<string, unknown>)[k] = k === 'spec' ? (f[2] as string).trim() || null : oneLine(f[2] as string, LIMITS.finding); } // RX.field matches only these four names; both of its groups are not optional
      continue;
    }
    // inside a task
    const where = `task ${task.id}`;
    const st = RX.step.exec(l);
    if (st) { task.steps++; if (st[1] !== ' ') task.ticked++; mode = null; continue; }
    const pts = RX.points.exec(l); if (pts) { task.points = Number(pts[1]); continue; }
    const fh = RX.filesHdr.exec(l);
    if (fh) { mode = 'files'; for (const p of inlineFiles(fh[1])) { const c = cleanPath(p, where, warnings); if (c) task.files.push(c); } continue; }
    const ih = RX.ifaceHdr.exec(l);
    if (ih) {
      mode = 'iface'; item = null;
      for (const m of (ih[1] as string).matchAll(/\b(Consumes|Produces)\b:?\s*(.*?)(?=\bConsumes\b|\bProduces\b|$)/gi)) (/^c/i.test(m[1] as string) ? task.consumes : task.produces).push((m[2] as string).trim()); // both groups are not optional, as is group 1 of RX.ifaceHdr
      continue;
    }
    if (RX.label.test(l)) { mode = null; continue; }
    if (mode === 'files') {
      const fi = RX.fileItem.exec(l);
      if (fi) { const c = cleanPath(fi[2], where, warnings); if (c) task.files.push(c); continue; }
      if (l.trim() && !/^\s/.test(l) && !RX.bullet.test(l)) mode = null;
      continue;
    }
    if (mode === 'iface') {
      const ii = RX.ifaceItem.exec(l);
      if (ii) { const arr = /^c/i.test(ii[1] as string) ? task.consumes : task.produces; arr.push(ii[2] as string); item = [arr, arr.length - 1]; continue; } // both groups of RX.ifaceItem are not optional
      if (item && /^\s+\S/.test(l) && !RX.bullet.test(l)) { (item as [string[], number])[0][(item as [string[], number])[1]] += ' ' + l.trim(); continue; } // in iface mode, item is [list, index]
      if (l.trim()) mode = null;
    }
  }
  closeTask();

  if (!tasks.length) throw fail(`${oneLine(base, 80)}: no Task headings${shaped.length ? ` (task-shaped headings at lines ${shaped.slice(0, 5).join(', ')})` : ''}`);
  if (tasks.length > LIMITS.tasks) throw fail(`${oneLine(base, 80)}: too many tasks (${tasks.length} > ${LIMITS.tasks})`);
  const seen = new Map<string, number>(), dups: string[] = [];
  for (const t of tasks) { if (seen.has(t.id)) dups.push(`duplicate task id ${t.id} (lines ${seen.get(t.id)} and ${t.line})`); else seen.set(t.id, t.line); }
  if (dups.length) throw fail(dups);
  for (const t of tasks) {
    t.files = [...new Set(t.files)];
    t.refs = [...new Set(t.consumes.flatMap((c) => [...c.matchAll(RX.taskRef)].map((m) => m[1] as string).filter(hasDigit)))]; // group 1 of RX.taskRef is not optional
    t.consumes = t.consumes.map((c) => oneLine(c, LIMITS.finding)); t.produces = t.produces.map((c) => oneLine(c, LIMITS.finding));
  }
  let spec: string | null = null;
  if (header.spec) spec = cleanPath(header.spec.replace(/^`|`$/g, ''), 'spec', warnings);
  header.spec = spec;
  return {
    slug, path: String(name), format: header.spec || reviewFocus.length ? '7' : '6.1', header,
    globalConstraints: globalConstraints.map((c) => oneLine(c, LIMITS.finding)), reviewFocus: reviewFocus.map((c) => oneLine(c, LIMITS.finding)),
    tasks, warnings,
  };
}

// ---------- ledger ----------
const COMMITS = /\bcommits\s+([0-9a-f]{7,40}|HEAD)\.\.([0-9a-f]{7,40}|HEAD)\b/;
const firstLine = (text: unknown): string => normLine(String(text ?? '').replace(/^﻿/, '').split(/\r?\n/).find((l) => l.trim()) ?? '');
// Per-plan identity (6.2.0 to 7.0.2): `# SDD ledger — plan: <path>` (spaces optional around the dash run).
function identity7(l: string): string | null {
  let i = skipWs(l, 1);
  if (!l.startsWith('SDD ledger', i)) return null;
  i = skipWs(l, i + 10);
  const d = i; while (isDash(l[i])) i++;
  if (i === d) return null;
  i = skipWs(l, i);
  if (!l.startsWith('plan:', i)) return null;
  return l.slice(i + 5).trim() || null;
}
// Free-form identity: the word `ledger`, later the word `plan`, then (after any non-alphanumerics) a token without spaces, `;` or `)`
// that ends in `.md` (case-insensitive) before a non-word character. As the former regex: the last `ledger` that has such a `plan`
// after it, then the first such `plan`. Linear: each candidate's skipped stretch is disjoint, and each token run is scanned once.
const isStop = (c: string | undefined): boolean => c === ';' || c === ')' || isWs(c);
function identityAny(l: string): string | null {
  const L: number[] = [], P: number[] = [];
  for (let i = 0; i < l.length; i++) { if (wordAt(l, i, 'ledger')) L.push(i); else if (wordAt(l, i, 'plan')) P.push(i); }
  if (!L.length || !P.length) return null;
  const good: Array<[number, string]> = []; let runEnd = -1, bestE = -1;
  for (const p of P) {
    if (p < (L[0] as number) + 6) continue; // L is not empty (returned above)
    let a = p + 4; while (a < l.length && !isAlnum(l[a])) a++;
    if (a >= l.length) continue;
    if (a >= runEnd) { // a new token run starts at or before a: scan it once for its last `.md` end
      runEnd = a; bestE = -1;
      while (runEnd < l.length && !isStop(l[runEnd])) { runEnd++; if (runEnd >= 3 && eqCI(l, runEnd - 3, '.md') && !isWord(l[runEnd])) bestE = runEnd; }
    }
    let lo = a; while (lo > p + 4 && !isStop(l[lo - 1])) lo--; // earliest start the skipped stretch allows
    const start = Math.min(a, bestE - 4);
    if (bestE >= 0 && start >= lo) good.push([p, l.slice(start, bestE)]);
  }
  if (!good.length) return null;
  const lastGood = (good[good.length - 1] as [number, string])[0]; // good is not empty
  let li = -1; for (const x of L) if (x + 6 <= lastGood) li = x;
  return (good.find(([p]) => p >= li + 6) as [number, string])[1]; // lastGood's own entry passes
}
// The plan path named by a ledger's identity line, or null. Only the first non-blank line counts, and only if it starts with '#'.
export function ledgerIdentity(text: unknown): string | null {
  const first = firstLine(text);
  if (!first.startsWith('#')) return null;
  const m = identity7(first) ?? identityAny(first);
  return m ? m.replace(/^`|`$/g, '') : null;
}
// Does the ledger's first non-blank line name this plan (its repo-relative path or its file name)? The identity of a flat ledger
// without a machine identity line (this repository's own ledger names its plan this way).
export function firstLineNamesPlan(text: unknown, planPath: string | null | undefined, planSlug: string | null | undefined): boolean {
  const first = firstLine(text);
  if (!first) return false;
  if (planPath && namesToken(first, normPlan(planPath))) return true;
  return !!planSlug && namesToken(first, planSlug + '.md');
}
// Does `line` contain `tok` as a whole token? Linear scan over the indexOf hits. After the token: not alphanumeric, '.', '-' or '_'
// (plan.md.bak and plan.md-old are other files). Before it: start, whitespace, quote, backtick or '('; a repo-relative path may not
// follow '/' (that is a longer path), and a bare file name may not either (that names another directory).
function namesToken(line: string, tok: string): boolean {
  for (let at = line.indexOf(tok); at >= 0; at = line.indexOf(tok, at + 1)) {
    const b = at === 0 ? '' : line[at - 1], a = line[at + tok.length] ?? '';
    if (b && !(/\s/.test(b) || b === '"' || b === "'" || b === '`' || b === '(')) continue;
    if (a && /[A-Za-z0-9._-]/.test(a)) continue;
    return true;
  }
  return false;
}
// `Task <id>[ (alias)][:] body` -> { id, body } or null (the alias is 1 to 20 characters without ')').
function taskLine(l: string): { id: string; body: string } | null {
  if (!l.startsWith('Task')) return null;
  const i = skipWs(l, 4); if (i === 4) return null;
  const e = scanId(l, i); if (e === i) return null;
  let j = skipWs(l, e);
  if (l[j] === '(') { const close = l.indexOf(')', j + 1); if (close > j + 1 && close - j - 1 <= 20) j = close + 1; else j = e; }
  j = skipWs(l, j); if (l[j] === ':') j++;
  return { id: l.slice(i, e), body: l.slice(skipWs(l, j)) };
}
// `parked — <text> — Ruling: <ruling>` (dash runs of - or —, case-insensitive words) -> [text, ruling] or null. As the former lazy regex:
// the first `Ruling:` preceded by spaces, a dash run and spaces that leaves at least one character of text.
function parkedLine(b: string): [string, string] | null {
  if (!eqCI(b, 0, 'parked')) return null;
  let i = 6; const w0 = i; i = skipWs(b, i); if (i === w0) return null;
  const d0 = i; while (isDash(b[i])) i++; if (i === d0) return null;
  const w1 = i; i = skipWs(b, i); if (i === w1) return null;
  const s0 = i;
  for (let from = s0 + 1; from < b.length; ) {
    let r = -1; for (let k = from; k + 7 <= b.length; k++) if (eqCI(b, k, 'ruling:')) { r = k; break; }
    if (r < 0) return null;
    from = r + 1;
    let j = r; while (j > s0 && isWs(b[j - 1])) j--;
    if (j === r) continue;
    const de = j; while (j > s0 && isDash(b[j - 1])) j--;
    if (j === de) continue;
    const we = j; while (j > s0 && isWs(b[j - 1])) j--;
    const k = Math.max(j, s0 + 1);
    if (k > we - 1 || r + 7 >= b.length) continue;
    const rest = b.slice(r + 7);
    return [b.slice(s0, k), rest.trimStart() || rest.slice(-1)];
  }
  return null;
}

// parseLedger(text, name) -> { plan, entries: [{task, status, commits?, notes}], rulings, parked, deferred: [{task|null, text, line}],
// mentioned: [ids], unclassified: number, firstUnclassified: line|0, warnings }. Status is derived ONLY from ledger lines:
// a complete line is sticky (done); otherwise the last task line wins (blocked or in_progress). Pure; text is sanitized here.
export function parseLedger(text: unknown, name: unknown = 'ledger'): ParsedLedger {
  const lines = String(text ?? '').replace(/^﻿/, '').split(/\r?\n/).map(normLine);
  const nonBlank = lines.filter((l) => l.trim()).length;
  if (nonBlank > LIMITS.ledgerLines) throw fail(`${oneLine(path.basename(String(name)), 80)}: too many ledger lines (${nonBlank} > ${LIMITS.ledgerLines})`);
  const plan = ledgerIdentity(text);
  const tasks = new Map<string, LedgerTaskState>(), rulings: LedgerNote[] = [], parked: LedgerNote[] = [], deferred: LedgerNote[] = [], warnings: string[] = [], mentioned = new Set<string>();
  let unclassified = 0, firstUnclassified = 0, last: LedgerTaskState | null = null;
  const entry = (id: string): LedgerTaskState => { if (!tasks.has(id)) tasks.set(id, { task: id, status: null, done: false, commits: null, notes: [] }); return tasks.get(id) as LedgerTaskState; }; // set on the same line
  const note = (s: string): string => oneLine(s, LIMITS.finding);
  const unknown = (i: number) => { unclassified++; if (!firstUnclassified) firstUnclassified = i + 1; };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] as string; // i < lines.length
    if (!l.trim()) continue;
    if (l.startsWith('#')) continue; // identity or a header comment: known, ignored
    if (/^\s/.test(l)) { // continuation of the previous task line
      if (!last) { unknown(i); continue; }
      if (/^\s+Minor\b/i.test(l)) deferred.push({ task: last.task, text: note(l.trim()), line: i + 1 });
      else last.notes.push(oneLine(l.trim(), LIMITS.note));
      continue;
    }
    const tl = taskLine(l);
    if (tl && hasDigit(tl.id)) {
      const { id, body } = tl; mentioned.add(id); last = entry(id);
      const c = COMMITS.exec(body);
      if (c) { last.commits = `${c[1]}..${c[2]}`; if (c[2] === 'HEAD' || c[1] === 'HEAD') warnings.push(`line ${i + 1}: task ${id} range ends at HEAD (recorded as given, not resolved)`); }
      let m: RegExpExecArray | [string, string] | null;
      if (/^complete\b/i.test(body)) { last.done = true; last.status = 'done'; }
      else if ((m = /^minor\s*\(deferred\):\s*(.+)$/i.exec(body))) deferred.push({ task: id, text: note(m[1] as string), line: i + 1 }); // group 1 is not optional
      else if ((m = parkedLine(body))) { parked.push({ task: id, text: note(`${m[0]} — Ruling: ${m[1]}`), line: i + 1 }); if (!last.done) last.status = 'in_progress'; }
      else if ((m = /^Ruling:\s*(.+)$/i.exec(body))) rulings.push({ task: id, text: note(m[1] as string), line: i + 1 }); // group 1 is not optional
      else if (/^blocked\b/i.test(body)) { if (!last.done) last.status = 'blocked'; }
      else if (!last.done) last.status = 'in_progress';
      continue;
    }
    let m: RegExpExecArray | null;
    if ((m = /^Ruling:\s*(.+)$/i.exec(l))) { rulings.push({ task: null, text: note(m[1] as string), line: i + 1 }); last = null; continue; } // group 1 is not optional
    if ((m = /^Final:\s*minor\s*\(deferred\):\s*(.+)$/i.exec(l))) { deferred.push({ task: null, text: note(m[1] as string), line: i + 1 }); last = null; continue; } // group 1 is not optional
    if ((m = /^Final:\s*Ruling:\s*(.+)$/i.exec(l))) { rulings.push({ task: null, text: note(m[1] as string), line: i + 1 }); last = null; continue; } // 6.2.0+ final review; group 1 is not optional
    if (/^(Final\b|Final review:|Preflight:)/i.test(l)) { last = null; continue; } // known, carries no status
    unknown(i); last = null;
  }
  const entries = [...tasks.values()].filter((e) => e.status).map((e) => ({ task: e.task, status: e.status as ImplStatus, ...(e.commits ? { commits: e.commits } : {}), notes: e.notes })); // filtered to entries with a status
  return { plan, entries, rulings, parked, deferred, mentioned: [...mentioned], unclassified, firstUnclassified, warnings }; // entries were filtered to a status
}

// Several ledgers for one plan (worktrees): done is sticky across them, otherwise the later ledger's status wins.
export function mergeLedgers(list: readonly ParsedLedger[]): ParsedLedger | null {
  if (!list.length) return null;
  if (list.length === 1) return list[0] as ParsedLedger; // the list has exactly one ledger
  const by = new Map<string, LedgerEntry>();
  for (const l of list) for (const e of l.entries) { const p = by.get(e.task); by.set(e.task, p && p.status === 'done' ? p : { ...e, notes: [...(p?.notes || []), ...e.notes] }); }
  const cat = <K extends 'rulings' | 'parked' | 'deferred' | 'mentioned' | 'warnings'>(k: K): Array<ParsedLedger[K][number]> => list.flatMap((l): Array<ParsedLedger[K][number]> => l[k]);
  return { plan: list.find((l) => l.plan)?.plan ?? null, entries: [...by.values()], rulings: cat('rulings'), parked: cat('parked'), deferred: cat('deferred'), mentioned: [...new Set(cat('mentioned'))], unclassified: list.reduce((a, l) => a + l.unclassified, 0), firstUnclassified: list.find((l) => l.firstUnclassified)?.firstUnclassified ?? 0, warnings: cat('warnings') };
}

// ---------- records ----------
const normPlan = (p: unknown): string => String(p).replace(/\\/g, '/').replace(/^\.\//, '');
// Does a ledger identity name this plan? Exact repo-relative match, or one path is a /-suffix of the other (absolute or subdir-relative).
export function ledgerNamesPlan(identity: unknown, planPath: unknown): boolean {
  const a = normPlan(identity), b = normPlan(planPath);
  return a === b || a.endsWith('/' + b) || b.endsWith('/' + a);
}

// ingestPlan({ plan, ledger, existing, owner, sprint }) -> { tickets, edges, findings, refs, schedule, report }: the FULL desired content
// of each file (records not owned by this plan are passed through unchanged). Pure. Throws SpIngestError (and so nothing may be written)
// on a foreign ledger, a ledger line naming an unknown task, or task renumbering relative to the stored ingest.
// existing = { tickets, edges, findings, refs, schedule } as plain record arrays. owner/sprint seed schedule rows only when owner is given.
export function ingestPlan({ plan, ledger = null, existing = {}, owner, sprint }: IngestOpts = {} as IngestOpts): IngestResult { // every caller passes plan
  const ex: SpRecords = { tickets: [], edges: [], findings: [], refs: [], schedule: [], ...existing };
  const epic = `sp:${plan.slug}`, keyOf = (id: string): string => `${epic}/${id}`;
  const owned = (k: unknown): boolean => k === epic || String(k).startsWith(epic + '/');
  const ids = new Set(plan.tasks.map((t) => t.id)), order = new Map(plan.tasks.map((t, i) => [t.id, i]));
  const errors: string[] = [];
  if (ledger) {
    if (ledger.plan && !ledgerNamesPlan(ledger.plan, plan.path)) errors.push(`foreign ledger: it names plan ${oneLine(ledger.plan, 80)}, not ${oneLine(plan.path, 80)}`);
    for (const id of ledger.mentioned) if (!ids.has(id)) errors.push(`ledger names unknown task ${oneLine(id, LIMITS.idChars)}`);
  }
  // renumbering: an old key now carries a different title while another new key carries the old title
  const oldTitle = new Map(ex.tickets.filter((t) => String(t.key).startsWith(epic + '/')).map((t) => [String(t.key).slice(epic.length + 1), t.summary ?? '']));
  const newByTitle = new Map<string, string>(); for (const t of plan.tasks) if (!newByTitle.has(t.title)) newByTitle.set(t.title, t.id);
  for (const t of plan.tasks) {
    const was = oldTitle.get(t.id);
    if (was === undefined || was === t.title) continue;
    const moved = newByTitle.get(was);
    if (moved && moved !== t.id) errors.push(`renumbered: ${keyOf(moved)} was ${keyOf(t.id)} (re-ingest refused; edges, schedule and refs would move)`);
  }
  if (errors.length) throw fail(errors);

  const warnings = [...plan.warnings]; // plan-derived; ledger warnings are kept apart (they are printed in their own fence)
  const status = new Map((ledger?.entries || []).map((e) => [e.task, e.status]));
  const prevTickets = new Map(ex.tickets.map((t) => [t.key, t]));

  // tickets
  const mkTicket = (key: string, summary: string, ep: string, points: number | null | undefined): Ticket => {
    const prev: Partial<Ticket> = prevTickets.get(key) || {};
    const r: Ticket = { jira_status: '', verdict: '', ...prev, key, summary, epic: ep, sp: points ?? prev.sp ?? null, verdict_source: prev.verdict_source || 'sp-ingest' };
    return r;
  };
  // the epic only groups its tasks: it carries no story points, and a null sp would make the solver refuse the whole plan
  const tickets = [mkTicket(epic, plan.header.title || plan.slug, '', 0)];
  for (const t of plan.tasks) {
    const r = mkTicket(keyOf(t.id), t.title, epic, t.points);
    if (ledger) r.impl_status = status.get(t.id) || 'todo'; // a ledger without a line for the task: not started
    // no ledger: impl_status stays whatever the last ingest recorded (a workspace deleted after the final review must not reset progress)
    tickets.push(r);
  }

  // edges: explicit `Task M` references in Consumes, and exact backticked names produced by exactly one earlier task
  const producers = new Map<string, string[]>();
  for (const t of plan.tasks) for (const s of producedSymbols(t.produces)) { if (!producers.has(s)) producers.set(s, []); (producers.get(s) as string[]).push(t.id); } // set on the same line
  const pairs = new Map<string, { c: string; p: string; names: Set<string>; refs: Set<string> }>();
  const addEdge = (c: string, p: string, why: { kind: 'names' | 'refs'; v: string }) => { const k = `${c}\u0000${p}`; if (!pairs.has(k)) pairs.set(k, { c, p, names: new Set(), refs: new Set() }); (pairs.get(k) as { names: Set<string>; refs: Set<string> })[why.kind].add(why.v); }; // set on the same line
  for (const t of plan.tasks) {
    const i = order.get(t.id) as number; // every task id is in order
    for (const r of t.refs) {
      if (r === t.id) continue;
      if (!ids.has(r)) { warnings.push(`task ${t.id}: Consumes names Task ${oneLine(r, LIMITS.idChars)}, which is not in this plan (no edge)`); continue; }
      if ((order.get(r) as number) > i) { warnings.push(`task ${t.id}: Consumes names the later Task ${r} (no edge)`); continue; } // ids.has(r) was tested
      addEdge(t.id, r, { kind: 'refs', v: `Task ${r}` });
    }
    for (const s of consumedSymbols(t.consumes)) {
      const from = (producers.get(s) || []).filter((p) => p !== t.id && (order.get(p) as number) < i); // producers are task ids
      if (from.length === 1) addEdge(t.id, from[0] as string, { kind: 'names', v: s }); // length checked on this line
      else if (from.length > 1) warnings.push(`task ${t.id}: ${oneLine(s, 40)} is produced by ${from.length} earlier tasks (no edge)`);
    }
  }
  const newEdges = [...pairs.values()].map((e): Edge => ({ consumer: keyOf(e.c), producer: keyOf(e.p), kind: EDGE_KIND, note: oneLine((e.names.size ? [...e.names] : [...e.refs]).sort(lt).join(', '), LIMITS.note) }));
  const keys = new Set(tickets.map((t) => t.key));
  const edges: Edge[] = [...ex.edges.filter((e) => !(owned(e.consumer) && e.kind === EDGE_KIND)), ...newEdges];

  // findings: plan kinds are recomputed; ledger kinds are kept (they survive the ledger's deletion) and new ones added
  const f = (key: string, kind: string, text: string): SpFinding => ({ key, kind, text });
  const planFindings = [...plan.globalConstraints.map((c) => f(epic, 'sp_constraint', c)), ...plan.reviewFocus.map((c) => f(epic, 'sp_review_focus', c))];
  const ledgerFindings = ledger ? [
    ...ledger.rulings.map((r) => f(r.task ? keyOf(r.task) : epic, 'sp_ruling', r.text)),
    ...ledger.parked.map((r) => f(r.task ? keyOf(r.task) : epic, 'sp_parked', r.text)),
    ...ledger.deferred.map((r) => f(r.task ? keyOf(r.task) : epic, 'sp_deferred', r.text)),
  ] : [];
  const seenF = new Set<string>(), findings: SpFinding[] = [];
  for (const x of [
    ...ex.findings.filter((x) => !(owned(x.key) && PLAN_KINDS.includes(x.kind)) && !(owned(x.key) && LEDGER_KINDS.includes(x.kind) && !keys.has(x.key))),
    ...planFindings, ...ledgerFindings,
  ]) {
    const id = owned(x.key) ? `${x.key}\u0000${x.kind}\u0000${x.text}` : null; // dedupe only this plan's records (counted as stored)
    if (id && seenF.has(id)) continue;
    if (id) seenF.add(id);
    findings.push(x);
  }

  // refs: files from Files lines (existing fingerprint values kept), one plans entry per task (existing entry object kept)
  const prevRefs = new Map(ex.refs.map((r) => [r.key, r]));
  const mkRef = (key: string, files: string[], planEntry: PlanRef | null): RefsRow => {
    const prev: Partial<RefsRow> = prevRefs.get(key) || {};
    const fm: Record<string, unknown> = {}; for (const p of files) fm[p] = prev.files && Object.hasOwn(prev.files, p) ? prev.files[p] : '';
    const others = (prev.plans || []).filter((x) => !(x && normPlan(x.plan) === normPlan(plan.path)));
    const mine = planEntry ? [(prev.plans || []).find((x) => x && normPlan(x.plan) === normPlan(plan.path) && String(x.task) === planEntry.task) || planEntry] : [];
    return { ...prev, key, plans: [...others, ...mine], files: fm };
  };
  const newRefs = [mkRef(epic, plan.header.spec ? [plan.header.spec] : [], null), ...plan.tasks.map((t) => mkRef(keyOf(t.id), t.files, { plan: plan.path, task: t.id }))];
  const refs = [...ex.refs.filter((r) => !owned(r.key)), ...newRefs];

  // schedule: never changed, except new rows when an owner AND a sprint are given explicitly (rows that exist are never touched)
  const schedule: ScheduleRow[] = [...ex.schedule];
  const scheduled = new Set(ex.schedule.filter((r) => (r.version ?? 'current') === 'current').map((r) => r.key));
  let seeded = 0, seededPoints = 0, seededWithPoints = 0;
  if (owner && sprint != null) for (const t of plan.tasks) {
    if (scheduled.has(keyOf(t.id))) continue;
    schedule.push({ version: 'current', key: keyOf(t.id), owner, sprint }); seeded++;
    if (t.points != null) { seededPoints += t.points; seededWithPoints++; }
  }
  const orphanSchedule = [...scheduled].filter((k) => owned(k) && !keys.has(k)).length;

  const prevOwned = ex.tickets.filter((t) => owned(t.key)).map((t) => t.key);
  const out: IngestResult = {
    tickets: [...ex.tickets.filter((t) => !owned(t.key)), ...tickets],
    edges, findings, refs, schedule,
    report: {
      key: epic, format: plan.format, tasks: plan.tasks.length, edges: newEdges.length,
      findings: findings.filter((x) => owned(x.key) && (PLAN_KINDS.includes(x.kind) || LEDGER_KINDS.includes(x.kind))).length,
      statuses: ledger ? plan.tasks.filter((t) => status.has(t.id)).length : 0, ledger: !!ledger,
      kept: ledger ? 0 : tickets.filter((t) => t.key !== epic && t.impl_status !== undefined).length, // previous impl_status left in place
      unclassified: ledger?.unclassified || 0, firstUnclassified: ledger?.firstUnclassified || 0,
      removed: prevOwned.filter((k) => !keys.has(k)).length, seeded, seededPoints, seededWithPoints, orphanSchedule,
      warnings: [...warnings, ...(ledger?.warnings || [])], planWarnings: warnings, ledgerWarnings: ledger?.warnings || [],
    },
  };
  return out;
}

// ---------- ledger layouts by release ----------
// Verified against the release sources of the superpowers repository (scripts/sdd-workspace, executing-plans/scripts/task-done and the
// SDD skill text at each tag, read with `git show <tag>:<path>`): exact versions only; anything else is reported as not verified.
export const SP_LAYOUTS = Object.freeze([
  { versions: ['6.1.1'], layout: 'flat', where: '.superpowers/sdd/progress.md' },
  { versions: ['6.2.0', '6.3.0'], layout: 'per-plan', where: '.superpowers/sdd/PLAN/progress.md, deleted after the final review' },
  { versions: ['6.4.1', '6.4.2', '7.0.0', '7.0.1', '7.0.2'], layout: 'per-plan', where: '.superpowers/sdd/PLAN*/progress.md beside a plan-path marker, deleted after the final review' },
]);
const READS = 'plangraph reads the 6.1.1 to 7.0.2 layouts';
/** One printed line, sanitized. */
export function ledgerLayoutOf(version: unknown): { verified: boolean; layout: string | null; line: string } {
  const v = typeof version === 'string' ? oneLine(version, 64) : '';
  const hit = SP_LAYOUTS.find((x) => x.versions.includes(v));
  if (hit) return { verified: true, layout: hit.layout, line: `superpowers ${v} keeps it at ${hit.where} (verified; ${READS})` };
  return { verified: false, layout: null, line: `superpowers ${v ? `${v} layout` : 'version unknown, layout'} not verified (${READS}; sp-ingest looks for each of them)` };
}

// ---------- files (read-only) ----------
// Reads a superpowers file: must resolve inside `root` (realpath), must be a regular file, read through readCapped with the fs object handed.
export function readSpFile(file: string, { max, fsImpl = fs }: { max?: number; fsImpl?: typeof fs } = {}): string {
  try { return readCapped(file, max as number, { fsImpl }); } // unchecked: undefined when a caller omits max, and the read is then not capped (pre-existing); every caller passes it
  catch (e) {
    if ((e as { code?: unknown }).code === 'TOO_LARGE') throw fail(`${oneLine(path.basename(file), 80)}: file too large (limit ${max} bytes)`); // unchecked: a thrown null would throw here (pre-existing)
    if ((e as { code?: unknown }).code === 'NOT_A_FILE') throw fail(`${oneLine(path.basename(file), 80)}: not a regular file`); // unchecked: a thrown null would throw here (pre-existing)
    if ((e as { code?: unknown }).code === 'ENOENT') throw fail(`${oneLine(path.basename(file), 80)}: no such file`); // unchecked: a thrown null would throw here (pre-existing)
    throw e;
  }
}
const isFile = (fsImpl: typeof fs, p: string): boolean => { try { return fsImpl.lstatSync(p).isFile(); } catch { return false; } };
const isDir = (fsImpl: typeof fs, p: string): boolean => { try { return fsImpl.lstatSync(p).isDirectory(); } catch { return false; } };

// findLedgers(root, { planSlug, planPath, worktrees, fsImpl, warnings }) -> [{ path, layout: 'per-plan'|'flat', root }], per-plan first,
// then by root order. Looks in `root` and in each worktree root given (the caller lists them with `git worktree list --porcelain`;
// this module never runs git). 6.4.1 to 7.0.2: .superpowers/sdd/<plan-basename>*/progress.md next to a `plan-path` marker naming the plan;
// 6.2.0 and 6.3.0: .superpowers/sdd/<plan-basename>/progress.md without a marker, used only when its identity line names the plan.
// 6.1.1 layout: .superpowers/sdd/progress.md, skipped when its identity line names another plan. A flat ledger WITHOUT an identity line
// is used only when its first line names the plan (path or file name); otherwise it is skipped and a warning is pushed onto `warnings`
// (the user can still pass it with --ledger FILE). Symlinked entries are never followed.
export function findLedgers(root: string, { planSlug, planPath, worktrees = [], fsImpl = fs, warnings = [] }: { planSlug?: string; planPath?: string; worktrees?: string[]; fsImpl?: typeof fs; warnings?: string[] } = {}): FoundLedger[] {
  const out: FoundLedger[] = [];
  for (const wroot of [...new Set([root, ...worktrees].filter(Boolean))]) {
    const sdd = path.join(wroot, '.superpowers', 'sdd');
    if (!isDir(fsImpl, sdd)) continue;
    let names: string[] = []; try { names = fsImpl.readdirSync(sdd).map(String).sort(); } catch { names = []; }
    for (const n of names) {
      if (!(n === planSlug || n.startsWith(planSlug + '-'))) continue;
      const dir = path.join(sdd, n), marker = path.join(dir, 'plan-path'), prog = path.join(dir, 'progress.md');
      if (!isDir(fsImpl, dir) || !isFile(fsImpl, prog)) continue;
      if (!isFile(fsImpl, marker)) {
        // 6.2.0 and 6.3.0: `.superpowers/sdd/<plan-basename>/` with no marker; the ledger's identity line is the only owner record
        if (n !== planSlug) continue;
        let text: string; try { text = readCapped(prog, LIMITS.ledgerBytes, { fsImpl }); } catch { continue; }
        const id = ledgerIdentity(text);
        if (!id) { warnings.push(`found ${path.relative(root, prog).split(path.sep).join('/')} without a plan identity: pass --ledger FILE to use it`); continue; }
        if (planPath ? !ledgerNamesPlan(id, planPath) : path.posix.basename(normPlan(id)) !== planSlug + '.md') continue;
        out.push({ path: prog, layout: 'per-plan', root: wroot });
        continue;
      }
      let named: string; try { named = readCapped(marker, 4096, { fsImpl }).trim(); } catch { continue; }
      if (planPath ? !ledgerNamesPlan(named, planPath) : path.posix.basename(normPlan(named)) !== planSlug + '.md') continue;
      out.push({ path: prog, layout: 'per-plan', root: wroot });
    }
    const flat = path.join(sdd, 'progress.md');
    if (isFile(fsImpl, flat)) {
      let text: string; try { text = readCapped(flat, LIMITS.ledgerBytes, { fsImpl }); } catch { continue; }
      const id = ledgerIdentity(text);
      if (id && !(planPath ? ledgerNamesPlan(id, planPath) : path.posix.basename(normPlan(id)) === planSlug + '.md')) continue;
      if (!id && !firstLineNamesPlan(text, planPath, planSlug)) {
        warnings.push(`found ${path.relative(root, flat).split(path.sep).join('/')} without a plan identity: pass --ledger FILE to use it`);
        continue;
      }
      out.push({ path: flat, layout: 'flat', root: wroot });
    }
  }
  return [...out.filter((x) => x.layout === 'per-plan'), ...out.filter((x) => x.layout === 'flat')]; // root first, then worktrees in the order given
}
