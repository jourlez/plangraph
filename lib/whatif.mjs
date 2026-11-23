// Safe reassignment: whatif (dry run), proposeMove (minimal repair search), relieve (fewest moves to bring one cell under cap), renderWhatif and renderRelieve (token-lean text).
// Pure functions over the model; nothing is mutated. Handoff rule: sprint[c] >= sprint[p] + (owner[c] !== owner[p] ? 1 : 0).
// Extra reason codes beyond the contract spec: OUT_OF_RANGE (sprint outside first_sprint..end_sprint), NO_REPAIR (proposeMove only).
// CAPACITY is a NEW violation only (as lib/verify.mjs counts them): the target cell ends over its capacity AND the move added load to it, so a
// 0-SP ticket may move into a cell that is already over capacity (its load and its verify violation are unchanged).
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

// Resolve person name: exact, then unique case-insensitive, then a unique first name or name prefix; null when none or ambiguous.
// Exported: `brain ready --person` resolves its name the same way.
export function resolvePerson(model, name, opts = {}) {
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

  // A self-link (key needs key) is read through P on both ends: the moved ticket's NEW slot, so it never yields a phantom reason.
  const P = (k) => (k === key ? { owner, sprint } : model.sched.get(k));
  for (const p of model.prods.get(key) || []) {
    const pp = P(p); if (!pp || !model.tickets.has(p)) continue;
    const dd = d(pp.owner, owner), need = pp.sprint + dd;
    if (sprint < need) reasons.push({ code: 'PRODUCER_LATE', key: p, detail: `S${pp.sprint} ${pp.owner}, needs S${sprint - dd}${dd ? ' for handoff' : ''}`, fix: `move ${key} to S${need}+ or give it to ${pp.owner} from S${pp.sprint}` });
  }
  for (const c of model.cons.get(key) || []) {
    const cc = P(c); if (!cc || !model.tickets.has(c)) continue;
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
  if (na > cap && na > nb) { // a move that adds no load (0 SP) leaves an existing overload as it was: no new violation
    let alt = null;
    for (let s = Math.max(sprint, first); s <= range(model, opts).max; s++) if (s !== sprint && (loads.get(cellKey(owner, s)) || 0) + sp <= cap) { alt = s; break; }
    reasons.push({ code: 'CAPACITY', key: `${owner} S${sprint}`, detail: `${na}/${cap}`, fix: alt ? `${owner} has room in S${alt}` : `${owner} has no room through S${range(model, opts).max}` });
  }

  // Naive forward ripple (capacity ignored): the moved ticket, then consumers that would have to shift later. The request itself is
  // fixed (a link back to it, a loop, never re-places it), and no shift goes past sprint + ticket count: an acyclic cascade never needs
  // more (each hop adds at most 1), so only a loop stops there, instead of climbing to the step guard.
  const rip = new Map([[key, { key, from: { owner: cur.owner, sprint: cur.sprint }, to: { owner, sprint }, why: 'requested' }]]);
  const q = [key]; let guard = 0;
  while (q.length && guard++ < 100000) {
    const x = q.shift(), px = P(x) && rip.has(x) ? rip.get(x).to : model.sched.get(x);
    for (const c of model.cons.get(x) || []) {
      if (c === key) continue;
      const cc = model.sched.get(c); if (!cc || !model.tickets.has(c)) continue;
      const need = px.sprint + d(px.owner, cc.owner);
      const prev = rip.get(c)?.to.sprint ?? cc.sprint;
      if (prev < need && need <= sprint + model.tickets.size) { rip.set(c, { key: c, from: { owner: cc.owner, sprint: cc.sprint }, to: { owner: cc.owner, sprint: need }, why: `consumer of ${x} needs S${need}` }); q.push(c); }
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

// ---- relieve: the smallest valid set of single-ticket moves that brings one person's load in one sprint to <= cap. ----
// Move space: only the tickets of that cell (owner PERSON, sprint N) move, each once, to one slot: the same owner in a later sprint (always),
// an earlier sprint (opts.allowEarlier), another person (opts.allowOwnerChange; in sprint N or later, earlier too with allowEarlier); every
// sprint in first_sprint..end_sprint (as whatif). Frozen tickets never move (closed statuses, frozen_statuses as whatif reads them, an sp:
// task with impl_status done, a sprint below frozen_before_sprint). A set is valid when, all moves applied together: the cell ends <= cap;
// every link with a moved ticket at either end (other end a placed ticket of the plan) satisfies the strict handoff rule (as whatif's
// PRODUCER_LATE / CONSUMER_EARLY, which also refuse a link that was already broken); every cell that gained load ends <= its owner's cap
// (whatif's CAPACITY). Then verifyPlan finds nothing that it did not already find on the current plan (asserted: an internal error
// otherwise). Choice: fewest tickets moved, then least total slip (sum of |to sprint - N|), then fewest owner changes, then key order (the
// moves sorted by key, compared by key, target owner, target sprint). Search: subsets by size, each assigned by depth-first search with a
// bound on slip and owner changes; budget = opts.budget steps, each subset step and slot try (default 1,000,000). When it is hit the answer says so (searchComplete
// false): a set found is not proven minimal, and no set found is not proven impossible. order: 'sequential' when the moves, applied one by
// one in the returned order, each pass whatif() alone (each printed command says OK when run in that order), else 'together' (key order).
export const RELIEVE_BUDGET = 1000000;
/** @param {any} model @param {{ person: string, sprint: number }} cell @param {{ allowEarlier?: boolean, allowOwnerChange?: boolean, budget?: number }} [opts] */
export function relieve(model, { person, sprint }, opts = {}) {
  const cfg = model.config || {}, cap = capOf(cfg, person), { first, end } = range(model, {}), budget = opts.budget ?? RELIEVE_BUDGET;
  const allowed = ['later', ...(opts.allowEarlier ? ['earlier'] : []), ...(opts.allowOwnerChange ? ['owner-change'] : [])];
  const cell = [];
  for (const [k, p] of model.sched) if (model.tickets.has(k) && p && p.owner === person && p.sprint === sprint) cell.push(k);
  cell.sort();
  const load = cell.reduce((a, k) => a + spOf(model.tickets.get(k)), 0);
  const res = { person, sprint, load, cap, after: load, status: 'none_needed', moves: [], slip: 0, ownerChanges: 0, order: null, searchComplete: true, nodes: 0, budget, allowed, excluded: [], reasons: [] };
  if (!(load > cap)) return res;
  const excess = load - cap, fz = frozenSet(model), fb = cfg.frozen_before_sprint;
  const pinned = (k) => { const t = model.tickets.get(k); return fz.has(t.jira_status) || (String(k).startsWith('sp:') && t.impl_status === 'done') || (Number.isFinite(fb) && sprint < fb); };
  const inCell = new Set(cell), { loads } = cellLoads(model), stays = new Set(cell.filter(pinned));
  const free = (k) => inCell.has(k) && !stays.has(k); // a cell ticket that may move: its links are checked inside the search
  const placed = (k) => { const p = model.sched.get(k); return model.tickets.has(k) && p && typeof p.owner === 'string' && p.owner !== '' && Number.isInteger(p.sprint) ? p : null; };
  const okLink = (pp, pc) => pc.sprint >= pp.sprint + d(pp.owner, pc.owner);
  // per candidate: its slots that pass the links to tickets outside the cell and the capacity of the target cell alone
  const cands = [], why = { FROZEN: [], NO_SLOT: [], LINKS: [], FULL: [] };
  for (const k of cell) {
    if (pinned(k)) { res.excluded.push({ key: k, code: 'FROZEN' }); why.FROZEN.push(k); continue; }
    const sp = spOf(model.tickets.get(k)), slots = [];
    const owners = [person, ...(opts.allowOwnerChange ? people(model, {}).filter((q) => q !== person) : [])];
    for (const o of owners) for (let s = first; s <= end; s++) {
      if ((o === person && s === sprint) || (s < sprint && !opts.allowEarlier)) continue;
      slots.push({ owner: o, sprint: s });
    }
    let linkOk = 0; const good = [];
    for (const to of slots) {
      let ok = true;
      for (const p of model.prods.get(k) || []) { if (p === k || free(p)) continue; const pp = placed(p); if (pp && !okLink(pp, to)) { ok = false; break; } }
      if (ok) for (const c of model.cons.get(k) || []) { if (c === k || free(c)) continue; const pc = placed(c); if (pc && !okLink(to, pc)) { ok = false; break; } }
      if (!ok) continue;
      linkOk++;
      if ((loads.get(cellKey(to.owner, to.sprint)) || 0) + sp > capOf(cfg, to.owner)) continue;
      good.push({ ...to, slip: Math.abs(to.sprint - sprint), oc: d(to.owner, person) });
    }
    good.sort((a, b) => a.slip - b.slip || a.oc - b.oc || (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0) || a.sprint - b.sprint);
    if (!good.length) { why[!slots.length ? 'NO_SLOT' : !linkOk ? 'LINKS' : 'FULL'].push(k); continue; }
    cands.push({ key: k, sp, slots: good, minSlip: good[0].slip });
  }
  // links between two tickets of the cell: checked once both ends are known (a ticket of the cell that does not move stays at (person, N))
  const intra = new Map(cands.map((c) => [c.key, []]));
  const consIn = new Map(cell.map((k) => [k, []])); // the cell consumers of each cell ticket
  for (const c of cell) for (const p of model.prods.get(c) || []) {
    if (!inCell.has(p) || p === c) continue;
    consIn.get(p).push(c);
    if (intra.has(c)) intra.get(c).push({ p, c }); if (intra.has(p)) intra.get(p).push({ p, c });
  }
  const freeable = cands.reduce((a, c) => a + c.sp, 0);
  let best = null, nodes = 0, hit = false;
  const better = (x, y) => {
    if (!y) return true;
    if (x.slip !== y.slip) return x.slip < y.slip;
    if (x.oc !== y.oc) return x.oc < y.oc;
    for (let i = 0; i < x.moves.length; i++) {
      const a = x.moves[i], b = y.moves[i];
      if (a.key !== b.key) return a.key < b.key;
      if (a.to.owner !== b.to.owner) return a.to.owner < b.to.owner;
      if (a.to.sprint !== b.to.sprint) return a.to.sprint < b.to.sprint;
    }
    return false;
  };
  const home = { owner: person, sprint };
  function assign(sub) {
    const at = new Map(), add = new Map();
    const where = (k) => at.get(k) ?? (inCell.has(k) ? (sub.has(k) ? null : home) : null);
    const list = [...sub.values()], byKey = list.slice().sort((a, b) => (a.key < b.key ? -1 : 1));
    const minRest = []; for (let i = list.length - 1, m = 0; i >= 0; i--) { m += list[i].minSlip; minRest[i] = m; }
    const dfs = (i, slip, oc) => {
      if (hit) return;
      if (best && best.moves.length === list.length && (slip + (minRest[i] ?? 0) > best.slip || (slip + (minRest[i] ?? 0) === best.slip && oc > best.oc))) return;
      if (i === list.length) {
        const moves = byKey.map((c) => ({ key: c.key, sp: c.sp, from: { ...home }, to: { owner: at.get(c.key).owner, sprint: at.get(c.key).sprint } }));
        const cand = { moves, slip, oc };
        if (better(cand, best)) best = cand;
        return;
      }
      const c = list[i];
      for (const to of c.slots) {
        if (++nodes > budget) { hit = true; return; }
        const ck = cellKey(to.owner, to.sprint), cur = (loads.get(ck) || 0) + (add.get(ck) || 0) + c.sp;
        if (cur > capOf(cfg, to.owner)) continue;
        at.set(c.key, to);
        let ok = true;
        for (const e of intra.get(c.key)) { const pp = where(e.p), pc = where(e.c); if (pp && pc && !okLink(pp, pc)) { ok = false; break; } }
        if (ok) { add.set(ck, (add.get(ck) || 0) + c.sp); dfs(i + 1, slip + to.slip, oc + to.oc); add.set(ck, add.get(ck) - c.sp); }
        at.delete(c.key);
        if (hit) return;
      }
    };
    dfs(0, 0, 0);
  }
  // subsets by size, from the fewest tickets that could free the excess (largest points first); a subset is searched only when it frees at
  // least the excess and, without allowEarlier, holds every cell consumer of each ticket in it (a ticket that leaves for a later sprint or
  // another owner breaks the link to a consumer that stays). Every subset step and every slot try counts against the budget.
  const bySp = cands.slice().sort((a, b) => b.sp - a.sp || (a.key < b.key ? -1 : 1)), pre = [0];
  for (const c of bySp) pre.push(pre[pre.length - 1] + c.sp);
  const closed = (pick) => opts.allowEarlier || pick.every((c) => consIn.get(c.key).every((y) => pick.some((q) => q.key === y)));
  if (freeable >= excess) {
    let kmin = 1; while (pre[kmin] < excess) kmin++;
    for (let k = kmin; k <= bySp.length && !best && !hit; k++) {
      const pick = [];
      const comb = (start, sum) => {
        if (hit) return;
        if (++nodes > budget) { hit = true; return; }
        if (pick.length === k) { if (sum >= excess && closed(pick)) assign(new Map(pick.map((c) => [c.key, c]))); return; }
        const need = k - pick.length;
        for (let i = start; i <= bySp.length - need; i++) {
          if (sum + pre[i + need] - pre[i] < excess) return; // the largest remaining tickets cannot reach the excess; later ones are smaller
          pick.push(bySp[i]); comb(i + 1, sum + bySp[i].sp); pick.pop();
          if (hit) return;
        }
      };
      comb(0, 0);
    }
  }
  res.nodes = Math.min(nodes, budget); res.searchComplete = !hit;
  if (!best) {
    res.status = 'no_relief';
    for (const code of ['FROZEN', 'NO_SLOT', 'LINKS', 'FULL']) if (why[code].length) res.reasons.push({ code, keys: why[code] });
    if (!hit) res.reasons.push(freeable < excess ? { code: 'NOT_ENOUGH', keys: [], freeable, needed: excess } : { code: 'CONFLICT', keys: cands.map((c) => c.key) });
    return res;
  }
  // the internal safety net: applied together, verifyPlan finds nothing new (every violation after was there before, byte for byte)
  const sched = applyMoves(model.sched, best.moves), sig = (v) => `${v.code}|${v.key}|${v.detail}`;
  const was = new Map(); for (const v of verifyPlan(model, model.sched, {})) was.set(sig(v), (was.get(sig(v)) || 0) + 1);
  for (const v of verifyPlan(model, sched, {})) { const n = was.get(sig(v)) || 0; if (!n) throw new Error(`relieve produced an invalid plan: ${sig(v)}`); was.set(sig(v), n - 1); }
  // apply order: repeatedly the first remaining move (key order) that whatif() accepts alone on the plan so far
  let rest = best.moves.slice(), cur = model.sched; const ordered = [];
  while (rest.length) {
    const i = rest.findIndex((m) => whatif({ ...model, sched: cur }, { key: m.key, ...(m.to.owner !== person ? { to: m.to.owner } : {}), sprint: m.to.sprint }, { noSuggest: true }).ok);
    if (i < 0) break;
    ordered.push(rest[i]); cur = applyMoves(cur, [rest[i]]); rest = rest.filter((_, j) => j !== i);
  }
  Object.assign(res, { status: 'relief', after: load - best.moves.reduce((a, m) => a + m.sp, 0), slip: best.slip, ownerChanges: best.oc, order: rest.length ? 'together' : 'sequential', moves: rest.length ? best.moves : ordered });
  return res;
}

// Text of a relieve result, line by line. cmd(move) gives the exact dry-run command of one move (null when a value is not shell-safe).
const ALLOWED_TEXT = (/** @type {string[]} */ a) => `this cell's tickets, ${a.includes('earlier') ? 'later or earlier' : 'later'} sprints, ${a.includes('owner-change') ? 'any owner' : 'same owner'}`;
const REASON_TEXT = { FROZEN: 'frozen (started or closed)', NO_SLOT: 'no other sprint in range', LINKS: 'every target breaks a link', FULL: 'every target is over capacity', CONFLICT: 'each could move, but no combination works together' };
/** @param {any} r @param {{ cmd: (m: any) => string | null, limit?: number, keys?: number, name?: (s: unknown) => string, key?: (s: unknown) => string }} o @returns {string[]} */
export function renderRelieve(r, { cmd, limit = 15, keys = 5, name = String, key = String }) {
  const head = `${name(r.person)} S${r.sprint}`, out = [];
  if (r.status === 'none_needed') return [`OK: ${head} is within capacity (${r.load}/${r.cap}): nothing to relieve`];
  if (r.status === 'no_relief') {
    out.push(`NO RELIEF: ${head} ${r.load}/${r.cap}: ${r.searchComplete ? `no relief found within the allowed moves (${ALLOWED_TEXT(r.allowed)})` : `no relief found within the search budget (${r.budget} steps); not proven impossible`}`);
    for (const x of r.reasons) {
      if (x.code === 'NOT_ENOUGH') { out.push(`- the tickets that can move free ${x.freeable} SP of the ${x.needed} needed`); continue; }
      out.push(`- ${/** @type {Record<string, string>} */ (REASON_TEXT)[x.code]} ${x.keys.length}: ${x.keys.slice(0, keys).map(key).join(' ')}${x.keys.length > keys ? ` +${x.keys.length - keys} more` : ''}`);
    }
    const flags = ['earlier', 'owner-change'].filter((f) => !r.allowed.includes(f)).map((f) => `--${f}`);
    out.push(`try: ${flags.length ? `${flags.join(', ')}, or ` : ''}brain whatif KEY --sprint M --slip --apply-plan to shift other tickets too`);
    return out;
  }
  const n = r.moves.length;
  out.push(`RELIEF: ${head} ${r.load}/${r.cap} -> ${r.after}/${r.cap} with ${n} move${n === 1 ? '' : 's'} (slip ${r.slip}, ${r.ownerChanges} owner change${r.ownerChanges === 1 ? '' : 's'})${r.searchComplete ? '' : ` (search budget ${r.budget} hit: not proven minimal)`}`);
  for (const m of r.moves.slice(0, limit)) out.push(`${key(m.key)} ${m.sp} SP: ${name(m.from.owner)} S${m.from.sprint} > ${name(m.to.owner)} S${m.to.sprint} | ${cmd(m) ?? '(no shell-safe command: a key or name has unsafe characters)'}`);
  if (n > limit) out.push(`... ${n - limit} more moves (-v for up to 100)`);
  out.push(r.order === 'sequential' ? '(dry run, nothing changed: to apply, the owner runs each command above in this order with --apply-plan --write, then brain export)'
    : '(dry run, nothing changed: no order passes brain whatif one move at a time; these moves only work together)');
  return out;
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
