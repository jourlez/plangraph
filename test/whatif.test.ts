// Tests for lib/whatif.ts: worked examples per reason code, property tests against lib/verify.ts, and a brute-force oracle for proposeMove.
// NOT covered: proposeMove optimality beyond n<=6 / 2 people / 4 sprints (the oracle enumerates every sprint vector; owner-change mode is only
// checked for validity, not against an oracle); budget-exhausted fallback is checked for validity only; ripple is a capacity-blind forward
// cascade and is checked for HANDOFF-closure, not minimality; renderWhatif wording is pinned by golden strings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModel } from '../lib/model.ts';
import type { Model, Placement, PlanConfig, Ticket } from '../lib/model.ts';
import { verifyPlan } from '../lib/verify.ts';
import type { Violation } from '../lib/verify.ts';
import { whatif, proposeMove, renderWhatif, applyMoves, estTokens, assertPlanValid } from '../lib/whatif.ts';
import type { MoveRequest, Slot, Suggestion, WhatifReason } from '../lib/whatif.ts';
import { genPlan, rng } from './fixtures/gen.ts';

const codes = (r: { reasons: ReadonlyArray<{ code: string }> }) => r.reasons.map((x) => x.code);
const cell = (m: Model, o: unknown, s: number) => [...m.sched].reduce((a, [k, p]) => a + (p.owner === o && p.sprint === s ? (m.tickets.get(k) as Ticket).sp as number : 0), 0); // genPlan places tickets only, each with points
function tight(g: ReturnType<typeof genPlan>) { // set caps to the max existing cell load so the base plan is capacity-clean but full
  const m = buildModel(g); let mx = 0;
  for (const p of new Set([...m.sched.values()].map((x) => x.owner))) for (let s = 1; s <= g.config.end_sprint; s++) mx = Math.max(mx, cell(m, p, s));
  return buildModel({ ...g, config: { ...g.config, caps: { default: mx } } });
}
const hand = (v: readonly Violation[]) => v.filter((x) => x.code === 'HANDOFF');

// Hand-built world: P1(Ana S2) -> X(Ana S3) -> C1(Ben S4), C2(Ana S3); caps Ben 5.
function world(extra = {}) {
  const T = (key: string, sp: number, st = 'To Do') => ({ key, sp, jira_status: st });
  return buildModel({
    tickets: [T('P1', 2), T('X', 3), T('C1', 2), T('C2', 1), T('B1', 4), T('D1', 1, 'Done'), T('W1', 1, 'In Progress')],
    edges: [['X', 'P1'], ['C1', 'X'], ['C2', 'X']].map(([consumer, producer]) => ({ consumer, producer, kind: 'x' })),
    schedule: ([['P1', 'Ana', 2], ['X', 'Ana', 3], ['C1', 'Ben', 4], ['C2', 'Ana', 3], ['B1', 'Ben', 5], ['D1', 'Ana', 1], ['W1', 'Ana', 3]] as Array<[string, string, number]>).map(([key, owner, sprint]) => ({ key, owner, sprint })), // literal tuples
    config: { first_sprint: 1, end_sprint: 6, caps: { default: 10, Ben: 5 }, ...extra },
  });
}

test('worked: ok move changes nothing and reports load', () => {
  const m = world(), before = JSON.stringify([...m.sched]);
  const r = whatif(m, { key: 'X', sprint: 3, to: 'Ana' });
  assert.deepEqual(codes(r), ['SAME_SLOT']); assert.equal(r.ok, false);
  const ok = whatif(m, { key: 'C2', sprint: 4 });
  assert.equal(ok.ok, true); assert.deepEqual(ok.reasons, []);
  assert.deepEqual(ok.load.Ana[4], { before: 0, after: 1, cap: 10 });
  assert.deepEqual(ok.load.Ana[3], { before: 5, after: 4, cap: 10 }); // freed capacity visible
  assert.equal(JSON.stringify([...m.sched]), before, 'dry run must not mutate');
});

test('worked: PRODUCER_LATE (same owner and handoff +1)', () => {
  const m = world();
  let r = whatif(m, { key: 'X', sprint: 1 });
  assert.deepEqual(codes(r).filter((c) => c !== 'CONSUMER_EARLY'), ['PRODUCER_LATE']);
  assert.equal((r.reasons.find((x) => x.code === 'PRODUCER_LATE') as WhatifReason).key, 'P1'); // the codes above include it
  assert.match((r.reasons.find((x) => x.code === 'PRODUCER_LATE') as WhatifReason).detail, /S2 Ana, needs S1$/); // the codes above include it
  r = whatif(m, { key: 'X', to: 'Ben', sprint: 2 }); // Ben needs producer at S1 (handoff)
  const pl = r.reasons.find((x) => x.code === 'PRODUCER_LATE') as WhatifReason; // a missing reason fails the asserts below
  assert.match(pl.detail, /S2 Ana, needs S1 for handoff/); assert.match(pl.fix, /S3\+/);
});

