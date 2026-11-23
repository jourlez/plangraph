// Property (c): lib/whatif.ts whatif and proposeMove against a clean-room move rule, on EVERY single-ticket request of every instance.
//
// The specified move rule (README "whatif", lib/whatif.ts header, CONTRACT strict handoff rule), stated here once:
//   A request {key, to?, sprint?} is YES iff all of:
//   1. key is a ticket with a current placement (else UNKNOWN_TICKET);
//   2. `to`, when given, names a person: an owner in the schedule, a capacity person (caps key other than `default`) or opts.people, matched
//      exactly, else by a unique case-insensitive match, else by a unique first name (else UNKNOWN_PERSON);
//   3. the target sprint (default: the current one) is a whole number in first_sprint (default 1) .. end_sprint (default: the last sprint
//      used in the schedule) (else OUT_OF_RANGE);
//   4. the target differs from the current slot (else SAME_SLOT);
//   5. the ticket is not frozen as history (oracle.ts: closed, a key of opts.frozen, a current sprint below frozen_before_sprint: always a
//      stop); In Progress, and any status listed in config.frozen_statuses, only warns, and stops under opts.strict (STARTED);
//   6. NEIGHBORHOOD, after applying the move: every live link with the moved ticket at either end, whose other end is a placed ticket,
//      satisfies the strict handoff rule (PRODUCER_LATE / CONSUMER_EARLY), the moved ticket's own placement used on BOTH ends of a self-link;
//      a link whose producer is CLOSED (oracle.ts isClosedTicket) is satisfied wherever the producer sits (frozen history: oracle.ts);
//   7. the target cell's load after the move (its current load plus the ticket's points) is at most the target owner's capacity, OR the
//      move added no load to it (CAPACITY is a NEW violation only, as lib/verify.ts counts them): a 0-point ticket may move into a cell
//      that is already over capacity (lib/whatif.ts header; test/whatif-zero-sp.test.ts). Encoded as specified.
//   Cross-check with the verify oracle: a YES move never adds a violation (multiset of oracle violations after minus before is empty).
// proposeMove (repairs), for every request and every flag combination of {allowSlip, allowEarlier, allowOwnerChange}:
//   ok => the first move is the request (slipped later only with allowSlip, never another owner), no frozen ticket (oracle.ts) other than the
//   requested one moves, no other ticket changes owner without allowOwnerChange or ends before its base sprint without allowEarlier, every
//   sprint is in first..end, and the repaired plan satisfies rule 6 for every moved ticket and rule 7 for every cell whose load grew, adds
//   no oracle violation; searchComplete => (slipped, shifted) is the lexicographic minimum over the WHOLE move space (brute force on the
//   proposeMove family); a complete NO_REPAIR => brute force finds no valid plan in that space. Every suggestion whatif prints is the first
//   move of such a repair (allowSlip on) and so passes the same checks.
// NOT covered: instances beyond BOUNDS; allowOverflow and opts.budget (the budget fallback is approximate by design and not exercised:
// the family is far below the budget); renderWhatif text; the ripple list (capacity-blind preview, checked by test/whatif.test.ts).
import assert from 'node:assert/strict';
import { buildModel } from '../../lib/model.ts';
import { whatif, proposeMove } from '../../lib/whatif.ts';
import type { WhatifResult } from '../../lib/whatif.ts';
import { oracleViolations, capFor, validPlacement, liveEdges, personsOf, isClosedTicket, isFrozenForWindow } from './oracle.ts';
import type { Instance, OConfig, OTicket, Placement } from './oracle.ts';
import { product, allGraphs, slots, keysOf, bag } from './enum.ts';
import type { Level } from './enum.ts';
import type { Model } from '../../lib/model.ts';

