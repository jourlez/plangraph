// Incremental re-audit: which audited tickets no longer match their inputs. Pure core (IO is injected through `deps`), see docs/STALE.md.
// Contract: computeStale(...) lists EXACTLY the tickets a full from-scratch re-derivation would list (proved by test/stale.test.mjs).
import crypto from 'node:crypto';
import { checkRef, checkRepoPath, compileHeading, makeGit } from './gitsafe.mjs';
import { oneLine } from './sanitize.mjs';

export const REASONS = ['plan', 'files', 'jira', 'links', 'rules', 'full', 'producer_changed'];
export const CLASSES = ['plan', 'files', 'jira', 'links', 'rules']; // input classes carried through producers (fp_prods)
export const DEFAULT_HEADING = '^#{2,3} Task {id}:';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const lt = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Canonical JSON: object keys sorted, so digests never depend on insertion order.
export function canon(x) {
  if (Array.isArray(x)) return '[' + x.map(canon).join(',') + ']';
  if (x && typeof x === 'object') return '{' + Object.keys(x).sort(lt).map((k) => JSON.stringify(k) + ':' + canon(x[k])).join(',') + '}';
  return JSON.stringify(x === undefined ? null : x);
}

// Plan text normalization (documented behaviour): CRLF/CR -> LF, BOM dropped, trailing spaces/tabs per line removed, trailing blank lines removed.
// Indentation, internal blank lines, wording and reflow ARE significant (a semantic edit must never hide inside "formatting").
// The per-line trim is a scan from the end (linear); the former `/[ \t]+$/` regex was quadratic on a long run of spaces before a non-space.
const trimEndBlank = (l) => { let e = l.length; while (e > 0 && (l.charCodeAt(e - 1) === 32 || l.charCodeAt(e - 1) === 9)) e--; return e === l.length ? l : l.slice(0, e); };
export function normalizePlanText(t) {
  return String(t ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n').map(trimEndBlank).join('\n').replace(/\n+$/, '');
}

// The section of a plan file for task `id` (suffix .pN stripped), from its heading to the next heading of the same shape.
export function planSection(text, id, heading = DEFAULT_HEADING) {
  const base = String(id).replace(/\.p\d+$/, '');
  const h = compileHeading(heading); const hit = h.find(text, base); if (!hit) return null;
  const rest = text.slice(hit.end); const n = h.nextIndex(rest);
  return text.slice(hit.start, hit.end + (n < 0 ? rest.length : n));
}

export const resolveRef = (config, flag) => checkRef(flag || (config && config.default_ref) || 'HEAD');

const linkSetFp = (ls) => sha(canon([...new Set((ls || []).map((x) => (typeof x === 'string' ? x : canon(x))))].sort(lt)));

// Own fingerprint of one ticket's refs row (not including producers). `row` = {plans:[{plan,task}], files:{path:..}}.
// opts: {ref, heading, rulesVersion}. Unavailable inputs (jira/links dep returns null/undefined, no rulesVersion) are null = "not checked".
export function fingerprintTicket(row, deps, opts = {}) {
  const heading = opts.heading || DEFAULT_HEADING;
  const plans = (row.plans || []).map((p) => {
    const raw = deps.readPlanText(opts.ref, p.plan);
    let fp;
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

const planKey = (p) => p.plan + '\0' + p.task;
const planDigest = (plans) => sha(plans.map((p) => planKey(p) + '=' + p.fp).sort(lt).join('\n'));
// Per-class digest of an own fingerprint (null = not available now).
function classDigests(fp) {
  return { plan: planDigest(fp.plans), files: fp.fp_files, jira: fp.jira_updated == null ? null : sha('j' + fp.jira_updated), links: fp.fp_links, rules: fp.rules == null ? null : sha('r' + fp.rules) };
}
const NONE = { plan: 'none', files: 'none', jira: 'none', links: 'none', rules: 'none' }; // ticket without a refs row: inputs unknown, constant

// Reverse-dependency graph from model.prods only (never trusts model.cons or edge order), sorted and deduplicated.
function graph(model, rowKeys) {
  const prods = new Map(); const nodes = new Set(rowKeys);
  for (const k of model.tickets ? model.tickets.keys() : []) nodes.add(k);
  for (const [c, ps] of model.prods || []) { nodes.add(c); for (const p of ps) nodes.add(p); }
  for (const n of nodes) prods.set(n, [...new Set((model.prods && model.prods.get(n)) || [])].sort(lt));
  const cons = new Map([...nodes].map((n) => [n, []]));
  for (const [c, ps] of prods) for (const p of ps) cons.get(p).push(c);
  for (const a of cons.values()) a.sort(lt);
  return { nodes: [...nodes].sort(lt), prods, cons };
}

// Merkle digest per input class over the producer cone, SCC-condensed so cycles terminate and are order-independent. Iterative Tarjan.
function effective(g, own) {
  const idx = new Map(), low = new Map(), on = new Set(), stack = [], eff = new Map(); let i = 0;
  const digestScc = (members) => {
    const ms = [...members].sort(lt); const set = new Set(ms); const ext = [...new Set(ms.flatMap((m) => g.prods.get(m)).filter((q) => !set.has(q)))].sort(lt);
    const out = {};
    for (const c of CLASSES) {
      const parts = ms.map((m) => m + ':' + ((own.get(m) || NONE)[c] ?? '-')); // '-' = unavailable now; skipped at compare time
      const avail = ms.every((m) => ((own.get(m) || NONE)[c]) != null) && ext.every((q) => eff.get(q)[c] != null);
      out[c] = avail ? sha(parts.join('|') + '#' + ext.map((q) => q + ':' + eff.get(q)[c]).join('|')) : null;
    }
    for (const m of ms) eff.set(m, out);
  };
  for (const root of g.nodes) {
    if (idx.has(root)) continue;
    const work = [[root, 0]]; idx.set(root, i); low.set(root, i++); stack.push(root); on.add(root);
    while (work.length) {
      const top = work[work.length - 1]; const [v, pi] = top; const ps = g.prods.get(v);
      if (pi < ps.length) {
        top[1]++; const w = ps[pi];
        if (!idx.has(w)) { idx.set(w, i); low.set(w, i++); stack.push(w); on.add(w); work.push([w, 0]); }
        else if (on.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
      } else {
        work.pop();
        if (work.length) { const u = work[work.length - 1][0]; low.set(u, Math.min(low.get(u), low.get(v))); }
        if (low.get(v) === idx.get(v)) { const comp = []; let w; do { w = stack.pop(); on.delete(w); comp.push(w); } while (w !== v); digestScc(comp); }
      }
    }
  }
  return eff;
}
const packEff = (e) => CLASSES.map((c) => e[c] ?? '').join('|');
const unpackEff = (s) => { const a = String(s).split('|'); const o = {}; CLASSES.forEach((c, k) => { o[c] = a[k] || null; }); return o; };

function analyze(model, refs, deps, opts) {
  const rows = new Map(); for (const r of refs) rows.set(r.key, r);
  const g = graph(model, [...rows.keys()]);
  const fps = new Map(), own = new Map();
  for (const k of [...rows.keys()].sort(lt)) { const fp = fingerprintTicket(rows.get(k), deps, opts); fps.set(k, fp); own.set(k, classDigests(fp)); }
  const eff = effective(g, own);
  return { rows, g, fps, eff };
}

// Direct reasons of one row against its record (own inputs only, plus the recorded producer digests).
function directReasons(row, fp, a, k, opts) {
  const rs = new Set();
  const rec = new Map((row.plans || []).map((p) => [planKey(p), p.fp]));
  for (const p of fp.plans) if (rec.get(planKey(p)) !== p.fp) { rs.add('plan'); break; }
  if (row.fp_files !== fp.fp_files) rs.add('files');
  if (fp.jira_updated != null && fp.jira_updated !== (row.jira_updated ?? '')) rs.add('jira');
  if (fp.fp_links != null && fp.fp_links !== row.fp_links) rs.add('links');
  if (fp.rules != null && fp.rules !== row.rules) rs.add('rules');
  if (opts.full) rs.add('full');
  const prods = a.g.prods.get(k);
  const mism = [];
  if (prods.length || row.fp_prods) {
    if (!row.fp_prods) mism.push(...prods); // legacy row: producer state at audit time unknown -> conservative
    else {
      const recKeys = Object.keys(row.fp_prods).sort(lt);
      if (recKeys.join('\0') !== prods.join('\0')) mism.push(...new Set([...prods.filter((p) => !(p in row.fp_prods)), ...recKeys.filter((p) => !prods.includes(p))]));
      for (const p of prods) if (p in row.fp_prods) {
        const r = unpackEff(row.fp_prods[p]), c = a.eff.get(p);
        if (CLASSES.some((cl) => r[cl] != null && c[cl] != null && r[cl] !== c[cl])) mism.push(p);
      }
    }
  }
  return { rs, mism: [...new Set(mism)].sort(lt) };
}

// ONE function computing the stale set (used by `brain stale`, `units --stale`, refs-update).
// model: buildModel() result; refs: array of refs rows (default model.refs); opts: {ref, heading, rulesVersion, full}.
export function computeStale(model, refs, deps, opts = {}) {
  const a = analyze(model, refs || model.refs || [], deps, opts);
  const reasons = new Map(), seedMism = new Map();
  for (const k of [...a.rows.keys()].sort(lt)) {
    const { rs, mism } = directReasons(a.rows.get(k), a.fps.get(k), a, k, opts);
    if (rs.size || mism.length) { reasons.set(k, rs); if (mism.length) seedMism.set(k, mism); }
  }
  // transitive propagation through producers: multi-source BFS over consumers; dist = hops from a changed source
  const dist = new Map([...reasons.keys()].map((k) => [k, 0]));
  let frontier = [...reasons.keys()].sort(lt);
  while (frontier.length) {
    const next = [];
    for (const p of frontier) for (const c of a.g.cons.get(p)) if (!dist.has(c)) { dist.set(c, dist.get(p) + 1); next.push(c); }
    frontier = next.sort(lt);
  }
  const stale = [];
  for (const k of [...dist.keys()].sort(lt)) {
    if (!a.rows.has(k) && !(model.tickets && model.tickets.has(k))) continue; // not a plan ticket: carries propagation only
    const own = reasons.get(k) || new Set();
    const inS = a.g.prods.get(k).filter((p) => dist.has(p)).sort((x, y) => dist.get(x) - dist.get(y) || lt(x, y));
    let via = null;
    if (inS.length) via = inS[0]; else if (seedMism.has(k)) via = seedMism.get(k)[0];
    const rs = [...own]; if (via != null) rs.push('producer_changed');
    stale.push({ key: k, reasons: REASONS.filter((r) => rs.includes(r)), via });
  }
  const audited = [...a.rows.keys()].filter((k) => !dist.has(k)).length;
  return { stale, clean: audited, ref: opts.ref ?? null };
}

// Fresh fingerprints for `keys` (default: all stale keys that have a refs row). Returns {rows, updated, skipped}; rows sorted by key, canonical field order.
/** @param {any} model @param {any[]} refs @param {any} deps @param {Record<string, any>} [opts] @param {string[] | null} [keys] */
export function refsUpdate(model, refs, deps, opts = {}, keys = null) {
  refs = refs || model.refs || [];
  const a = analyze(model, refs, deps, opts);
  const want = keys ? new Set(keys) : new Set(computeStale(model, refs, deps, opts).stale.map((s) => s.key));
  const updated = [], skipped = [];
  const ORDER = ['key', 'plans', 'files', 'fp_files', 'jira_updated', 'fp_links', 'rules', 'fp_prods', 'audited_at'];
  const rows = [...a.rows.keys()].sort(lt).map((k) => {
    const r = a.rows.get(k);
    if (!want.has(k)) return r;
    const fp = a.fps.get(k); const fp_prods = {};
    for (const p of a.g.prods.get(k)) fp_prods[p] = packEff(a.eff.get(p));
    const out = { ...r, plans: fp.plans, fp_files: fp.fp_files, jira_updated: fp.jira_updated ?? r.jira_updated ?? '', rules: fp.rules ?? r.rules, fp_links: fp.fp_links ?? r.fp_links, fp_prods, audited_at: opts.commit ?? r.audited_at ?? '' };
    for (const f of ['rules', 'fp_links']) if (out[f] === undefined) delete out[f];
    updated.push(k);
    const o = {}; for (const f of ORDER) if (f in out) o[f] = out[f]; for (const f of Object.keys(out).sort(lt)) if (!(f in o)) o[f] = out[f];
    return o;
  });
  for (const k of want) if (!a.rows.has(k)) skipped.push(k);
  return { rows, updated, skipped: skipped.sort(lt) };
}

// Keys to hand to `units --stale`, same set as `stale`; `exclude` (e.g. tickets Done in Jira) is applied AFTER propagation.
export const staleKeys = (res, exclude = new Set()) => res.stale.map((s) => s.key).filter((k) => !exclude.has(k));

// Token-lean text for the CLI. Always states the ref used. opts: {list, json, limit, jiraChecked, linksChecked, commit}
export function formatStale(res, opts = {}) {
  if (opts.json) return JSON.stringify({ ref: res.ref, commit: opts.commit ?? null, stale: res.stale, clean: res.clean }) + '\n';
  const by = {}; for (const s of res.stale) for (const r of s.reasons) by[r] = (by[r] || 0) + 1;
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
const isAbsentError = (e) => {
  if (!e || e.code || e.signal || typeof e.status !== 'number') return false;
  const msg = String(e.stderr || e.message || '');
  if (/end-of-options/.test(msg)) return false;
  // Anchored to the start of a stderr line (makeGit pins LC_ALL=C): a hostile path echoed inside another message cannot match.
  // ONLY "this path is not in that ref" counts as absent. A bad ref (invalid object name, bad revision, unknown revision, ambiguous
  // argument) is a configuration error and must fail loudly, never read as "every plan is absent".
  return /^(?:fatal|error): path '.*' (?:does not exist in|exists on disk, but not in) /im.test(msg);
};
// Real-git adapter. Caches git show per (ref,path), ls-tree per ref and rev-parse per ref. Jira snapshot (optional): {KEY:{updated, blockedBy|links}}.
export function gitDeps(repoRoot, defaultRef, extra = {}) {
  const git = extra.git || makeGit(repoRoot);
  const texts = new Map(), trees = new Map(), commits = new Map(); const snap = extra.jira || null;
  const R = (ref) => checkRef(ref || defaultRef || 'HEAD');
  const tree = (ref) => {
    if (!trees.has(ref)) { const t = new Map(); for (const l of git('ls-tree', '-r', '--end-of-options', ref).split('\n')) { const m = /^\d+ blob (\w+)\t(.+)$/.exec(l); if (m) t.set(m[2], m[1]); } trees.set(ref, t); }
    return trees.get(ref);
  };
  return {
    readPlanText(ref, planPath) { const r = R(ref), pp = checkRepoPath(planPath), k = r + '\0' + pp; if (!texts.has(k)) { let t = null; try { t = git('show', '--end-of-options', `${r}:${pp}`); } catch (e) { if (!isAbsentError(e)) throw e; } texts.set(k, t); } return texts.get(k); },
    listFiles(ref, paths) { const t = tree(R(ref)); const o = {}; for (const p of paths) o[p] = t.get(p) || null; return o; },
    jiraStamp: (key) => (snap ? (snap[key] && snap[key].updated) || '' : null),
    linkSet: (key) => (snap ? (snap[key] && (snap[key].links || snap[key].blockedBy)) || [] : null),
    status: (key) => (snap ? (snap[key] && snap[key].status) || '' : null),
    commit(ref) { const r = R(ref); if (!commits.has(r)) commits.set(r, git('rev-parse', '--short', '--end-of-options', r).trim()); return commits.get(r); },
  };
}
