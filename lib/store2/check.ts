// The store validator (spec 4.0 rule 6): what git cannot guarantee. Read-only except fmtStore. Each violation carries path (relative to the
// store root), line and a one-line fix. The batch codes UNSORTED_BATCH and MISSING_CURRENT are added by lib/store2/batches.ts's checks.
import path from 'node:path';
import { assertInside, writeAtomicSafe } from '../fsafe.ts';
import { readDataCapped } from '../jsonl.ts';
import { parseNodeUri } from '../graph/uri.ts';
import { sourceProblem, REQ_KINDS } from '../schema.ts';
import { FIX, listBatchFiles, listKinds, listNodeFiles, loadRaw } from './nodes.ts';
import { nodePath } from './layout.ts';
import { canon, formatPg } from './pg.ts';
import { checkBatches } from './check-batches.ts';
import type { Node } from './pg.ts';

export type ViolationCode = 'ID_MISMATCH' | 'DUPLICATE_ID' | 'CASE_COLLISION' | 'NOT_CANONICAL' | 'DANGLING_LINK' | 'BAD_SCHEMA' | 'CONFLICT_MARKERS' | 'BAD_LINE' | 'UNSORTED_BATCH' | 'SYMLINK' | 'OVERSIZE' | 'MISSING_CURRENT';
export interface StoreViolation { code: ViolationCode; path: string; line: number; fix: string }

const FIXES: Readonly<Record<string, string>> = {
  ...FIX,
  DUPLICATE_ID: 'two files hold the same id: keep one and delete the other',
  CASE_COLLISION: 'two names differ only in case: rename or delete one (a case-insensitive file system cannot hold both)',
  NOT_CANONICAL: 'run plangraph fmt',
  DANGLING_LINK: 'add the missing node or remove the link',
  BAD_SCHEMA: 'correct the field value (see the node format in the docs)',
};
const MARKER_RE = /^(<{7}( |$)|={7}$|>{7}( |$)|\|{7}( |$))/;
const MAX_BATCH_BYTES = 64 * 1024 * 1024;
const DERIVATION = ['extracted', 'inferred', 'human'];
const STATUS: Readonly<Record<string, readonly string[]>> = { requirement: ['proposed', 'accepted', 'dropped'], decision: ['proposed', 'accepted', 'deprecated', 'superseded', 'rejected'] };

