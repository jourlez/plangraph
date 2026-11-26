// Trust tests for bin/plangraph-solve (docs/SOLVER.md, Trust). OR-Tools 9.15.6755 can report OPTIMAL above the true optimum on a hinted run
// (upstream issue 5582), and a raw infeasibility core is not trusted (upstream issue 5141). Each test runs the real solver (real OR-Tools through
// bin/plangraph-solve-run) with a small Python driver that loads bin/plangraph-solve as a module, injects a fault, and calls main():
//   nohint     no hint at all: the reference optimum;
//   wronghint  every hinted stage gets a deliberately wrong hint (all free tickets on one person in the first sprint: infeasible and better than
//              the optimum); the result must never beat the proven bound, never claim a false optimum, and still pass `verify`;
//   liar       every hinted stage solve is replaced by a fake solver that claims OPTIMAL for the hint itself (the issue 5582 symptom: a genuine
//              schedule, a matching objective, a false bound); the audit must catch every false claim and fall back to a verified schedule;
//   lowball    as liar, but the reported objective and bound are 1 below what the schedule has: the recomputation must catch it;
//   highbound  as liar, but the reported bound is 1 above the schedule's objective (the schedule beats the bound): caught the same way;
//   minimize   minimize_links on a superset of the injected conflicting links: deletion must shrink it to exactly the injected set.
// Skips only when neither uv nor a python3 with ortools exists on this machine (as test/solver.test.ts).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { genPlan, rng } from './fixtures/gen.ts';
import { buildModel } from '../lib/model.ts';
import { verifyPlan } from '../lib/verify.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUN = path.join(ROOT, 'bin', 'plangraph-solve-run');
const SOLVE = path.join(ROOT, 'bin', 'plangraph-solve');
type Plan = ReturnType<typeof genPlan>;
/** One row of the solver's schedule output. */
type Row = { item: string; owner: string; sprint: number };
/** One stage record of the meta file. */
type Stage = { name: string; status: string; objective: number; bound: number; untrusted?: string[]; solver_status?: string; below_bound?: boolean };
/** The fields of the solver's meta file these tests read. */
type Meta = { status: string; proved: boolean; verified: boolean; end_sprint: number; end_sprint_proved: boolean; stages: Stage[]; explanation: { links: string[]; n_links: number; more: number; proved_minimal: boolean } };
const has = (cmd: string, args: string[]) => { try { return spawnSync(cmd, args, { stdio: 'ignore', timeout: 120000 }).status === 0; } catch { return false; } };
const SKIP = has('uv', ['--version']) || has('python3', ['-c', 'import ortools']) ? false : 'skipped: neither uv nor a python3 with ortools is available, solver tests cannot run';
const tmpRoot = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'plangraph-solver-trust-'));
process.on('exit', () => fs.rmSync(tmpRoot, { recursive: true, force: true }));
spawnSync('git', ['init', '-q'], { cwd: tmpRoot }); // the solver confines paths to the git root of its cwd: run it from here
const DRIVER = path.join(tmpRoot, 'driver.py');
fs.writeFileSync(DRIVER, `
import importlib.machinery, importlib.util, json, sys, types
loader = importlib.machinery.SourceFileLoader('plangraph_solve', sys.argv[1]); spec = importlib.util.spec_from_loader('plangraph_solve', loader)
m = importlib.util.module_from_spec(spec); loader.exec_module(m)
from ortools.sat.python import cp_model as cp
mode = sys.argv[2]
if mode == 'nohint':
    m.set_hint = lambda pr, cx, assign: cx.m.ClearHints()
elif mode == 'wronghint':
    real_hint = m.set_hint
    m.set_hint = lambda pr, cx, assign: real_hint(pr, cx, {i: (assign[i] if i in pr.frozen else (0, pr.S0)) for i in range(pr.n)})
elif mode in ('liar', 'lowball', 'highbound'):
    real_solve = m.solve_with; dobj, dbound = {'liar': (0, 0), 'lowball': (-1, -1), 'highbound': (0, 1)}[mode]
    class Liar:
        """Claims OPTIMAL for the hinted assignment, with the hint's own objective as the bound."""
        def __init__(s, model):
            pb = model.Proto(); s.h = dict(zip(pb.solution_hint.vars, pb.solution_hint.values)); o = pb.objective
            ref = lambda r: s.h[r] if r >= 0 else 1 - s.h[-r - 1]
            s.obj = (o.offset + sum(c * ref(v) for v, c in zip(o.vars, o.coeffs))) * (o.scaling_factor or 1)
            s.deterministic_time = 0.0
        def Value(s, x): return x if isinstance(x, int) else s.h[x.Index()]
        def ObjectiveValue(s): return s.obj + dobj
        def BestObjectiveBound(s): return s.obj + dbound
        def NumConflicts(s): return 0
        def StatusName(s, st): return 'OPTIMAL'
    m.solve_with = lambda cp_, a, model, budget, on_solution, anytime: (Liar(model), cp.OPTIMAL) if m.has_hint(model) else real_solve(cp_, a, model, budget, on_solution, anytime)
elif mode == 'minimize':
    d, injected, extra = sys.argv[3], json.loads(sys.argv[4]), json.loads(sys.argv[5])
    A = types.SimpleNamespace(jsonl_dir=d, config=None, db=None, baseline='current', freeze=sys.argv[6], freeze_file=None, end=None, balance=False, deterministic=True, workers=1, seed=1)
    pr = m.prepare(A, *m.load_raw(A))
    link = lambda s: (pr.ix[s.split('>')[0]], pr.ix[s.split('>')[1]])
    end = pr.target; clock = m.Clock(100.0, True, 0.0); witness = m.construct(pr)
    out = {}
    got, sure = m.minimize_links(pr, cp, A, clock, end, {link(s) for s in injected + extra}, witness, 30.0)
    out['superset'] = [sorted(f'{pr.T[c]}>{pr.T[p]}' for c, p in got), sure]
    got, sure = m.minimize_links(pr, cp, A, clock, end, {link(s) for s in injected[1:]}, witness, 30.0)
    out['too_small'] = [sorted(f'{pr.T[c]}>{pr.T[p]}' for c, p in got), sure]
    print(json.dumps(out)); sys.exit(0)
sys.exit(m.main(sys.argv[3:]))
`);
let counter = 0;
const wjl = (f: string, rows: readonly unknown[]) => fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
function writePlan(plan: Plan) {
  const dir = path.join(tmpRoot, `p${counter++}`); fs.mkdirSync(dir, { recursive: true });
  wjl(path.join(dir, 'tickets.jsonl'), plan.tickets); wjl(path.join(dir, 'edges.jsonl'), plan.edges); wjl(path.join(dir, 'schedule.jsonl'), plan.schedule);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(plan.config));
  return dir;
}
/** Run the driver in `mode` through the real launcher; the solver's own flags follow. */
function drive(mode: string, args: string[]) {
  return spawnSync(RUN, [SOLVE, mode, ...args], { encoding: 'utf8', timeout: 300000, cwd: tmpRoot, env: { ...process.env, PLANGRAPH_SOLVE_SCRIPT: DRIVER } });
}
function solve(mode: string, dir: string, extra: string[] = []) {
  const out = path.join(dir, `${mode}.json`);
  const r = drive(mode, ['--jsonl-dir', dir, '--out', out, '--time', '30', '--deterministic', ...extra]);
  const read = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);
  const raw = read(out), metaRaw = read(`${out}.meta.json`);
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, raw, schedule: (raw ? JSON.parse(raw) : null) as Row[], meta: (metaRaw ? JSON.parse(metaRaw) : null) as Meta };
}
const verifyOut = (p: Plan, schedule: readonly Row[]) => verifyPlan(buildModel({ tickets: p.tickets, edges: p.edges, config: p.config,
  schedule: schedule.map((r) => ({ key: r.item, owner: r.owner, sprint: r.sprint })) })).map((v) => `${v.code} ${v.key} ${v.detail}`);