/** a requested move: the ticket, the target owner name (as typed) and the target sprint */
export interface Move { key: string; to?: string; sprint?: number }
export interface MoveOpts { strict?: boolean }
export interface RepairOpts { strict?: boolean; allowSlip?: boolean; allowEarlier?: boolean; allowOwnerChange?: boolean }
/** the oracle verdict */
export interface Verdict { yes: boolean; codes: Set<string>; owner?: string; sprint?: number; hard: boolean }
interface Repair { ok: boolean; moves: Array<{ key: string; to: Placement }>; searchComplete?: boolean; slipped?: number; shifted?: number; reasons: Array<{ code: string }> }
type Cost = [number, number];
interface Bound {
  n: number; unplaced?: boolean; sprints?: number[]; sps: number[][]; caps: number[]; sts: Array<string | string[]>;
  tos?: Array<string | undefined>; sprintReq?: Array<number | undefined>; ghost?: boolean;
}
interface VerdictBound extends Bound { cfgs: OConfig[] }

const sp = (t: OTicket | undefined): number => (t && typeof t.sp === 'number' && Number.isFinite(t.sp) ? t.sp : 0);
const tget = (inst: Instance, k: string): OTicket | undefined => inst.tickets.find((t) => t.key === k);

function resolve(inst: Instance, name: string): string | null {
  const ps = [...personsOf(inst)].sort();
  if (ps.includes(name)) return name;
  const q = String(name).trim().toLowerCase();
  const ci = ps.filter((p) => p.toLowerCase() === q);
  if (ci.length === 1) return ci[0];
  const fn = ps.filter((p) => q && p.toLowerCase().split(/\s+/)[0] === q);
  return fn.length === 1 ? fn[0] : null;
}
// the statuses that only warn (rule 5): In Progress always, plus what config.frozen_statuses lists
const warnStatuses = (inst: Instance): string[] => { const f = (inst.config || {}).frozen_statuses; return ['In Progress', ...(Array.isArray(f) ? f : [])]; };
const historyFrozen = (inst: Instance, k: string): boolean => { const cfg = inst.config || {}, cur = inst.sched.get(k); return isClosedTicket(inst, k) || !!(inst.frozen && inst.frozen.has(k)) || (Number.isFinite(cfg.frozen_before_sprint) && validPlacement(cur) && cur.sprint < (cfg.frozen_before_sprint as number)); };
const cellLoad = (inst: Instance, sched: Map<string, Placement>, o: string, s: number): number => { let v = 0; for (const [k, p] of sched) if (tget(inst, k) && validPlacement(p) && p.owner === o && p.sprint === s) v += sp(tget(inst, k)); return v; };
// Rule 6 on a schedule for a set of moved tickets.
function handoffOk(inst: Instance, sched: Map<string, Placement>, moved: Set<string>): boolean {
  for (const e of liveEdges(inst)) {
    if (!moved.has(e.consumer) && !moved.has(e.producer)) continue;
    const c = sched.get(e.consumer), p = sched.get(e.producer);
    if (!tget(inst, e.consumer) || !tget(inst, e.producer) || !validPlacement(c) || !validPlacement(p) || isClosedTicket(inst, e.producer)) continue;
    if (c.sprint < p.sprint + (c.owner === p.owner ? 0 : 1)) return false;
  }
  return true;
}
function windowOf(inst: Instance): { first: number; end: number } {
  const cfg = inst.config || {};
  let used = 0; for (const p of inst.sched.values()) if (p.sprint > used) used = p.sprint;
  return { first: cfg.first_sprint ?? 1, end: cfg.end_sprint ?? used };
}

