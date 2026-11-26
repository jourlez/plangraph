// Safe reassignment: whatif (dry run), proposeMove (minimal repair search), relieve (fewest moves to bring one cell under cap), renderWhatif and renderRelieve (token-lean text).
// Pure functions over the model; nothing is mutated. Handoff rule: sprint[c] >= sprint[p] + (owner[c] !== owner[p] ? 1 : 0).
// Extra reason codes beyond the contract spec: OUT_OF_RANGE (sprint outside first_sprint..end_sprint), NO_REPAIR (proposeMove only).
// CAPACITY is a NEW violation only (as lib/verify.ts counts them): the target cell ends over its capacity AND the move added load to it, so a
// 0-SP ticket may move into a cell that is already over capacity (its load and its verify violation are unchanged).
// Gate and slot (0.5.0): BLOCKED (the moved ticket has an open held_by item or a verdict other than READY: a warning, a stop under opts.strict;
// the blocker rules of lib/graph/blockers.ts, order waits excluded since PRODUCER_LATE covers them) and SPRINT_CLOSED (the target sprint's
// state is closed, or its end is before opts.asOf: always a stop). Neither can be repaired by a move, so neither gets a suggestion. The
// `touches` line (touchesLine) is a bounded read-side note over trace and identity relations; it never changes a verdict.
// Frozen history (lib/frozen.ts): a link whose producer is closed is satisfied wherever the producer sits, so it never yields
// PRODUCER_LATE / CONSUMER_EARLY, never ripples and never needs a repair; the moved ticket itself is free, so every other link of it binds.
import { capacityFor, capacityAdvice } from './capacity.ts';
import type { Model, Placement, Ticket } from './model.ts';
import { verifyPlan } from './verify.ts';
import type { Violation } from './verify.ts';
import { isClosed, frozenTest } from './frozen.ts';
import { blockedRow, sprintIsClosed } from './graph/blockers.ts';
import { REL_SEMANTICS } from './graph/files.ts';
import type { NodeType } from './graph/files.ts';
import type { PlanRecord } from './model.ts';
import type { GraphReader, NodeRef, Rel } from './graph/views.ts';

/** A slot: owner and sprint. Model.sched rows may still hold a null owner or sprint; whatif reads them through SchedView as slots,
 * unchecked: such a value is compared and printed exactly as before (pre-existing). */
export interface Slot { owner: string; sprint: number }
type SchedView = ReadonlyMap<string, Slot>;
// Ripple.from, Move.from and FindResult.from are typed owner: string, but can hold a null owner (or sprint) copied from a validated
// schedule row (documented, pre-existing): a typed consumer that needs a real owner must test it.
/** A requested move: the ticket, the new owner (null or absent: keep) and the new sprint (null or absent: keep). */
export interface MoveRequest { key: string; to?: string | null; sprint?: number | null }
export interface WhatifOptions {
  people?: readonly string[] | undefined; allowOverflow?: boolean; overflowLimit?: number; frozen?: ReadonlyMap<string, Placement>; strict?: boolean; noSuggest?: boolean;
  allowSlip?: boolean; allowEarlier?: boolean; allowOwnerChange?: boolean; budget?: number; workLimit?: number;
  /** open-items register rows (the gate reads the open ones) and the as-of day (YYYY-MM-DD) for a sprint that ended */
  items?: readonly PlanRecord[]; asOf?: string;
}
/** whatif and proposeMove reason codes (OUT_OF_RANGE and NO_REPAIR beyond the contract spec, see the header). */
export type WhatifCode = 'UNKNOWN_TICKET' | 'UNKNOWN_PERSON' | 'OUT_OF_RANGE' | 'SAME_SLOT' | 'STARTED' | 'PRODUCER_LATE' | 'CONSUMER_EARLY' | 'CAPACITY' | 'NO_REPAIR' | 'BLOCKED' | 'SPRINT_CLOSED';
/** One reason, discriminated on its code; warn (a STARTED warning only) does not stop the move. */
export type WhatifReason = { [C in WhatifCode]: { code: C; key: string; detail: string; fix: string; warn?: boolean } }[WhatifCode];
export interface LoadCell { before: number; after: number; cap: number }
/** Per owner, per sprint: the load before and after the move. */
type Loads = Record<string, Record<string, LoadCell>>;
export interface Ripple { key: string; from: Slot; to: Slot; why: string }
export type Suggestion = { sprint: number; owner: string; shifts: number; ownerChanges: number; flags?: string[]; none?: never }
  | { none: true; sprint?: never; owner?: never; shifts?: never; ownerChanges?: never; flags?: never };
export interface WhatifResult {
  ok: boolean; reasons: WhatifReason[]; ripple: Ripple[]; load: Loads; started: boolean; suggestion: Suggestion | null;
  freed?: { owner: string; sprint: number; sp: number };
  /** advisory lines (a capacity row above the config value) */
  notes?: string[];
  /** the bounded `touches:` line, set by the caller (touchesLine) */
  touches?: string;
}
/** What renderWhatif reads: a whatif result, or a hand-built one with only these fields (load is read only when ok). */
export interface WhatifView {
  ok: boolean; reasons: ReadonlyArray<{ code: string; key: string; detail: string; fix?: string; warn?: boolean }>;
  ripple?: ReadonlyArray<{ key: string; to: { owner: string; sprint: number } }>; load?: Loads;
  freed?: { owner: string; sprint: number; sp: number }; notes?: readonly string[]; touches?: string | undefined; suggestion?: { none?: boolean; sprint?: number; owner?: string; shifts?: number; ownerChanges?: number; flags?: string[] } | null;
}
export interface Move { key: string; from: Slot; to: Slot }
export type ProposeResult = { ok: true; moves: Move[]; reasons: WhatifReason[]; shifted: number; ownerChanges: number; slipped: number; searchComplete: boolean; nodes: number }
  | { ok: false; moves: Move[]; reasons: WhatifReason[]; searchComplete?: boolean; nodes?: number; shifted?: never; ownerChanges?: never; slipped?: never };

/** The codes no move can repair (src/commands/plan.ts reads the same set). */
export const HARD = new Set(['UNKNOWN_TICKET', 'UNKNOWN_PERSON', 'SAME_SLOT', 'OUT_OF_RANGE', 'SPRINT_CLOSED']);
/** A reason no move can repair: a hard code, or a STARTED or BLOCKED that stops (not a warning). */
const stops = (r: { code: string; warn?: boolean | undefined }): boolean => HARD.has(r.code) || ((r.code === 'STARTED' || r.code === 'BLOCKED') && !r.warn);
const ISO_DAY = /^\d{4}-\d{2}-\d{2}/;
const spOf = (t: Ticket | undefined): number => (t && Number.isFinite(t.sp) ? t.sp as number : 0); // Number.isFinite is the check
const d = (a: unknown, b: unknown): number => (a !== b ? 1 : 0);
const cellKey = (o: unknown, s: unknown): string => `${o}\t${s}`;
const est = (s: string): number => Math.ceil(s.length / 4);
export { est as estTokens };

// Frozen tickets: ONE predicate, lib/frozen.ts frozenTest (closed, frozen_statuses as config lists them, opts.frozen, a current sprint below
// frozen_before_sprint), the same as verify and the solver. whatif's STARTED: closed, opts.frozen and frozen_before_sprint are a hard stop
// (history); a status in the warn set only warns (stops under opts.strict). proposeMove and relieve never move a frozen ticket.
/** The statuses that warn (STARTED, warn) when the ticket is not otherwise frozen: In Progress always (someone started it, whatever
 * frozen_statuses says: `plangraph init` writes ["Done"]), plus every status config.frozen_statuses lists. */
function warnSet(model: Model): Set<string> { const f = (model.config || {}).frozen_statuses; return new Set(['In Progress', ...(Array.isArray(f) ? f.filter((x) => typeof x === 'string') : [])]); } // f is typed string[] (PlanConfig) but unchecked: the filter keeps only strings

function people(model: Model, opts: { people?: readonly string[] | undefined }): string[] {
  const set = new Set(opts.people || []);
  for (const p of model.sched.values()) if (p.owner) set.add(p.owner);
  for (const k of Object.keys(((model.config || {}).caps) || {})) if (k !== 'default') set.add(k);
  return [...set].sort();
}

