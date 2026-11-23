// Clean-room oracles for the exhaustive small-scope suite. Written from docs/CONTRACT.md, docs/FORMAT.md, docs/STALE.md and the
// documented header rules of each module, NOT from the library code. This file imports nothing from lib/ or src/: a shared helper would
// let one bug hide in both sides. Every function takes plain data (arrays, objects, Maps of plain values) and returns plain data.
//
// Instance shape (the enumerators in enum.mjs build these, and the property files turn them into a lib model with buildModel):
//   { tickets: [{key, sp, jira_status?, impl_status?, verdict?}], edges: [{consumer, producer, kind?}],
//     sched: Map key -> {owner, sprint} (the current schedule; may hold keys that are not tickets, or invalid placements),
//     config: {...config.json}, frozen?: Map key -> {owner, sprint}, enforceMin?: boolean }

const has = (o, k) => o !== null && typeof o === 'object' && Object.hasOwn(o, k);
const finiteNum = (v) => typeof v === 'number' && Number.isFinite(v);

// Capacity of a person (CONTRACT: `config.caps[person] ?? config.caps.default`; 140 when neither is a number, the documented default).
export function capFor(config, person) {
  const caps = config && config.caps;
  if (has(caps, person) && finiteNum(caps[person])) return caps[person];
  if (has(caps, 'default') && finiteNum(caps.default)) return caps.default;
  return 140;
}
export function minFor(config, person) {
  const m = config && config.min_per_sprint;
  if (has(m, person) && finiteNum(m[person])) return m[person];
  if (has(m, 'default') && finiteNum(m.default)) return m.default;
  return 0;
}
// A placement is valid when the owner is a non-empty string and the sprint a whole number.
export const validPlacement = (p) => !!p && typeof p.owner === 'string' && p.owner.length > 0 && Number.isInteger(p.sprint);
const storyPoints = (t) => (t && finiteNum(t.sp) ? t.sp : 0);

// Edges that count: every edge whose kind is not in config.ignore_link_kinds (duplicates kept; they are the same rule twice).
export function liveEdges(inst) {
  const skip = new Set((inst.config && inst.config.ignore_link_kinds) || []);
  return inst.edges.filter((e) => !skip.has(e.kind));
}

// Frozen rule (CONTRACT + verify header): a ticket keeps its slot when its jira_status is Done, in config.closed_statuses or in
// config.frozen_statuses, when it is a key of opts.frozen, or when its CURRENT sprint is below config.frozen_before_sprint.
export function isFrozenForWindow(inst, key) {
  const cfg = inst.config || {};
  const t = inst.tickets.find((x) => x.key === key);
  const st = t ? t.jira_status || '' : '';
  const statuses = ['Done'];
  if (Array.isArray(cfg.closed_statuses)) statuses.push(...cfg.closed_statuses);
  if (Array.isArray(cfg.frozen_statuses)) statuses.push(...cfg.frozen_statuses);
  if (statuses.includes(st)) return true;
  if (inst.frozen && inst.frozen.has(key)) return true;
  const cur = inst.sched.get(key);
  return finiteNum(cfg.frozen_before_sprint) && validPlacement(cur) && cur.sprint < cfg.frozen_before_sprint;
}

// All elementary facts about cycles that the oracle needs: does node x reach node y (consumer -> producer direction)?
export function reach(nodes, succ) {
  const r = new Map();
  for (const s of nodes) {
    const seen = new Set(), stack = [...(succ.get(s) || [])];
    while (stack.length) { const x = stack.pop(); if (seen.has(x)) continue; seen.add(x); for (const y of succ.get(x) || []) stack.push(y); }
    r.set(s, seen);
  }
  return r;
}

