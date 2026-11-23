// Incremental re-audit: which audited tickets no longer match their inputs. Pure core (IO is injected through `deps`), see docs/STALE.md.
// Contract: computeStale(...) lists EXACTLY the tickets a full from-scratch re-derivation would list (proved by test/stale.test.ts).
import crypto from 'node:crypto';
import { checkRef, checkRepoPath, compileHeading, makeGit } from './gitsafe.ts';
import { oneLine } from './sanitize.ts';
import type { Model, PlanRecord } from './model.ts';

export const REASONS = ['plan', 'files', 'jira', 'links', 'rules', 'full', 'producer_changed'] as const;
export const CLASSES = ['plan', 'files', 'jira', 'links', 'rules'] as const; // input classes carried through producers (fp_prods)
export const DEFAULT_HEADING = '^#{2,3} Task {id}:';
/** Why a ticket is stale: one of REASONS. */
export type StaleReason = (typeof REASONS)[number];
/** An input class carried through producers: one of CLASSES. */
export type InputClass = (typeof CLASSES)[number];
/** One input digest per class (null = not available now). */
export type ClassDigests = Partial<Record<InputClass, string | null>>;
/** One plan reference of a refs row; `fp` is the recorded section fingerprint. lib/schema checks only that plans is an array, so plan and
 * task are unchecked: they are concatenated into keys and handed to the plan reader as they are. */
export interface PlanRef { plan: string; task: string; fp?: unknown; [extra: string]: unknown } // unchecked: plan and task are not validated (pre-existing)
/** One line of refs.jsonl. lib/schema checks only key (a string), plans (an array) and files (an object) on load: the other leaves are unknown
 * (every read compares them, converts them or hands them to a function taking unknown); unknown fields are kept. */
export interface RefsRow {
  key: string; plans?: PlanRef[] | null; files?: Record<string, unknown> | null; fp_files?: unknown; jira_updated?: unknown; fp_links?: unknown;
  rules?: unknown; fp_prods?: Record<string, unknown> | null; audited_at?: unknown; [extra: string]: unknown; // unchecked: fp_prods is used as an object with Object.keys and `in` (pre-existing)
}
/** The model fields computeStale reads; each one is tested before use. */
export interface StaleModel { tickets?: Model['tickets'] | Map<string, unknown> | null; prods?: Map<string, string[]> | null; refs?: readonly PlanRecord[] | null }
/** The injected IO (gitDeps is the real one). A null/undefined jiraStamp or linkSet answer means "not checked". */
export interface StaleDeps {
  readPlanText(ref: string | null | undefined, planPath: string): string | null | undefined;
  listFiles(ref: string | null | undefined, paths: string[]): Record<string, string | null | undefined> | null | undefined;
  jiraStamp?: ((key: string) => unknown) | null;
  linkSet?: ((key: string) => readonly unknown[] | null | undefined) | null;
  status?: ((key: string) => unknown) | null;
  commit?: (ref?: string | null) => string;
}
/** The real-git adapter: every member present. */
export interface GitDeps extends StaleDeps {
  jiraStamp: (key: string) => unknown; linkSet: (key: string) => readonly unknown[] | null; status: (key: string) => unknown; commit: (ref?: string | null) => string;
}
/** What formatStale reads of a result (a StaleResult fits). */
export interface StaleView { ref: string | null; clean: number; stale: ReadonlyArray<{ key: string; reasons: readonly string[]; via?: string | null }> }
/** computeStale/refsUpdate options. */
export interface StaleOpts { ref?: string | null; heading?: string; rulesVersion?: unknown; full?: boolean; commit?: string | null }
/** A ticket's own fingerprint (producers not included). */
export interface TicketFingerprint { plans: PlanRef[]; fp_files: string; jira_updated: string | null; fp_links: string | null; rules: string | null }
/** One stale ticket: why, and the producer it inherits staleness from (null when it changed itself). */
export interface StaleEntry { key: string; reasons: StaleReason[]; via: string | null }
/** computeStale's answer: the stale tickets, the count of clean audited ones, the ref used. */
export interface StaleResult { stale: StaleEntry[]; clean: number; ref: string | null }
/** refsUpdate's answer. */
export interface RefsUpdateResult { rows: RefsRow[]; updated: string[]; skipped: string[] }
/** formatStale options. */
export interface FormatStaleOpts { list?: boolean; json?: boolean; limit?: number; jiraChecked?: boolean; linksChecked?: boolean; commit?: string | null }
/** A failure thrown by the git runner (child_process fields); every field is tested before use. */
interface ExecFailure { code?: unknown; signal?: unknown; status?: unknown; stderr?: unknown; message?: unknown }
/** One entry of a Jira snapshot file (user data). */
export interface JiraSnapEntry { updated?: unknown; links?: readonly unknown[]; blockedBy?: readonly unknown[]; status?: unknown; [extra: string]: unknown } // unchecked: iterated without Array.isArray (pre-existing)
/** The real-git adapter's options. */
export interface GitDepsExtra { git?: (...args: string[]) => string; jira?: Record<string, JiraSnapEntry> | null }

