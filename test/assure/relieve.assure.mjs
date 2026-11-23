// Property (i): lib/whatif.mjs relieve (`brain whatif --relieve PERSON --sprint N`) against a clean-room brute force, on EVERY instance.
//
// The specified rule (docs/CONTRACT.md "Relieve"), stated here once, written from the contract and not from the library:
//   cell = the tickets placed with owner PERSON in sprint N; load = their story points; cap = capFor(config, PERSON). load <= cap: nothing
//   to relieve. Movable: the cell's tickets that are not frozen (oracle.mjs isFrozenForWindow: closed, an sp: task with impl_status done,
//   config.frozen_statuses as listed (no default), N below config.frozen_before_sprint). Slots of a movable
//   ticket: PERSON in every sprint N+1..end; with allowEarlier PERSON in first..N-1; with allowOwnerChange every other person (an owner in the
//   schedule or a caps key other than default) in N..end (first..end with allowEarlier). first = first_sprint ?? 1, end = end_sprint ?? the
//   last sprint used. Frozen history (oracle.mjs): the cell needs relief only when its FREE load does not fit in max(0, cap - stay load),
//   stay load = the story points of its tickets that are not movable; a cell above cap by those alone needs none. A set of moves (each
//   movable ticket stays or takes one slot) is VALID when, applied together: the free load left fits in max(0, cap - stay load); every live
//   link with a moved ticket at either end, other end a ticket with a valid placement, satisfies the strict handoff rule unless its producer
//   is closed (oracle.mjs isClosedTicket: a closed producer satisfies its links); every
//   cell whose load grew ends <= its owner's cap; the multiset of oracle violations after is contained in the one before. BEST: fewest moves,
//   then least total |to sprint - N|, then fewest owner changes, then the moves sorted by key compared by (key, owner, sprint).
// Checked on every instance and every flag combination: the library's status equals the oracle's (nothing to relieve / relief / none);
// a relief is EXACTLY the oracle's best set (so it is minimal by brute force, and deterministic tie-breaking holds), its after-load, slip
// and owner changes match, it passes the oracle validity on its own, the search is complete (the family is far below the budget); order
// 'sequential' means each move, applied in the returned order, is a YES of the clean-room whatif oracle (whatif.assure.mjs oracleMove) on
// the plan so far, and 'together' means no order of the moves has that property (all permutations tried); a no-relief answer lists every
// frozen ticket of the cell under FROZEN; repeated calls give deep-equal results.
// Families (BOUNDS): tickets T1..Tn, T1 and T2 in Ana S2, T3 (n = 3) in Ana S2, Ana S3, Ben S2 or Ben S1; every graph (self-links
// included) x every story-point vector in {0,1,2} x T2 To Do, In Progress or Done (a closed producer or consumer: frozen history) x end_sprint 2 or 3 x the four flag combinations; caps 2.
// NOT covered: instances beyond BOUNDS; the budget fallback (test/whatif-relieve.test.mjs hits it on purpose); the text and --json of
// the CLI (test/whatif-relieve.test.mjs, goldens); moves of tickets outside the cell (outside the move space by design); MINLOAD
// (verify runs without --enforce-min); closed_statuses, frozen_before_sprint and sp: keys (the library reads them, this family does not vary them).
import assert from 'node:assert/strict';
import { buildModel } from '../../lib/model.mjs';
import { relieve } from '../../lib/whatif.mjs';
import { oracleViolations, capFor, validPlacement, liveEdges, personsOf, isClosedTicket, isFrozenForWindow } from './oracle.mjs';
import { product, allGraphs, keysOf, bag } from './enum.mjs';
import { oracleMove } from './whatif.assure.mjs';

export const BOUNDS = {
  full: { n: [2, 3], ends: [2, 3] },
  quick: { n: [2, 3], ends: [2] },
};
const P = 'Ana', N = 2;
const spv = (t) => (t && typeof t.sp === 'number' && Number.isFinite(t.sp) ? t.sp : 0);
const tget = (inst, k) => inst.tickets.find((t) => t.key === k);
const cellLoad = (inst, sched, o, s) => { let v = 0; for (const [k, p] of sched) if (tget(inst, k) && validPlacement(p) && p.owner === o && p.sprint === s) v += spv(tget(inst, k)); return v; };
const vsig = (v) => (v.code === 'HANDOFF' ? `HANDOFF|${v.key}|${v.producer}` : `${v.code}|${v.key}`);

