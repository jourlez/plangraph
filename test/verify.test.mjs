// Tests for lib/verify.mjs. Property + mutation tests over genPlan seeds.
// NOT covered: MINLOAD semantics beyond the documented convention (per person, sprints first_sprint..last used sprint, points);
// models with edges whose endpoints are missing from tickets (skipped silently); performance beyond a 5000-ticket smoke check.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildModel } from '../lib/model.mjs';
import { verifyPlan, summarize } from '../lib/verify.mjs';
import { genPlan } from './fixtures/gen.mjs';

const codes = (v) => v.map((x) => x.code);
const mk = (o) => buildModel(genPlan(o));
const clone = (m) => new Map([...m.sched].map(([k, v]) => [k, { ...v }]));

test('genPlan plans verify clean across 300 seeds (feasible by construction)', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const m = mk({ n: 5 + (seed % 40), people: 1 + (seed % 5), density: 0.05 + (seed % 7) / 20, seed });
    assert.deepEqual(verifyPlan(m), [], `seed ${seed}`);
  }
});

test('mutation: lowering a consumer below its handoff bound yields HANDOFF on exactly that consumer', () => {
  let hit = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const m = mk({ n: 25, people: 3, density: 0.15, seed });
    const keys = [...m.prods.keys()].sort(); if (!keys.length) continue;
    const c = keys[seed % keys.length], s = clone(m);
    s.get(c).sprint = s.get(c).sprint - 1; // sprint was max(producer bound, 1): one lower always breaks if bound>=... check below
    const bound = Math.max(...m.prods.get(c).map((p) => m.sched.get(p).sprint + (m.sched.get(p).owner !== m.sched.get(c).owner ? 1 : 0)));
    const v = verifyPlan(m, s).filter((x) => x.code === 'HANDOFF');
    if (m.sched.get(c).sprint === bound) { hit++; assert.ok(v.some((x) => x.key === c), `seed ${seed}`); assert.ok(v.every((x) => x.key === c || m.prods.get(x.key)?.includes(c)), 'only c or its consumers'); }
  }
  assert.ok(hit > 100);
});

test('mutation: flipping a producer owner so the handoff needs +1 is caught and names producer and consumer', () => {
  const m = buildModel({ tickets: [{ key: 'A', sp: 1 }, { key: 'B', sp: 1 }], edges: [{ consumer: 'B', producer: 'A', kind: 'x' }], schedule: [{ key: 'A', owner: 'Ana', sprint: 2 }, { key: 'B', owner: 'Ana', sprint: 2 }] });
  assert.deepEqual(verifyPlan(m), []);
  const s = clone(m); s.get('B').owner = 'Ben';
  const v = verifyPlan(m, s);
  assert.equal(v.length, 1); assert.equal(v[0].code, 'HANDOFF'); assert.equal(v[0].key, 'B');
  assert.match(v[0].detail, /producer A S2 Ana, consumer B S2 Ben, consumer needs >=S3/);
});

test('UNPLACED and UNKNOWN_TICKET', () => {
  const m = mk({ n: 6, seed: 4 });
  const s = clone(m); s.delete('T-3'); s.set('ZZ-1', { owner: 'Ana', sprint: 1 });
  s.set('T-4', { owner: 'Ana', sprint: 1.5 });
  const v = verifyPlan(m, s);
  assert.deepEqual(v.filter((x) => x.code === 'UNPLACED').map((x) => x.key), ['T-3', 'T-4']);
  assert.deepEqual(v.filter((x) => x.code === 'UNKNOWN_TICKET').map((x) => x.key), ['ZZ-1']);
});

test('CAPACITY: overloading one cell is reported with load/cap; per-person caps honored', () => {
  const g = genPlan({ n: 4, people: 1, density: 0, seed: 9, cap: 1000 });
  const m = buildModel({ ...g, schedule: g.schedule.map((r) => ({ ...r, sprint: 1 })), config: { ...g.config, caps: { default: 1000 } } });
  const total = [...m.tickets.values()].reduce((a, t) => a + t.sp, 0);
  assert.deepEqual(verifyPlan(m), []);
  m.config.caps = { default: total - 1 };
  assert.deepEqual(verifyPlan(m).map((x) => [x.code, x.key, x.detail]), [['CAPACITY', 'Ana S1', `${total}/${total - 1}`]]);
  m.config.caps = { default: 1, Ana: total };
  assert.deepEqual(verifyPlan(m), []);
});