before(() => {
  if (SKIP) return;
  const w = spawnSync(RUN, ['--help'], { encoding: 'utf8', timeout: 600000 });
  if (w.status !== 0) throw new Error(`solver warm-up failed (status ${w.status}): ${String(w.stderr).slice(0, 500)}`);
}, { timeout: 630000 });

/** Tight capacity and a minimum per sprint, so the constructive start (the hint of stage 1) is often not optimal. */
const instance = (seed: number): Plan => {
  const p = genPlan({ n: 10 + (seed % 5), people: 3, density: 0.25, seed, cap: 6 });
  p.config.min_per_sprint = { [p.tickets[0].v2_owner as string]: 2 };
  return p;
};

/** The checks every faulty-hint run must pass against the unhinted reference. Returns how many false claims the audit caught. */
function compare(label: string, p: Plan, ref: ReturnType<typeof solve>, r: ReturnType<typeof solve>) {
  assert.ok([0, 4].includes(r.code as number), `${label}: exit ${r.code}\n${r.stdout}${r.stderr}`);
  assert.equal(r.meta.verified, true, label);
  assert.deepEqual(verifyOut(p, r.schedule), [], `${label}: the schedule fails plangraph verify`);
  let same = true, caught = 0;
  r.meta.stages.forEach((s, k) => {
    const want = ref.meta.stages[k];
    assert.equal(s.name, want.name, label);
    assert.ok(!s.below_bound && s.objective >= s.bound - 1e-9, `${label} ${s.name}: objective ${s.objective} beats its bound ${s.bound}`);
    assert.ok(s.objective >= (same ? want.objective : -Infinity), `${label} ${s.name}: ${s.objective} beats the true optimum ${want.objective}`);
    if (s.status === 'OPTIMAL' && same) assert.equal(s.objective, want.objective, `${label} ${s.name}: claimed OPTIMAL at ${s.objective}, optimum ${want.objective}`);
    if (s.untrusted) { caught++; assert.notEqual(s.status, 'OPTIMAL', label); assert.ok(s.bound <= want.objective, `${label} ${s.name}: fallback bound ${s.bound} above the optimum`); }
    same &&= s.objective === want.objective;
  });
  if (r.meta.status === 'OPTIMAL') assert.ok(same, `${label}: OPTIMAL but not the reference optimum`);
  if (r.meta.end_sprint_proved) assert.equal(r.meta.end_sprint, ref.meta.end_sprint, label);
  return caught;
}