// movable = not frozen (oracle.mjs, the one frozen rule: closed, frozen_statuses as config lists them, a current sprint below frozen_before_sprint)
const frozenOf = (inst, k) => isFrozenForWindow(inst, k);
// the story points of the cell's tickets that cannot move (they stay in any relief)
const stayLoad = (inst) => { let v = 0; for (const [k, p] of inst.sched) if (tget(inst, k) && validPlacement(p) && p.owner === P && p.sprint === N && frozenOf(inst, k)) v += spv(tget(inst, k)); return v; };
// does the cell (P, N) of `sched` hold free load that does not fit in max(0, cap - stay load)?
const needsRelief = (inst, sched) => { const z = stayLoad(inst), f = cellLoad(inst, sched, P, N) - z, cap = capFor(inst.config, P); return f > 0 && f > Math.max(0, cap - z); };
function valid(inst, after, moved, before) {
  if (needsRelief(inst, after)) return false;
  for (const e of liveEdges(inst)) {
    if (!moved.has(e.consumer) && !moved.has(e.producer)) continue;
    const c = after.get(e.consumer), p = after.get(e.producer);
    if (!tget(inst, e.consumer) || !tget(inst, e.producer) || !validPlacement(c) || !validPlacement(p) || isClosedTicket(inst, e.producer)) continue;
    if (c.sprint < p.sprint + (c.owner === p.owner ? 0 : 1)) return false;
  }
  const cells = new Set([...moved].map((k) => JSON.stringify([after.get(k).owner, after.get(k).sprint])));
  for (const id of cells) { const [o, s] = JSON.parse(id); if (cellLoad(inst, after, o, s) > cellLoad(inst, inst.sched, o, s) && cellLoad(inst, after, o, s) > capFor(inst.config, o)) return false; }
  const left = [...before];
  for (const x of oracleViolations({ ...inst, sched: after }, after).map(vsig)) { const i = left.indexOf(x); if (i < 0) return false; left.splice(i, 1); }
  return true;
}
const cmpMoves = (a, b) => {
  for (let i = 0; i < a.length; i++) {
    if (a[i].key !== b[i].key) return a[i].key < b[i].key ? -1 : 1;
    if (a[i].to.owner !== b[i].to.owner) return a[i].to.owner < b[i].to.owner ? -1 : 1;
    if (a[i].to.sprint !== b[i].to.sprint) return a[i].to.sprint - b[i].to.sprint;
  }
  return 0;
};
/** The brute force: { status, best? } over every assignment of the movable cell tickets. */
export function oracleRelieve(inst, flags) {
  const cfg = inst.config || {}, cap = capFor(cfg, P), load = cellLoad(inst, inst.sched, P, N);
  if (!needsRelief(inst, inst.sched)) return { status: 'none_needed' };
  let used = 0; for (const p of inst.sched.values()) if (p.sprint > used) used = p.sprint;
  const first = cfg.first_sprint ?? 1, end = cfg.end_sprint ?? used;
  const cell = inst.tickets.map((t) => t.key).filter((k) => { const p = inst.sched.get(k); return validPlacement(p) && p.owner === P && p.sprint === N; }).sort();
  const movable = cell.filter((k) => !frozenOf(inst, k)), others = [...personsOf(inst)].filter((q) => q !== P).sort();
  const slots = [];
  for (let s = N + 1; s <= end; s++) slots.push({ owner: P, sprint: s });
  if (flags.allowEarlier) for (let s = first; s < N; s++) slots.push({ owner: P, sprint: s });
  if (flags.allowOwnerChange) for (const q of others) for (let s = flags.allowEarlier ? first : N; s <= end; s++) slots.push({ owner: q, sprint: s });
  const before = bag(oracleViolations(inst).map(vsig));
  let best = null;
  product(movable.map(() => [null, ...slots]), (ch) => {
    const moves = [], after = new Map(inst.sched);
    movable.forEach((k, i) => { if (ch[i]) { after.set(k, ch[i]); moves.push({ key: k, sp: spv(tget(inst, k)), from: { owner: P, sprint: N }, to: { owner: ch[i].owner, sprint: ch[i].sprint } }); } });
    if (!moves.length || !valid(inst, after, new Set(moves.map((m) => m.key)), before)) return;
    const c = { moves, k: moves.length, slip: moves.reduce((a, m) => a + Math.abs(m.to.sprint - N), 0), oc: moves.filter((m) => m.to.owner !== P).length };
    if (!best || c.k < best.k || (c.k === best.k && (c.slip < best.slip || (c.slip === best.slip && (c.oc < best.oc || (c.oc === best.oc && cmpMoves(c.moves, best.moves) < 0)))))) best = c;
  });
  return best ? { status: 'relief', best, load, cap, frozen: cell.filter((k) => frozenOf(inst, k)) } : { status: 'no_relief', frozen: cell.filter((k) => frozenOf(inst, k)) };
}

