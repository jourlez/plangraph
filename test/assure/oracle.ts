// Clean-room oracles for the exhaustive small-scope suite. Written from docs/CONTRACT.md, docs/FORMAT.md, docs/STALE.md and the
// documented header rules of each module, NOT from the library code. This file imports nothing from lib/ or src/: a shared helper would
// let one bug hide in both sides. Every function takes plain data (arrays, objects, Maps of plain values) and returns plain data.
//
// Instance shape (the enumerators in enum.ts build these, and the property files turn them into a lib model with buildModel):
//   { tickets: [{key, sp, jira_status?, impl_status?, verdict?}], edges: [{consumer, producer, kind?}],
//     sched: Map key -> {owner, sprint} (the current schedule; may hold keys that are not tickets, or invalid placements),
//     config: {...config.json}, frozen?: Map key -> {owner, sprint}, enforceMin?: boolean }

export interface Placement { owner: string; sprint: number }
export interface OTicket { key: string; sp?: number | string; jira_status?: string; impl_status?: string; verdict?: string }
export interface OEdge { consumer: string; producer: string; kind?: string }
export interface OFinding { key: string; kind?: string }
export type OItem = { key: string; kind?: string; status?: string }; // a type alias, not an interface: it must fit the library's PlanRecord (a string-keyed record)
export interface OConfig {
  caps?: Record<string, number>; min_per_sprint?: Record<string, number>; ignore_link_kinds?: string[]; closed_statuses?: string[];
  frozen_statuses?: string[]; frozen_before_sprint?: number; first_sprint?: number; end_sprint?: number; [k: string]: unknown;
}
export interface ReadyScope { keys: string[]; ready: string[]; done: string[]; notReady: string[]; waiting: string[]; openItems: string[]; verdict: string[] }
export interface Instance {
  tickets: OTicket[]; edges: OEdge[]; sched: Map<string, Placement>; config?: OConfig;
  frozen?: Map<string, Placement> | undefined; enforceMin?: boolean | undefined; findings?: OFinding[];
}
/** what the ready oracles read of an instance: no schedule is needed for a single-ticket answer */
export interface ReadyInstance { tickets: OTicket[]; edges: OEdge[]; config?: OConfig; findings?: OFinding[]; sched?: Map<string, Placement> }
export interface OViolation { code: string; key: string; producer?: string }
export type OSnapshot = Record<string, { status?: string } | undefined>;

const has = (o: unknown, k: string): o is Record<string, unknown> => o !== null && typeof o === 'object' && Object.hasOwn(o, k);
const finiteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

// Capacity of a person (CONTRACT: `config.caps[person] ?? config.caps.default`; 140 when neither is a number, the documented default).
export function capFor(config: OConfig | undefined, person: string): number {
  const caps = config && config.caps;
  if (has(caps, person) && finiteNum(caps[person])) return caps[person];
  if (has(caps, 'default') && finiteNum(caps.default)) return caps.default;
  return 140;
}
export function minFor(config: OConfig | undefined, person: string): number {
  const m = config && config.min_per_sprint;
  if (has(m, person) && finiteNum(m[person])) return m[person];
  if (has(m, 'default') && finiteNum(m.default)) return m.default;
  return 0;
}
// A placement is valid when the owner is a non-empty string and the sprint a whole number.
export const validPlacement = (p: Placement | null | undefined): p is Placement => !!p && typeof p.owner === 'string' && p.owner.length > 0 && Number.isInteger(p.sprint);
const storyPoints = (t: OTicket | undefined): number => (t && finiteNum(t.sp) ? t.sp : 0);

// Edges that count: every edge whose kind is not in config.ignore_link_kinds (duplicates kept; they are the same rule twice).
export function liveEdges(inst: { edges: OEdge[]; config?: OConfig }): OEdge[] {
  const skip = new Set<string | undefined>((inst.config && inst.config.ignore_link_kinds) || []);
  return inst.edges.filter((e) => !skip.has(e.kind));
}