/** The oracle verdict: { yes, codes:Set, owner, sprint, hard } */
export function oracleMove(inst: Instance, mv: Move, opts: MoveOpts = {}): Verdict {
  const codes = new Set<string>(), cur = inst.sched.get(mv.key), t = tget(inst, mv.key);
  if (!cur || !t) return { yes: false, codes: new Set(['UNKNOWN_TICKET']), hard: true };
  let owner = cur.owner;
  if (mv.to != null) { const r = resolve(inst, mv.to); if (r) owner = r; else { owner = mv.to; codes.add('UNKNOWN_PERSON'); } }
  const sprint = mv.sprint ?? cur.sprint, { first, end } = windowOf(inst);
  if (!Number.isInteger(sprint) || sprint < first || sprint > end) codes.add('OUT_OF_RANGE');
  if (owner === cur.owner && sprint === cur.sprint) { codes.add('SAME_SLOT'); return { yes: false, codes, hard: true }; }
  const st = t.jira_status;
  let warnOnly = false, hard = codes.size > 0;
  if (historyFrozen(inst, mv.key)) { codes.add('STARTED'); hard = true; } else if (st && warnStatuses(inst).includes(st)) { codes.add('STARTED'); if (opts.strict) hard = true; else warnOnly = true; }
  const after = new Map(inst.sched); after.set(mv.key, { owner, sprint });
  for (const e of liveEdges(inst)) {
    const other = e.consumer === mv.key ? e.producer : e.producer === mv.key ? e.consumer : null;
    if (other === null || e.consumer === e.producer) continue; // a self-link: same placement on both ends, rule holds
    const op = inst.sched.get(other);
    if (!tget(inst, other) || !validPlacement(op) || isClosedTicket(inst, e.producer)) continue;
    const c = after.get(e.consumer) as Placement, p = after.get(e.producer) as Placement; // both ends are scheduled: `after` extends the schedule that holds them
    if (c.sprint < p.sprint + (c.owner === p.owner ? 0 : 1)) codes.add(e.consumer === mv.key ? 'PRODUCER_LATE' : 'CONSUMER_EARLY');
  }
  { const nb = cellLoad(inst, inst.sched, owner, sprint), na = nb + sp(t); if (na > capFor(inst.config, owner) && na > nb) codes.add('CAPACITY'); }
  const blocking = [...codes].filter((c) => !(c === 'STARTED' && warnOnly));
  return { yes: blocking.length === 0, codes, owner, sprint, hard };
}

const fail = (inst: Instance, what: string, extra: unknown): never => assert.fail(`whatif: ${what}\n${JSON.stringify({ ...inst, sched: [...inst.sched], extra })}`);
const sig = (v: { code: string; key: string; producer?: string }): string => (v.code === 'HANDOFF' ? `HANDOFF|${v.key}|${v.producer}` : `${v.code}|${v.key}`);
function newViolations(inst: Instance, after: Map<string, Placement>): string[] {
  const before = bag(oracleViolations(inst).map(sig)), now = bag(oracleViolations({ ...inst, sched: after }, after).map(sig));
  const left = [...before];
  return now.filter((x) => { const i = left.indexOf(x); if (i >= 0) { left.splice(i, 1); return false; } return true; });
}

// Brute force over the whole move space of proposeMove (stated in the header). Returns the lexicographic minimum [slip, shifted] or null.
function bruteRepair(inst: Instance, mv: Move, target: Placement, opts: RepairOpts): Cost | null {
  const cur = inst.sched.get(mv.key) as Placement, { first, end } = windowOf(inst);
  const people = [...personsOf(inst)].sort();
  const others = [...inst.sched.keys()].filter((k) => k !== mv.key && tget(inst, k) && validPlacement(inst.sched.get(k))).sort();
  const choices = others.map((k) => {
    const b = inst.sched.get(k) as Placement; // `others` keeps only scheduled keys
    if (isFrozenForWindow(inst, k)) return [b];
    const out = [b];
    for (const o of opts.allowOwnerChange ? people : [b.owner]) for (let s = Math.max(first, opts.allowEarlier ? first : b.sprint); s <= end; s++) if (!(o === b.owner && s === b.sprint)) out.push({ owner: o, sprint: s });
    return out;
  });
  const keyOpts = [target.sprint];
  if (opts.allowSlip) for (let s = target.sprint + 1; s <= end; s++) if (!(target.owner === cur.owner && target.sprint < cur.sprint && s >= cur.sprint)) keyOpts.push(s);
  let best: Cost | null = null;
  for (const ks of keyOpts) product([...choices, [0]], (ch) => {
    const after = new Map(inst.sched); after.set(mv.key, { owner: target.owner, sprint: ks });
    const moved = new Set([mv.key]);
    others.forEach((k, i) => { after.set(k, ch[i] as Placement); if (ch[i] !== inst.sched.get(k)) moved.add(k); });
    if (!repairValid(inst, after, moved)) return;
    const c: Cost = [ks - target.sprint, moved.size - 1];
    if (!best || c[0] < best[0] || (c[0] === best[0] && c[1] < best[1])) best = c;
  });
  return best;
}
// Rule 6 for every moved ticket, rule 7 for every cell whose load grew.
function repairValid(inst: Instance, after: Map<string, Placement>, moved: Set<string>): boolean {
  if (!handoffOk(inst, after, moved)) return false;
  const cells = new Set<string>();
  for (const k of moved) { const p = after.get(k) as Placement; cells.add(JSON.stringify([p.owner, p.sprint])); }
  for (const id of cells) { const [o, s] = JSON.parse(id), now = cellLoad(inst, after, o, s); if (now > cellLoad(inst, inst.sched, o, s) && now > capFor(inst.config, o)) return false; }
  return true;
}