function* instances(B) {
  const FLAGS = [{}, { allowEarlier: true }, { allowOwnerChange: true }, { allowEarlier: true, allowOwnerChange: true }];
  const T3 = [{ owner: 'Ana', sprint: 2 }, { owner: 'Ana', sprint: 3 }, { owner: 'Ben', sprint: 2 }, { owner: 'Ben', sprint: 1 }];
  for (const n of B.n) {
    const keys = keysOf(n);
    for (const g of allGraphs(keys)) for (const third of n === 3 ? T3 : [null]) for (const end of B.ends) {
      const sps = []; product(keys.map(() => [0, 1, 2]), (v) => sps.push(v));
      for (const sp of sps) for (const st2 of ['To Do', 'In Progress', 'Done']) {
        const sched = new Map([['T1', { owner: P, sprint: N }], ['T2', { owner: P, sprint: N }]]);
        if (third && third.sprint <= end) sched.set('T3', third); else if (third) continue;
        const tickets = keys.map((key, i) => ({ key, sp: sp[i], jira_status: key === 'T2' ? st2 : 'To Do' }));
        const inst = { tickets, edges: g.map(([consumer, producer]) => ({ consumer, producer, kind: 'plan_need' })), sched, config: { first_sprint: 1, end_sprint: end, caps: { default: 2, Ben: 2 }, frozen_statuses: ['Done', 'In Progress'] } };
        for (const flags of FLAGS) yield { inst, flags };
      }
    }
  }
}
const fail = (what, x, extra) => assert.fail(`relieve: ${what}\n${JSON.stringify({ ...x.inst, sched: [...x.inst.sched], flags: x.flags, extra })}`);
const perms = (a) => (a.length <= 1 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map((r) => [x, ...r])));
const seqOk = (inst, order) => {
  let cur = inst;
  for (const m of order) {
    if (!oracleMove(cur, { key: m.key, ...(m.to.owner !== m.from.owner ? { to: m.to.owner } : {}), sprint: m.to.sprint }).yes) return false;
    const sched = new Map(cur.sched); sched.set(m.key, { ...m.to }); cur = { ...cur, sched };
  }
  return true;
};

export function assureRelieve(lvl) {
  const B = BOUNDS[lvl], counts = { instances: 0, none_needed: 0, relief: 0, no_relief: 0, sequential: 0, together: 0, maxMoves: 0 };
  for (const x of instances(B)) {
    const model = buildModel({ tickets: x.inst.tickets, edges: x.inst.edges, config: x.inst.config, schedule: [...x.inst.sched].map(([key, p]) => ({ key, ...p })) });
    const got = relieve(model, { person: P, sprint: N }, x.flags), want = oracleRelieve(x.inst, x.flags);
    if (got.status !== want.status) fail(`status ${got.status}, oracle ${want.status}`, x, { got, want });
    if (!got.searchComplete) fail('search budget hit on a small instance', x, got);
    if (counts.instances % 97 === 0) assert.deepEqual(relieve(model, { person: P, sprint: N }, x.flags), got, 'relieve is deterministic');
    if (want.status === 'relief') {
      const sorted = got.moves.slice().sort((a, b) => (a.key < b.key ? -1 : 1));
      if (cmpMoves(sorted, want.best.moves) !== 0 || sorted.length !== want.best.moves.length) fail('the relief is not the brute-force best set', x, { got: got.moves, want: want.best.moves });
      const after = new Map(x.inst.sched); for (const m of got.moves) after.set(m.key, { ...m.to });
      if (!valid(x.inst, after, new Set(got.moves.map((m) => m.key)), bag(oracleViolations(x.inst).map(vsig)))) fail('the relief fails the oracle', x, got);
      if (got.slip !== want.best.slip || got.ownerChanges !== want.best.oc || got.after !== want.load - got.moves.reduce((a, m) => a + m.sp, 0)) fail('slip, owner changes or after-load differ', x, { got, want });
      if (got.order === 'sequential' ? !seqOk(x.inst, got.moves) : perms(got.moves).some((o) => seqOk(x.inst, o))) fail(`order ${got.order} is wrong`, x, got);
      counts[got.order]++; counts.maxMoves = Math.max(counts.maxMoves, got.moves.length);
    }
    if (want.status === 'no_relief') {
      const fz = got.reasons.find((r) => r.code === 'FROZEN')?.keys ?? [];
      if (fz.join() !== want.frozen.join()) fail('FROZEN reason differs from the frozen tickets of the cell', x, { got, want });
    }
    counts[want.status]++; counts.instances++;
  }
  return counts;
}