test('trust: a deliberately wrong hint never yields an objective below the proven bound or a false OPTIMAL; output passes verify', { skip: SKIP, timeout: 600000 }, () => {
  for (let seed = 1; seed <= 8; seed++) {
    const p = instance(seed), dir = writePlan(p);
    const ref = solve('nohint', dir);
    assert.equal(ref.code, 0, `seed ${seed}: ${ref.stdout}${ref.stderr}`); assert.equal(ref.meta.status, 'OPTIMAL', `seed ${seed}: the reference must be proved`);
    compare(`wronghint seed ${seed}`, p, ref, solve('wronghint', dir));
  }
});

test('trust: a solver that claims OPTIMAL for its hint is caught; the stage is FEASIBLE and the result is a verified schedule', { skip: SKIP, timeout: 600000 }, () => {
  let caught = 0, better = 0;
  for (let seed = 1; seed <= 8; seed++) {
    const p = instance(seed), dir = writePlan(p);
    const ref = solve('nohint', dir); assert.equal(ref.meta.status, 'OPTIMAL', `seed ${seed}`);
    const r = solve('liar', dir);
    caught += compare(`liar seed ${seed}`, p, ref, r);
    better += r.meta.stages.filter((s) => s.untrusted?.includes('an unhinted re-solve found a better schedule')).length;
    for (const s of r.meta.stages) if (s.untrusted) assert.equal(s.solver_status, 'OPTIMAL', `seed ${seed}`);
    if (r.meta.stages.find((s) => s.status !== 'OPTIMAL')?.untrusted) assert.match(r.stdout, /solver claimed OPTIMAL, not trusted/);
  }
  // the fault must have been live: on these instances the hint is often not optimal, so a solver that believed the liar would claim false optima
  assert.ok(caught >= 2 && better >= 2, `caught ${caught} false claims (${better} with a better schedule): the test instances no longer exercise the audit`);
});

/** A genPlan base (all free tickets, first_sprint 2) plus N frozen consumers in sprint 1, each linked to a free producer: every injected link
 * is impossible (a free producer cannot sit before sprint 2). Decoys that must never be blamed: base links, links from free consumers to the
 * frozen tickets, and links between two frozen tickets (history). */
