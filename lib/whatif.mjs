// Safe reassignment: whatif (dry run), proposeMove (minimal repair search), renderWhatif (token-lean text).
// Pure functions over the model; nothing is mutated. Handoff rule: sprint[c] >= sprint[p] + (owner[c] !== owner[p] ? 1 : 0).
// Extra reason codes beyond the contract spec: OUT_OF_RANGE (sprint outside first_sprint..end_sprint), NO_REPAIR (proposeMove only).
// Known limit, kept on the safe side: CAPACITY compares the target cell's load after the move with its capacity, so a 0-SP ticket cannot move
// into a cell that is already over capacity, although the move adds no load and no new violation. Refusing it never creates a blocker.
import { capOf } from './model.mjs';
import { verifyPlan } from './verify.mjs';

const HARD = new Set(['UNKNOWN_TICKET', 'UNKNOWN_PERSON', 'SAME_SLOT', 'OUT_OF_RANGE']);
const spOf = (t) => (t && Number.isFinite(t.sp) ? t.sp : 0);
const d = (a, b) => (a !== b ? 1 : 0);
const cellKey = (o, s) => `${o}\t${s}`;
const est = (s) => Math.ceil(s.length / 4);
export { est as estTokens };

// Closed tickets (Done, plus config.closed_statuses) are always pinned, whatever frozen_statuses says (`brain init` once wrote []).
/** @param {any} model @returns {Set<string>} */
function closedSet(model) { const c = (model.config || {}).closed_statuses; return new Set(['Done', ...(Array.isArray(c) ? c.filter((x) => typeof x === 'string') : [])]); }
/** @param {any} model @returns {Set<string>} */
function frozenSet(model) { const f = (model.config || {}).frozen_statuses; return new Set([...closedSet(model), ...(Array.isArray(f) ? f : ['Done', 'In Progress'])]); }

function people(model, opts) {
  const set = new Set(opts.people || []);
  for (const p of model.sched.values()) if (p.owner) set.add(p.owner);
  for (const k of Object.keys(((model.config || {}).caps) || {})) if (k !== 'default') set.add(k);
  return [...set].sort();
}

function cellLoads(model) {
  const m = new Map(), members = new Map();
  for (const [k, p] of model.sched) {
    const t = model.tickets.get(k); if (!t) continue;
    const c = cellKey(p.owner, p.sprint);
    m.set(c, (m.get(c) || 0) + spOf(t));
    if (!members.has(c)) members.set(c, []);
    members.get(c).push(k);
  }
  for (const a of members.values()) a.sort();
  return { loads: m, members };
}

function range(model, opts) {
  const cfg = model.config || {};
  const first = cfg.first_sprint ?? 1;
  let used = 0; for (const p of model.sched.values()) if (p.sprint > used) used = p.sprint;
  const end = cfg.end_sprint ?? used;
  return { first, end, max: opts.allowOverflow ? end + (opts.overflowLimit ?? 12) : end };
}

// Resolve person name: exact, then unique case-insensitive.
function resolvePerson(model, name, opts) {
  const ps = people(model, opts);
  if (ps.includes(name)) return name;
  const q = String(name).trim().toLowerCase();
  const m = ps.filter((p) => p.toLowerCase() === q);
  if (m.length === 1) return m[0];
  // a unique first name or name prefix ("Ana" for "Ana Diaz") is accepted; an ambiguous one is not guessed
  const pre = ps.filter((p) => { const l = p.toLowerCase(); return q && (l.startsWith(q + ' ') || l.split(/\s+/)[0] === q); });
  return pre.length === 1 ? pre[0] : null;
}