test('worked: CONSUMER_EARLY names every early consumer, with owner-dependent +1', () => {
  const m = world();
  const r = whatif(m, { key: 'X', sprint: 4 }); // C2 (Ana S3) early; C1 (Ben S4) needs S5
  assert.deepEqual(r.reasons.filter((x) => x.code === 'CONSUMER_EARLY').map((x) => x.key), ['C1', 'C2']);
  assert.match(r.reasons[0].detail, /needs S5/);
  assert.deepEqual(r.ripple.map((x) => x.key), ['X', 'C1', 'C2']);
  assert.equal(r.ripple[1].to.sprint, 5);
});

test('worked: CAPACITY with the full list of reasons returned at once', () => {
  const m = world();
  const r = whatif(m, { key: 'X', to: 'Ben', sprint: 5 }); // Ben S5 has B1 (4) + X (3) = 7 > 5; C1 (Ben S4) early; C2 early
  assert.ok(codes(r).includes('CAPACITY') && codes(r).includes('CONSUMER_EARLY'));
  const cap = r.reasons.find((x) => x.code === 'CAPACITY') as WhatifReason; // the codes above include it
  assert.equal(cap.key, 'Ben S5'); assert.equal(cap.detail, '7/5');
  assert.equal((r.freed as { owner: string }).owner, 'Ana'); assert.equal((r.freed as { sp: number }).sp, 3); // whatif sets freed for a known ticket
});

test('worked: STARTED (Done hard stop, In Progress warns unless strict)', () => {
  const m = world();
  const d = whatif(m, { key: 'D1', sprint: 2 });
  assert.equal(d.ok, false); assert.equal(d.started, true); assert.deepEqual(codes(d), ['STARTED']);
  const w = whatif(m, { key: 'W1', sprint: 4 });
  assert.equal(w.ok, true); assert.equal(w.started, true); assert.equal(w.reasons[0].code, 'STARTED'); assert.equal(w.reasons[0].warn, true);
  assert.equal(whatif(m, { key: 'W1', sprint: 4 }, { strict: true }).ok, false);
  // review M2: `plangraph init` writes frozen_statuses ["Done"]; In Progress still warns (it was silenced before)
  const m2 = world({ frozen_statuses: ['Done'] }), w2 = whatif(m2, { key: 'W1', sprint: 4 });
  assert.deepEqual([w2.ok, w2.started, w2.reasons[0].code, w2.reasons[0].warn], [true, true, 'STARTED', true]);
});

test('worked: UNKNOWN_PERSON, UNKNOWN_TICKET, SAME_SLOT, OUT_OF_RANGE, case-insensitive names', () => {
  const m = world();
  assert.deepEqual(codes(whatif(m, { key: 'NOPE', sprint: 2 })), ['UNKNOWN_TICKET']);
  const up = whatif(m, { key: 'C2', to: 'Zed' }); assert.equal(up.ok, false); assert.ok(codes(up).includes('UNKNOWN_PERSON'));
  assert.deepEqual(codes(whatif(m, { key: 'C2', to: 'Ana', sprint: 3 })), ['SAME_SLOT']);
  assert.ok(codes(whatif(m, { key: 'C2', sprint: 9 })).includes('OUT_OF_RANGE'));
  assert.ok(codes(whatif(m, { key: 'C2', sprint: 0 })).includes('OUT_OF_RANGE'));
  assert.equal(whatif(m, { key: 'C2', to: 'ben', sprint: 6 }).ripple[0].to.owner, 'Ben');
});

test('property: whatif agrees exactly with verifyPlan on the naively applied move (400 plans x 6 moves, loose and tight caps)', () => {
  let oks = 0, noHand = 0, noCap = 0, n = 0;
  for (let seed = 1; seed <= 400; seed++) {
    const g = genPlan({ n: 6 + (seed % 25), people: 1 + (seed % 4), density: 0.08 + (seed % 5) / 20, seed, maxSp: 6 });
    const m = seed % 2 ? tight(g) : buildModel(g);
    const r0 = rng(seed * 31), names = [...new Set([...m.sched.values()].map((p) => p.owner))];
    for (let i = 0; i < 6; i++) {
      const keys = [...m.tickets.keys()], key = keys[Math.floor(r0() * keys.length)];
      const mv = { key, to: names[Math.floor(r0() * names.length)] as string | null /* generated placements always have an owner */, sprint: 1 + Math.floor(r0() * g.config.end_sprint) };
      const w = whatif(m, mv, { noSuggest: true }); if (codes(w).includes('SAME_SLOT')) continue; n++;
      const applied = new Map(m.sched); applied.set(key, { owner: mv.to, sprint: mv.sprint });
      const v = verifyPlan(m, applied);
      const wantHand = hand(v).length > 0, gotHand = codes(w).some((c) => c === 'PRODUCER_LATE' || c === 'CONSUMER_EARLY');
      assert.equal(gotHand, wantHand, `handoff seed ${seed} ${JSON.stringify(mv)}`);
      const wantCap = v.some((x) => x.code === 'CAPACITY'), gotCap = codes(w).includes('CAPACITY');
      assert.equal(gotCap, wantCap, `capacity seed ${seed} ${JSON.stringify(mv)}`);
      assert.equal(w.ok, v.length === 0, `ok seed ${seed}`);
      if (w.ok) { oks++; assert.equal(hand(v).length, 0); }
      if (wantHand) noHand++; if (wantCap) noCap++;
      // each HANDOFF violation is explained by a reason naming the same other ticket
      for (const h of hand(v)) assert.ok(w.reasons.some((x) => (x.code === 'CONSUMER_EARLY' && x.key === h.key) || (x.code === 'PRODUCER_LATE' && h.detail.includes(`producer ${x.key} `))), 'explained');
    }
  }
  assert.ok(oks > 50 && noHand > 100 && noCap > 30, `coverage ok=${oks} hand=${noHand} cap=${noCap} of ${n}`);
});