function checkRepair(inst: Instance, mv: Move, opts: RepairOpts, pm: Repair, target: Placement, brute: boolean): void {
  const { first, end } = windowOf(inst);
  if (pm.ok) {
    const m0 = pm.moves[0];
    if (m0.key !== mv.key || m0.to.owner !== target.owner || m0.to.sprint < target.sprint || (!opts.allowSlip && m0.to.sprint !== target.sprint)) fail(inst, 'first move is not the request', { mv, opts, pm });
    const after = new Map(inst.sched), moved = new Set<string>();
    for (const m of pm.moves) {
      const b = inst.sched.get(m.key) as Placement; // a repair moves scheduled tickets
      if (m.key !== mv.key) {
        if (isFrozenForWindow(inst, m.key)) fail(inst, 'a frozen or Done ticket was moved', { mv, opts, m });
        if (!opts.allowOwnerChange && m.to.owner !== b.owner) fail(inst, 'owner changed without allowOwnerChange', { mv, opts, m });
        if (!opts.allowEarlier && m.to.sprint < b.sprint) fail(inst, 'moved earlier without allowEarlier', { mv, opts, m });
      }
      if (m.to.sprint < first || m.to.sprint > end) fail(inst, 'repair outside the sprint window', { mv, opts, m });
      after.set(m.key, { owner: m.to.owner, sprint: m.to.sprint }); moved.add(m.key);
    }
    if (!repairValid(inst, after, moved)) fail(inst, 'repair breaks a rule on a moved ticket', { mv, opts, pm });
    const nv = newViolations(inst, after);
    if (nv.length) fail(inst, 'repair adds a violation', { mv, opts, pm, nv });
    if (brute && pm.searchComplete) {
      const best = bruteRepair(inst, mv, target, opts);
      if (!best || best[0] !== pm.slipped || best[1] !== pm.shifted) fail(inst, 'repair claimed minimal but is not', { mv, opts, pm: { slipped: pm.slipped, shifted: pm.shifted }, best });
    }
  } else if (brute && pm.searchComplete && pm.reasons.some((r) => r.code === 'NO_REPAIR')) {
    const best = bruteRepair(inst, mv, target, opts);
    if (best) fail(inst, 'NO_REPAIR claimed complete but a repair exists', { mv, opts, best });
  }
}

const FLAGS: RepairOpts[] = [{}, { allowSlip: true }, { allowEarlier: true }, { allowOwnerChange: true }, { allowSlip: true, allowEarlier: true, allowOwnerChange: true }];