function cellLoads(model: Model): { loads: Map<string, number>; members: Map<string, string[]> } {
  const m = new Map<string, number>(), members = new Map<string, string[]>();
  for (const [k, p] of model.sched) {
    const t = model.tickets.get(k); if (!t) continue;
    const c = cellKey(p.owner, p.sprint);
    m.set(c, (m.get(c) || 0) + spOf(t));
    if (!members.has(c)) members.set(c, []);
    (members.get(c) as string[]).push(k); // set just above
  }
  for (const a of members.values()) a.sort();
  return { loads: m, members };
}

function range(model: Model, opts: { allowOverflow?: boolean; overflowLimit?: number }): { first: number; end: number; max: number } {
  const cfg = model.config || {};
  const first = cfg.first_sprint ?? 1;
  let used = 0; for (const p of (model.sched as SchedView).values()) if (p.sprint > used) used = p.sprint; // schedule rows are read as placed slots: a null owner or sprint is compared and printed as before (unchecked, pre-existing)
  const end = cfg.end_sprint ?? used;
  return { first, end, max: opts.allowOverflow ? end + (opts.overflowLimit ?? 12) : end };
}

// Resolve person name: exact, then unique case-insensitive, then a unique first name or name prefix; null when none or ambiguous.
// Exported: `plangraph ready --person` resolves its name the same way.
export function resolvePerson(model: Model, name: string, opts: { people?: readonly string[] | undefined } = {}): string | null {
  const ps = people(model, opts);
  if (ps.includes(name)) return name;
  const q = String(name).trim().toLowerCase();
  const m = ps.filter((p) => p.toLowerCase() === q);
  if (m.length === 1) return m[0] as string; // length checked on this line
  // a unique first name or name prefix ("Ana" for "Ana Diaz") is accepted; an ambiguous one is not guessed
  const pre = ps.filter((p) => { const l = p.toLowerCase(); return q && (l.startsWith(q + ' ') || l.split(/\s+/)[0] === q); });
  return pre.length === 1 ? pre[0] as string : null; // length checked on this line
}

export function whatif(model: Model, mv: MoveRequest, opts: WhatifOptions = {}): WhatifResult {
  const { key } = mv;
  const reasons: WhatifReason[] = [];
  const res: WhatifResult = { ok: false, reasons, ripple: [], load: {}, started: false, suggestion: null };
  const cur = (model.sched as SchedView).get(key), t = model.tickets.get(key); // schedule rows are read as placed slots: a null owner or sprint is compared and printed as before (unchecked, pre-existing)
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

  // Started tickets: closed, caller-frozen and frozen_before_sprint are a hard stop; a status of the warn set warns (stop under opts.strict).
  const status = t.jira_status, fb = (model.config || {}).frozen_before_sprint;
  if (isClosed(model, key)) { res.started = true; reasons.push({ code: 'STARTED', key, detail: String(key).startsWith('sp:') && t.impl_status === 'done' ? 'impl_status done' : `status ${status}`, fix: 'reopen first or leave it' }); }
  else if (opts.frozen && opts.frozen.has(key)) { res.started = true; reasons.push({ code: 'STARTED', key, detail: 'frozen by the caller', fix: 'leave it' }); }
  else if (Number.isFinite(fb) && Number.isInteger(cur.sprint) && cur.sprint < (fb as number)) { res.started = true; reasons.push({ code: 'STARTED', key, detail: `sprint ${cur.sprint} is before frozen_before_sprint ${fb}`, fix: 'it is history: leave it' }); } // fb: Number.isFinite is the check
  else if (status && warnSet(model).has(status)) {
    res.started = true;
    reasons.push({ code: 'STARTED', key, detail: `status ${status}`, fix: 'confirm with the assignee', ...(opts.strict ? {} : { warn: true }) });
  }

  // Slot: a target sprint that is closed, or whose end is before the as-of day.
  if (Number.isInteger(sprint)) {
    const row = (model.sprints ?? []).find((x) => Number(x.n) === sprint), end = typeof row?.end === 'string' && ISO_DAY.test(row.end) ? row.end.slice(0, 10) : null;
    if (sprintIsClosed(model, sprint)) reasons.push({ code: 'SPRINT_CLOSED', key: `S${sprint}`, detail: `S${sprint} is closed`, fix: 'pick an open sprint' });
    else if (end && opts.asOf && ISO_DAY.test(opts.asOf) && end < opts.asOf.slice(0, 10)) reasons.push({ code: 'SPRINT_CLOSED', key: `S${sprint}`, detail: `S${sprint} ended ${end}`, fix: 'pick a sprint that has not ended' });
  }
  // Gate: an open held_by item or a verdict other than READY on the moved ticket (producers still waiting are PRODUCER_LATE's business).
  const blocked = blockedRow(model, key, sprint, { items: opts.items ?? [], frozen: frozenTest(model, opts.frozen ? { frozen: opts.frozen } : {}) });
  if (blocked) reasons.push({ code: 'BLOCKED', key, detail: blocked.detail, fix: 'clear it first, or move it knowingly', ...(opts.strict ? {} : { warn: true }) });

  // A self-link (key needs key) is read through P on both ends: the moved ticket's NEW slot, so it never yields a phantom reason.
  const P = (k: string): Slot | undefined => (k === key ? { owner, sprint } : (model.sched as SchedView).get(k)); // schedule rows are read as placed slots: a null owner or sprint is compared and printed as before (unchecked, pre-existing)
  for (const p of model.prods.get(key) || []) {
    const pp = P(p); if (!pp || !model.tickets.has(p) || isClosed(model, p)) continue;
    const dd = d(pp.owner, owner), need = pp.sprint + dd;
    if (sprint < need) reasons.push({ code: 'PRODUCER_LATE', key: p, detail: `S${pp.sprint} ${pp.owner}, needs S${sprint - dd}${dd ? ' for handoff' : ''}`, fix: `move ${key} to S${need}+ or give it to ${pp.owner} from S${pp.sprint}` });
  }
  for (const c of isClosed(model, key) ? [] : model.cons.get(key) || []) {
    const cc = P(c); if (!cc || !model.tickets.has(c)) continue;
    const dd = d(owner, cc.owner), need = sprint + dd;
    if (cc.sprint < need) reasons.push({ code: 'CONSUMER_EARLY', key: c, detail: `S${cc.sprint} ${cc.owner}, needs S${need}`, fix: `move ${c} to S${need}+ or ${key} to <=S${cc.sprint - dd}` });
  }

  // Capacity and load bookkeeping.
  const { loads } = cellLoads(model);
  const sp = spOf(t), oc = cellKey(cur.owner, cur.sprint), nc = cellKey(owner, sprint);
  const entry = (o: string, s: number, before: number, after: number) => { (res.load[o] ||= {})[s] = { before, after, cap: capacityFor(o, s, model.capacity ?? [], model.config) }; };
  entry(cur.owner, cur.sprint, loads.get(oc) || 0, (loads.get(oc) || 0) - sp);
  const nb = loads.get(nc) || 0, na = nb + sp;
  entry(owner, sprint, nb, na);
  res.freed = { owner: cur.owner, sprint: cur.sprint, sp };
  const cap = capacityFor(owner, sprint, model.capacity ?? [], model.config), advice = capacityAdvice(owner, sprint, model.capacity ?? [], model.config);
  if (advice) res.notes = [advice];
  if (na > cap && na > nb) { // a move that adds no load (0 SP) leaves an existing overload as it was: no new violation
    let alt: number | null = null;
    for (let s = Math.max(sprint, first); s <= range(model, opts).max; s++) if (s !== sprint && (loads.get(cellKey(owner, s)) || 0) + sp <= cap) { alt = s; break; }
    reasons.push({ code: 'CAPACITY', key: `${owner} S${sprint}`, detail: `${na}/${cap}`, fix: alt ? `${owner} has room in S${alt}` : `${owner} has no room through S${range(model, opts).max}` });
  }

  // Naive forward ripple (capacity ignored): the moved ticket, then consumers that would have to shift later. The request itself is
  // fixed (a link back to it, a loop, never re-places it), and no shift goes past sprint + ticket count: an acyclic cascade never needs
  // more (each hop adds at most 1), so only a loop stops there, instead of climbing to the step guard.
  const rip = new Map<string, Ripple>([[key, { key, from: { owner: cur.owner, sprint: cur.sprint }, to: { owner, sprint }, why: 'requested' }]]);
  const q = [key]; let guard = 0;
  while (q.length && guard++ < 100000) {
    const x = q.shift() as string, px = (P(x) && rip.has(x) ? (rip.get(x) as Ripple).to : model.sched.get(x)) as Slot; // q.length was tested; every queued key is in rip (set before its push)
    for (const c of isClosed(model, x) ? [] : model.cons.get(x) || []) {
      if (c === key) continue;
      const cc = (model.sched as SchedView).get(c); if (!cc || !model.tickets.has(c)) continue; // schedule rows are read as placed slots: a null owner or sprint is compared and printed as before (unchecked, pre-existing)
      const need = px.sprint + d(px.owner, cc.owner);
      const prev = rip.get(c)?.to.sprint ?? cc.sprint;
      if (prev < need && need <= sprint + model.tickets.size) { rip.set(c, { key: c, from: { owner: cc.owner, sprint: cc.sprint }, to: { owner: cc.owner, sprint: need }, why: `consumer of ${x} needs S${need}` }); q.push(c); }
    }
  }
  res.ripple = [...rip.values()];

  res.ok = !reasons.some((r) => !r.warn);
  if (!res.ok && !opts.noSuggest && !reasons.some(stops)) {
    const pm = proposeMove(model, mv, { ...opts, allowSlip: true, noSuggest: true });
    // flags: what applying the repair needs beyond the caller's own options (the search allowed slip; the user may not have)
    if (pm.ok) res.suggestion = { sprint: (pm.moves[0] as Move).to.sprint, owner: (pm.moves[0] as Move).to.owner, shifts: pm.moves.length - 1, ownerChanges: pm.moves.slice(1).filter((m) => m.from.owner !== m.to.owner).length, ...(pm.slipped > 0 && !opts.allowSlip ? { flags: ['slip'] } : {}) }; // an ok proposeMove has at least the requested move
    else res.suggestion = { none: true };
  }
  return res;
}