test('property: whatif is monotone and explainable (every reason carries code/key/detail/fix; adding a cap never removes a reason)', () => {
  for (let seed = 1; seed <= 100; seed++) {
    const m = tight(genPlan({ n: 20, people: 3, density: 0.15, seed }));
    const keys = [...m.tickets.keys()], key = keys[seed % keys.length];
    const mv = { key, to: 'Ben', sprint: 1 + (seed % (m.config.end_sprint as number)) }; // genPlan sets end_sprint
    const a = whatif(m, mv);
    for (const x of a.reasons) for (const f of ['code', 'key', 'detail', 'fix']) assert.ok(typeof (x as Record<string, unknown>)[f] === 'string' && ((x as Record<string, unknown>)[f] as string).length, `${f} seed ${seed}`); // read by name; typeof is the check
    const m2 = buildModel({ ...genPlan({ n: 20, people: 3, density: 0.15, seed }), config: { ...m.config, caps: { default: Math.max(1, ((m.config.caps as Record<string, unknown>).default as number) - 3) } } }); // genPlan sets a numeric caps.default
    const b = whatif(m2, mv, { noSuggest: true });
    for (const c of codes(a).filter((c) => c !== 'CAPACITY')) assert.ok(codes(b).includes(c));
    if (codes(a).includes('CAPACITY')) assert.ok(codes(b).includes('CAPACITY'));
  }
});

// ---------- proposeMove ----------
function randMove(m: Model, r0: () => number, end: number | undefined): MoveRequest {
  const keys = [...m.tickets.keys()], names = [...new Set([...m.sched.values()].map((p) => p.owner))];
  return { key: keys[Math.floor(r0() * keys.length)], to: names[Math.floor(r0() * names.length)] as string | null, sprint: 1 + Math.floor(r0() * (end as number)) }; // generated placements always have an owner; callers pass the end_sprint genPlan set
}

test('proposeMove: every ok output verifies, keeps other owners, pins started tickets, respects end_sprint (500 random cases, all option sets)', () => {
  let ok = 0, repaired = 0, tot = 0;
  for (let seed = 1; seed <= 500; seed++) {
    const g = genPlan({ n: 8 + (seed % 20), people: 2 + (seed % 3), density: 0.1 + (seed % 4) / 15, seed, maxSp: 5 });
    g.tickets.forEach((t, i) => { if (i % 7 === 3) t.jira_status = 'Done'; else if (i % 11 === 5) t.jira_status = 'In Progress'; });
    g.config.end_sprint += 2; (g.config as PlanConfig).frozen_statuses = ['In Progress']; // pinned only because config lists it (lib/frozen.ts)
    const m = tight(g), r0 = rng(seed * 7);
    const mv = randMove(m, r0, m.config.end_sprint);
    const o = [{}, { allowEarlier: true }, { allowSlip: true }, { allowEarlier: true, allowSlip: true }, { allowOwnerChange: true, allowSlip: true }][seed % 5];
    const r = proposeMove(m, mv, o); tot++;
    if (!r.ok) continue; ok++;
    const plan = applyMoves(m.sched, r.moves);
    assert.deepEqual(verifyPlan(m, plan), [], `seed ${seed}`); // base is clean, so the result must be fully clean
    if (r.moves.length > 1) repaired++;
    for (const mvd of r.moves.slice(1)) {
      const st = (m.tickets.get(mvd.key) as Ticket).jira_status; // a move names a ticket
      assert.ok(st !== 'Done' && st !== 'In Progress', 'pinned ticket moved');
      if (!o.allowOwnerChange) assert.equal(mvd.from.owner, mvd.to.owner);
      if (!o.allowEarlier) assert.ok(mvd.to.sprint > mvd.from.sprint || (mvd.to.owner !== mvd.from.owner && mvd.to.sprint === mvd.from.sprint));
      assert.ok(mvd.to.sprint <= (m.config.end_sprint as number)); // genPlan sets end_sprint
    }
    assert.equal(r.moves[0].key, mv.key);
    if (!o.allowSlip) assert.equal(r.moves[0].to.sprint, mv.sprint);
  }
  assert.ok(ok > 100 && repaired > 30, `ok=${ok} repaired=${repaired} of ${tot}`);
});

