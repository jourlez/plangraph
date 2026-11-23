// Independent plan verifier. Shares no code with any solver or with lib/whatif.mjs (only capOf, a one-line config lookup).
// verifyPlan(model, sched = model.sched, opts) -> [{code,key,detail}] sorted by (code order, key, detail); [] means the plan is valid.
// opts: { frozen: Map key->{owner,sprint}, enforceMin: bool }. O(V+E).
// Conventions: HANDOFF key = consumer; CAPACITY/MINLOAD key = "Person S<n>"; CYCLE key = smallest ticket key on the cycle, detail = path;
// BEFORE_FIRST key = ticket; CONFIG key = the config field.
// Frozen history (lib/frozen.mjs states the rule once; bin/brain-solve verify() applies the same): frozen = closed (Done, closed_statuses, an
// sp: task with impl_status done), jira_status in config.frozen_statuses, a key of opts.frozen, or current sprint below
// config.frozen_before_sprint. A constraint exists only where at least one side is free: no HANDOFF when the producer is closed or both ends
// are frozen; CAPACITY only for a cell above cap that holds a free ticket with story points (free load must fit in max(0, cap - frozen load)).
// First-sprint window (the rule of bin/brain-solve verify(), checked against it by test/verify.test.mjs): a FREE ticket placed before
// config.first_sprint (default 1) is BEFORE_FIRST; frozen tickets keep their own slot, even below it. A first_sprint that is not a whole
// number within +-1000000 is one CONFIG violation, and the window (and MINLOAD) is then not checked.
// Key namespace rule: a key starting with `sp:` is a superpowers implementation task (or its plan epic). It is placed only when someone
// assigns it, so an sp: ticket without a placement is NOT reported UNPLACED; once placed it is verified like any other ticket.
import { capOf, ownNumber } from './model.mjs';
import { frozenTest, linkBinds } from './frozen.mjs';

const ORDER = ['CONFIG', 'UNKNOWN_TICKET', 'UNPLACED', 'BEFORE_FIRST', 'HANDOFF', 'CAPACITY', 'FROZEN_MOVED', 'MINLOAD', 'CYCLE'];
const MAX_SPAN = 1000; // MINLOAD checks at most this many sprints after first_sprint
const spOf = (t) => (t && Number.isFinite(t.sp) ? t.sp : 0);
const isSpKey = (k) => String(k).startsWith('sp:');
const placed = (p) => p && typeof p.owner === 'string' && p.owner !== '' && Number.isInteger(p.sprint);

// load[person][sprint] = story points, over valid placements of known tickets.
function loadsOf(model, sched) {
  const load = new Map();
  for (const [k, p] of sched) {
    const t = model.tickets.get(k);
    if (!t || !placed(p)) continue;
    if (!load.has(p.owner)) load.set(p.owner, new Map());
    const m = load.get(p.owner);
    m.set(p.sprint, (m.get(p.sprint) || 0) + spOf(t));
  }
  return load;
}