test('FROZEN_MOVED', () => {
  const m = mk({ n: 8, seed: 5 });
  const fro = new Map([['T-2', { ...m.sched.get('T-2') }], ['T-3', { ...m.sched.get('T-3') }]]);
  assert.deepEqual(verifyPlan(m, m.sched, { frozen: fro }), []);
  const s = clone(m); s.get('T-2').owner = 'Zed';
  const v = verifyPlan(m, s, { frozen: fro });
  assert.deepEqual(codes(v.filter((x) => x.code === 'FROZEN_MOVED')), ['FROZEN_MOVED']);
  const s2 = clone(m); s2.get('T-3').sprint += 1; // sprint-only change is also a move
  assert.deepEqual(verifyPlan(m, s2, { frozen: fro }).filter((x) => x.code === 'FROZEN_MOVED').map((x) => x.key), ['T-3']);
  const s3 = clone(m); s3.delete('T-2');
  assert.ok(verifyPlan(m, s3, { frozen: fro }).some((x) => x.code === 'FROZEN_MOVED' && x.key === 'T-2'));
  assert.equal(v.find((x) => x.code === 'FROZEN_MOVED').key, 'T-2');
});

test('MINLOAD only when enforceMin', () => {
  const m = buildModel({ tickets: [{ key: 'A', sp: 3 }], schedule: [{ key: 'A', owner: 'Ana', sprint: 2 }], config: { first_sprint: 1, caps: { default: 10 }, min_per_sprint: { default: 2 } } });
  assert.deepEqual(verifyPlan(m), []);
  assert.deepEqual(verifyPlan(m, m.sched, { enforceMin: true }).map((x) => [x.code, x.key, x.detail]), [['MINLOAD', 'Ana S1', '0/2']]);
  m.config.min_per_sprint = { Ana: 3 }; // load exactly at the minimum is fine, one below is not
  assert.deepEqual(verifyPlan(m, m.sched, { enforceMin: true }).map((x) => x.key), ['Ana S1']);
  m.config.min_per_sprint = { Ana: 4 };
  assert.deepEqual(verifyPlan(m, m.sched, { enforceMin: true }).map((x) => `${x.key} ${x.detail}`), ['Ana S1 0/4', 'Ana S2 3/4']);
});

test('CYCLE: injected cycles are reported with path, canonical and deduplicated', () => {
  const tickets = ['A', 'B', 'C', 'D'].map((key) => ({ key, sp: 1 }));
  const edges = [['B', 'A'], ['C', 'B'], ['A', 'C'], ['D', 'C']].map(([consumer, producer]) => ({ consumer, producer, kind: 'x' }));
  const schedule = tickets.map((t) => ({ key: t.key, owner: 'Ana', sprint: 1 }));
  const v = verifyPlan(buildModel({ tickets, edges, schedule })).filter((x) => x.code === 'CYCLE');
  assert.equal(v.length, 1); assert.equal(v[0].key, 'A');
  assert.equal(v[0].detail, 'A -> C -> B -> A');
  // self loop
  const v2 = verifyPlan(buildModel({ tickets: [{ key: 'A', sp: 1 }], edges: [{ consumer: 'A', producer: 'A', kind: 'x' }], schedule: [{ key: 'A', owner: 'Ana', sprint: 1 }] })).filter((x) => x.code === 'CYCLE');
  assert.equal(v2[0].detail, 'A -> A');
});

test('CYCLE: injecting a back edge into 200 random DAGs is always detected; clean DAGs never report one', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const g = genPlan({ n: 30, people: 2, density: 0.1, seed });
    assert.equal(verifyPlan(buildModel(g)).filter((x) => x.code === 'CYCLE').length, 0);
    const m0 = buildModel(g); const consEdge = g.edges[seed % Math.max(1, g.edges.length)]; if (!consEdge) continue;
    // reverse edge closes a 2-cycle
    const m = buildModel({ ...g, edges: [...g.edges, { consumer: consEdge.producer, producer: consEdge.consumer, kind: 'x' }] });
    const cyc = verifyPlan(m).filter((x) => x.code === 'CYCLE');
    assert.ok(cyc.length >= 1, `seed ${seed}`);
    assert.ok(cyc.some((c) => c.detail.includes(consEdge.consumer) && c.detail.includes(consEdge.producer)));
    void m0;
  }
});

test('determinism and O(V+E) smoke (5000 tickets)', () => {
  const m = mk({ n: 5000, people: 8, density: 0.002, seed: 7 });
  const t0 = Date.now(); const a = JSON.stringify(verifyPlan(m)); const b = JSON.stringify(verifyPlan(m));
  assert.equal(a, b); assert.ok(Date.now() - t0 < 3000);
});