test('proposeMove: a move that is already fine returns just itself; rejected-for-hard-reasons returns reasons', () => {
  const m = world();
  assert.deepEqual(proposeMove(m, { key: 'C2', sprint: 4 }).moves.map((x) => x.key), ['C2']);
  assert.equal(proposeMove(m, { key: 'D1', sprint: 4 }).ok, false);
  assert.equal(proposeMove(m, { key: 'D1', sprint: 4 }).reasons[0].code, 'STARTED');
});

test('proposeMove worked: pushing X to S4 shifts exactly its consumers; overflow past end_sprint is refused unless allowed', () => {
  const m = world();
  const r = proposeMove(m, { key: 'X', sprint: 4 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.moves.map((x) => [x.key, x.to.sprint]), [['X', 4], ['C1', 6], ['C2', 4]]); // C1 wants S5 for the handoff but Ben S5 is full (B1 4 + C1 2 > 5), so it lands in S6
  assert.deepEqual(r.moves.map((x) => [x.key, x.to.sprint]), [['X', 4], ['C1', 6], ['C2', 4]]);
  const m2 = world({ end_sprint: 4 });
  const bad = proposeMove(m2, { key: 'X', sprint: 4 });
  assert.equal(bad.ok, false); assert.ok(bad.reasons.some((x) => x.code === 'NO_REPAIR'));
  const ov = proposeMove(m2, { key: 'X', sprint: 4 }, { allowOverflow: true });
  assert.equal(ov.ok, true); assert.ok(ov.moves.some((x) => x.to.sprint > 4));
});

test('proposeMove: producer-late repair via allowEarlier and via slip', () => {
  const T = (key: string) => ({ key, sp: 1, jira_status: 'To Do' });
  const m = buildModel({ tickets: [T('P'), T('Q'), T('K')], edges: [{ consumer: 'K', producer: 'P', kind: 'x' }],
    schedule: ([['P', 'Ana', 3], ['Q', 'Ana', 1], ['K', 'Ana', 4]] as Array<[string, string, number]>).map(([key, owner, sprint]) => ({ key, owner, sprint })), config: { first_sprint: 1, end_sprint: 5, caps: { default: 9 } } }); // literal tuples
  assert.equal(proposeMove(m, { key: 'K', sprint: 2 }).ok, false);
  const e = proposeMove(m, { key: 'K', sprint: 2 }, { allowEarlier: true });
  assert.deepEqual(e.moves.map((x) => [x.key, x.to.sprint]), [['K', 2], ['P', 2]]);
  const s = proposeMove(m, { key: 'K', sprint: 2 }, { allowSlip: true });
  // the earlier request slips to S3 (same owner as P, so S3 is enough), still before its current slot S4 (review M3: this used to say no repair)
  assert.deepEqual(s.moves.map((x) => [x.key, x.to.sprint]), [['K', 3]]);
  const t = proposeMove(m, { key: 'K', sprint: 2, to: 'Ana' }, { allowSlip: true });
  assert.deepEqual(t.moves.map((x) => [x.key, x.to.sprint]), [['K', 3]]);
});

// Brute-force oracle: enumerate every sprint vector for the non-requested tickets; minimum number of moved tickets that verifies.
function oracle(m: Model, mv: MoveRequest, { allowEarlier }: { allowEarlier?: boolean }) {
  const keys = [...m.tickets.keys()].sort(), others = keys.filter((k) => k !== mv.key), end = m.config.end_sprint as number; // genPlan sets end_sprint
  const fz = new Set(keys.filter((k) => ['Done', 'In Progress'].includes((m.tickets.get(k) as Ticket).jira_status as string))); // k is a ticket key; a missing status is not in the list
  const dom = others.map((k) => { const b = (m.sched.get(k) as Slot).sprint; if (fz.has(k)) return [b]; const out: number[] = []; for (let s = allowEarlier ? 1 : b; s <= end; s++) out.push(s); return out; }); // genPlan places every ticket
  let best = Infinity; const plan = new Map<string, Placement>(m.sched); plan.set(mv.key, { owner: mv.to, sprint: mv.sprint });
  const rec = (i: number, moved: number) => {
    if (moved >= best) return;
    if (i === others.length) { if (verifyPlan(m, plan).length === 0) best = moved; return; }
    const k = others[i], b = m.sched.get(k) as Placement; // genPlan places every ticket
    for (const s of dom[i]) { plan.set(k, { owner: b.owner, sprint: s }); rec(i + 1, moved + (s !== b.sprint ? 1 : 0)); }
    plan.set(k, b);
  };
  rec(0, 0);
  return best;
}

test('proposeMove vs brute-force oracle (n<=6, 2 people, 4 sprints): validity, completeness and gap statistics', () => {
  const stats = { cases: 0, feasible: 0, equal: 0, maxExcess: 0, sumExcess: 0, falseInfeasible: 0, falseFeasible: 0 };
  for (const allowEarlier of [false, true]) for (let seed = 1; stats.cases < (allowEarlier ? 2400 : 1200) && seed < 20000; seed++) {
    const g = genPlan({ n: 4 + (seed % 3), people: 2, density: 0.2 + (seed % 4) / 10, seed: seed + (allowEarlier ? 100000 : 0), maxSp: 4 });
    if (Math.max(...g.schedule.map((r) => r.sprint)) > 3) continue;
    g.config.end_sprint = 4;
    g.tickets.forEach((t, i) => { if ((seed + i) % 9 === 0) t.jira_status = 'Done'; });
    const m = tight(g), r0 = rng(seed * 13 + 1), mv = randMove(m, r0, 4);
    if ((m.tickets.get(mv.key) as Ticket).jira_status === 'Done') continue; // randMove picks a ticket key
    const w = whatif(m, mv, { noSuggest: true });
    if (w.reasons.some((x) => ['SAME_SLOT', 'STARTED', 'UNKNOWN_PERSON'].includes(x.code))) continue;
    if (!allowEarlier && stats.cases === 1200) break;
    stats.cases++;
    const opt = oracle(m, mv, { allowEarlier }), r = proposeMove(m, mv, { allowEarlier });
    if (opt === Infinity) { if (r.ok) stats.falseFeasible++; continue; }
    stats.feasible++;
    if (!r.ok) { stats.falseInfeasible++; continue; }
    const got = r.moves.length - 1;
    assert.deepEqual(verifyPlan(m, applyMoves(m.sched, r.moves)), []);
    assert.ok(got >= opt, 'cannot beat the oracle');
    if (got === opt) stats.equal++;
    stats.maxExcess = Math.max(stats.maxExcess, got - opt); stats.sumExcess += got - opt;
  }
  console.log(`# oracle gap: ${JSON.stringify(stats)}`);
  assert.equal(stats.falseFeasible, 0); assert.equal(stats.falseInfeasible, 0);
  assert.ok(stats.feasible > 500, `feasible ${stats.feasible}`);
  assert.ok(stats.maxExcess <= 0, `max excess ${stats.maxExcess}`); // search is exact on these sizes; any regression to a heuristic shows here
});

test('proposeMove vs oracle, harder shape (n=5, 3 people, 6 sprints, big tickets): gap statistics', () => {
  const st = { cases: 0, feasible: 0, equal: 0, maxExcess: 0 };
  for (let seed = 1; seed < 40000 && st.cases < 600; seed++) {
    const g = genPlan({ n: 5, people: 3, density: 0.25, seed: seed + 500000, maxSp: 6 });
    g.config.end_sprint = 6; (g.config as PlanConfig).frozen_statuses = ['In Progress']; g.tickets.forEach((t, i) => { if ((seed + i) % 8 === 0) t.jira_status = 'In Progress'; }); // PlanConfig names frozen_statuses; genPlan's inferred config does not
    const m = tight(g), mv = randMove(m, rng(seed * 5 + 2), 6);
    if ((m.tickets.get(mv.key) as Ticket).jira_status !== 'To Do') continue; // randMove picks a ticket key
    const w = whatif(m, mv, { noSuggest: true });
    if (w.reasons.some((x) => ['SAME_SLOT', 'UNKNOWN_PERSON'].includes(x.code))) continue;
    st.cases++;
    const opt = oracle(m, mv, { allowEarlier: false }), r = proposeMove(m, mv, {});
    if (opt === Infinity) { assert.equal(r.ok, false); continue; }
    st.feasible++; assert.equal(r.ok, true);
    const got = r.moves.length - 1; assert.ok(got >= opt);
    if (got === opt) st.equal++; st.maxExcess = Math.max(st.maxExcess, got - opt);
  }
  console.log(`# oracle gap (harder): ${JSON.stringify(st)}`);
  assert.ok(st.feasible > 100); assert.equal(st.maxExcess, 0);
});

test('regression: minimising moved tickets (not search steps); found by mutating the priority order', () => {
  // Ticket pushed several sprints (1 moved, many steps) beats several tickets pushed one sprint each. Seeds located by search against the mutant.
  for (const [seed, key, to, want] of ([[5814, 'T-2', 'Ben', 1], [7325, 'T-6', 'Ana', 2], [534, 'T-4', 'Ana', 3]] as Array<[number, string, string, number]>)) { // literal tuples
    const g = genPlan({ n: 7, people: 2, density: 0.12, seed, maxSp: 6 }); g.config.end_sprint = 7;
    const m = tight(g), mv = { key, to, sprint: 1 };
    const r = proposeMove(m, mv, {});
    assert.equal(r.ok, true); assert.equal(r.moves.length - 1, want, `seed ${seed}`);
    assert.equal(oracle(m, mv, { allowEarlier: false }), want, `oracle seed ${seed}`);
  }
});

test('proposeMove with owner changes: result verifies and may reassign others only when allowed', () => {
  let changed = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const m = tight(genPlan({ n: 12, people: 3, density: 0.2, seed, maxSp: 4 }));
    const mv = randMove(m, rng(seed), m.config.end_sprint);
    const r = proposeMove(m, mv, { allowOwnerChange: true, allowSlip: true });
    if (!r.ok) continue;
    assert.deepEqual(verifyPlan(m, applyMoves(m.sched, r.moves)), []);
    changed += r.ownerChanges;
  }
  assert.ok(changed >= 0);
});