// Frozen history, from first principles (docs/CONTRACT.md "Frozen history"; the same rule is the header of lib/frozen.ts, which this file
// does not import). History cannot be late: a schedule constrains only what can still move.
//   CLOSED: finished. An sp: task whose impl_status is 'done'; any ticket whose jira_status is 'Done' or listed in config.closed_statuses.
//   FROZEN: keeps its slot. Closed; jira_status listed in config.frozen_statuses (nothing else: no default list); a key of opts.frozen; or
//     a CURRENT sprint (inst.sched, never the schedule under check) below config.frozen_before_sprint.
//   A constraint exists only where at least one side is FREE (not frozen):
//     link c needs p: no constraint when p is closed (a finished producer is never late, wherever it sits), none when c and p are both
//       frozen (a fixed fact of history); otherwise the strict handoff rule;
//     cell (owner, sprint): its capacity binds only its free load, which must fit in max(0, cap - frozen load): a cell of frozen tickets
//       only is never over capacity, and a free story point may not join a cell whose frozen load already reaches cap.
export function isClosedTicket(inst: Instance, key: string): boolean {
  const t = inst.tickets.find((x) => x.key === key);
  if (!t) return false;
  if (String(key).startsWith('sp:') && t.impl_status === 'done') return true;
  const closed = ['Done', ...(Array.isArray((inst.config || {}).closed_statuses) ? (inst.config as OConfig).closed_statuses as string[] : [])]; // the Array.isArray test above passed, so config is set
  return typeof t.jira_status === 'string' && closed.includes(t.jira_status);
}
export function isFrozenForWindow(inst: Instance, key: string): boolean {
  const cfg = inst.config || {};
  if (inst.frozen && inst.frozen.has(key)) return true;
  const t = inst.tickets.find((x) => x.key === key);
  if (!t) return false;
  if (isClosedTicket(inst, key)) return true;
  if (Array.isArray(cfg.frozen_statuses) && typeof t.jira_status === 'string' && cfg.frozen_statuses.includes(t.jira_status)) return true;
  const cur = inst.sched.get(key);
  return finiteNum(cfg.frozen_before_sprint) && validPlacement(cur) && cur.sprint < cfg.frozen_before_sprint;
}
// Does the link (consumer c, producer p) constrain the plan? The rule above, in one predicate.
export const linkConstrains = (inst: Instance, c: string, p: string): boolean => !isClosedTicket(inst, p) && !(isFrozenForWindow(inst, c) && isFrozenForWindow(inst, p));

// All elementary facts about cycles that the oracle needs: does node x reach node y (consumer -> producer direction)?
export function reach(nodes: string[], succ: Map<string, Set<string>>): Map<string, Set<string>> {
  const r = new Map<string, Set<string>>();
  for (const s of nodes) {
    const seen = new Set<string>(), stack = [...(succ.get(s) || [])];
    while (stack.length) { const x = stack.pop() as string; /* the loop condition checked the length */ if (seen.has(x)) continue; seen.add(x); for (const y of succ.get(x) || []) stack.push(y); }
    r.set(s, seen);
  }
  return r;
}

// The plan-rule oracle. Returns { list: [{code, key, producer?}], cyclic: Set of nodes on some cycle }.
// Rule sources: CONTRACT "Strict handoff rule", caps; verify header for BEFORE_FIRST, FROZEN_MOVED, MINLOAD, UNPLACED, UNKNOWN_TICKET, CONFIG.
// CYCLE is checked separately by cycleFacts (the spec fixes WHICH loops exist, not which one representative is printed).
export function oracleViolations(inst: Instance, sched: Map<string, Placement> = inst.sched): OViolation[] {
  const out: OViolation[] = [];
  const cfg = inst.config || {};
  const tk = new Map(inst.tickets.map((t) => [t.key, t]));
  for (const k of sched.keys()) if (!tk.has(k)) out.push({ code: 'UNKNOWN_TICKET', key: k });
  for (const t of inst.tickets) if (!validPlacement(sched.get(t.key)) && !String(t.key).startsWith('sp:')) out.push({ code: 'UNPLACED', key: t.key });
  const slot = (k: string): Placement | null => (tk.has(k) && validPlacement(sched.get(k)) ? sched.get(k) as Placement : null); // validPlacement just held

  let first = 1, firstOk = true;
  if (cfg.first_sprint !== undefined) {
    const f = cfg.first_sprint;
    if (typeof f === 'number' && Number.isInteger(f) && f >= -1000000 && f <= 1000000) first = f;
    else { firstOk = false; out.push({ code: 'CONFIG', key: 'first_sprint' }); }
  }
  if (firstOk) for (const k of sched.keys()) { const p = slot(k); if (p && p.sprint < first && !isFrozenForWindow(inst, k)) out.push({ code: 'BEFORE_FIRST', key: k }); }

  for (const e of liveEdges(inst)) {
    const pc = slot(e.consumer), pp = slot(e.producer);
    if (!pc || !pp || !linkConstrains(inst, e.consumer, e.producer)) continue;
    const need = pp.sprint + (pp.owner === pc.owner ? 0 : 1);
    if (pc.sprint < need) out.push({ code: 'HANDOFF', key: e.consumer, producer: e.producer });
  }

  const load = new Map(), frozenLoad = new Map(), freeLoad = new Map();
  for (const [k, p] of sched) {
    if (!slot(k)) continue;
    const id = JSON.stringify([p.owner, p.sprint]), v = storyPoints(tk.get(k)), side = isFrozenForWindow(inst, k) ? frozenLoad : freeLoad;
    load.set(id, (load.get(id) || 0) + v);
    side.set(id, (side.get(id) || 0) + v);
  }
  // free load F must fit in max(0, cap - frozen load Z): with Z >= cap that is F > 0 (and then the total is above cap), with Z < cap it is
  // Z + F > cap; both read as: some free story point is there and the total is above cap (the total summed in schedule order, as before)
  for (const [id, v] of load) { const [o, s] = JSON.parse(id); if ((freeLoad.get(id) || 0) > 0 && v > capFor(cfg, o)) out.push({ code: 'CAPACITY', key: `${o} S${s}` }); }

  if (inst.frozen) for (const [k, f] of inst.frozen) { const p = sched.get(k); if (!p || p.owner !== f.owner || p.sprint !== f.sprint) out.push({ code: 'FROZEN_MOVED', key: k }); }

  if (inst.enforceMin && firstOk) {
    const persons = new Set();
    for (const id of load.keys()) persons.add(JSON.parse(id)[0]);
    for (const p of Object.keys(cfg.min_per_sprint || {})) if (p !== 'default') persons.add(p);
    let last = 0;
    for (const p of sched.values()) if (validPlacement(p) && p.sprint > last) last = p.sprint;
    if (last - first > 1000) out.push({ code: 'CONFIG', key: 'sprint span' });
    else for (const person of persons) {
      const min = minFor(cfg, person as string); // persons holds strings
      if (!(min > 0)) continue;
      for (let s = first; s <= last; s++) { const v = load.get(JSON.stringify([person, s])) || 0; if (v < min) out.push({ code: 'MINLOAD', key: `${person} S${s}` }); }
    }
  }
  return out;
}