const sha = (s: string): string => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const lt = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// Canonical JSON: object keys sorted, so digests never depend on insertion order.
export function canon(x: unknown): string {
  if (Array.isArray(x)) return '[' + x.map(canon).join(',') + ']';
  if (x && typeof x === 'object') return '{' + Object.keys(x).sort(lt).map((k) => JSON.stringify(k) + ':' + canon((x as Record<string, unknown>)[k])).join(',') + '}'; // a non-null object: its own keys are read
  return JSON.stringify(x === undefined ? null : x);
}

// Plan text normalization (documented behaviour): CRLF/CR -> LF, BOM dropped, trailing spaces/tabs per line removed, trailing blank lines removed.
// Indentation, internal blank lines, wording and reflow ARE significant (a semantic edit must never hide inside "formatting").
// The per-line trim is a scan from the end (linear); the former `/[ \t]+$/` regex was quadratic on a long run of spaces before a non-space.
const trimEndBlank = (l: string): string => { let e = l.length; while (e > 0 && (l.charCodeAt(e - 1) === 32 || l.charCodeAt(e - 1) === 9)) e--; return e === l.length ? l : l.slice(0, e); };
export function normalizePlanText(t: unknown): string {
  return String(t ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n').map(trimEndBlank).join('\n').replace(/\n+$/, '');
}

// The section of a plan file for task `id` (suffix .pN stripped), from its heading to the next heading of the same shape.
export function planSection(text: string, id: unknown, heading: string = DEFAULT_HEADING): string | null {
  const base = String(id).replace(/\.p\d+$/, '');
  const h = compileHeading(heading); const hit = h.find(text, base); if (!hit) return null;
  const rest = text.slice(hit.end); const n = h.nextIndex(rest);
  return text.slice(hit.start, hit.end + (n < 0 ? rest.length : n));
}

export const resolveRef = (config: { default_ref?: unknown } | null | undefined, flag?: string | null): string => checkRef(flag || (config && config.default_ref) || 'HEAD');

const linkSetFp = (ls: readonly unknown[] | null | undefined): string => sha(canon([...new Set((ls || []).map((x) => (typeof x === 'string' ? x : canon(x))))].sort(lt)));

// Own fingerprint of one ticket's refs row (not including producers). `row` = {plans:[{plan,task}], files:{path:..}}.
// opts: {ref, heading, rulesVersion}. Unavailable inputs (jira/links dep returns null/undefined, no rulesVersion) are null = "not checked".
export function fingerprintTicket(row: RefsRow, deps: StaleDeps, opts: StaleOpts = {}): TicketFingerprint {
  const heading = opts.heading || DEFAULT_HEADING;
  const plans = (row.plans || []).map((p) => {
    const raw = deps.readPlanText(opts.ref, p.plan);
    let fp: string;
    if (raw == null) fp = 'nofile'; else { const sec = planSection(normalizePlanText(raw), p.task, heading); fp = sec == null ? 'nosection' : sha(heading + '\0' + normalizePlanText(sec)); }
    return { ...p, fp };
  });
  const paths = Object.keys(row.files || {}).sort(lt);
  const tree = paths.length ? deps.listFiles(opts.ref, paths) || {} : {};
  const fp_files = sha(paths.map((p) => p + ':' + (tree[p] || 'absent')).join('\n'));
  const j = deps.jiraStamp ? deps.jiraStamp(row.key) : null;
  const l = deps.linkSet ? deps.linkSet(row.key) : null;
  return { plans, fp_files, jira_updated: j == null ? null : String(j), fp_links: l == null ? null : linkSetFp(l), rules: opts.rulesVersion == null ? null : String(opts.rulesVersion) };
}

const planKey = (p: PlanRef): string => p.plan + '\0' + p.task;
const planDigest = (plans: PlanRef[]): string => sha(plans.map((p) => planKey(p) + '=' + p.fp).sort(lt).join('\n'));
// Per-class digest of an own fingerprint (null = not available now).
function classDigests(fp: TicketFingerprint): ClassDigests {
  return { plan: planDigest(fp.plans), files: fp.fp_files, jira: fp.jira_updated == null ? null : sha('j' + fp.jira_updated), links: fp.fp_links, rules: fp.rules == null ? null : sha('r' + fp.rules) };
}
const NONE: ClassDigests = { plan: 'none', files: 'none', jira: 'none', links: 'none', rules: 'none' }; // ticket without a refs row: inputs unknown, constant

// Reverse-dependency graph from model.prods only (never trusts model.cons or edge order), sorted and deduplicated.
function graph(model: StaleModel, rowKeys: string[]): { nodes: string[]; prods: Map<string, string[]>; cons: Map<string, string[]> } {
  const prods = new Map<string, string[]>(); const nodes = new Set<string>(rowKeys);
  for (const k of model.tickets ? model.tickets.keys() : []) nodes.add(k);
  for (const [c, ps] of model.prods || []) { nodes.add(c); for (const p of ps) nodes.add(p); }
  for (const n of nodes) prods.set(n, [...new Set((model.prods && model.prods.get(n)) || [])].sort(lt));
  const cons = new Map<string, string[]>([...nodes].map((n) => [n, []]));
  for (const [c, ps] of prods) for (const p of ps) (cons.get(p) as string[]).push(c); // every producer was added to nodes above
  for (const a of cons.values()) a.sort(lt);
  return { nodes: [...nodes].sort(lt), prods, cons };
}

// Merkle digest per input class over the producer cone, SCC-condensed so cycles terminate and are order-independent. Iterative Tarjan.
function effective(g: ReturnType<typeof graph>, own: Map<string, ClassDigests>): Map<string, ClassDigests> {
  const idx = new Map<string, number>(), low = new Map<string, number>(), on = new Set<string>(), stack: string[] = [], eff = new Map<string, ClassDigests>(); let i = 0;
  const digestScc = (members: string[]) => {
    const ms = [...members].sort(lt); const set = new Set(ms); const ext = [...new Set(ms.flatMap((m) => g.prods.get(m) as string[]).filter((q) => !set.has(q)))].sort(lt); // every member is a node
    const out: ClassDigests = {};
    for (const c of CLASSES) {
      const parts = ms.map((m) => m + ':' + ((own.get(m) || NONE)[c] ?? '-')); // '-' = unavailable now; skipped at compare time
      const avail = ms.every((m) => ((own.get(m) || NONE)[c]) != null) && ext.every((q) => (eff.get(q) as ClassDigests)[c] != null); // producers outside the SCC finished first (Tarjan order)
      out[c] = avail ? sha(parts.join('|') + '#' + ext.map((q) => q + ':' + (eff.get(q) as ClassDigests)[c]).join('|')) : null; // producers outside the SCC finished first (Tarjan order)
    }
    for (const m of ms) eff.set(m, out);
  };
  for (const root of g.nodes) {
    if (idx.has(root)) continue;
    const work: Array<[string, number]> = [[root, 0]]; idx.set(root, i); low.set(root, i++); stack.push(root); on.add(root);
    while (work.length) {
      const top = work[work.length - 1] as [string, number]; const [v, pi] = top; const ps = g.prods.get(v) as string[]; // work is non-empty (loop condition); v is a node
      if (pi < ps.length) {
        top[1]++; const w = ps[pi] as string; // pi < ps.length (checked above)
        if (!idx.has(w)) { idx.set(w, i); low.set(w, i++); stack.push(w); on.add(w); work.push([w, 0]); }
        else if (on.has(w)) low.set(v, Math.min(low.get(v) as number, idx.get(w) as number)); // both were indexed when pushed
      } else {
        work.pop();
        if (work.length) { const u = (work[work.length - 1] as [string, number])[0]; low.set(u, Math.min(low.get(u) as number, low.get(v) as number)); } // work.length is the check; both were indexed when pushed
        if (low.get(v) === idx.get(v)) { const comp: string[] = []; let w: string; do { w = stack.pop() as string; on.delete(w); comp.push(w); } while (w !== v); digestScc(comp); } // v is still on the stack
      }
    }
  }
  return eff;
}
const packEff = (e: ClassDigests): string => CLASSES.map((c) => e[c] ?? '').join('|');
const unpackEff = (s: unknown): ClassDigests => { const a = String(s).split('|'); const o: ClassDigests = {}; CLASSES.forEach((c, k) => { o[c] = a[k] || null; }); return o; };

function analyze(model: StaleModel, refs: readonly RefsRow[], deps: StaleDeps, opts: StaleOpts) {
  const rows = new Map<string, RefsRow>(); for (const r of refs) rows.set(r.key, r);
  const g = graph(model, [...rows.keys()]);
  const fps = new Map<string, TicketFingerprint>(), own = new Map<string, ClassDigests>();
  for (const k of [...rows.keys()].sort(lt)) { const fp = fingerprintTicket(rows.get(k) as RefsRow, deps, opts); fps.set(k, fp); own.set(k, classDigests(fp)); } // k is a key of rows
  const eff = effective(g, own);
  return { rows, g, fps, eff };
}

// Direct reasons of one row against its record (own inputs only, plus the recorded producer digests).
function directReasons(row: RefsRow, fp: TicketFingerprint, a: ReturnType<typeof analyze>, k: string, opts: StaleOpts): { rs: Set<StaleReason>; mism: string[] } {
  const rs = new Set<StaleReason>();
  const rec = new Map((row.plans || []).map((p) => [planKey(p), p.fp]));
  for (const p of fp.plans) if (rec.get(planKey(p)) !== p.fp) { rs.add('plan'); break; }
  if (row.fp_files !== fp.fp_files) rs.add('files');
  if (fp.jira_updated != null && fp.jira_updated !== (row.jira_updated ?? '')) rs.add('jira');
  if (fp.fp_links != null && fp.fp_links !== row.fp_links) rs.add('links');
  if (fp.rules != null && fp.rules !== row.rules) rs.add('rules');
  if (opts.full) rs.add('full');
  const prods = a.g.prods.get(k) as string[]; // every row key is a node
  const mism: string[] = [];
  if (prods.length || row.fp_prods) {
    if (!row.fp_prods) mism.push(...prods); // legacy row: producer state at audit time unknown -> conservative
    else {
      const recKeys = Object.keys(row.fp_prods).sort(lt);
      if (recKeys.join('\0') !== prods.join('\0')) mism.push(...new Set([...prods.filter((p) => !(p in (row.fp_prods as Record<string, unknown>))), ...recKeys.filter((p) => !prods.includes(p))])); // set: tested by the enclosing else
      for (const p of prods) if (p in row.fp_prods) {
        const r = unpackEff(row.fp_prods[p]), c = a.eff.get(p) as ClassDigests; // p is a node
        if (CLASSES.some((cl) => r[cl] != null && c[cl] != null && r[cl] !== c[cl])) mism.push(p);
      }
    }
  }
  return { rs, mism: [...new Set(mism)].sort(lt) };
}

// ONE function computing the stale set (used by `brain stale`, `units --stale`, refs-update).
// model: buildModel() result; refs: array of refs rows (default model.refs); opts: {ref, heading, rulesVersion, full}.
export function computeStale(model: StaleModel, refs: readonly PlanRecord[] | null | undefined, deps: StaleDeps, opts: StaleOpts = {}): StaleResult {
  const a = analyze(model, (refs || model.refs || []) as readonly RefsRow[], deps, opts); // refs rows passed lib/schema's refs check on load
  const reasons = new Map<string, Set<StaleReason>>(), seedMism = new Map<string, string[]>();
  for (const k of [...a.rows.keys()].sort(lt)) {
    const { rs, mism } = directReasons(a.rows.get(k) as RefsRow, a.fps.get(k) as TicketFingerprint, a, k, opts); // k is a key of rows, fingerprinted in analyze
    if (rs.size || mism.length) { reasons.set(k, rs); if (mism.length) seedMism.set(k, mism); }
  }
  // transitive propagation through producers: multi-source BFS over consumers; dist = hops from a changed source
  const dist = new Map<string, number>([...reasons.keys()].map((k) => [k, 0]));
  let frontier = [...reasons.keys()].sort(lt);
  while (frontier.length) {
    const next: string[] = [];
    for (const p of frontier) for (const c of a.g.cons.get(p) as string[]) if (!dist.has(c)) { dist.set(c, (dist.get(p) as number) + 1); next.push(c); } // p is a node with a distance
    frontier = next.sort(lt);
  }
  const stale: StaleEntry[] = [];
  for (const k of [...dist.keys()].sort(lt)) {
    if (!a.rows.has(k) && !(model.tickets && model.tickets.has(k))) continue; // not a plan ticket: carries propagation only
    const own = reasons.get(k) || new Set();
    const inS = (a.g.prods.get(k) as string[]).filter((p) => dist.has(p)).sort((x, y) => (dist.get(x) as number) - (dist.get(y) as number) || lt(x, y)); // k is a node; filtered to keys with a distance
    let via: string | null = null;
    if (inS.length) via = inS[0] as string; else if (seedMism.has(k)) via = (seedMism.get(k) as string[])[0] as string; // non-empty: tested on the same line
    const rs: StaleReason[] = [...own]; if (via != null) rs.push('producer_changed');
    stale.push({ key: k, reasons: REASONS.filter((r) => rs.includes(r)), via });
  }
  const audited = [...a.rows.keys()].filter((k) => !dist.has(k)).length;
  return { stale, clean: audited, ref: opts.ref ?? null };
}

// Fresh fingerprints for `keys` (default: all stale keys that have a refs row). Returns {rows, updated, skipped}; rows sorted by key, canonical field order.
export function refsUpdate(model: StaleModel, refs: readonly PlanRecord[] | null | undefined, deps: StaleDeps, opts: StaleOpts = {}, keys: string[] | null = null): RefsUpdateResult {
  refs = refs || model.refs || [];
  const a = analyze(model, refs as readonly RefsRow[], deps, opts); // refs rows passed lib/schema's refs check on load
  const want = keys ? new Set(keys) : new Set(computeStale(model, refs, deps, opts).stale.map((s) => s.key));
  const updated: string[] = [], skipped: string[] = [];
  const ORDER = ['key', 'plans', 'files', 'fp_files', 'jira_updated', 'fp_links', 'rules', 'fp_prods', 'audited_at'];
  const rows = [...a.rows.keys()].sort(lt).map((k) => {
    const r = a.rows.get(k) as RefsRow; // k is a key of rows
    if (!want.has(k)) return r;
    const fp = a.fps.get(k) as TicketFingerprint; const fp_prods: Record<string, string> = {}; // every row was fingerprinted in analyze
    for (const p of a.g.prods.get(k) as string[]) fp_prods[p] = packEff(a.eff.get(p) as ClassDigests); // k and its producers are nodes
    const out: RefsRow = { ...r, plans: fp.plans, fp_files: fp.fp_files, jira_updated: fp.jira_updated ?? r.jira_updated ?? '', rules: fp.rules ?? r.rules, fp_links: fp.fp_links ?? r.fp_links, fp_prods, audited_at: opts.commit ?? r.audited_at ?? '' };
    for (const f of ['rules', 'fp_links']) if (out[f] === undefined) delete out[f];
    updated.push(k);
    const o: Record<string, unknown> = {}; for (const f of ORDER) if (f in out) o[f] = out[f]; for (const f of Object.keys(out).sort(lt)) if (!(f in o)) o[f] = out[f];
    return o as RefsRow; // a key-reordered copy of out
  });
  for (const k of want) if (!a.rows.has(k)) skipped.push(k);
  return { rows, updated, skipped: skipped.sort(lt) };
}

// Keys to hand to `units --stale`, same set as `stale`; `exclude` (e.g. tickets Done in Jira) is applied AFTER propagation.
export const staleKeys = (res: { stale: ReadonlyArray<{ key: string }> }, exclude: Set<string> = new Set()): string[] => res.stale.map((s) => s.key).filter((k) => !exclude.has(k));

// Token-lean text for the CLI. Always states the ref used. opts: {list, json, limit, jiraChecked, linksChecked, commit}
export function formatStale(res: StaleView, opts: FormatStaleOpts = {}): string {
  if (opts.json) return JSON.stringify({ ref: res.ref, commit: opts.commit ?? null, stale: res.stale, clean: res.clean }) + '\n';
  const by: Record<string, number> = {}; for (const s of res.stale) for (const r of s.reasons) by[r] = (by[r] || 0) + 1;
  const unchecked = [opts.jiraChecked === false ? 'jira' : '', opts.linksChecked === false ? 'links' : ''].filter(Boolean);
  let out = `stale vs ${res.ref}${opts.commit ? ' (' + opts.commit + ')' : ''}: ${res.stale.length} of ${res.stale.length + res.clean} need re-audit${res.stale.length ? ' ' + JSON.stringify(by) : ''}${unchecked.length ? ' | not checked: ' + unchecked.join(',') : ''}\n`;
  if (opts.list) {
    const lim = opts.limit ?? 40;
    for (const s of res.stale.slice(0, lim)) out += `${oneLine(s.key, 120)}: ${s.reasons.join(',')}${s.via ? ' via ' + oneLine(s.via, 120) : ''}\n`; // keys are data
    if (res.stale.length > lim) out += `... ${res.stale.length - lim} more\n`;
  }
  return out;
}

// Only a git exit-status failure about a missing path or ref means "absent"; timeouts, signals, spawn errors and old-git option errors propagate.
const isAbsentError = (e: ExecFailure | null | undefined): boolean => {
  if (!e || e.code || e.signal || typeof e.status !== 'number') return false;
  const msg = String(e.stderr || e.message || '');
  if (/end-of-options/.test(msg)) return false;
  // Anchored to the start of a stderr line (makeGit pins LC_ALL=C): a hostile path echoed inside another message cannot match.
  // ONLY "this path is not in that ref" counts as absent. A bad ref (invalid object name, bad revision, unknown revision, ambiguous
  // argument) is a configuration error and must fail loudly, never read as "every plan is absent".
  return /^(?:fatal|error): path '.*' (?:does not exist in|exists on disk, but not in) /im.test(msg);
};
// Real-git adapter. Caches git show per (ref,path), ls-tree per ref and rev-parse per ref. Jira snapshot (optional): {KEY:{updated, blockedBy|links}}.
export function gitDeps(repoRoot: string, defaultRef?: string | null, extra: GitDepsExtra = {}): GitDeps {
  const git = extra.git || makeGit(repoRoot);
  const texts = new Map<string, string | null>(), trees = new Map<string, Map<string, string>>(), commits = new Map<string, string>(); const snap = extra.jira || null;
  const R = (ref: string | null | undefined): string => checkRef(ref || defaultRef || 'HEAD');
  const tree = (ref: string): Map<string, string> => {
    if (!trees.has(ref)) { const t = new Map<string, string>(); for (const l of git('ls-tree', '-r', '--end-of-options', ref).split('\n')) { const m = /^\d+ blob (\w+)\t(.+)$/.exec(l); if (m) t.set(m[2] as string, m[1] as string); } trees.set(ref, t); } // both groups always match
    return trees.get(ref) as Map<string, string>; // set on the line above
  };
  return {
    readPlanText(ref, planPath) { const r = R(ref), pp = checkRepoPath(planPath), k = r + '\0' + pp; if (!texts.has(k)) { let t: string | null = null; try { t = git('show', '--end-of-options', `${r}:${pp}`); } catch (e) { if (!isAbsentError(e as ExecFailure)) throw e; } texts.set(k, t); } return texts.get(k); }, // whatever was thrown: isAbsentError tests every field
    listFiles(ref, paths) { const t = tree(R(ref)); const o: Record<string, string | null> = {}; for (const p of paths) o[p] = t.get(p) || null; return o; },
    jiraStamp: (key: string) => (snap ? (snap[key] && snap[key].updated) || '' : null),
    linkSet: (key: string) => (snap ? (snap[key] && (snap[key].links || snap[key].blockedBy)) || [] : null),
    status: (key: string) => (snap ? (snap[key] && snap[key].status) || '' : null),
    commit(ref) { const r = R(ref); if (!commits.has(r)) commits.set(r, git('rev-parse', '--short', '--end-of-options', r).trim()); return commits.get(r) as string; }, // set on the line above
  };
}