/** Groups of two or more names that are equal ignoring case but not equal (sorted). */
export function caseCollisions(paths: readonly string[]): string[][] {
  const by = new Map<string, Set<string>>();
  for (const p of paths) { const k = p.toLowerCase(); (by.get(k) ?? by.set(k, new Set()).get(k) as Set<string>).add(p); }
  return [...by.values()].filter((s) => s.size > 1).map((s) => [...s].sort()).sort((a, b) => (a[0] as string) < (b[0] as string) ? -1 : 1);
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string' && v !== '';
const optStr = (o: Record<string, unknown>, k: string) => o[k] === undefined || typeof o[k] === 'string';

/** The first schema problem of a node: [field, message], or null. */
function schemaProblem(kind: string, n: Node): [string, string] | null {
  if (n.schema_version !== undefined && !(Number.isSafeInteger(n.schema_version) && (n.schema_version as number) > 0)) return ['schema_version', 'schema_version must be a positive whole number'];
  for (const f of ['src', 'fp', 'valid_to', 'superseded_by']) if (n[f] !== undefined && typeof n[f] !== 'string') return [f, `${f} must be a string`];
  if (n.derivation !== undefined && !DERIVATION.includes(n.derivation as string)) return ['derivation', `derivation must be one of ${DERIVATION.join(', ')}`];
  const st = STATUS[kind];
  if (st && n.status !== undefined && !st.includes(n.status as string)) return ['status', `status must be one of ${st.join(', ')}`];
  if (kind === 'requirement') {
    if (n.kind !== undefined && !REQ_KINDS.includes(n.kind as string)) return ['kind', `kind must be one of ${REQ_KINDS.join(', ')}`];
    if (n.source !== undefined) { const m = sourceProblem(n.source); if (m) return ['source', m.replace(/^"source" /, 'source ')]; }
    for (const f of ['text', 'priority']) if (n[f] !== undefined && typeof n[f] !== 'string') return [f, `${f} must be a string`];
  }
  if (kind === 'decision') for (const f of ['title', 'date']) if (n[f] !== undefined && typeof n[f] !== 'string') return [f, `${f} must be a string`];
  if (kind === 'team' && n.name !== undefined && typeof n.name !== 'string') return ['name', 'name must be a string'];
  for (const l of (n.links ?? []) as unknown[]) if (!isObj(l) || !str(l.rel) || !str(l.to) || (l.attrs !== undefined && !isObj(l.attrs)) || !optStr(l, 'until')) return ['links', 'a link is {rel, to, attrs?, until?} with string rel and to'];
  for (const x of (n.xrefs ?? []) as unknown[]) if (!isObj(x) || !str(x.sys) || !str(x.xid) || !optStr(x, 'src') || !optStr(x, 'seen') || !optStr(x, 'note')) return ['xrefs', 'an xref is {sys, xid, src?, seen?, note?} with string sys and xid'];
  for (const f of ['acceptance', 'members', 'owns', 'affects']) if (((n[f] ?? []) as unknown[]).some((e) => typeof e !== 'string')) return [f, `every ${f} element must be a string`];
  return null;
}

const lineOf = (text: string, field: string, exact?: string): number => {
  const rows = text.split('\n');
  const i = exact === undefined ? -1 : rows.indexOf(exact);
  return (i >= 0 ? i : Math.max(0, rows.findIndex((r) => r.startsWith(`${field} `)))) + 1;
};

interface Entry { abs: string; kind: string; node: Node; text: string }

/** Parsed nodes of the whole store plus every violation found while reading them. */
export function checkStore(root: string): StoreViolation[] {
  const out: StoreViolation[] = [];
  const add = (code: ViolationCode, abs: string, line: number, fix?: string) => out.push({ code, path: path.relative(root, abs), line, fix: fix ?? (FIXES[code] as string) }); // every code but the batch ones has a fix text
  const entries: Entry[] = [], names: string[] = [];
  for (const kind of listKinds(root)) {
    for (const abs of listNodeFiles(root, kind)) {
      names.push(path.relative(root, abs));
      const r = loadRaw(root, abs);
      if ('problem' in r) out.push(r.problem); else entries.push({ abs, kind, node: r.node, text: r.text });
    }
  }
  const ids = new Set<string>(), byKey = new Map<string, Entry[]>();
  for (const e of entries) { ids.add(e.node.id); const k = `${e.kind}\u0000${e.node.id}`; byKey.set(k, [...(byKey.get(k) ?? []), e]); }
  for (const group of byKey.values()) {
    const keeper = group.find((e) => e.abs === nodePath(root, e.kind, e.node.id)) ?? (group[0] as Entry); // groups are never empty
    for (const e of group) if (e !== keeper) add('DUPLICATE_ID', e.abs, 1);
    if (keeper.abs !== nodePath(root, keeper.kind, keeper.node.id)) add('ID_MISMATCH', keeper.abs, 1);
  }
  for (const e of entries) {
    const canonical = formatPg(e.node);
    if (canonical !== e.text) { const a = e.text.split('\n'), b = canonical.split('\n'); add('NOT_CANONICAL', e.abs, Math.max(1, a.findIndex((l, i) => l !== b[i]) + 1 || Math.min(a.length, b.length))); }
    const sp = schemaProblem(e.kind, e.node);
    if (sp) { add('BAD_SCHEMA', e.abs, lineOf(e.text, sp[0]), `${sp[1]}`); continue; }
    for (const l of (e.node.links ?? []) as Array<{ rel: string; to: string }>) {
      const target = l.to.startsWith('pg:') ? parseNodeUri(l.to)?.id : l.to;
      if (target === undefined || !ids.has(target)) add('DANGLING_LINK', e.abs, lineOf(e.text, 'links', `links ${canon(l)}`), `no node ${l.to.slice(0, 60)}: add it or remove the link`);
    }
  }
  for (const group of caseCollisions(names)) for (const dup of group.slice(1)) add('CASE_COLLISION', path.join(root, dup), 0);
  for (const f of listBatchFiles(root)) checkJsonl(root, f, add);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line !== b.line ? a.line - b.line : a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}

/** Generic line checks of one batch file: symlink, conflict markers, one JSON object per line. Order and CURRENT are the batch checks. */
function checkJsonl(root: string, f: string, add: (code: ViolationCode, abs: string, line: number, fix?: string) => void): void {
  let text: string;
  try { text = readDataCapped(f, MAX_BATCH_BYTES); }
  catch (e) { const c = (e as NodeJS.ErrnoException).code; add(c === 'SYMLINK' || c === 'ELOOP' ? 'SYMLINK' : c === 'TOO_LARGE' ? 'OVERSIZE' : 'BAD_LINE', f, 0); return; }
  const rows = text.split('\n');
  if (rows[rows.length - 1] === '') rows.pop();
  const m = rows.findIndex((r) => MARKER_RE.test(r));
  if (m >= 0) { add('CONFLICT_MARKERS', f, m + 1); return; }
  for (let i = 0; i < rows.length; i++) {
    let ok = false;
    try { ok = isObj(JSON.parse(rows[i] as string)); } catch { /* not JSON */ } // i < rows.length
    if (!ok) { add('BAD_LINE', f, i + 1); return; }
  }
}

/** Rewrite every file whose only problem is NOT_CANONICAL; returns their paths (relative, sorted). A damaged file is left alone. */
export function fmtStore(root: string): { rewritten: string[] } {
  const rewritten: string[] = [];
  for (const kind of listKinds(root)) {
    for (const abs of listNodeFiles(root, kind)) {
      const r = loadRaw(root, abs);
      if ('problem' in r) continue;
      const text = formatPg(r.node);
      if (text === r.text) continue;
      assertInside(root, abs);
      writeAtomicSafe(abs, text, { root });
      rewritten.push(path.relative(root, abs));
    }
  }
  return { rewritten: rewritten.sort() };
}

/** How many files the readers skip (damaged, misplaced or duplicated node files, damaged batch lines): what the card reports. Reads every node file, writes nothing, never throws on content. */
export function problemFiles(root: string): number {
  const bad = new Set<string>(), seen = new Set<string>();
  for (const kind of listKinds(root)) {
    for (const abs of listNodeFiles(root, kind)) {
      const r = loadRaw(root, abs);
      if ('problem' in r) { bad.add(r.problem.path); continue; }
      const key = `${kind}\u0000${r.node.id}`;
      if (abs !== nodePath(root, kind, r.node.id) || seen.has(key)) bad.add(path.relative(root, abs)); else seen.add(key);
    }
  }
  for (const v of checkBatches(root)) if (v.code === 'CONFLICT_MARKERS' || v.code === 'BAD_LINE') bad.add(v.path);
  return bad.size;
}

/** The codes that do not fail `plangraph check`: a file that is only unformatted (plangraph fmt fixes it) or a batch whose lines are out of order (readers sort them). */
const WARNING_CODES: ReadonlySet<string> = new Set(['NOT_CANONICAL', 'UNSORTED_BATCH']);
export interface StoreProblem { code: string; path: string; line: number | null; fix: string; warning: boolean }
/** Every violation of the entity store (node files and batch files), once each, sorted by path, line and code. */
export function storeProblems(root: string): StoreProblem[] {
  const seen = new Set<string>(), out: StoreProblem[] = [];
  for (const v of [...checkStore(root), ...checkBatches(root)]) {
    const line = v.line === 0 ? null : v.line, k = `${v.code}\u0000${v.path}\u0000${line}`;
    if (!seen.has(k)) { seen.add(k); out.push({ code: v.code, path: v.path, line, fix: v.fix, warning: WARNING_CODES.has(v.code) }); }
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : (a.line ?? 0) - (b.line ?? 0) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)));
}
/** `error: CODE path:line: fix` (or `warning:`), the line `plangraph check` prints; the path and fix are one sanitized line. */
export const renderStoreProblem = (v: StoreProblem): string => `${v.warning ? 'warning' : 'error'}: ${v.code} ${v.path.replace(/\s+/g, ' ').slice(0, 200)}${v.line === null ? '' : `:${v.line}`}: ${v.fix.replace(/\s+/g, ' ').slice(0, 200)}`;