export function checkRequest(inst: Instance, model: Model, mv: Move, { repairs = false, brute = false, strictToo = true }: { repairs?: boolean; brute?: boolean; strictToo?: boolean } = {}): number {
  let n = 0;
  for (const opts of strictToo ? [{}, { strict: true }] : [{}]) {
    const o = oracleMove(inst, mv, opts), r: WhatifResult = whatif(model, mv, { ...opts, noSuggest: !repairs });
    n++;
    const libCodes = [...new Set(r.reasons.map((x) => x.code))].sort().join(','), oraCodes = [...o.codes].sort().join(',');
    if (r.ok !== o.yes || libCodes !== oraCodes) fail(inst, 'verdict differs', { mv, opts, lib: { ok: r.ok, codes: libCodes }, oracle: { yes: o.yes, codes: oraCodes } });
    if (o.yes) {
      const after = new Map(inst.sched); after.set(mv.key, { owner: o.owner as string, sprint: o.sprint as number }); // a YES verdict carries both
      const nv = newViolations(inst, after);
      if (nv.length) fail(inst, 'a YES move adds a violation', { mv, opts, nv });
    }
    if (repairs && !o.yes && r.suggestion && !r.suggestion.none) {
      const pm = proposeMove(model, mv, { ...opts, allowSlip: true });
      if (!pm.ok || pm.moves[0].to.sprint !== r.suggestion.sprint || pm.moves[0].to.owner !== r.suggestion.owner || pm.moves.length - 1 !== r.suggestion.shifts) fail(inst, 'suggestion is not the repair', { mv, s: r.suggestion });
      checkRepair(inst, mv, { ...opts, allowSlip: true }, pm, o as Placement, false); // a verdict with a suggestion carries owner and sprint
      n++;
    }
    if (repairs && !o.hard) for (const f of FLAGS) {
      const pm = proposeMove(model, mv, { ...opts, ...f });
      checkRepair(inst, mv, { ...opts, ...f }, pm, o as Placement, brute); // !o.hard: the verdict carries owner and sprint
      n++;
    }
  }
  return n;
}

// Each tier is a full product of its domains: graphs (every link set on n tickets, self-links included) x sps x caps x sts x cfgs x every
// placement of every ticket (owners Ana, Ben x sprints, plus unplaced when set) x every request (reqKeys x tos x sprintReq).
const T = (keys: string[], a: Array<string | string[]>): string[][] => a.map((x) => (typeof x === 'string' ? keys.map((_, i) => (i ? 'To Do' : x)) : x));
export const BOUNDS: Record<Level, { verdict: VerdictBound[]; repair: Bound[] }> = {
  full: {
    verdict: [
      { n: 1, unplaced: true, sps: [[0], [1], [2], [1.5]], caps: [0, 1, 2, 3, 5], sts: ['To Do', 'In Progress', 'Done', 'Closed'], cfgs: [{}, { first_sprint: 2 }, { end_sprint: 4 }, { frozen_statuses: [] }, { closed_statuses: ['Closed'] }, { first_sprint: 2, end_sprint: 2 }, { frozen_before_sprint: 2 }], tos: [undefined, 'Ana', 'Ben', 'ana', 'Zed', 'Cleo'], sprintReq: [undefined, 0, 1, 2, 3, 4, 5, 1.5], ghost: true },
      { n: 2, unplaced: true, sps: [[0, 1], [1, 1], [2, 1], [1, 2], [1.5, 1.5]], caps: [1, 2, 3], sts: ['To Do', 'In Progress', 'Done'], cfgs: [{}, { first_sprint: 2, end_sprint: 4 }, { frozen_before_sprint: 2 }] },
      { n: 3, sprints: [1, 2], sps: [[1, 1, 1], [0, 2, 1]], caps: [2, 3], sts: ['To Do', 'In Progress'], cfgs: [{}] },
    ],
    repair: [
      { n: 2, sps: [[1, 1], [2, 1], [0, 2]], caps: [1, 2, 3], sts: [['To Do', 'To Do'], ['To Do', 'In Progress'], ['To Do', 'Done']] },
      { n: 3, sprints: [1, 2], sps: [[1, 1, 1]], caps: [2], sts: [['To Do', 'To Do', 'To Do'], ['To Do', 'To Do', 'Done']] },
    ],
  },
  quick: {
    verdict: [
      { n: 1, unplaced: true, sps: [[1], [1.5]], caps: [0, 2], sts: ['To Do', 'In Progress', 'Done', 'Closed'], cfgs: [{}, { first_sprint: 2 }, { end_sprint: 4 }, { frozen_statuses: [] }, { closed_statuses: ['Closed'] }, { first_sprint: 2, end_sprint: 2 }, { frozen_before_sprint: 2 }], tos: [undefined, 'Ana', 'Ben', 'ana', 'Zed', 'Cleo'], sprintReq: [undefined, 0, 1, 2, 3, 4, 5, 1.5], ghost: true },
      { n: 2, sprints: [1, 2], sps: [[1, 1], [0, 2]], caps: [2], sts: ['To Do', 'In Progress'], cfgs: [{}] },
    ],
    repair: [{ n: 2, sps: [[2, 1], [0, 2]], caps: [1, 2], sts: [['To Do', 'To Do'], ['To Do', 'Done']], tos: [undefined, 'Ben'], sprintReq: [undefined, 1, 3] }],
  },
};