export function verifyPlan(model, sched = model.sched, opts = {}) {
  const out = [];
  const add = (code, key, detail) => out.push({ code, key, detail });
  for (const k of sched.keys()) if (!model.tickets.has(k)) add('UNKNOWN_TICKET', k, 'placed but not in tickets');
  for (const k of model.tickets.keys()) if (!placed(sched.get(k)) && !isSpKey(k)) add('UNPLACED', k, 'no valid owner/sprint');
  const at = (k) => { const p = sched.get(k); return model.tickets.has(k) && placed(p) ? p : null; };
  const cfg = model.config || {};

  let first = 1, firstOk = true;
  if (cfg.first_sprint !== undefined) {
    if (Number.isSafeInteger(cfg.first_sprint) && Math.abs(cfg.first_sprint) <= 1e6) first = cfg.first_sprint;
    else { firstOk = false; add('CONFIG', 'first_sprint', 'must be a whole number from -1000000 to 1000000'); }
  }
  const frozen = frozenTest(model, opts);
  if (firstOk) for (const k of sched.keys()) { const p = at(k); if (p && p.sprint < first && !frozen(k)) add('BEFORE_FIRST', k, `sprint ${p.sprint} before the first sprint ${first}`); }

  for (const [c, ps] of model.prods) {
    const pc = at(c); if (!pc) continue;
    for (const p of ps) {
      const pp = at(p); if (!pp || !linkBinds(model, frozen, c, p)) continue;
      const need = pp.sprint + (pp.owner !== pc.owner ? 1 : 0);
      if (pc.sprint < need) add('HANDOFF', c, `producer ${p} S${pp.sprint} ${pp.owner}, consumer ${c} S${pc.sprint} ${pc.owner}, consumer needs >=S${need}`);
    }
  }

  const load = loadsOf(model, sched), withFree = new Set(); // cells holding a free ticket with story points
  for (const [k, p] of sched) if (model.tickets.has(k) && placed(p) && spOf(model.tickets.get(k)) > 0 && !frozen(k)) withFree.add(`${p.owner}\t${p.sprint}`);
  for (const [person, m] of load) for (const [s, v] of m) {
    const cap = capOf(model.config, person);
    if (v > cap && withFree.has(`${person}\t${s}`)) add('CAPACITY', `${person} S${s}`, `${v}/${cap}`);
  }

  if (opts.frozen) for (const [k, f] of opts.frozen) {
    const p = sched.get(k);
    if (!p || p.owner !== f.owner || p.sprint !== f.sprint) add('FROZEN_MOVED', k, `was ${f.owner} S${f.sprint}, now ${p ? `${p.owner} S${p.sprint}` : 'unplaced'}`);
  }

  const mins = cfg.min_per_sprint || {};
  if (opts.enforceMin && firstOk) {
    const people = new Set([...load.keys(), ...Object.keys(mins).filter((x) => x !== 'default')]);
    let maxS = 0; for (const p of sched.values()) if (placed(p) && p.sprint > maxS) maxS = p.sprint;
    // only people with a minimum > 0 are checked; with none there is no loop to bound and nothing to report
    const checked = [...people].sort().filter((person) => ownNumber(mins, person, 0) > 0);
    const spanOk = maxS - first <= MAX_SPAN; // a huge sprint number in data must not turn into a huge loop
    if (!spanOk && checked.length) add('CONFIG', 'sprint span', `placed sprints span more than ${MAX_SPAN} from first_sprint; MINLOAD not checked`);
    for (const person of spanOk ? checked : []) {
      const min = ownNumber(mins, person, 0);
      for (let s = first; s <= maxS; s++) {
        const v = load.get(person)?.get(s) || 0;
        if (v < min) add('MINLOAD', `${person} S${s}`, `${v}/${min}`);
      }
    }
  }

  // Cycles: iterative DFS over consumer -> producer, one report per back edge, canonical rotation, deduplicated.
  const color = new Map(), seen = new Set();
  for (const root of [...model.prods.keys()].sort()) {
    if (color.get(root)) continue;
    const stack = [[root, 0]], path = [root]; color.set(root, 1);
    while (stack.length) {
      const top = stack[stack.length - 1], ps = model.prods.get(top[0]) || [];
      if (top[1] >= ps.length) { color.set(top[0], 2); stack.pop(); path.pop(); continue; }
      const n = ps[top[1]++], cn = color.get(n);
      if (cn === 1) {
        let cyc = path.slice(path.indexOf(n));
        const mi = cyc.reduce((b, x, i) => (x < cyc[b] ? i : b), 0);
        cyc = [...cyc.slice(mi), ...cyc.slice(0, mi)];
        const id = cyc.join('>');
        if (!seen.has(id)) { seen.add(id); add('CYCLE', cyc[0], [...cyc, cyc[0]].join(' -> ')); }
      } else if (!cn) { color.set(n, 1); stack.push([n, 0]); path.push(n); }
    }
  }

  return out.sort((a, b) => ORDER.indexOf(a.code) - ORDER.indexOf(b.code) || (a.key < b.key ? -1 : a.key > b.key ? 1 : a.detail < b.detail ? -1 : a.detail > b.detail ? 1 : 0));
}

// summarize(model, sched, opts): { end_sprint, owner_changes_vs_baseline, load:{person:{sprint:points}} }.
// Baseline owner = opts.baseline (Map key->owner) or ticket.v2_owner; tickets without a baseline owner are not counted.
export function summarize(model, sched = model.sched, opts = {}) {
  let end = 0, changes = 0;
  for (const [k, p] of sched) {
    if (!placed(p)) continue;
    if (p.sprint > end) end = p.sprint;
    const base = opts.baseline ? opts.baseline.get(k) : model.tickets.get(k)?.v2_owner;
    if (base != null && base !== p.owner) changes++;
  }
  const load = {};
  const all = loadsOf(model, sched);
  for (const person of [...all.keys()].sort()) {
    const m = all.get(person); load[person] = {};
    for (const s of [...m.keys()].sort((a, b) => a - b)) load[person][s] = m.get(s);
  }
  return { end_sprint: end, owner_changes_vs_baseline: changes, load };
}