export function whatif(model, mv, opts = {}) {
  const { key } = mv;
  const reasons = [];
  const res = { ok: false, reasons, ripple: [], load: {}, started: false, suggestion: null };
  const cur = model.sched.get(key), t = model.tickets.get(key);
  if (!cur || !t) { reasons.push({ code: 'UNKNOWN_TICKET', key, detail: 'not in plan', fix: 'check the key' }); return res; }
  let owner = cur.owner;
  if (mv.to != null) {
    const r = resolvePerson(model, mv.to, opts);
    if (r) owner = r;
    else { owner = mv.to; reasons.push({ code: 'UNKNOWN_PERSON', key: String(mv.to), detail: 'not an owner or capacity person', fix: `one of ${people(model, opts).join(', ')}` }); }
  }
  const sprint = mv.sprint ?? cur.sprint;
  const { first, end } = range(model, opts);
  if (!Number.isInteger(sprint) || sprint < first || (sprint > end && !opts.allowOverflow)) reasons.push({ code: 'OUT_OF_RANGE', key, detail: `S${sprint} outside S${first}..S${end}`, fix: `use S${first}..S${end}` });
  if (owner === cur.owner && sprint === cur.sprint) { reasons.push({ code: 'SAME_SLOT', key, detail: `already ${owner} S${sprint}`, fix: 'nothing to do' }); return res; }

  // Started tickets: Done is a hard stop; other frozen statuses warn (stop under opts.strict).
  const status = t.jira_status;
  if (status && closedSet(model).has(status)) { res.started = true; reasons.push({ code: 'STARTED', key, detail: `status ${status}`, fix: 'reopen first or leave it' }); }
  else if (status && frozenSet(model).has(status)) {
    res.started = true;
    reasons.push({ code: 'STARTED', key, detail: `status ${status}`, fix: 'confirm with the assignee', ...(opts.strict ? {} : { warn: true }) });
  }

  const P = (k) => (k === key ? { owner, sprint } : model.sched.get(k));
  for (const p of model.prods.get(key) || []) {
    const pp = model.sched.get(p); if (!pp || !model.tickets.has(p)) continue;
    const dd = d(pp.owner, owner), need = pp.sprint + dd;
    if (sprint < need) reasons.push({ code: 'PRODUCER_LATE', key: p, detail: `S${pp.sprint} ${pp.owner}, needs S${sprint - dd}${dd ? ' for handoff' : ''}`, fix: `move ${key} to S${need}+ or give it to ${pp.owner} from S${pp.sprint}` });
  }
  for (const c of model.cons.get(key) || []) {
    const cc = model.sched.get(c); if (!cc || !model.tickets.has(c)) continue;
    const dd = d(owner, cc.owner), need = sprint + dd;
    if (cc.sprint < need) reasons.push({ code: 'CONSUMER_EARLY', key: c, detail: `S${cc.sprint} ${cc.owner}, needs S${need}`, fix: `move ${c} to S${need}+ or ${key} to <=S${cc.sprint - dd}` });
  }

  // Capacity and load bookkeeping.
  const { loads } = cellLoads(model);
  const sp = spOf(t), oc = cellKey(cur.owner, cur.sprint), nc = cellKey(owner, sprint);
  const entry = (o, s, before, after) => { (res.load[o] ||= {})[s] = { before, after, cap: capOf(model.config, o) }; };
  entry(cur.owner, cur.sprint, loads.get(oc) || 0, (loads.get(oc) || 0) - sp);
  const nb = loads.get(nc) || 0, na = nb + sp;
  entry(owner, sprint, nb, na);
  res.freed = { owner: cur.owner, sprint: cur.sprint, sp };
  const cap = capOf(model.config, owner);
  if (na > cap) {
    let alt = null;
    for (let s = Math.max(sprint, first); s <= range(model, opts).max; s++) if (s !== sprint && (loads.get(cellKey(owner, s)) || 0) + sp <= cap) { alt = s; break; }
    reasons.push({ code: 'CAPACITY', key: `${owner} S${sprint}`, detail: `${na}/${cap}`, fix: alt ? `${owner} has room in S${alt}` : `${owner} has no room through S${range(model, opts).max}` });
  }

  // Naive forward ripple (capacity ignored): the moved ticket, then consumers that would have to shift later.
  const rip = new Map([[key, { key, from: { owner: cur.owner, sprint: cur.sprint }, to: { owner, sprint }, why: 'requested' }]]);
  const q = [key]; let guard = 0;
  while (q.length && guard++ < 100000) {
    const x = q.shift(), px = P(x) && rip.has(x) ? rip.get(x).to : model.sched.get(x);
    for (const c of model.cons.get(x) || []) {
      const cc = model.sched.get(c); if (!cc || !model.tickets.has(c)) continue;
      const need = px.sprint + d(px.owner, cc.owner);
      const prev = rip.get(c)?.to.sprint ?? cc.sprint;
      if (prev < need) { rip.set(c, { key: c, from: { owner: cc.owner, sprint: cc.sprint }, to: { owner: cc.owner, sprint: need }, why: `consumer of ${x} needs S${need}` }); q.push(c); }
    }
  }
  res.ripple = [...rip.values()];

  res.ok = !reasons.some((r) => !r.warn);
  if (!res.ok && !opts.noSuggest && !reasons.some((r) => HARD.has(r.code) || (r.code === 'STARTED' && !r.warn))) {
    const pm = proposeMove(model, mv, { ...opts, allowSlip: true, noSuggest: true });
    // flags: what applying the repair needs beyond the caller's own options (the search allowed slip; the user may not have)
    if (pm.ok) res.suggestion = { sprint: pm.moves[0].to.sprint, owner: pm.moves[0].to.owner, shifts: pm.moves.length - 1, ownerChanges: pm.moves.slice(1).filter((m) => m.from.owner !== m.to.owner).length, ...(pm.slipped > 0 && !opts.allowSlip ? { flags: ['slip'] } : {}) };
    else res.suggestion = { none: true };
  }
  return res;
}