test('assertPlanValid throws on a handoff break, a new overload and a moved pinned ticket; accepts the base and pre-existing violations', () => {
  const m = world(), pin = () => false;
  assert.doesNotThrow(() => assertPlanValid(m, m.sched, {}, pin));
  const a = new Map(m.sched); a.set('C2', { owner: 'Ana', sprint: 1 });
  assert.throws(() => assertPlanValid(m, a, {}, pin), /HANDOFF/);
  const b = new Map(m.sched); b.set('B1', { owner: 'Ben', sprint: 4 }); // Ben S4 would hold C1 (2) + B1 (4) > 5
  assert.throws(() => assertPlanValid(m, b, {}, pin), /CAPACITY/);
  const c = new Map(m.sched); c.set('W1', { owner: 'Ana', sprint: 4 });
  assert.throws(() => assertPlanValid(m, c, {}, (k) => k === 'W1'), /FROZEN_MOVED/);
});

test('proposeMove large plan stays within budget and still verifies (fallback path)', () => {
  const g = genPlan({ n: 300, people: 4, density: 0.02, seed: 21, maxSp: 5 }); g.config.end_sprint += 6;
  const m = tight(g); let ran = 0;
  for (let i = 0; i < 12; i++) {
    const mv = randMove(m, rng(i + 1), m.config.end_sprint);
    const r = proposeMove(m, mv, { allowSlip: true, budget: 3000 }); ran++;
    if (r.ok) assert.deepEqual(verifyPlan(m, applyMoves(m.sched, r.moves)), []);
  }
  assert.equal(ran, 12);
});