// Cycle facts over the live edges (consumer -> producer), every node that appears on an edge: the set of nodes on a cycle (a self-link
// is a cycle of one), and a checker for a reported path "a -> b -> ... -> a".
export function cycleFacts(inst: Instance): { onCycle: Set<string>; comp: Map<string, string>; isPath: (cyc: string[]) => boolean } {
  const succ = new Map<string, Set<string>>(), nodes = new Set<string>();
  for (const e of liveEdges(inst)) {
    nodes.add(e.consumer); nodes.add(e.producer);
    if (!succ.has(e.consumer)) succ.set(e.consumer, new Set());
    (succ.get(e.consumer) as Set<string>).add(e.producer); // set on the line above
  }
  const r = reach([...nodes], succ);
  const onCycle = new Set([...nodes].filter((x) => (r.get(x) as Set<string>).has(x))); // every node of `nodes` is a key of r
  // strongly connected component of each cyclic node: the cyclic nodes it reaches and that reach it
  const comp = new Map<string, string>();
  for (const x of onCycle) comp.set(x, [...onCycle].filter((y) => y === x || ((r.get(x) as Set<string>).has(y) && (r.get(y) as Set<string>).has(x))).sort().join('|'));
  const isPath = (cyc: string[]): boolean => cyc.length >= 1 && cyc.every((x, i) => succ.get(x)?.has(cyc[(i + 1) % cyc.length])) && new Set(cyc).size === cyc.length;
  return { onCycle, comp, isPath };
}

// ---- whatif oracle: the single-ticket move rule (see whatif.assure.ts for the full statement) ----
export function personsOf(inst: Instance, extra: string[] = []): Set<string> {
  const s = new Set<string>(extra);
  for (const p of inst.sched.values()) if (p && p.owner) s.add(p.owner);
  for (const k of Object.keys((inst.config && inst.config.caps) || {})) if (k !== 'default') s.add(k);
  return s;
}