// ---- proposeMove: best-first search over single-ticket moves, cost = (slip of the requested ticket, other tickets moved, steps). ----
class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  less(x, y) { for (let i = 0; i < x.pr.length; i++) if (x.pr[i] !== y.pr[i]) return x.pr[i] < y.pr[i]; return x.id < y.id; }
  push(n) { const a = this.a; a.push(n); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (!this.less(a[i], a[p])) break; [a[i], a[p]] = [a[p], a[i]]; i = p; } }
  pop() { const a = this.a, top = a[0], last = a.pop(); if (a.length) { a[0] = last; let i = 0; for (;;) { let m = i; const l = 2 * i + 1, r = l + 1; if (l < a.length && this.less(a[l], a[m])) m = l; if (r < a.length && this.less(a[r], a[m])) m = r; if (m === i) break; [a[i], a[m]] = [a[m], a[i]]; i = m; } } return top; }
}

export function proposeMove(model, mv, opts = {}) {
  const w = whatif(model, mv, { ...opts, noSuggest: true });
  const hard = w.reasons.filter((r) => HARD.has(r.code) || (r.code === 'STARTED' && !r.warn));
  if (hard.length) return { ok: false, moves: [], reasons: hard };
  const { key } = mv, cur = model.sched.get(key);
  const owner = w.ripple[0].to.owner, sprint = w.ripple[0].to.sprint;
  const tgt = { owner, sprint };
  if (w.ok) return { ok: true, moves: [{ key, from: { ...cur }, to: tgt }], reasons: [], shifted: 0, ownerChanges: 0, slipped: 0, searchComplete: true, nodes: 0 };

  const cfg = model.config || {}, { first, max } = range(model, opts);
  const fz = frozenSet(model);
  const pinned = (k) => k !== key && (fz.has(model.tickets.get(k)?.jira_status) || (opts.frozen && opts.frozen.has(k)));
  const base = model.sched;
  const ppl = people(model, opts);
  const { loads: baseLoads, members: baseMembers } = cellLoads(model);
  const budget = opts.budget ?? 20000;

  const PL = (ov, k) => ov.get(k) ?? base.get(k);
  const okTk = (k) => model.tickets.has(k) && base.has(k);

  function violations(ov) {
    const edges = new Map();
    for (const x of ov.keys()) {
      for (const p of model.prods.get(x) || []) if (okTk(p)) edges.set(`${p}\t${x}`, [p, x]);
      for (const c of model.cons.get(x) || []) if (okTk(c)) edges.set(`${x}\t${c}`, [x, c]);
    }
    const out = [];
    for (const k of [...edges.keys()].sort()) {
      const [p, c] = edges.get(k), pp = PL(ov, p), pc = PL(ov, c);
      if (pc.sprint < pp.sprint + d(pp.owner, pc.owner)) out.push({ t: 'H', p, c });
    }
    const delta = new Map();
    for (const [k, v] of ov) { const b = base.get(k), sp = spOf(model.tickets.get(k)); delta.set(cellKey(b.owner, b.sprint), (delta.get(cellKey(b.owner, b.sprint)) || 0) - sp); delta.set(cellKey(v.owner, v.sprint), (delta.get(cellKey(v.owner, v.sprint)) || 0) + sp); }
    for (const c of [...delta.keys()].sort()) {
      const dl = delta.get(c); if (dl <= 0) continue;
      const [o, s] = c.split('\t'), load = (baseLoads.get(c) || 0) + dl, cap = capOf(cfg, o);
      if (load > cap) out.push({ t: 'C', owner: o, sprint: Number(s), load, cap, delta });
    }
    return out;
  }

  const movable = (k) => !pinned(k);
  // An option is {k, owner?, sprint?}. The requested ticket may only slip later (never change owner) and only with allowSlip.
  const canMove = (k, o, s, ov) => {
    if (!movable(k)) return false;
    const cur2 = PL(ov, k);
    // Slipping an earlier request must stay before the current slot (same owner): reaching it again is no move.
    if (k === key) return !!opts.allowSlip && o === cur2.owner && s > cur2.sprint && s <= max && !(o === cur.owner && sprint < cur.sprint && s >= cur.sprint);
    return s >= first && s <= max && (o === cur2.owner || !!opts.allowOwnerChange);
  };
  // Without allowEarlier a ticket never ends before its base sprint; with it, it may. The requested ticket is exempt: the request itself may
  // be earlier than its base sprint, and canMove already bounds its slip.
  const optsFor = (v, ov) => {
    const out = [];
    const push = (k, o, s) => {
      if (canMove(k, o, s, ov) && (opts.allowEarlier || k === key || s >= base.get(k).sprint)) out.push({ k, o, s });
    };
    if (v.t === 'H') {
      const pp = PL(ov, v.p), pc = PL(ov, v.c), dd = d(pp.owner, pc.owner);
      push(v.c, pc.owner, pp.sprint + dd);
      if (opts.allowEarlier) push(v.p, pp.owner, pc.sprint - dd);
      if (opts.allowOwnerChange && dd) { push(v.c, pp.owner, pc.sprint); push(v.p, pc.owner, pp.sprint); }
    } else {
      const mem = new Set((baseMembers.get(cellKey(v.owner, v.sprint)) || []).filter((k) => !ov.has(k)));
      for (const [k, p] of ov) if (p.owner === v.owner && p.sprint === v.sprint) mem.add(k);
      for (const k of [...mem].sort()) {
        if (!(spOf(model.tickets.get(k)) > 0)) continue;
        push(k, v.owner, v.sprint + 1);
        if (opts.allowEarlier && k !== key) push(k, v.owner, v.sprint - 1);
        if (opts.allowOwnerChange) for (const q of ppl) if (q !== v.owner) push(k, q, v.sprint);
      }
    }
    return out;
  };
  const apply = (ov, o) => {
    const n = new Map(ov), b = base.get(o.k);
    if (o.o === b.owner && o.s === b.sprint && o.k !== key) n.delete(o.k); else n.set(o.k, { owner: o.o, sprint: o.s });
    return n;
  };
  const ser = (ov) => [...ov].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}:${v.owner}:${v.sprint}`).join('|');
  // Closure: apply forced moves (violations with exactly one repair) until a branching point, goal or dead end.
  let work = 0; const workLimit = opts.workLimit ?? 60000; // violation scans; bounds total effort independent of the node budget
  const closure = (ov) => {
    const loop = new Set(); // a forced-move cycle means no repair is reachable down this path
    for (let i = 0; i < 100000; i++) {
      const sid = ser(ov); if (loop.has(sid)) return { dead: true }; loop.add(sid);
      if (++work > workLimit) return { dead: true, over: true };
      const vs = violations(ov);
      if (!vs.length) return { ov, goal: true, vs };
      const v = vs.find((x) => x.t === 'H') || vs[0], os = optsFor(v, ov);
      if (!os.length) return { dead: true };
      if (os.length === 1) { ov = apply(ov, os[0]); continue; }
      return { ov, goal: false, vs, v, os };
    }
    return { dead: true };
  };
  const metrics = (ov, steps, nv) => {
    const slip = (ov.get(key)?.sprint ?? sprint) - sprint;
    let moved = 0; for (const k of ov.keys()) if (k !== key) moved++;
    return { slip, moved, steps, nv };
  };

  function run(greedy) {
    const heap = new Heap(), seen = new Set(); let id = 0, pops = 0; work = 0;
    const seed = new Map([[key, tgt]]);
    const push = (ov, steps) => {
      const c = closure(ov); if (c.dead) return;
      const sid = ser(c.ov); if (seen.has(sid)) return; seen.add(sid);
      const m = metrics(c.ov, steps, c.vs.length);
      heap.push({ pr: greedy ? [m.nv, m.slip, m.moved, m.steps] : [m.slip, m.moved, m.steps], id: id++, c, steps });
    };
    push(seed, 0);
    while (heap.size) {
      if (pops++ >= budget || work > workLimit) return { exhausted: true, pops };
      const n = heap.pop();
      if (n.c.goal) return { ov: n.c.ov, pops, complete: !greedy };
      for (const o of n.c.os) push(apply(n.c.ov, o), n.steps + 1);
    }
    return work > workLimit ? { exhausted: true, pops } : { infeasible: true, pops };
  }

  let r = run(false), approx = false;
  if (r.exhausted) { approx = true; r = run(true); }
  if (!r.ov) {
    return { ok: false, moves: [], reasons: [...w.reasons.filter((x) => !x.warn), { code: 'NO_REPAIR', key, detail: r.infeasible ? 'no repair exists under the move rules' : `search budget ${budget} exhausted`, fix: r.infeasible ? 'allow earlier moves, owner changes, slip or overflow' : 'raise opts.budget' }], searchComplete: !!r.infeasible, nodes: r.pops };
  }
  const plan = new Map(base);
  for (const [k, v] of r.ov) plan.set(k, v);
  assertPlanValid(model, plan, opts, pinned);
  const moves = [{ key, from: { ...cur }, to: { ...r.ov.get(key) } }];
  for (const k of [...r.ov.keys()].filter((x) => x !== key).sort()) moves.push({ key: k, from: { ...base.get(k) }, to: { ...r.ov.get(k) } });
  return { ok: true, moves, reasons: [], shifted: moves.length - 1, ownerChanges: moves.filter((m) => m.from.owner !== m.to.owner && m.key !== key).length, slipped: moves[0].to.sprint - sprint, searchComplete: !approx && r.complete, nodes: r.pops };
}

// Internal safety net: the repaired plan must introduce no violation that the base plan did not already have.
export function assertPlanValid(model, plan, opts, pinned) {
  const fro = new Map(); for (const [k, p] of model.sched) if (pinned(k)) fro.set(k, p);
  const sig = (v) => `${v.code}|${v.key}|${v.detail}`;
  const before = verifyPlan(model, model.sched, {}), after = verifyPlan(model, plan, { frozen: fro });
  const baseSet = new Set(before.map(sig)), baseCap = new Map(before.filter((v) => v.code === 'CAPACITY').map((v) => [v.key, parseInt(v.detail, 10)]));
  const bad = after.filter((v) => !baseSet.has(sig(v)) && !(v.code === 'CAPACITY' && baseCap.has(v.key) && parseInt(v.detail, 10) <= baseCap.get(v.key)));
  if (bad.length) throw new Error(`proposeMove produced an invalid plan: ${bad.slice(0, 3).map(sig).join('; ')}`);
}

// Apply a set of moves (from proposeMove) to a schedule copy.
export function applyMoves(sched, moves) {
  const n = new Map(sched);
  for (const m of moves) n.set(m.key, { owner: m.to.owner, sprint: m.to.sprint });
  return n;
}

// ---- renderWhatif: yes/no first, reasons joined by ' | ', bounded. ----
export function renderWhatif(r, opts = {}) {
  const lim = opts.limit ?? 8;
  const mv = r.ripple && r.ripple[0];
  const head = mv ? `${mv.key} -> ${mv.to.owner} S${mv.to.sprint}` : (r.reasons[0]?.key ?? '?');
  const rs = r.reasons.map((x) => `${x.code} ${x.key} (${x.detail})`);
  const shown = rs.slice(0, lim).join(' | ') + (rs.length > lim ? ` | ... ${rs.length - lim} more` : '');
  const warn = r.reasons.length && r.reasons.every((x) => x.warn);
  if (r.ok) {
    let s = `OK: ${head}.`;
    for (const o of Object.keys(r.load)) for (const sp of Object.keys(r.load[o])) { const l = r.load[o][sp]; if (l.after > l.before) s += ` ${o} S${sp} ${l.after}/${l.cap}.`; }
    if (r.freed && r.freed.sp) s += ` Frees ${r.freed.sp} on ${r.freed.owner} S${r.freed.sprint}.`;
    if (warn) s += ` WARN ${shown}.`;
    return s;
  }
  let s = `NO: ${head}. ${shown}.`;
  const g = r.suggestion;
  if (g && !g.none) {
    const at = mv && g.sprint !== mv.to.sprint ? `move to S${g.sprint}` : `keep S${g.sprint}`;
    const need = g.flags && g.flags.length ? `; apply with ${g.flags.map((/** @type {string} */ f) => `--${f}`).join(' ')}` : '';
    s += ` Fix: ${at} (${g.shifts} ${g.shifts === 1 ? 'other shifts' : 'others shift'}, ${g.ownerChanges} owner changes${need}).`;
  } else if (g && g.none) s += ' Fix: none found; try --earlier or --owner-change.';
  else if (r.reasons[0] && r.reasons[0].fix) s += ` Fix: ${r.reasons[0].fix}.`;
  return s;
}