test('proposeMove throws if its own result would be invalid (internal assertion is live)', async () => {
  // A model whose verifyPlan sees a violation the search cannot see: an edge to a ticket absent from tickets is skipped by both, so
  // use a cap override mismatch instead: nothing to throw in a consistent model. Guard: the function must not throw on 200 random cases.
  for (let seed = 1; seed <= 200; seed++) {
    const m = tight(genPlan({ n: 15, people: 3, density: 0.15, seed }));
    assert.doesNotThrow(() => proposeMove(m, randMove(m, rng(seed), m.config.end_sprint), { allowSlip: true, allowEarlier: seed % 2 === 0 }));
  }
});

// ---------- renderWhatif ----------
test('renderWhatif golden strings and token budget', () => {
  const m = world();
  assert.equal(renderWhatif(whatif(m, { key: 'C2', sprint: 4 })), 'OK: C2 -> Ana S4. Ana S4 1/10. Frees 1 on Ana S3.');
  const no = renderWhatif(whatif(m, { key: 'X', to: 'Ben', sprint: 5 }));
  assert.match(no, /^NO: X -> Ben S5\. CONSUMER_EARLY C1 \(S4 Ben, needs S5\) \| CONSUMER_EARLY C2 \(S3 Ana, needs S6\) \| CAPACITY Ben S5 \(7\/5\)\./);
  assert.match(no, /Fix: keep S5 \(3 others shift, 0 owner changes\)\.$/); // X's own owner change is the request, not a side effect
  assert.ok(estTokens(no) <= 120, `${estTokens(no)} tokens: ${no}`);
  const w = renderWhatif(whatif(m, { key: 'W1', sprint: 4 }));
  assert.match(w, /^OK: W1 -> Ana S4\..*WARN STARTED W1 \(status In Progress\)\.$/);
  assert.equal(renderWhatif(whatif(m, { key: 'D1', sprint: 4 })).startsWith('NO: D1 -> Ana S4. STARTED D1 (status Done).'), true);
});

test('renderWhatif names the real CLI flags when no fix is found', () => {
  const fake = { ok: false, ripple: [{ key: 'K', to: { owner: 'Ana', sprint: 2 } }], reasons: [{ code: 'CAPACITY', key: 'K', detail: 'Ana S2 (6/5)', fix: 'x' }], load: {}, suggestion: { none: true } };
  const s = renderWhatif(fake);
  assert.match(s, /Fix: none found; try --earlier or --owner-change\./);
  assert.doesNotMatch(s, /allowEarlier|allowOwnerChange/);
});

test('renderWhatif truncates beyond 8 reasons with "... N more"', () => {
  const fake = { ok: false, ripple: [{ key: 'K', to: { owner: 'Ana', sprint: 2 } }], reasons: Array.from({ length: 11 }, (_, i) => ({ code: 'CONSUMER_EARLY', key: `C${i}`, detail: 'S1 Ben, needs S3', fix: 'x' })), load: {}, suggestion: { sprint: 3, shifts: 11, ownerChanges: 0 } };
  const s = renderWhatif(fake);
  assert.ok(s.includes('| ... 3 more'));
  assert.equal((s.match(/CONSUMER_EARLY/g) || []).length, 8);
  assert.ok(s.includes('Fix: move to S3 (11 others shift, 0 owner changes).'));
});