// ---- ready oracle (CONTRACT `brain ready`, docs/OPENITEMS.md, FORMAT section 6) ----
// A ticket may start now when: (1) it is not already done: an sp: task whose impl_status is done, or a Jira ticket whose status (the snapshot's when
// the snapshot names it, else its jira_status) is Done or in config.closed_statuses (wave B: a closed ticket is "DONE", never "ready to start");
// (2) its verdict is empty or READY; (3) no finding of it is open (a finding is closed by an open-items row {key, kind, status:'done'});
// (4) no open-items row for it is open (status other than 'done'); (5) every producer over a live link that is a known ticket is done:
// an sp: producer (whatever the consumer is) is done when its impl_status is 'done'; any other producer when its status (the snapshot's
// when the snapshot names it, else the ticket's jira_status) is 'Done' or in config.closed_statuses. A producer that is not a ticket
// (dangling) does not block, and a done producer never blocks, wherever it sits.
export function oracleReady(inst: ReadyInstance, items: OItem[] = [], snapshot: OSnapshot | null = null): Set<string> {
  const tk = new Map(inst.tickets.map((t) => [t.key, t]));
  const closed = new Set(items.filter((i) => i.status === 'done').map((i) => JSON.stringify([i.key, i.kind])));
  const res = new Set<string>();
  const sp = (k: string): boolean => String(k).startsWith('sp:');
  for (const t of inst.tickets) {
    if (sp(t.key) && t.impl_status === 'done') continue;
    if (!sp(t.key)) { const own = snapshot && has(snapshot, t.key) ? snapshot[t.key]?.status : t.jira_status; if (own === 'Done' || (inst.config?.closed_statuses || []).includes(own as string)) continue; }
    if (t.verdict && t.verdict !== 'READY') continue;
    if ((inst.findings || []).some((f) => f.key === t.key && !closed.has(JSON.stringify([f.key, f.kind])))) continue;
    if (items.some((i) => i.key === t.key && i.status !== 'done')) continue;
    let ok = true;
    for (const e of liveEdges(inst)) {
      if (e.consumer !== t.key || !tk.has(e.producer)) continue;
      const p = tk.get(e.producer) as OTicket; // tk.has(e.producer) held above
      if (sp(p.key)) { if (p.impl_status !== 'done') ok = false; continue; }
      const st = snapshot && has(snapshot, p.key) ? snapshot[p.key]?.status : p.jira_status;
      if (st !== 'Done' && !(inst.config?.closed_statuses || []).includes(st as string)) ok = false;
    }
    if (ok) res.add(t.key);
  }
  return res;
}

// ---- bulk ready oracle (`brain ready --person NAME --sprint N`, CONTRACT) ----
// Scope: the tickets whose current placement is valid and has that owner (exact) and/or that sprint (at least one filter). Within it each
// ticket is exactly one of: ready (oracleReady), done (its own status closed, as in (1) above), not ready. A not-ready ticket is in every
// group whose cause it has: verdict (a verdict other than READY), openItems (an open finding or an open register row), waiting (a live
// producer that is a known ticket and is not done by the producer rule of (5): an sp: producer by impl_status for any consumer). Done
// tickets are in no group.
export function oracleReadyScope(inst: ReadyInstance, items: OItem[], snapshot: OSnapshot | null, { owner, sprint }: { owner?: string; sprint?: number }): ReadyScope {
  const tk = new Map(inst.tickets.map((t) => [t.key, t])), sched = inst.sched || new Map();
  const sp = (k: string): boolean => String(k).startsWith('sp:');
  const statusOf = (t: OTicket): string | undefined => (snapshot && has(snapshot, t.key) ? snapshot[t.key]?.status : t.jira_status);
  const closedList = ['Done', ...((inst.config && inst.config.closed_statuses) || [])];
  const isDone = (t: OTicket): boolean => (sp(t.key) ? t.impl_status === 'done' : closedList.includes(statusOf(t) as string));
  const shut = new Set(items.filter((i) => i.status === 'done').map((i) => JSON.stringify([i.key, i.kind])));
  const ready = oracleReady(inst, items, snapshot);
  const out: ReadyScope = { keys: [], ready: [], done: [], notReady: [], waiting: [], openItems: [], verdict: [] };
  for (const t of [...inst.tickets].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))) {
    const p = sched.get(t.key);
    if (!validPlacement(p) || (owner !== undefined && p.owner !== owner) || (sprint !== undefined && p.sprint !== sprint)) continue;
    if (out.keys.includes(t.key)) continue; // a duplicate ticket row counts once
    out.keys.push(t.key);
    if (isDone(t)) { out.done.push(t.key); continue; }
    if (ready.has(t.key)) { out.ready.push(t.key); continue; }
    out.notReady.push(t.key);
    if (t.verdict && t.verdict !== 'READY') out.verdict.push(t.key);
    if ((inst.findings || []).some((f) => f.key === t.key && !shut.has(JSON.stringify([f.key, f.kind]))) || items.some((i) => i.key === t.key && i.status !== 'done')) out.openItems.push(t.key);
    const waits = liveEdges(inst).some((e) => {
      if (e.consumer !== t.key || !tk.has(e.producer)) return false;
      const q = tk.get(e.producer) as OTicket; // tk.has(e.producer) held above
      if (sp(q.key)) return q.impl_status !== 'done';
      return !closedList.includes(statusOf(q) as string);
    });
    if (waits) out.waiting.push(t.key);
  }
  return out;
}

// ---- graph closure oracle (docs/STALE.md): stale = everything reachable from a changed ticket through consumers, any depth ----
// edges: [[consumer, producer]]; seeds: changed tickets. Returns the set of nodes reachable from the seeds along producer -> consumer.
export function consumerClosure(edges: Array<[string, string]>, seeds: Iterable<string>): Set<string> {
  const out = new Set(seeds), stack = [...seeds];
  while (stack.length) { const p = stack.pop(); for (const [c, q] of edges) if (q === p && !out.has(c)) { out.add(c); stack.push(c); } }
  return out;
}