// ---- proposeMove: best-first search over single-ticket moves, cost = (slip of the requested ticket, other tickets moved, steps). ----
class Heap<T extends { pr: number[]; id: number }> {
  declare a: T[];
  constructor() { this.a = []; }
  get size(): number { return this.a.length; }
  less(x: T, y: T): boolean { for (let i = 0; i < x.pr.length; i++) if (x.pr[i] !== y.pr[i]) return (x.pr[i] as number) < (y.pr[i] as number); return x.id < y.id; } // i < x.pr.length, and one search pushes priority tuples of one length
  push(n: T): void { const a = this.a; a.push(n); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (!this.less(a[i] as T, a[p] as T)) break; [a[i], a[p]] = [a[p] as T, a[i] as T]; i = p; } } // 0 <= p < i < a.length
  pop(): T { const a = this.a, top = a[0], last = a.pop(); if (a.length) { a[0] = last as T; let i = 0; for (;;) { let m = i; const l = 2 * i + 1, r = l + 1; if (l < a.length && this.less(a[l] as T, a[m] as T)) m = l; if (r < a.length && this.less(a[r] as T, a[m] as T)) m = r; if (m === i) break; [a[i], a[m]] = [a[m] as T, a[i] as T]; i = m; } } return top as T; } // a[0] = last: a was not empty, so something was popped; i, m, l, r < a.length (tested); the one caller pops only while size > 0
}

/** An overlay: the tickets moved so far, key -> new slot. */
type Ov = Map<string, Slot>;
/** A violation of a candidate overlay: a broken handoff (producer p, consumer c) or a cell over capacity. */
type OvViolation = { t: 'H'; p: string; c: string } | { t: 'C'; owner: string; sprint: number; load: number; cap: number; delta: Map<string, number> };
/** One repair option: move ticket k to owner o, sprint s. */
interface MoveOption { k: string; o: string; s: number }
/** A closure that is not a dead end: a goal, or (goal false) a branching point with its violation v and options os. */
interface OpenClosure { dead?: undefined; ov: Ov; goal: boolean; vs: OvViolation[]; v?: OvViolation; os?: MoveOption[] }
type Closure = { dead: true; over?: true } | OpenClosure;
interface SearchNode { pr: number[]; id: number; c: OpenClosure; steps: number }
type RunResult = { exhausted: true; pops: number; ov?: never; complete?: never; infeasible?: never } | { ov: Ov; pops: number; complete: boolean; exhausted?: never; infeasible?: never }
  | { infeasible: true; pops: number; ov?: never; complete?: never; exhausted?: never };