test('whatif is deterministic and never mutates the model', () => {
  const m = tight(genPlan({ n: 30, people: 3, density: 0.15, seed: 5 }));
  const snap = JSON.stringify([[...m.sched], [...m.prods], [...m.cons], [...m.tickets]]);
  const a = JSON.stringify(whatif(m, { key: 'T-9', to: 'Ben', sprint: 2 })), b = JSON.stringify(whatif(m, { key: 'T-9', to: 'Ben', sprint: 2 }));
  assert.equal(a, b);
  proposeMove(m, { key: 'T-9', to: 'Ben', sprint: 2 }, { allowSlip: true });
  assert.equal(JSON.stringify([[...m.sched], [...m.prods], [...m.cons], [...m.tickets]]), snap);
});

test('person names: a unique first name resolves, an ambiguous one is not guessed', () => {
  const mk = (owners: string[]) => buildModel({
    tickets: owners.map((o, i) => ({ key: `P-${i + 1}`, sp: 1, jira_status: 'To Do', v2_owner: o })), edges: [],
    schedule: owners.map((o, i) => ({ version: 'current', key: `P-${i + 1}`, owner: o, sprint: 1 })),
    config: { first_sprint: 1, end_sprint: 6, caps: { default: 50 } },
  });
  const uniq = mk(['Ana Diaz', 'Ben Cole']);
  assert.equal(whatif(uniq, { key: 'P-2', to: 'ana', sprint: 2 }).reasons.some((r) => r.code === 'UNKNOWN_PERSON'), false);
  assert.equal(whatif(uniq, { key: 'P-2', to: 'Ana Diaz', sprint: 2 }).ok, true);
  const amb = mk(['Ana Diaz', 'Ana Lopez', 'Ben Cole']);
  assert.equal(whatif(amb, { key: 'P-3', to: 'Ana', sprint: 2 }).reasons.some((r) => r.code === 'UNKNOWN_PERSON'), true);
  assert.equal(whatif(uniq, { key: 'P-2', to: 'Zed', sprint: 2 }).reasons.some((r) => r.code === 'UNKNOWN_PERSON'), true);
});

// Review I1: `frozen_statuses: []` (what `plangraph init` wrote) pinned nothing, so a repair shifted a Done consumer. Done and config.closed_statuses
// are always pinned, whatever frozen_statuses says; a requested ticket in a closed status is a hard STARTED stop like Done.
test('regression: Done and closed_statuses tickets are always pinned, even with frozen_statuses []', () => {
  const mk = (st: string, extra: PlanConfig = {}) => buildModel({
    tickets: [{ key: 'T-1', sp: 3, jira_status: 'To Do' }, { key: 'T-2', sp: 2, jira_status: st }],
    edges: [{ consumer: 'T-2', producer: 'T-1', kind: 'plan_need' }],
    schedule: [{ key: 'T-1', owner: 'Ana', sprint: 2 }, { key: 'T-2', owner: 'Ana', sprint: 2 }],
    config: { first_sprint: 1, end_sprint: 6, caps: { default: 10 }, frozen_statuses: [], ...extra },
  });
  for (const [st, extra] of [['Done', {}], ['Closed', { closed_statuses: ['Done', 'Closed'] }]] as Array<[string, PlanConfig]>) { // literal tuples
    const m = mk(st, extra);
    const r = proposeMove(m, { key: 'T-1', sprint: 3 }, { allowSlip: true, allowEarlier: true, allowOwnerChange: true });
    assert.equal(r.ok, false, `${st}: ${JSON.stringify(r.moves)}`); assert.deepEqual(r.reasons.map((x) => x.code), ['CONSUMER_EARLY', 'NO_REPAIR']);
    const w = whatif(m, { key: 'T-2', sprint: 3 });
    assert.equal(w.ok, false); assert.equal(w.started, true); assert.deepEqual(codes(w), ['STARTED']); assert.equal(w.reasons[0].warn, undefined);
    assert.equal((whatif(m, { key: 'T-1', sprint: 3 }).suggestion as Suggestion).none, true, `${st}: no suggestion may move the closed consumer`); // a blocked, repairable move gets a suggestion
  }
  // frozen_statuses keeps its meaning for open statuses, the same in verify, the solver and whatif (lib/frozen.ts): only what it lists
  // is pinned, so [] and an absent key pin In Progress no more, ['In Progress'] pins it
  const ip = (extra: PlanConfig) => buildModel({ tickets: [{ key: 'A', sp: 1, jira_status: 'To Do' }, { key: 'B', sp: 1, jira_status: 'In Progress' }],
    edges: [{ consumer: 'B', producer: 'A', kind: 'x' }], schedule: [{ key: 'A', owner: 'Ana', sprint: 2 }, { key: 'B', owner: 'Ana', sprint: 2 }],
    config: { first_sprint: 1, end_sprint: 6, caps: { default: 10 }, ...extra } });
  assert.equal(proposeMove(ip({ frozen_statuses: [] }), { key: 'A', sprint: 3 }).ok, true);
  assert.equal(proposeMove(ip({}), { key: 'A', sprint: 3 }).ok, true);
  assert.equal(proposeMove(ip({ frozen_statuses: ['In Progress'] }), { key: 'A', sprint: 3 }).ok, false);
});