function injected(seed: number, N: number) {
  const p = genPlan({ n: 14, people: 3, density: 0.2, seed, cap: 1000 }), r = rng(seed * 31 + N);
  p.config.first_sprint = 2; p.config.end_sprint = 40;
  const inj: string[] = [], con: string[] = [];
  for (let k = 1; k <= N; k++) {
    const key = `CON-${k}`; con.push(key);
    p.tickets.push({ key, summary: key, epic: 'E', sp: 1, jira_status: 'To Do', v2_owner: 'Ana', v2_sprint: 1, verdict: 'READY', verdict_source: 'audit', first_verdict: 'READY' });
    p.schedule.push({ version: 'current', key, owner: 'Ana', sprint: 1 });
    const prod = `T-${1 + Math.floor(r() * 14)}`; inj.push(`${key}>${prod}`);
    p.edges.push({ consumer: key, producer: prod, kind: 'plan_need', note: '' });
    const free = `FREE-${k}`; // a free consumer of the frozen ticket: the link holds (sprint 2 or later)
    p.tickets.push({ key: free, summary: free, epic: 'E', sp: 1, jira_status: 'To Do', v2_owner: 'Ben', v2_sprint: 2, verdict: 'READY', verdict_source: 'audit', first_verdict: 'READY' });
    p.schedule.push({ version: 'current', key: free, owner: 'Ben', sprint: 2 });
    p.edges.push({ consumer: free, producer: key, kind: 'plan_need', note: '' });
    if (k > 1) p.edges.push({ consumer: key, producer: `CON-${k - 1}`, kind: 'plan_need', note: '' }); // two frozen tickets: history, never a constraint
  }
  return { p, inj: [...new Set(inj)].sort(), freeze: con.join(',') };
}

test('trust: with N injected conflicting links the explained core is exactly the injected set, confirmed minimal; nothing is written', { skip: SKIP, timeout: 600000 }, () => {
  for (const [seed, N] of [[1, 1], [2, 3], [3, 6], [4, 8]]) {
    const { p, inj, freeze } = injected(seed, N);
    const r = solve('honest', writePlan(p), ['--freeze', freeze]);
    assert.equal(r.code, 1, `seed ${seed}: ${r.stdout}${r.stderr}`); assert.equal(r.raw, null); assert.equal(r.meta.status, 'INFEASIBLE');
    const ex = r.meta.explanation;
    assert.equal(ex.more, 0); assert.equal(ex.n_links, inj.length, r.stdout);
    for (const l of ex.links) assert.ok(inj.includes(l), `seed ${seed}: ${l} is not an injected link (${inj.join(', ')})`);
    assert.deepEqual(ex.links, inj); assert.equal(ex.proved_minimal, true);
  }
});

test('trust: deletion-based minimisation shrinks a superset of the injected links to exactly that set, and refuses a set too small to verify', { skip: SKIP, timeout: 300000 }, () => {
  const { p, inj, freeze } = injected(5, 4);
  assert.ok(inj.length >= 2, 'the instance needs at least two distinct injected links');
  const decoys = p.edges.filter((e) => e.producer.startsWith('T-') && e.consumer.startsWith('T-')).slice(0, 5).map((e) => `${e.consumer}>${e.producer}`);
  assert.ok(decoys.length >= 3);
  const r = drive('minimize', [writePlan(p), JSON.stringify(inj), JSON.stringify(decoys), freeze]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout) as { superset: [string[], boolean]; too_small: [string[], boolean] };
  assert.deepEqual(out.superset, [inj, true]);
  // a claimed set that leaves one impossible link in place: the witness fails the verifier, so the set is returned unconfirmed, never as proved
  assert.deepEqual(out.too_small, [inj.slice(1), false]);
});

test('trust: a reported objective that differs from the schedule, or a bound the schedule beats, is never accepted as proved', { skip: SKIP, timeout: 600000 }, () => {
  for (const [mode, reason] of [['lowball', /^objective mismatch: reported -?\d+, the schedule has -?\d+$/], ['highbound', /beats the proven bound/]] as const) {
    for (let seed = 1; seed <= 3; seed++) {
      const p = instance(seed), dir = writePlan(p);
      const ref = solve('nohint', dir), r = solve(mode, dir);
      compare(`${mode} seed ${seed}`, p, ref, r);
      assert.notEqual(r.meta.status, 'OPTIMAL', `${mode} seed ${seed}`); assert.equal(r.meta.proved, false);
      for (const s of r.meta.stages) { // every stage is hinted (a valid start exists), so every stage report is faked and must be rejected
        assert.equal(s.status, 'FEASIBLE', `${mode} seed ${seed} ${s.name}`);
        assert.ok(s.untrusted?.some((w) => reason.test(w)), `${mode} seed ${seed} ${s.name}: ${JSON.stringify(s.untrusted)}`);
      }
    }
  }
});