export function proposeMove(model: Model, mv: MoveRequest, opts: WhatifOptions = {}): ProposeResult {
  const w = whatif(model, mv, { ...opts, noSuggest: true });
  const hard = w.reasons.filter(stops);
  if (hard.length) return { ok: false, moves: [], reasons: hard };
  const { key } = mv, cur = (model.sched as SchedView).get(key) as Slot; // whatif found it (no UNKNOWN_TICKET above); schedule rows are read as placed slots (unchecked, pre-existing)
  const owner = (w.ripple[0] as Ripple).to.owner, sprint = (w.ripple[0] as Ripple).to.sprint; // whatif returns an empty ripple only with a HARD reason (UNKNOWN_TICKET, SAME_SLOT), handled above
  const tgt = { owner, sprint };
  if (w.ok) return { ok: true, moves: [{ key, from: { ...cur }, to: tgt }], reasons: [], shifted: 0, ownerChanges: 0, slipped: 0, searchComplete: true, nodes: 0 };

  const cfg = model.config || {}, { first, max } = range(model, opts);
  const fz = frozenTest(model, opts);
  const pinned = (k: string): boolean => k !== key && fz(k);
  const base = model.sched as SchedView; // schedule rows are read as placed slots (unchecked, pre-existing)
  const ppl = people(model, opts);
  const { loads: baseLoads, members: baseMembers } = cellLoads(model);
  const budget = opts.budget ?? 20000;

  const PL = (ov: Ov, k: string): Slot => ov.get(k) ?? base.get(k) as Slot; // only placed tickets (okTk, the overlay's keys) are read
  const okTk = (k: string): boolean => model.tickets.has(k) && base.has(k);

  function violations(ov: Ov): OvViolation[] {
    const edges = new Map<string, [string, string]>();
    for (const x of ov.keys()) {
      for (const p of model.prods.get(x) || []) if (okTk(p) && !isClosed(model, p)) edges.set(`${p}\t${x}`, [p, x]);
      if (!isClosed(model, x)) for (const c of model.cons.get(x) || []) if (okTk(c)) edges.set(`${x}\t${c}`, [x, c]);
    }
    const out: OvViolation[] = [];
    for (const k of [...edges.keys()].sort()) {
      const [p, c] = edges.get(k) as [string, string], pp = PL(ov, p), pc = PL(ov, c); // k is one of edges' keys
      if (pc.sprint < pp.sprint + d(pp.owner, pc.owner)) out.push({ t: 'H', p, c });
    }
    const delta = new Map<string, number>();
    for (const [k, v] of ov) { const b = base.get(k) as Slot, sp = spOf(model.tickets.get(k)); delta.set(cellKey(b.owner, b.sprint), (delta.get(cellKey(b.owner, b.sprint)) || 0) - sp); delta.set(cellKey(v.owner, v.sprint), (delta.get(cellKey(v.owner, v.sprint)) || 0) + sp); } // the overlay holds only placed tickets
    for (const c of [...delta.keys()].sort()) {
      const dl = delta.get(c) as number; if (dl <= 0) continue; // c is one of delta's keys
      const [o, s] = c.split('\t') as [string, string], load = (baseLoads.get(c) || 0) + dl, cap = capacityFor(o, Number(s), model.capacity ?? [], cfg); // c was built by cellKey(owner, sprint)
      if (load > cap) out.push({ t: 'C', owner: o, sprint: Number(s), load, cap, delta });
    }
    return out;
  }

  const movable = (k: string): boolean => !pinned(k);
  // An option is {k, owner?, sprint?}. The requested ticket may only slip later (never change owner) and only with allowSlip.
  const canMove = (k: string, o: string, s: number, ov: Ov): boolean => {
    if (!movable(k)) return false;
    const cur2 = PL(ov, k);
    // Slipping an earlier request must stay before the current slot (same owner): reaching it again is no move.
    if (k === key) return !!opts.allowSlip && o === cur2.owner && s > cur2.sprint && s <= max && !(o === cur.owner && sprint < cur.sprint && s >= cur.sprint);
    return s >= first && s <= max && (o === cur2.owner || !!opts.allowOwnerChange);
  };
  // Without allowEarlier a ticket never ends before its base sprint; with it, it may. The requested ticket is exempt: the request itself may
  // be earlier than its base sprint, and canMove already bounds its slip.
  const optsFor = (v: OvViolation, ov: Ov): MoveOption[] => {
    const out: MoveOption[] = [];
    const push = (k: string, o: string, s: number) => {
      if (canMove(k, o, s, ov) && (opts.allowEarlier || k === key || s >= (base.get(k) as Slot).sprint)) out.push({ k, o, s }); // canMove read k's slot: it is placed
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
  const apply = (ov: Ov, o: MoveOption): Ov => {
    const n = new Map(ov), b = base.get(o.k) as Slot; // an option only names a placed ticket
    if (o.o === b.owner && o.s === b.sprint && o.k !== key) n.delete(o.k); else n.set(o.k, { owner: o.o, sprint: o.s });
    return n;
  };
  const ser = (ov: Ov): string => [...ov].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}:${v.owner}:${v.sprint}`).join('|');
  // Closure: apply forced moves (violations with exactly one repair) until a branching point, goal or dead end.
  let work = 0; const workLimit = opts.workLimit ?? 60000; // violation scans; bounds total effort independent of the node budget
  const closure = (ov: Ov): Closure => {
    const loop = new Set<string>(); // a forced-move cycle means no repair is reachable down this path
    for (let i = 0; i < 100000; i++) {
      const sid = ser(ov); if (loop.has(sid)) return { dead: true }; loop.add(sid);
      if (++work > workLimit) return { dead: true, over: true };
      const vs = violations(ov);
      if (!vs.length) return { ov, goal: true, vs };
      const v = vs.find((x) => x.t === 'H') || vs[0] as OvViolation, os = optsFor(v, ov); // vs is not empty (returned above)
      if (!os.length) return { dead: true };
      if (os.length === 1) { ov = apply(ov, os[0] as MoveOption); continue; } // length checked on this line
      return { ov, goal: false, vs, v, os };
    }
    return { dead: true };
  };
  const metrics = (ov: Ov, steps: number, nv: number) => {
    const slip = (ov.get(key)?.sprint ?? sprint) - sprint;
    let moved = 0; for (const k of ov.keys()) if (k !== key) moved++;
    return { slip, moved, steps, nv };
  };

  function run(greedy: boolean): RunResult {
    const heap = new Heap<SearchNode>(), seen = new Set<string>(); let id = 0, pops = 0; work = 0;
    const seed = new Map([[key, tgt]]);
    const push = (ov: Ov, steps: number) => {
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
      for (const o of n.c.os as MoveOption[]) push(apply(n.c.ov, o), n.steps + 1); // not a goal: a branching point, which carries its options
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
  const moves: Move[] = [{ key, from: { ...cur }, to: { ...(r.ov.get(key) as Slot) } }]; // the seed overlay holds key, and closures only add keys
  for (const k of [...r.ov.keys()].filter((x) => x !== key).sort()) moves.push({ key: k, from: { ...(base.get(k) as Slot) }, to: { ...(r.ov.get(k) as Slot) } }); // k is an overlay key: a placed ticket
  return { ok: true, moves, reasons: [], shifted: moves.length - 1, ownerChanges: moves.filter((m) => m.from.owner !== m.to.owner && m.key !== key).length, slipped: (moves[0] as Move).to.sprint - sprint, searchComplete: !approx && r.complete, nodes: r.pops }; // moves was created with the requested move
}

// Internal safety net: the repaired plan must introduce no violation that the base plan did not already have.
export function assertPlanValid(model: Model, plan: ReadonlyMap<string, Placement>, opts: WhatifOptions, pinned: (k: string) => boolean): void {
  const fro = new Map<string, Placement>(); for (const [k, p] of model.sched) if (pinned(k)) fro.set(k, p);
  const sig = (v: Violation) => `${v.code}|${v.key}|${v.detail}`;
  const before = verifyPlan(model, model.sched, {}), after = verifyPlan(model, plan, { frozen: fro });
  const baseSet = new Set(before.map(sig)), baseCap = new Map(before.filter((v) => v.code === 'CAPACITY').map((v): [string, number] => [v.key, parseInt(v.detail, 10)]));
  const bad = after.filter((v) => !baseSet.has(sig(v)) && !(v.code === 'CAPACITY' && baseCap.has(v.key) && parseInt(v.detail, 10) <= (baseCap.get(v.key) as number))); // has() was just tested
  if (bad.length) throw new Error(`proposeMove produced an invalid plan: ${bad.slice(0, 3).map(sig).join('; ')}`);
}

// Apply a set of moves (from proposeMove) to a schedule copy.
export function applyMoves(sched: ReadonlyMap<string, Placement>, moves: ReadonlyArray<{ key: string; to: Slot }>): Map<string, Placement> {
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
export interface RelieveOptions { allowEarlier?: boolean; allowOwnerChange?: boolean; budget?: number }
export interface RelieveMove { key: string; sp: number; from: Slot; to: Slot }
/** Why no relief: per-candidate exclusion codes, or a whole-cell reason with its numbers. */
export type RelieveReason = { code: 'FROZEN' | 'NO_SLOT' | 'LINKS' | 'FULL' | 'CONFLICT'; keys: string[] } | { code: 'NOT_ENOUGH'; keys: string[]; freeable: number; needed: number }
  | { code: 'NO_ROOM'; keys: string[]; room: number; needed: number };
export interface RelieveResult {
  person: string; sprint: number; first: number; load: number; cap: number; after: number; status: 'none_needed' | 'no_relief' | 'relief'; moves: RelieveMove[];
  slip: number; ownerChanges: number; order: 'sequential' | 'together' | null; searchComplete: boolean; nodes: number; budget: number; allowed: string[];
  excluded: Array<{ key: string; code: 'FROZEN' }>; reasons: RelieveReason[]; frozenLoad?: number;
}
/** A slot a cell ticket may move to, with its slip and owner change (0 or 1). */
interface GoodSlot extends Slot { slip: number; oc: number }
interface Candidate { key: string; sp: number; slots: GoodSlot[]; minSlip: number }
interface Relief { moves: RelieveMove[]; slip: number; oc: number }
export function relieve(model: Model, { person, sprint }: { person: string; sprint: number }, opts: RelieveOptions = {}): RelieveResult {
  const cfg = model.config || {}, cap = capacityFor(person, sprint, model.capacity ?? [], cfg), { first, end } = range(model, {}), budget = opts.budget ?? RELIEVE_BUDGET;
  const allowed = ['later', ...(opts.allowEarlier ? ['earlier'] : []), ...(opts.allowOwnerChange ? ['owner-change'] : [])];
  const cell: string[] = [];
  for (const [k, p] of model.sched) if (model.tickets.has(k) && p && p.owner === person && p.sprint === sprint) cell.push(k);
  cell.sort();
  const load = cell.reduce((a, k) => a + spOf(model.tickets.get(k)), 0);
  const res: RelieveResult = { person, sprint, first, load, cap, after: load, status: 'none_needed', moves: [], slip: 0, ownerChanges: 0, order: null, searchComplete: true, nodes: 0, budget, allowed, excluded: [], reasons: [] };
  const pinned = frozenTest(model);
  // frozen history: the frozen load stays; only the free load must fit in max(0, cap - frozen load), so a cell over cap by frozen tickets
  // alone needs no relief, and with the frozen load at or above cap every free story point must leave
  const stayLoad = cell.reduce((a, k) => a + (pinned(k) ? spOf(model.tickets.get(k)) : 0), 0), freeLoad = load - stayLoad;
  const excess = stayLoad >= cap ? cell.reduce((a, k) => a + (pinned(k) ? 0 : spOf(model.tickets.get(k))), 0) : load - cap;
  res.frozenLoad = stayLoad;
  if (!(load > cap) || !(excess > 0) || !(freeLoad > 0)) return res;
  const inCell = new Set(cell), { loads } = cellLoads(model), stays = new Set(cell.filter(pinned));
  const free = (k: string): boolean => inCell.has(k) && !stays.has(k); // a cell ticket that may move: its links are checked inside the search
  const placed = (k: string): Slot | null => { const p = model.sched.get(k); return model.tickets.has(k) && p && typeof p.owner === 'string' && p.owner !== '' && Number.isInteger(p.sprint) ? p as Slot : null; }; // Number.isInteger is the sprint check
  const okLink = (pp: Slot, pc: Slot): boolean => pc.sprint >= pp.sprint + d(pp.owner, pc.owner);
  const closedP = (p: string): boolean => isClosed(model, p); // a closed producer satisfies its links wherever it sits
  // per candidate: its slots that pass the links to tickets outside the cell and the capacity of the target cell alone
  const cands: Candidate[] = [], why: Record<'FROZEN' | 'NO_SLOT' | 'LINKS' | 'FULL', string[]> = { FROZEN: [], NO_SLOT: [], LINKS: [], FULL: [] };
  for (const k of cell) {
    if (pinned(k)) { res.excluded.push({ key: k, code: 'FROZEN' }); why.FROZEN.push(k); continue; }
    const sp = spOf(model.tickets.get(k)), slots: Slot[] = [];
    const owners = [person, ...(opts.allowOwnerChange ? people(model, {}).filter((q) => q !== person) : [])];
    for (const o of owners) for (let s = first; s <= end; s++) {
      if ((o === person && s === sprint) || (s < sprint && !opts.allowEarlier)) continue;
      slots.push({ owner: o, sprint: s });
    }
    let linkOk = 0; const good: GoodSlot[] = [];
    for (const to of slots) {
      let ok = true;
      for (const p of model.prods.get(k) || []) { if (p === k || free(p) || closedP(p)) continue; const pp = placed(p); if (pp && !okLink(pp, to)) { ok = false; break; } }
      if (ok && !closedP(k)) for (const c of model.cons.get(k) || []) { if (c === k || free(c)) continue; const pc = placed(c); if (pc && !okLink(to, pc)) { ok = false; break; } }
      if (!ok) continue;
      linkOk++;
      if ((loads.get(cellKey(to.owner, to.sprint)) || 0) + sp > capacityFor(to.owner, to.sprint, model.capacity ?? [], cfg)) continue;
      good.push({ ...to, slip: Math.abs(to.sprint - sprint), oc: d(to.owner, person) });
    }
    good.sort((a, b) => a.slip - b.slip || a.oc - b.oc || (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0) || a.sprint - b.sprint);
    if (!good.length) { why[!slots.length ? 'NO_SLOT' : !linkOk ? 'LINKS' : 'FULL'].push(k); continue; }
    cands.push({ key: k, sp, slots: good, minSlip: (good[0] as GoodSlot).slip }); // good is not empty (continued above)
  }
  // links between two tickets of the cell: checked once both ends are known (a ticket of the cell that does not move stays at (person, N))
  const intra = new Map(cands.map((c): [string, Array<{ p: string; c: string }>] => [c.key, []]));
  const consIn = new Map(cell.map((k): [string, string[]] => [k, []])); // the cell consumers of each cell ticket
  for (const c of cell) for (const p of model.prods.get(c) || []) {
    if (!inCell.has(p) || p === c || closedP(p)) continue;
    (consIn.get(p) as string[]).push(c); // p is in the cell: consIn has every cell ticket
    if (intra.has(c)) (intra.get(c) as Array<{ p: string; c: string }>).push({ p, c }); if (intra.has(p)) (intra.get(p) as Array<{ p: string; c: string }>).push({ p, c }); // has() was just tested
  }
  const freeable = cands.reduce((a, c) => a + c.sp, 0);
  let best = null as Relief | null, nodes = 0, hit = false; // `as`: best is set inside the search closures, which narrowing does not follow
  const better = (x: Relief, y: Relief | null): boolean => {
    if (!y) return true;
    if (x.slip !== y.slip) return x.slip < y.slip;
    if (x.oc !== y.oc) return x.oc < y.oc;
    for (let i = 0; i < x.moves.length; i++) {
      const a = x.moves[i] as RelieveMove, b = y.moves[i] as RelieveMove; // i < x.moves.length; both come from subsets of one size k (the size loop stops at the first k with a result)
      if (a.key !== b.key) return a.key < b.key;
      if (a.to.owner !== b.to.owner) return a.to.owner < b.to.owner;
      if (a.to.sprint !== b.to.sprint) return a.to.sprint < b.to.sprint;
    }
    return false;
  };
  const home: Slot = { owner: person, sprint };
  function assign(sub: Map<string, Candidate>): void {
    const at = new Map<string, GoodSlot>(), add = new Map<string, number>();
    const where = (k: string): Slot | null => at.get(k) ?? (inCell.has(k) ? (sub.has(k) ? null : home) : null);
    const list = [...sub.values()], byKey = list.slice().sort((a, b) => (a.key < b.key ? -1 : 1));
    const minRest: number[] = []; for (let i = list.length - 1, m = 0; i >= 0; i--) { m += (list[i] as Candidate).minSlip; minRest[i] = m; } // 0 <= i < list.length
    const dfs = (i: number, slip: number, oc: number): void => {
      if (hit) return;
      if (best && best.moves.length === list.length && (slip + (minRest[i] ?? 0) > best.slip || (slip + (minRest[i] ?? 0) === best.slip && oc > best.oc))) return;
      if (i === list.length) {
        const moves = byKey.map((c) => ({ key: c.key, sp: c.sp, from: { ...home }, to: { owner: (at.get(c.key) as GoodSlot).owner, sprint: (at.get(c.key) as GoodSlot).sprint } })); // every ticket of list got its slot on the way down
        const cand = { moves, slip, oc };
        if (better(cand, best)) best = cand;
        return;
      }
      const c = list[i] as Candidate; // i < list.length: i === list.length returned above
      for (const to of c.slots) {
        if (++nodes > budget) { hit = true; return; }
        const ck = cellKey(to.owner, to.sprint), cur = (loads.get(ck) || 0) + (add.get(ck) || 0) + c.sp;
        if (cur > capacityFor(to.owner, to.sprint, model.capacity ?? [], cfg)) continue;
        at.set(c.key, to);
        let ok = true;
        for (const e of intra.get(c.key) as Array<{ p: string; c: string }>) { const pp = where(e.p), pc = where(e.c); if (pp && pc && !okLink(pp, pc)) { ok = false; break; } } // intra has every candidate
        if (ok) { add.set(ck, (add.get(ck) || 0) + c.sp); dfs(i + 1, slip + to.slip, oc + to.oc); add.set(ck, (add.get(ck) as number) - c.sp); } // set at the start of this block
        at.delete(c.key);
        if (hit) return;
      }
    };
    dfs(0, 0, 0);
  }
  // subsets by size, from the fewest tickets that could free the excess (largest points first); a subset is searched only when it frees at
  // least the excess and, without allowEarlier, holds every cell consumer of each ticket in it (a ticket that leaves for a later sprint or
  // another owner breaks the link to a consumer that stays). Every subset step and every slot try counts against the budget.
  const bySp = cands.slice().sort((a, b) => b.sp - a.sp || (a.key < b.key ? -1 : 1)), pre: number[] = [0];
  for (const c of bySp) pre.push((pre[pre.length - 1] as number) + c.sp); // pre starts with one entry and only grows
  const closed = (pick: Candidate[]) => opts.allowEarlier || pick.every((c) => (consIn.get(c.key) as string[]).every((y) => pick.some((q) => q.key === y))); // consIn has every cell ticket
  if (freeable >= excess) {
    let kmin = 1; while ((pre[kmin] as number) < excess) kmin++; // pre[bySp.length] = freeable >= excess > 0, so kmin stops at bySp.length at most
    for (let k = kmin; k <= bySp.length && !best && !hit; k++) {
      const pick: Candidate[] = [];
      const comb = (start: number, sum: number): void => {
        if (hit) return;
        if (++nodes > budget) { hit = true; return; }
        if (pick.length === k) { if (sum >= excess && closed(pick)) assign(new Map(pick.map((c) => [c.key, c]))); return; }
        const need = k - pick.length;
        for (let i = start; i <= bySp.length - need; i++) {
          if (sum + (pre[i + need] as number) - (pre[i] as number) < excess) return; // the largest remaining tickets cannot reach the excess; later ones are smaller; i + need <= bySp.length < pre.length
          pick.push(bySp[i] as Candidate); comb(i + 1, sum + (bySp[i] as Candidate).sp); pick.pop(); // need >= 1, so i < bySp.length
          if (hit) return;
        }
      };
      comb(0, 0);
    }
  }
  res.nodes = Math.min(nodes, budget); res.searchComplete = !hit;
  if (!best) {
    res.status = 'no_relief';
    for (const code of ['FROZEN', 'NO_SLOT', 'LINKS', 'FULL'] as const) if (why[code].length) res.reasons.push({ code, keys: why[code] }); // literal codes of RelieveReason
    if (!hit && freeable < excess) res.reasons.push({ code: 'NOT_ENOUGH', keys: [], freeable, needed: excess });
    else if (!hit) {
      // every candidate fits somewhere alone; when the target cells together have less room than the excess, say so (an upper bound on what
      // the moves could free: room per distinct target cell, max(0, cap - load))
      const targets = new Map<string, number>();
      for (const c of cands) for (const to of c.slots) targets.set(cellKey(to.owner, to.sprint), Math.max(0, capacityFor(to.owner, to.sprint, model.capacity ?? [], cfg) - (loads.get(cellKey(to.owner, to.sprint)) || 0)));
      const room = [...targets.values()].reduce((a, v) => a + v, 0);
      res.reasons.push(room < excess ? { code: 'NO_ROOM', keys: cands.map((c) => c.key), room, needed: excess } : { code: 'CONFLICT', keys: cands.map((c) => c.key) });
    }
    return res;
  }
  // the internal safety net: applied together, verifyPlan finds nothing new (every violation after was there before, byte for byte)
  const sched = applyMoves(model.sched, best.moves), sig = (v: Violation) => `${v.code}|${v.key}|${v.detail}`;
  const was = new Map<string, number>(); for (const v of verifyPlan(model, model.sched, {})) was.set(sig(v), (was.get(sig(v)) || 0) + 1);
  for (const v of verifyPlan(model, sched, {})) { const n = was.get(sig(v)) || 0; if (!n) throw new Error(`relieve produced an invalid plan: ${sig(v)}`); was.set(sig(v), n - 1); }
  // apply order: repeatedly the first remaining move (key order) that whatif() accepts alone on the plan so far
  let rest = best.moves.slice(), cur = model.sched; const ordered: RelieveMove[] = [];
  while (rest.length) {
    const i = rest.findIndex((m) => whatif({ ...model, sched: cur }, { key: m.key, ...(m.to.owner !== person ? { to: m.to.owner } : {}), sprint: m.to.sprint }, { noSuggest: true }).ok);
    if (i < 0) break;
    ordered.push(rest[i] as RelieveMove); cur = applyMoves(cur, [rest[i] as RelieveMove]); rest = rest.filter((_, j) => j !== i); // findIndex found i >= 0
  }
  Object.assign(res, { status: 'relief', after: load - best.moves.reduce((a, m) => a + m.sp, 0), slip: best.slip, ownerChanges: best.oc, order: rest.length ? 'together' : 'sequential', moves: rest.length ? best.moves : ordered });
  return res;
}

// ---- findSlots: every (owner, sprint) slot one ticket may move to with NO violation anywhere (`plangraph whatif KEY --find`, read-only). ----
// Slot space (relieve's move space for one ticket): the same owner in every later sprint (always); an earlier sprint with opts.allowEarlier;
// every other person (an owner or a caps person) with opts.allowOwnerChange, in the current sprint or later (earlier too with both);
// sprints first_sprint..end_sprint; --slip is implied. A slot is VALID when whatif() says ok (a STARTED warning keeps it valid, marked warn;
// opts.strict turns it into a stop) and, applied to a copy, verifyPlan finds nothing it did not already find (every violation after was
// there before; a CAPACITY cell may only get lighter): an internal error otherwise. Ranked by slip |to sprint - current sprint|, then the
// same owner first, then the least load on the target cell, then owner name, then sprint. At most FIND_MAX slots are tried (searchComplete
// false beyond). reasons: for the slots that are not valid, how many fail each blocking whatif code (a slot counts under each of its codes).
// A ticket whatif stops with STARTED (closed, frozen; a started one under strict) has no slot: status 'frozen', after one try.
export const FIND_MAX = 5000;
export interface FindOptions { allowEarlier?: boolean; allowOwnerChange?: boolean; strict?: boolean; people?: readonly string[]; max?: number; items?: readonly PlanRecord[]; asOf?: string }
export interface FoundSlot { owner: string; sprint: number; slip: number; sameOwner: boolean; load: number; cap: number; warn: boolean }
/** from is null only for status unknown (the ticket is not in the plan). */
export interface FindResult {
  key: string; from: Slot | null; status: 'unknown' | 'frozen' | 'found' | 'none'; tried: number; valid: number; slots: FoundSlot[]; reasons: Record<string, number>;
  allowed: string[]; searchComplete: boolean; first?: number; frozen?: string;
}
export function findSlots(model: Model, key: string, opts: FindOptions = {}): FindResult {
  const cur = (model.sched as SchedView).get(key), t = model.tickets.get(key), max = opts.max ?? FIND_MAX; // schedule rows are read as placed slots (unchecked, pre-existing)
  const allowed = ['later', ...(opts.allowEarlier ? ['earlier'] : []), ...(opts.allowOwnerChange ? ['owner-change'] : [])];
  const res: FindResult = { key, from: null, status: 'unknown', tried: 0, valid: 0, slots: [], reasons: {}, allowed, searchComplete: true };
  if (!cur || !t) return res;
  res.from = { owner: cur.owner, sprint: cur.sprint };
  const { first, end } = range(model, {}), { loads } = cellLoads(model);
  res.first = first;
  const owners = [cur.owner, ...(opts.allowOwnerChange ? people(model, opts).filter((q) => q !== cur.owner) : [])];
  const sig = (v: Violation) => `${v.code}|${v.key}|${v.detail}`, before = verifyPlan(model, model.sched, {});
  const was = new Set(before.map(sig)), wasCap = new Map(before.filter((v) => v.code === 'CAPACITY').map((v): [string, number] => [v.key, parseFloat(v.detail)]));
  const list: FoundSlot[] = [];
  outer: for (const o of owners) for (let s = first; s <= end; s++) {
    if (o === cur.owner && s <= cur.sprint && !(opts.allowEarlier && s < cur.sprint)) continue; // same owner: later, or earlier with --earlier
    if (o !== cur.owner && s < cur.sprint && !opts.allowEarlier) continue;
    if (res.tried >= max) { res.searchComplete = false; break outer; }
    res.tried++;
    const w = whatif(model, { key, to: o, sprint: s }, { strict: !!opts.strict, people: opts.people, noSuggest: true, ...(opts.items ? { items: opts.items } : {}), ...(opts.asOf ? { asOf: opts.asOf } : {}) });
    const stop = w.reasons.find((r) => r.code === 'STARTED' && !r.warn);
    if (stop) { res.frozen = stop.detail; break outer; } // a frozen (or, under strict, started) ticket keeps its slot: no slot can be valid
    if (!w.ok) { for (const c of new Set(w.reasons.filter((r) => !r.warn).map((r) => r.code))) res.reasons[c] = (res.reasons[c] || 0) + 1; continue; }
    const after = verifyPlan(model, applyMoves(model.sched, [{ key, to: { owner: o, sprint: s } }]), {});
    const bad = after.filter((v) => !was.has(sig(v)) && !(v.code === 'CAPACITY' && wasCap.has(v.key) && parseFloat(v.detail) <= (wasCap.get(v.key) as number))); // has() was just tested
    if (bad.length) throw new Error(`findSlots produced an invalid slot: ${bad.slice(0, 3).map(sig).join('; ')}`);
    list.push({ owner: o, sprint: s, slip: Math.abs(s - cur.sprint), sameOwner: o === cur.owner, load: loads.get(cellKey(o, s)) || 0, cap: capacityFor(o, s, model.capacity ?? [], model.config), warn: w.reasons.some((r) => r.warn && r.code === 'STARTED') });
  }
  list.sort((a, b) => a.slip - b.slip || Number(b.sameOwner) - Number(a.sameOwner) || a.load - b.load || (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0) || a.sprint - b.sprint);
  return Object.assign(res, { status: res.frozen ? 'frozen' : list.length ? 'found' : 'none', valid: list.length, slots: list });
}
const FIND_SPACE = (a: readonly string[]): string => `${a.includes('earlier') ? 'later or earlier' : 'later'} sprints, ${a.includes('owner-change') ? 'any owner' : 'same owner'}`;
/** Text of a findSlots result. cmd(slot) gives the exact dry-run command (null when not shell-safe). */
export function renderFind(r: FindResult, { cmd, top = 5, name = String, key = String }: { cmd: (s: FoundSlot) => string | null; top?: number; name?: (s: unknown) => string; key?: (s: unknown) => string }): string[] {
  if (r.status === 'unknown') return [`NO: ${key(r.key)} is not in the plan`];
  const head = `FIND ${key(r.key)} (${name((r.from as Slot).owner)} S${(r.from as Slot).sprint})`, out: string[] = []; // from is set for every status but unknown, returned above
  const label = (x: FoundSlot) => `S${x.sprint} ${name(x.owner)}${x.sameOwner ? ' (no change)' : ''}`;
  const budget = r.searchComplete ? '' : ` (stopped after ${r.tried} slots: not every slot was tried)`;
  if (r.status === 'frozen') return [`${head}: no slot: ${key(r.key)} keeps its slot (STARTED: ${r.frozen})`];
  if (r.status === 'none') {
    const why = Object.entries(r.reasons).sort((a, b) => (b[1]) - (a[1]) || (a[0] < b[0] ? -1 : 1)).map(([c, n]) => `${c} ${n}`).join(', ');
    out.push(`${head}: no valid slot among ${r.tried} tried (${FIND_SPACE(r.allowed)})${why ? `: ${why}` : ''}${budget}`);
    const flags = ['earlier', 'owner-change'].filter((f) => !r.allowed.includes(f) && !(f === 'earlier' && (r.from as Slot).sprint <= (r.first as number))).map((f) => `--${f}`); // findSlots sets from and first for every status but unknown
    out.push(`try: ${flags.length ? `${flags.join(', ')}, or ` : ''}plangraph whatif ${key(r.key)} --sprint M --slip --apply-plan to shift other tickets too`);
    return out;
  }
  out.push(`${head}: ${r.valid} valid slot${r.valid === 1 ? '' : 's'} of ${r.tried} tried (${FIND_SPACE(r.allowed)}); best: ${r.slots.slice(0, top).map(label).join(', ')}${budget}`);
  for (const x of r.slots.slice(0, top)) out.push(`${label(x)}: slip ${x.slip}, load ${x.load}/${x.cap}${x.warn ? ', started: confirm with the assignee' : ''} | ${cmd(x) ?? '(no shell-safe command: a key or name has unsafe characters)'}`);
  if (r.valid > top) out.push(`... ${r.valid - top} more valid slots (--json lists up to 200)`);
  out.push('(dry run, nothing changed: each slot was checked with whatif and plangraph verify on a copy; to apply one, run its command with --apply-plan --write, then plangraph export)');
  return out;
}

// Text of a relieve result, line by line. cmd(move) gives the exact dry-run command of one move (null when a value is not shell-safe).
const ALLOWED_TEXT = (a: readonly string[]): string => `this cell's tickets, ${a.includes('earlier') ? 'later or earlier' : 'later'} sprints, ${a.includes('owner-change') ? 'any owner' : 'same owner'}`;
const REASON_TEXT: Record<string, string> = { FROZEN: 'frozen (started or closed)', NO_SLOT: 'no other sprint in range', LINKS: 'every target breaks a link', FULL: 'every target is over capacity', CONFLICT: 'each could move, but no combination works together' };
export function renderRelieve(r: RelieveResult, { cmd, limit = 15, keys = 5, name = String, key = String }: { cmd: (m: RelieveMove) => string | null; limit?: number; keys?: number; name?: (s: unknown) => string; key?: (s: unknown) => string }): string[] {
  const head = `${name(r.person)} S${r.sprint}`, out: string[] = [];
  if (r.status === 'none_needed') return [r.load > r.cap ? `OK: ${head} is over capacity (${r.load}/${r.cap}) only by frozen tickets, which are history: nothing to relieve` : `OK: ${head} is within capacity (${r.load}/${r.cap}): nothing to relieve`];
  if (r.status === 'no_relief') {
    out.push(`NO RELIEF: ${head} ${r.load}/${r.cap}: ${r.searchComplete ? `no relief found within the allowed moves (${ALLOWED_TEXT(r.allowed)})` : `no relief found within the search budget (${r.budget} steps); not proven impossible`}`);
    for (const x of r.reasons) {
      if (x.code === 'NOT_ENOUGH') { out.push(`- the tickets that can move free ${x.freeable} SP of the ${x.needed} needed`); continue; }
      if (x.code === 'NO_ROOM') { out.push(`- the targets have room for ${x.room} of ${x.needed} SP`); continue; }
      out.push(`- ${(REASON_TEXT)[x.code]} ${x.keys.length}: ${x.keys.slice(0, keys).map(key).join(' ')}${x.keys.length > keys ? ` +${x.keys.length - keys} more` : ''}`);
    }
    // no --earlier when sprint N is first_sprint: there is no earlier sprint to move to
    const flags = ['earlier', 'owner-change'].filter((f) => !r.allowed.includes(f) && !(f === 'earlier' && Number.isFinite(r.first) && r.sprint <= r.first)).map((f) => `--${f}`);
    out.push(`try: ${flags.length ? `${flags.join(', ')}, or ` : ''}plangraph whatif KEY --sprint M --slip --apply-plan to shift other tickets too`);
    return out;
  }
  const n = r.moves.length;
  out.push(`RELIEF: ${head} ${r.load}/${r.cap} -> ${r.after}/${r.cap} with ${n} move${n === 1 ? '' : 's'} (slip ${r.slip}, ${r.ownerChanges} owner change${r.ownerChanges === 1 ? '' : 's'})${r.searchComplete ? '' : ` (search budget ${r.budget} hit: not proven minimal)`}`);
  for (const m of r.moves.slice(0, limit)) out.push(`${key(m.key)} ${m.sp} SP: ${name(m.from.owner)} S${m.from.sprint} > ${name(m.to.owner)} S${m.to.sprint} | ${cmd(m) ?? '(no shell-safe command: a key or name has unsafe characters)'}`);
  if (n > limit) out.push(`... ${n - limit} more moves (-v for up to 100)`);
  out.push(r.order === 'sequential' ? '(dry run, nothing changed: to apply, the owner runs each command above in this order with --apply-plan --write, then plangraph export)'
    : '(dry run, nothing changed: these moves only work together, and plangraph cannot apply them together: it applies one move at a time with its own repair (plangraph whatif KEY --sprint N --apply-plan --write), and each of these moves alone breaks a link or a capacity, so no command above says OK on its own. To apply them, edit schedule.json by hand, check it with plangraph verify FILE, then plangraph schedule-load FILE NAME)');
  return out;
}

// ---- renderWhatif: yes/no first, reasons joined by ' | ', bounded. ----
export function renderWhatif(r: WhatifView, opts: { limit?: number } = {}): string {
  const lim = opts.limit ?? 8;
  const mv = r.ripple && r.ripple[0];
  const head = mv ? `${mv.key} -> ${mv.to.owner} S${mv.to.sprint}` : (r.reasons[0]?.key ?? '?');
  const rs = r.reasons.map((x) => `${x.code} ${x.key} (${x.detail})`);
  const shown = rs.slice(0, lim).join(' | ') + (rs.length > lim ? ` | ... ${rs.length - lim} more` : '');
  const warn = r.reasons.length && r.reasons.every((x) => x.warn);
  if (r.ok) {
    let s = `OK: ${head}.`;
    for (const o of Object.keys(r.load as Loads)) for (const sp of Object.keys((r.load as Loads)[o] as Record<string, LoadCell>)) { const l = ((r.load as Loads)[o] as Record<string, LoadCell>)[sp] as LoadCell; if (l.after > l.before) s += ` ${o} S${sp} ${l.after}/${l.cap}.`; } // an ok result carries its load (whatif always sets it); o and sp are keys of the maps they index
    if (r.freed && r.freed.sp) s += ` Frees ${r.freed.sp} on ${r.freed.owner} S${r.freed.sprint}.`;
    if (warn) s += ` WARN ${shown}.`;
    if (r.notes?.length) s += ` Note: ${r.notes.join('; ')}.`;
    if (r.touches) s += ` ${r.touches}`;
    return s;
  }
  let s = `NO: ${head}. ${shown}.`;
  const g = r.suggestion;
  if (g && !g.none) {
    const at = mv && g.sprint !== mv.to.sprint ? `move to S${g.sprint}` : `keep S${g.sprint}`;
    const need = g.flags && g.flags.length ? `; apply with ${g.flags.map((f) => `--${f}`).join(' ')}` : '';
    s += ` Fix: ${at} (${g.shifts} ${g.shifts === 1 ? 'other shifts' : 'others shift'}, ${g.ownerChanges} owner changes${need}).`;
  } else if (g && g.none) s += ' Fix: none found; try --earlier or --owner-change.';
  else if (r.reasons[0] && r.reasons[0].fix) s += ` Fix: ${r.reasons[0].fix}.`;
  if (r.notes?.length) s += ` Note: ${r.notes.join('; ')}.`;
  if (r.touches) s += ` ${r.touches}`;
  return s;
}

// ---- repair suggestion through the solver (amendment section 3.14 item 2) ----
// The check is propagation (whatif); the solver runs only to suggest a repair. repairSpec gives the call: bin/plangraph-solve in repair mode with
// every ticket outside the free scope fixed at its current slot (the scope: the requested ticket, the cone of its transitive consumers, the
// tickets of the target cell), a complete hint (the naive forward ripple of the move, every ticket placed) and a stability objective (owner
// changes, then sprint moves, then the usual stages). The scope rules are the ones of bin/plangraph-solve repair_scope (a test compares them).
// suggestionFromSchedule turns the solver's schedule back into a Suggestion after checking it against the same safety net as proposeMove.
/** The transitive consumers of `key` (not `key` itself); a closed ticket does not pass the move on, as in the ripple. */
export function repairCone(model: Model, key: string): string[] {
  const seen = new Set<string>(), todo = [key];
  while (todo.length) {
    const x = todo.pop() as string; // todo.length was tested
    if (isClosed(model, x)) continue;
    for (const c of model.cons.get(x) || []) if (c !== key && !seen.has(c)) { seen.add(c); todo.push(c); }
  }
  return [...seen].sort();
}
export interface RepairSpec {
  /** the flags after `bin/plangraph-solve ... --out F` (the plan itself comes from --jsonl-dir or the index) */
  args: string[];
  /** the requested ticket, its cone and the target-cell tickets: the only tickets the solver may move (frozen history aside) */
  free: string[]; cone: string[];
  /** the complete hint: every placed ticket's slot after the naive ripple */
  hint: Map<string, Slot>;
  to: Slot;
}
/** The solver call for a repair, or null when whatif stops the move for a reason no move repairs (hard code, STARTED or BLOCKED stop). */
export function repairSpec(model: Model, mv: MoveRequest, opts: WhatifOptions = {}): RepairSpec | null {
  const w = whatif(model, mv, { ...opts, noSuggest: true });
  if (w.reasons.some(stops) || !w.ripple.length) return null;
  const to = (w.ripple[0] as Ripple).to, key = mv.key, cone = repairCone(model, key);
  const cell = [...model.sched].filter(([, p]) => p.owner === to.owner && p.sprint === to.sprint).map(([k]) => k);
  const fz = frozenTest(model, opts), free = [...new Set([key, ...cone, ...cell])].filter((k) => model.tickets.has(k) && (k === key || !fz(k))).sort(); // history never moves
  const hint = new Map<string, Slot>();
  for (const [k, p] of model.sched) if (model.tickets.has(k)) hint.set(k, { owner: p.owner as string, sprint: p.sprint as number });
  for (const r of w.ripple) hint.set(r.key, { ...r.to });
  const args = ['--baseline', 'current', '--repair', key, '--repair-to', to.owner, '--repair-sprint', String(to.sprint), ...(opts.allowOwnerChange ? ['--repair-owner-change'] : []), ...(opts.allowEarlier ? ['--repair-earlier'] : [])];
  return { args, free, cone, hint, to };
}
/** A solver schedule row: the shape of the --out array. */
export interface SolverRow { item: string; owner: string; sprint: number }
/** The Suggestion a solver schedule makes for `mv`, or { none: true } when it is not a repair of that move (the requested ticket is not at the
 * requested owner in the requested sprint or later, or a ticket outside the free scope moved). Throws like proposeMove when the schedule
 * introduces a violation the plan did not have (the internal safety net). */
export function suggestionFromSchedule(model: Model, mv: MoveRequest, rows: readonly SolverRow[], opts: WhatifOptions = {}): Suggestion {
  const spec = repairSpec(model, mv, opts);
  if (!spec) return { none: true };
  const plan = new Map<string, Placement>(model.sched), free = new Set(spec.free), moves: Move[] = [];
  for (const r of rows) {
    const cur = (model.sched as SchedView).get(r.item);
    if (!cur || (cur.owner === r.owner && cur.sprint === r.sprint)) continue;
    if (!free.has(r.item)) return { none: true };
    plan.set(r.item, { owner: r.owner, sprint: r.sprint }); moves.push({ key: r.item, from: { ...cur }, to: { owner: r.owner, sprint: r.sprint } });
  }
  const at = plan.get(mv.key) as Slot; // whatif found the ticket, so it is placed
  if (at.owner !== spec.to.owner || at.sprint < spec.to.sprint) return { none: true };
  const fz = frozenTest(model, opts);
  assertPlanValid(model, plan, opts, (k) => k !== mv.key && fz(k));
  const others = moves.filter((m) => m.key !== mv.key);
  return { sprint: at.sprint, owner: at.owner, shifts: others.length, ownerChanges: others.filter((m) => m.from.owner !== m.to.owner).length, ...(at.sprint > spec.to.sprint && !opts.allowSlip ? { flags: ['slip'] } : {}) };
}

// ---- touchesLine: where a ticket's work is traced to, one bounded line. ----
// Depth 2 over the trace and identity relations only (REL_SEMANTICS decides: group and info relations, and every extension relation, are
// never read), in both directions, since implements runs from the plan task to the ticket and tracked_by from the ticket's xref row. The
// second step never enters a plan task or a ticket (a plan's other tasks are siblings, not the ticket's trace). At most TOUCHES_TOKENS
// estimated tokens: entries that do not fit are counted as "+N". note(node) may add a parenthetical, e.g. an assignee from the cache.
export const TOUCHES_TOKENS = 40;
const TRACE_RELS = (Object.keys(REL_SEMANTICS) as Array<keyof typeof REL_SEMANTICS>).filter((r) => REL_SEMANTICS[r] === 'trace' || REL_SEMANTICS[r] === 'identity') as Rel[];
const LEVEL_CAP = 20, LABEL_MAX = 50;
const tidy = (x: string): string => { const t = x.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim(); return t.length > LABEL_MAX ? `${t.slice(0, LABEL_MAX - 1)}~` : t; };
function touchLabel(n: NodeRef): string | null {
  const type = n.type as string;
  if (type === 'plan' || type === 'plantask') return `plan ${tidy(n.id)}`;
  if (type === 'doc' || type === 'repo' || type === 'epic') return `${type} ${tidy(n.id)}`;
  if (type.startsWith('x-')) return tidy(n.id.replace(':', ' '));
  return null; // tickets, people, sprints and open items are not a trace target
}
export function touchesLine(g: Pick<GraphReader, 'reach'>, key: string, { note }: { note?: (n: NodeRef) => string | null } = {}): string | null {
  const start: NodeRef = { id: key, type: 'ticket' as NodeType };
  const step = (from: NodeRef): NodeRef[] => [false, true].flatMap((rv) => g.reach(from, TRACE_RELS, 1, rv).map((x): NodeRef => ({ id: x.id, type: x.type })));
  const seen = new Set<string>([`${start.type}\t${start.id}`]), found: NodeRef[] = [], mark = (n: NodeRef): boolean => { const k = `${n.type}\t${n.id}`; if (seen.has(k)) return false; seen.add(k); return true; };
  const first = step(start).filter(mark).slice(0, LEVEL_CAP);
  found.push(...first);
  for (const n of first) for (const m of step(n)) if ((m.type as string) !== 'plantask' && (m.type as string) !== 'ticket' && mark(m)) found.push(m);
  const planOf = new Set(found.filter((n) => n.type === 'plantask').map((n) => n.id.split('#')[0]));
  const items: string[] = [];
  const rank = (t: string): number => (t === 'plantask' || t === 'plan' ? 0 : t === 'repo' ? 1 : 2); // the plan first, then the code, then the tracker
  for (const n of found.toSorted((a, b) => rank(a.type) - rank(b.type))) {
    if (n.type === 'plan' && planOf.has(n.id)) continue; // the task already names its plan
    const l = touchLabel(n); if (!l) continue;
    const nt = note?.(n); items.push(nt ? `${l} (${tidy(nt)})` : l);
  }
  if (!items.length) return null;
  let out = items.slice(); const line = (a: string[], more: number): string => `touches: ${a.join(', ')}${more ? ` +${more}` : ''}`;
  while (out.length > 1 && est(line(out, items.length - out.length)) > TOUCHES_TOKENS) out.pop();
  if (est(line(out, items.length - out.length)) > TOUCHES_TOKENS) out = [`${(out[0] as string).slice(0, 120)}~`];
  return line(out, items.length - out.length);
}