test('summarize: end sprint, owner changes vs baseline, load per person per sprint', () => {
  const m = mk({ n: 20, people: 3, seed: 11 });
  const s = summarize(m);
  assert.equal(s.owner_changes_vs_baseline, 0);
  assert.equal(s.end_sprint, Math.max(...[...m.sched.values()].map((p) => p.sprint)));
  const sum = Object.values(s.load).flatMap((o) => Object.values(o)).reduce((a, b) => a + b, 0);
  assert.equal(sum, [...m.tickets.values()].reduce((a, t) => a + t.sp, 0));
  const sc = clone(m); sc.get('T-1').owner = 'Zed'; sc.get('T-2').owner = 'Zed';
  assert.equal(summarize(m, sc).owner_changes_vs_baseline, 2);
  assert.equal(summarize(m, sc, { baseline: new Map([['T-1', 'Ana'], ['T-2', 'Zed']]) }).owner_changes_vs_baseline, 1);
});

// The sp: key namespace denotes superpowers implementation tasks (docs/FORMAT.md section 6): placed only when someone assigns them.
test('sp: tickets: unplaced is not UNPLACED; placed ones are verified like any ticket (HANDOFF); other keys still need a placement', () => {
  const tickets = [{ key: 'sp:p' }, { key: 'sp:p/1', sp: 1 }, { key: 'sp:p/2', sp: 1 }, { key: 'T-1', sp: 1 }];
  const edges = [{ consumer: 'sp:p/2', producer: 'sp:p/1', kind: 'sp_needs' }];
  const none = buildModel({ tickets, edges, schedule: [{ key: 'T-1', owner: 'Ana', sprint: 1 }] });
  assert.deepEqual(verifyPlan(none), [], 'unplaced sp: tickets (epic and tasks) are not reported');
  const noT = buildModel({ tickets, edges, schedule: [] });
  assert.deepEqual(verifyPlan(noT).map((x) => `${x.code} ${x.key}`), ['UNPLACED T-1'], 'a non-sp ticket still needs a placement');
  const placed = buildModel({ tickets, edges, schedule: [{ key: 'T-1', owner: 'Ana', sprint: 1 }, { key: 'sp:p/1', owner: 'Ben', sprint: 3 }, { key: 'sp:p/2', owner: 'Ana', sprint: 3 }] });
  assert.deepEqual(verifyPlan(placed).map((x) => `${x.code} ${x.key}`), ['HANDOFF sp:p/2']);
  const half = buildModel({ tickets, edges, schedule: [{ key: 'T-1', owner: 'Ana', sprint: 1 }, { key: 'sp:p/1', owner: 'Ben', sprint: null }] });
  assert.deepEqual(verifyPlan(half), [], 'an sp: row without a valid placement counts as unplaced');
});

// ---------- first-sprint window: oracle agreement with the solver's own verifier ----------
// bin/brain-solve's prepare() and verify() need no OR-Tools (it is imported in main()), so the solver module itself is the oracle:
// every instance of a small exhaustive grid is judged by both, and the sets of tickets reported before the first sprint must be equal.
const SOLVER = path.join(import.meta.dirname, '../bin/brain-solve');
const ORACLE = `
import sys, json, argparse, importlib.machinery, importlib.util
loader = importlib.machinery.SourceFileLoader('brain_solve', sys.argv[1])
spec = importlib.util.spec_from_loader('brain_solve', loader); m = importlib.util.module_from_spec(spec); loader.exec_module(m)
a = argparse.Namespace(baseline='current', freeze=None, freeze_file=None, end=None, balance=False)
out = []
for inst in json.load(sys.stdin):
    cur = {'current': {k: tuple(v) for k, v in inst['cur'].items()}}
    pr = m.prepare(a, inst['tickets'], [], cur, inst['cfg'])
    bad = m.verify(pr, {k: tuple(v) for k, v in inst['assign'].items()})
    out.append(sorted(b.split(' ')[0] for b in bad if 'before the first sprint' in b))
print(json.dumps(out))
`;
const python = () => { const r = spawnSync('python3', ['--version'], { encoding: 'utf8' }); return r.status === 0; };