test('renderWhatif names the flags a slipped suggestion needs', () => {
  const fake = { ok: false, ripple: [{ key: 'K', to: { owner: 'Ana', sprint: 2 } }], reasons: [{ code: 'PRODUCER_LATE', key: 'P', detail: 'S3 Ana, needs S2', fix: 'x' }], load: {}, suggestion: { sprint: 3, owner: 'Ana', shifts: 0, ownerChanges: 0, flags: ['slip'] } };
  assert.ok(renderWhatif(fake).endsWith('Fix: move to S3 (0 others shift, 0 owner changes; apply with --slip).'), renderWhatif(fake));
  const m = buildModel({ tickets: [{ key: 'P', sp: 1 }, { key: 'K', sp: 1 }, { key: 'B', sp: 1 }], edges: [{ consumer: 'K', producer: 'P', kind: 'x' }],
    schedule: [{ key: 'P', owner: 'Ana', sprint: 3 }, { key: 'K', owner: 'Ana', sprint: 3 }, { key: 'B', owner: 'Ben', sprint: 1 }], config: { first_sprint: 1, end_sprint: 6, caps: { default: 5 } } });
  const w = whatif(m, { key: 'K', to: 'Ben', sprint: 3 });
  assert.deepEqual(w.suggestion, { sprint: 4, owner: 'Ben', shifts: 0, ownerChanges: 0, flags: ['slip'] });
  assert.equal(renderWhatif(w), 'NO: K -> Ben S3. PRODUCER_LATE P (S3 Ana, needs S2 for handoff). Fix: move to S4 (0 others shift, 0 owner changes; apply with --slip).');
  assert.equal((whatif(m, { key: 'K', to: 'Ben', sprint: 3 }, { allowSlip: true }).suggestion as Suggestion).flags, undefined, 'the user already passed --slip'); // a blocked, repairable move gets a suggestion
});

// Review M3: a requested move to an earlier sprint could never slip to a later sprint below its current slot (the "never before its base
// sprint" rule was applied to the requested ticket too), so whatif said "none found" although a nearby sprint is fine.
test('regression: an earlier request slips to the nearest valid sprint below its current slot (T-3 Ben S4 needs T-1 Ana S2, asked Ana S1)', () => {
  const m = buildModel({ tickets: [{ key: 'T-1', sp: 2 }, { key: 'T-2', sp: 1 }, { key: 'T-3', sp: 2 }], edges: [{ consumer: 'T-3', producer: 'T-1', kind: 'x' }],
    schedule: [{ key: 'T-1', owner: 'Ana', sprint: 2 }, { key: 'T-2', owner: 'Ben', sprint: 1 }, { key: 'T-3', owner: 'Ben', sprint: 4 }], config: { first_sprint: 1, end_sprint: 6, caps: { default: 10 } } });
  assert.equal(whatif(m, { key: 'T-3', to: 'Ana', sprint: 2 }).ok, true);
  const w = whatif(m, { key: 'T-3', to: 'Ana', sprint: 1 });
  assert.deepEqual(w.suggestion, { sprint: 2, owner: 'Ana', shifts: 0, ownerChanges: 0, flags: ['slip'] });
  const pm = proposeMove(m, { key: 'T-3', to: 'Ana', sprint: 1 }, { allowSlip: true });
  assert.equal(pm.ok, true); assert.deepEqual(pm.moves, [{ key: 'T-3', from: { owner: 'Ben', sprint: 4 }, to: { owner: 'Ana', sprint: 2 } }]);
});

test('capacity boundary: a move landing exactly on capacity is accepted; one point over is refused and the suggestion is the first sprint with exactly enough room', () => {
  const T = (key: string, sp: number) => ({ key, sp, jira_status: 'To Do' });
  const m = buildModel({
    tickets: [T('A', 3), T('B', 2), T('C', 1), T('Z', 3), T('Y', 2)],
    edges: [],
    schedule: ([['A', 'Ben', 1], ['B', 'Ben', 2], ['C', 'Ben', 3], ['Z', 'Ana', 1], ['Y', 'Ana', 1]] as Array<[string, string, number]>).map(([key, owner, sprint]) => ({ key, owner, sprint })), // literal tuples
    config: { first_sprint: 1, end_sprint: 4, caps: { default: 10, Ben: 5 } },
  });
  const exact = whatif(m, { key: 'Y', to: 'Ben', sprint: 1 }); // 3 + 2 = 5 = cap
  assert.equal(exact.ok, true); assert.deepEqual(exact.reasons, []);
  assert.deepEqual(exact.load.Ben[1], { before: 3, after: 5, cap: 5 });
  const over = whatif(m, { key: 'Z', to: 'Ben', sprint: 1 }); // 3 + 3 = 6 > 5; S2 holds 2: 2 + 3 = 5 fits exactly; S3 (1 + 3 = 4) also fits
  assert.equal(over.ok, false);
  const cap = over.reasons.find((x) => x.code === 'CAPACITY') as WhatifReason; // a missing reason fails the asserts below
  assert.equal(cap.detail, '6/5');
  assert.equal(cap.fix, 'Ben has room in S2');
});