// The plan-rule oracle. Returns { list: [{code, key, producer?}], cyclic: Set of nodes on some cycle }.
// Rule sources: CONTRACT "Strict handoff rule", caps; verify header for BEFORE_FIRST, FROZEN_MOVED, MINLOAD, UNPLACED, UNKNOWN_TICKET, CONFIG.
// CYCLE is checked separately by cycleFacts (the spec fixes WHICH loops exist, not which one representative is printed).
export function oracleViolations(inst, sched = inst.sched) {
  const out = [];
  const cfg = inst.config || {};
  const tk = new Map(inst.tickets.map((t) => [t.key, t]));
  for (const k of sched.keys()) if (!tk.has(k)) out.push({ code: 'UNKNOWN_TICKET', key: k });
  for (const t of inst.tickets) if (!validPlacement(sched.get(t.key)) && !String(t.key).startsWith('sp:')) out.push({ code: 'UNPLACED', key: t.key });
  const slot = (k) => (tk.has(k) && validPlacement(sched.get(k)) ? sched.get(k) : null);

  let first = 1, firstOk = true;
  if (cfg.first_sprint !== undefined) {
    const f = cfg.first_sprint;
    if (typeof f === 'number' && Number.isInteger(f) && f >= -1000000 && f <= 1000000) first = f;
    else { firstOk = false; out.push({ code: 'CONFIG', key: 'first_sprint' }); }
  }
  if (firstOk) for (const k of sched.keys()) { const p = slot(k); if (p && p.sprint < first && !isFrozenForWindow(inst, k)) out.push({ code: 'BEFORE_FIRST', key: k }); }

  for (const e of liveEdges(inst)) {
    const pc = slot(e.consumer), pp = slot(e.producer);
    if (!pc || !pp) continue;
    const need = pp.sprint + (pp.owner === pc.owner ? 0 : 1);
    if (pc.sprint < need) out.push({ code: 'HANDOFF', key: e.consumer, producer: e.producer });
  }

  const load = new Map();
  for (const [k, p] of sched) {
    if (!slot(k)) continue;
    const id = JSON.stringify([p.owner, p.sprint]);
    load.set(id, (load.get(id) || 0) + storyPoints(tk.get(k)));
  }
  for (const [id, v] of load) { const [o, s] = JSON.parse(id); if (v > capFor(cfg, o)) out.push({ code: 'CAPACITY', key: `${o} S${s}` }); }

  if (inst.frozen) for (const [k, f] of inst.frozen) { const p = sched.get(k); if (!p || p.owner !== f.owner || p.sprint !== f.sprint) out.push({ code: 'FROZEN_MOVED', key: k }); }

  if (inst.enforceMin && firstOk) {
    const persons = new Set();
    for (const id of load.keys()) persons.add(JSON.parse(id)[0]);
    for (const p of Object.keys(cfg.min_per_sprint || {})) if (p !== 'default') persons.add(p);
    let last = 0;
    for (const p of sched.values()) if (validPlacement(p) && p.sprint > last) last = p.sprint;
    if (last - first > 1000) out.push({ code: 'CONFIG', key: 'sprint span' });
    else for (const person of persons) {
      const min = minFor(cfg, person);
      if (!(min > 0)) continue;
      for (let s = first; s <= last; s++) { const v = load.get(JSON.stringify([person, s])) || 0; if (v < min) out.push({ code: 'MINLOAD', key: `${person} S${s}` }); }
    }
  }
  return out;
}

// Cycle facts over the live edges (consumer -> producer), every node that appears on an edge: the set of nodes on a cycle (a self-link
// is a cycle of one), and a checker for a reported path "a -> b -> ... -> a".
export function cycleFacts(inst) {
  const succ = new Map(), nodes = new Set();
  for (const e of liveEdges(inst)) {
    nodes.add(e.consumer); nodes.add(e.producer);
    if (!succ.has(e.consumer)) succ.set(e.consumer, new Set());
    succ.get(e.consumer).add(e.producer);
  }
  const r = reach([...nodes], succ);
  const onCycle = new Set([...nodes].filter((x) => r.get(x).has(x)));
  // strongly connected component of each cyclic node: the cyclic nodes it reaches and that reach it
  const comp = new Map();
  for (const x of onCycle) comp.set(x, [...onCycle].filter((y) => y === x || (r.get(x).has(y) && r.get(y).has(x))).sort().join('|'));
  const isPath = (cyc) => cyc.length >= 1 && cyc.every((x, i) => succ.get(x)?.has(cyc[(i + 1) % cyc.length])) && new Set(cyc).size === cyc.length;
  return { onCycle, comp, isPath };
}

// ---- whatif oracle: the single-ticket move rule (see whatif.assure.mjs for the full statement) ----
export function personsOf(inst, extra = []) {
  const s = new Set(extra);
  for (const p of inst.sched.values()) if (p && p.owner) s.add(p.owner);
  for (const k of Object.keys((inst.config && inst.config.caps) || {})) if (k !== 'default') s.add(k);
  return s;
}