test('BEFORE_FIRST agrees with bin/brain-solve verify() on an exhaustive grid (first_sprint, frozen_statuses, frozen_before_sprint)', { skip: !python() && 'python3 not found' }, () => {
  const insts = [], S = [0, 1, 2];
  for (const ca of S) for (const cb of S) for (const aa of S) for (const ab of S) for (const sa of ['To Do', 'In Progress', 'Done']) for (const sb of ['To Do', '']) for (const first of [0, 1, 2, 3]) for (const fst of [[], ['In Progress'], ['']]) for (const fb of [undefined, 1, 2]) {
    const cfg = { end_sprint: 9, caps: { default: 50 }, first_sprint: first, frozen_statuses: fst, ...(fb === undefined ? {} : { frozen_before_sprint: fb }) };
    insts.push({ tickets: [{ key: 'A', sp: 1, jira_status: sa, v2_owner: 'Ana', v2_sprint: 1 }, { key: 'B', sp: 2, jira_status: sb, v2_owner: 'Ben', v2_sprint: 1 }],
      cur: { A: ['Ana', ca], B: ['Ben', cb] }, assign: { A: ['Ana', aa], B: ['Ben', ab] }, cfg });
  }
  const r = spawnSync('python3', ['-I', '-c', ORACLE, SOLVER], { input: JSON.stringify(insts), encoding: 'utf8', maxBuffer: 1 << 26, timeout: 120000 });
  assert.equal(r.status, 0, r.stderr);
  const want = JSON.parse(r.stdout);
  assert.equal(want.length, insts.length);
  let flagged = 0;
  insts.forEach((x, i) => {
    const model = buildModel({ tickets: x.tickets, schedule: Object.entries(x.cur).map(([key, [owner, sprint]]) => ({ key, owner, sprint })), config: x.cfg });
    const sched = new Map(Object.entries(x.assign).map(([k, [owner, sprint]]) => [k, { owner, sprint }]));
    const got = verifyPlan(model, sched).filter((v) => v.code === 'BEFORE_FIRST').map((v) => v.key).sort();
    assert.deepEqual(got, want[i], JSON.stringify(x));
    flagged += got.length;
  });
  assert.ok(flagged > 1000 && flagged < insts.length * 2, `grid exercises both outcomes (${flagged} flagged of ${insts.length * 2})`);
});

test('BEFORE_FIRST: message, opts.frozen exemption, default first sprint 1, and a bad first_sprint is one CONFIG violation', () => {
  const tickets = [{ key: 'A', sp: 1 }, { key: 'B', sp: 1, jira_status: 'Done' }];
  const schedule = [{ key: 'A', owner: 'Ana', sprint: 0 }, { key: 'B', owner: 'Ana', sprint: 0 }];
  const m = (config) => buildModel({ tickets, schedule, config: { caps: { default: 10 }, ...config } });
  assert.deepEqual(verifyPlan(m({ first_sprint: 1, frozen_statuses: ['Done'] })), [{ code: 'BEFORE_FIRST', key: 'A', detail: 'sprint 0 before the first sprint 1' }]);
  assert.deepEqual(verifyPlan(m({})).map((v) => v.key), ['A'], 'default first_sprint is 1; no frozen_statuses: only Done (always frozen) is exempt');
  assert.deepEqual(verifyPlan(m({}), undefined, { frozen: new Map([['A', { owner: 'Ana', sprint: 0 }], ['B', { owner: 'Ana', sprint: 0 }]]) }), []);
  assert.deepEqual(verifyPlan(m({ first_sprint: 0 })), []);
  for (const bad of [1.5, '1', true, null, 1e7, -1e7, [1], {}]) {
    assert.deepEqual(verifyPlan(m({ first_sprint: bad, min_per_sprint: { default: 5 } }), undefined, { enforceMin: true }),
      [{ code: 'CONFIG', key: 'first_sprint', detail: 'must be a whole number from -1000000 to 1000000' }], JSON.stringify(bad));
  }
  assert.ok(verifyPlan(m({ first_sprint: -1e6 })).every((v) => v.code !== 'CONFIG'), 'the bound itself is accepted');
});

test('BEFORE_FIRST: Done and closed_statuses tickets are always frozen (as in bin/brain-solve), whatever frozen_statuses says', () => {
  const tickets = [{ key: 'A', sp: 1, jira_status: 'Done' }, { key: 'B', sp: 1, jira_status: 'Closed' }, { key: 'C', sp: 1, jira_status: 'To Do' }];
  const schedule = [{ key: 'A', owner: 'Ana', sprint: 1 }, { key: 'B', owner: 'Ana', sprint: 1 }, { key: 'C', owner: 'Ana', sprint: 1 }];
  const m = (config) => buildModel({ tickets, schedule, config: { caps: { default: 10 }, first_sprint: 2, ...config } });
  assert.deepEqual(verifyPlan(m({ frozen_statuses: [] })).map((v) => v.key), ['B', 'C']);
  assert.deepEqual(verifyPlan(m({ frozen_statuses: [], closed_statuses: ['Done', 'Closed'] })).map((v) => v.key), ['C']);
});