export function assureWhatif(lvl: Level, parts: Array<'verdict' | 'repair'> = ['verdict', 'repair']): { instances: number; requests: number; calls: number } {
  const B = BOUNDS[lvl], counts = { instances: 0, requests: 0, calls: 0 };
  // Verdict family: whatif YES/NO and reason codes on every request, plain and strict.
  for (const b of parts.includes('verdict') ? B.verdict : []) {
    const keys = keysOf(b.n), sprints = b.sprints || [1, 2, 3], sl = slots(['Ana', 'Ben'], sprints, !!b.unplaced);
    const { sps, caps, cfgs } = b, sts = T(keys, b.sts);
    const tos = b.tos || [undefined, 'Ana', 'Ben'], sprintReq = b.sprintReq || [undefined, 0, ...sprints, sprints.length + 1, sprints.length + 2];
    const reqKeys = b.ghost ? [...keys, 'NOPE'] : keys;
    for (const g of allGraphs(keys)) product([sps, caps, sts, cfgs], ([spv, cap, st, extra]) => {
      const tickets = keys.map((key, i) => ({ key, sp: spv[i], jira_status: st[i] })), edges = g.map(([consumer, producer]) => ({ consumer, producer, kind: 'plan_need' }));
      const config = { caps: { default: cap, ...(b.ghost ? { Cleo: 1 } : {}) }, ...extra };
      const model = buildModel({ tickets, edges, config });
      product(keys.map(() => sl), (ch) => {
        const sched = new Map(); keys.forEach((k, i) => { if (ch[i]) sched.set(k, ch[i]); });
        const inst = { tickets, edges, sched, config }; model.sched = sched;
        counts.instances++;
        for (const key of reqKeys) for (const to of tos) for (const s of sprintReq) { counts.requests++; counts.calls += checkRequest(inst, model, { key, ...(to !== undefined ? { to } : {}), ...(s !== undefined ? { sprint: s } : {}) }); }
      });
    });
  }
  // Repair family: suggestions and proposeMove under every flag combination, minimality and infeasibility by brute force.
  for (const b of parts.includes('repair') ? B.repair : []) {
    const keys = keysOf(b.n), sprints = b.sprints || [1, 2, 3], sl = slots(['Ana', 'Ben'], sprints, false);
    const { sps, caps, sts } = b, tos = b.tos || [undefined, 'Ana', 'Ben'], sprintReq = b.sprintReq || [undefined, ...sprints, sprints.length + 1];
    for (const g of allGraphs(keys)) product([sps, caps, sts], ([spv, cap, st]) => {
      const tickets = keys.map((key, i) => ({ key, sp: spv[i], jira_status: st[i] })), edges = g.map(([consumer, producer]) => ({ consumer, producer, kind: 'plan_need' }));
      const config = { caps: { default: cap }, end_sprint: sprints[sprints.length - 1] + 1 };
      const model = buildModel({ tickets, edges, config });
      product(keys.map(() => sl), (ch) => {
        const sched = new Map(keys.map((k, i) => [k, ch[i]]));
        const inst = { tickets, edges, sched, config }; model.sched = sched;
        counts.instances++;
        for (const key of keys) for (const to of tos) for (const s of sprintReq) {
          counts.requests++; counts.calls += checkRequest(inst, model, { key, ...(to !== undefined ? { to } : {}), ...(s !== undefined ? { sprint: s } : {}) }, { repairs: true, brute: true, strictToo: false });
        }
      });
    });
  }
  return counts;
}