// ---- ready oracle (CONTRACT `brain ready`, docs/OPENITEMS.md, FORMAT section 6) ----
// A ticket may start now when: (1) it is not already done: an sp: task whose impl_status is done, or a Jira ticket whose status (the snapshot's when
// the snapshot names it, else its jira_status) is Done or in config.closed_statuses (wave B: a closed ticket is "DONE", never "ready to start");
// (2) its verdict is empty or READY; (3) no finding of it is open (a finding is closed by an open-items row {key, kind, status:'done'});
// (4) no open-items row for it is open (status other than 'done'); (5) every producer over a live link that is a known ticket is done:
// for an sp: consumer and sp: producer, the producer's impl_status is 'done'; otherwise the producer's status (the snapshot's when the
// snapshot names it, else the ticket's jira_status) is exactly 'Done'. A producer that is not a ticket (dangling) does not block.
export function oracleReady(inst, items = [], snapshot = null) {
  const tk = new Map(inst.tickets.map((t) => [t.key, t]));
  const closed = new Set(items.filter((i) => i.status === 'done').map((i) => JSON.stringify([i.key, i.kind])));
  const res = new Set();
  const sp = (k) => String(k).startsWith('sp:');
  for (const t of inst.tickets) {
    if (sp(t.key) && t.impl_status === 'done') continue;
    if (!sp(t.key)) { const own = snapshot && has(snapshot, t.key) ? snapshot[t.key]?.status : t.jira_status; if (own === 'Done' || (inst.config?.closed_statuses || []).includes(own)) continue; }
    if (t.verdict && t.verdict !== 'READY') continue;
    if ((inst.findings || []).some((f) => f.key === t.key && !closed.has(JSON.stringify([f.key, f.kind])))) continue;
    if (items.some((i) => i.key === t.key && i.status !== 'done')) continue;
    let ok = true;
    for (const e of liveEdges(inst)) {
      if (e.consumer !== t.key || !tk.has(e.producer)) continue;
      const p = tk.get(e.producer);
      if (sp(t.key) && sp(p.key)) { if (p.impl_status !== 'done') ok = false; continue; }
      const st = snapshot && has(snapshot, p.key) ? snapshot[p.key]?.status : p.jira_status;
      if (st !== 'Done' && !(inst.config?.closed_statuses || []).includes(st)) ok = false;
    }
    if (ok) res.add(t.key);
  }
  return res;
}

// ---- bulk ready oracle (`brain ready --person NAME --sprint N`, CONTRACT) ----
// Scope: the tickets whose current placement is valid and has that owner (exact) and/or that sprint (at least one filter). Within it each
// ticket is exactly one of: ready (oracleReady), done (its own status closed, as in (1) above), not ready. A not-ready ticket is in every
// group whose cause it has: verdict (a verdict other than READY), openItems (an open finding or an open register row), waiting (a live
// producer that is a known ticket and is not done by the producer rule of (5)). Done tickets are in no group.
/** @param {any} inst @param {any[]} items @param {any} snapshot @param {{ owner?: string, sprint?: number }} filter */
export function oracleReadyScope(inst, items, snapshot, { owner, sprint }) {
  const tk = new Map(inst.tickets.map((t) => [t.key, t])), sched = inst.sched || new Map();
  const sp = (k) => String(k).startsWith('sp:');
  const statusOf = (t) => (snapshot && has(snapshot, t.key) ? snapshot[t.key]?.status : t.jira_status);
  const closedList = ['Done', ...((inst.config && inst.config.closed_statuses) || [])];
  const isDone = (t) => (sp(t.key) ? t.impl_status === 'done' : closedList.includes(statusOf(t)));
  const shut = new Set(items.filter((i) => i.status === 'done').map((i) => JSON.stringify([i.key, i.kind])));
  const ready = oracleReady(inst, items, snapshot);
  const out = { keys: [], ready: [], done: [], notReady: [], waiting: [], openItems: [], verdict: [] };
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
      const q = tk.get(e.producer);
      if (sp(t.key) && sp(q.key)) return q.impl_status !== 'done';
      return !closedList.includes(statusOf(q));
    });
    if (waits) out.waiting.push(t.key);
  }
  return out;
}

// ---- graph closure oracle (docs/STALE.md): stale = everything reachable from a changed ticket through consumers, any depth ----
// edges: [[consumer, producer]]; seeds: changed tickets. Returns the set of nodes reachable from the seeds along producer -> consumer.
export function consumerClosure(edges, seeds) {
  const out = new Set(seeds), stack = [...seeds];
  while (stack.length) { const p = stack.pop(); for (const [c, q] of edges) if (q === p && !out.has(c)) { out.add(c); stack.push(c); } }
  return out;
}
