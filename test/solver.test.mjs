// Tests for bin/brain-solve (CP-SAT sprint assignment), run through the launcher bin/brain-solve-run with --jsonl-dir (no Node SQLite needed).
// What is covered: property tests on genPlan instances checked by a Node-side verifier written in this file (handoff, capacity, frozen, placed once);
// a brute-force oracle on tiny instances (optimal end sprint, optimal load_of, minimum owner changes: the lexicographic optimum); infeasible instance
// with a known culprit link; determinism (byte-identical output); frozen assignments (four ways); baselines; status honesty under a tiny budget;
// transitive reduction keeps the optimum; exit codes; atomic/refused writes; stage_order (meta order, brute force for owner-first and
// shortfall-first, invalid values, the `brain init` default); anytime output (SIGTERM leaves a verified file, restore on verifier rejection);
// --lns/--decompose polish (verified, never worse, deterministic); the first_sprint window (free tickets never before first_sprint, frozen ones
// exempt, no contradictory end-sprint bound); the anytime verifier gate and the LNS acceptance check (mutants); partial meta written before the
// schedule, --meta none turning anytime writes off, gap_pct clamping and the directory fsync (Python unit checks, stdlib only).
// NOT covered: the SQLite input path (smoke.sh covers it when ortools is present), real-size optimality (only the status honesty is tested at 1400
// tickets), multi-worker nondeterminism (only --deterministic is tested for identical bytes), Windows, and the launcher's venv fallback branch;
// anytime writes with --format object end to end, a kill landing between the meta and schedule renames, the 64 MiB snapshot limit, and the measured --lns gain (docs/SOLVER.md, not a test).
// Skips only when neither `uv` nor a python3 with ortools exists on this machine.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { genPlan, rng } from './fixtures/gen.mjs';
import { buildModel } from '../lib/model.mjs';
import { verifyPlan } from '../lib/verify.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUN = path.join(ROOT, 'bin', 'brain-solve-run');
const SOLVE = path.join(ROOT, 'bin', 'brain-solve');
const has = (cmd, args) => { try { return spawnSync(cmd, args, { stdio: 'ignore', timeout: 120000 }).status === 0; } catch { return false; } };
const HAVE_UV = has('uv', ['--version']);
const HAVE_PY = has('python3', ['-c', 'import ortools']);
const SKIP = HAVE_UV || HAVE_PY ? false : 'skipped: neither uv nor a python3 with ortools is available, solver tests cannot run';
if (SKIP) console.log(SKIP);
const tmpRoot = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'brain-solver-'));
process.on('exit', () => fs.rmSync(tmpRoot, { recursive: true, force: true }));
spawnSync('git', ['init', '-q'], { cwd: tmpRoot });  // the solver confines paths to the git root of its cwd: run it from here
let counter = 0;

const wjl = (f, rows) => fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
function writePlan(plan) {
  const dir = path.join(tmpRoot, `p${counter++}`); fs.mkdirSync(dir, { recursive: true });
  wjl(path.join(dir, 'tickets.jsonl'), plan.tickets); wjl(path.join(dir, 'edges.jsonl'), plan.edges); wjl(path.join(dir, 'schedule.jsonl'), plan.schedule);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(plan.config));
  return dir;
}
function solve(plan, args = [], { env = {}, time = 30 } = {}) {
  const dir = writePlan(plan); const out = path.join(dir, 'out.json');
  const r = spawnSync(RUN, ['--jsonl-dir', dir, '--out', out, '--time', String(time), ...args], { encoding: 'utf8', timeout: 300000, cwd: tmpRoot, env: { ...process.env, ...env } });
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);
  const raw = read(out), metaRaw = read(out + '.meta.json');
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, dir, out, raw, metaRaw, schedule: raw ? JSON.parse(raw) : null, meta: metaRaw ? JSON.parse(metaRaw) : null };
}
// Explicit timeouts (ms). A cold uv env (numpy + ortools wheels) took 27 s to build in one isolated-cache measurement and is network-bound, so it can take much longer on a slow connection; the warm-up below pays it once, so these only
// need to cover the work of one test, with margin for a slow machine.
const WARMUP_MS = 600000, T_HEAVY = 600000, T_MEDIUM = 300000, T_LIGHT = 120000;
before(() => {
  if (SKIP) return;
  const w = spawnSync(RUN, ['--help'], { encoding: 'utf8', timeout: WARMUP_MS });
  // A failed warm-up must fail loudly here, not as a confusing timeout inside an unrelated test.
  if (w.status !== 0) throw new Error(`solver warm-up failed (status ${w.status}, signal ${w.signal}): ${String(w.stderr).slice(0, 500)}`);
}, { timeout: WARMUP_MS + 30000 });
const plan = (o) => genPlan(o);
const people = (p) => [...new Set([...p.tickets.map((t) => t.v2_owner), ...p.schedule.filter((s) => (s.version ?? 'current') === 'current').map((s) => s.owner)])].sort();
const capOf = (p, who) => p.config.caps[who] ?? p.config.caps.default ?? 140;

// Independent verifier (Node side). Returns a list of problems. A ticket that is not frozen must sit in first_sprint or later (no new work in
// past sprints); a frozen ticket keeps its own slot, which may be earlier.
function check(p, schedule, frozen = new Map()) {
  const bad = [], at = new Map(), first = p.config.first_sprint ?? 1;
  for (const r of schedule) { if (at.has(r.item)) bad.push(`dup ${r.item}`); at.set(r.item, r); }
  for (const t of p.tickets) if (!at.has(t.key)) bad.push(`missing ${t.key}`);
  if (at.size !== p.tickets.length) bad.push('extra tickets');
  const P = people(p), skip = new Set(p.config.ignore_link_kinds || []), sp = new Map(p.tickets.map((t) => [t.key, t.sp])), load = new Map();
  for (const r of schedule) {
    if (!P.includes(r.owner)) bad.push(`owner ${r.owner}`);
    if (!Number.isInteger(r.sprint) || r.sprint < 1) bad.push(`sprint ${r.sprint}`);
    else if (!frozen.has(r.item) && r.sprint < first) bad.push(`past sprint ${r.item} S${r.sprint} < S${first}`);
    const k = `${r.owner}|${r.sprint}`; load.set(k, (load.get(k) || 0) + sp.get(r.item));
  }
  for (const [k, v] of load) if (v > capOf(p, k.split('|')[0])) bad.push(`cap ${k} ${v}`);
  for (const e of p.edges) {
    if (skip.has(e.kind)) continue;
    const c = at.get(e.consumer), q = at.get(e.producer);
    if (c.sprint < q.sprint + (c.owner === q.owner ? 0 : 1)) bad.push(`handoff ${e.consumer}>${e.producer}`);
  }
  for (const [k, v] of frozen) { const r = at.get(k); if (r.owner !== v.owner || r.sprint !== v.sprint) bad.push(`frozen ${k} moved`); }
  return bad;
}
const curOf = (p) => new Map(p.schedule.map((s) => [s.key, { owner: s.owner, sprint: s.sprint }]));
const endOf = (s) => Math.max(...s.map((r) => r.sprint));
const changes = (s, base) => s.filter((r) => base.get(r.item) && base.get(r.item) !== r.owner).length;

test('property: valid, proved optimal schedules on random genPlan instances', { skip: SKIP, timeout: T_HEAVY }, () => {
  for (let seed = 1; seed <= 16; seed++) {
    const p = plan({ n: 3 + ((seed * 7) % 23), people: 2 + (seed % 3), density: 0.15, seed, cap: 5 + (seed % 4) * 3 });
    const r = solve(p);
    assert.equal(r.code, 0, `seed ${seed}: ${r.stdout}${r.stderr}`);
    assert.deepEqual(check(p, r.schedule), [], `seed ${seed}`);
    assert.equal(r.meta.status, 'OPTIMAL', `seed ${seed}`); assert.equal(r.meta.proved, true); assert.equal(r.meta.verified, true);
    assert.equal(r.meta.end_sprint, endOf(r.schedule));
    assert.equal(r.meta.owner_changes, changes(r.schedule, new Map(p.schedule.map((s) => [s.key, s.owner]))));
    assert.match(r.meta.input_hash, /^[0-9a-f]{64}$/); assert.equal(r.meta.seed, 1); assert.ok(r.meta.ortools_version);
  }
});

// brute force oracle: all (person, sprint in 1..4) assignments of a tiny plan; lexicographic optimum in `order` (default end, load_of, owner
// changes). Returns [end, load_of, owner changes, shortfall] of the optimum; shortfall counts min_per_sprint over sprints 1..end.
// Window: the oracle's plans have first_sprint 1 and no frozen tickets, so its sprint range 1..4 starts at first_sprint, the same window the
// solver gives free tickets; it never had the frozen-below-first_sprint window bug (it has no frozen tickets).
function oracle(p, loadOf, order = ['end', 'load', 'changes']) {
  assert.equal(p.config.first_sprint ?? 1, 1, 'the oracle enumerates sprints from 1: first_sprint must be 1');
  assert.equal(p.config.frozen_statuses, undefined, 'the oracle has no frozen tickets');
  const P = people(p), keys = p.tickets.map((t) => t.key), n = keys.length, sp = p.tickets.map((t) => t.sp), ix = new Map(keys.map((k, i) => [k, i]));
  const cur = curOf(p), base = keys.map((k) => cur.get(k).owner), links = p.edges.map((e) => [ix.get(e.consumer), ix.get(e.producer)]);
  const SP = 4, per = P.length * SP, o = new Array(n), s = new Array(n); let best = null, bestKey = null;
  const cap = p.config.caps.default, mins = Object.entries(p.config.min_per_sprint || {});
  const at = { end: 0, load: 1, changes: 2, short: 3 };
  (function rec(i) {
    if (i === n) {
      for (const [c, q] of links) if (s[c] < s[q] + (o[c] === o[q] ? 0 : 1)) return;
      const ld = new Map(); for (let j = 0; j < n; j++) { const k = o[j] * 10 + s[j]; ld.set(k, (ld.get(k) || 0) + sp[j]); }
      for (const v of ld.values()) if (v > cap) return;
      const end = Math.max(...s), lo = loadOf == null ? 0 : sp.reduce((a, v, j) => a + (P[o[j]] === loadOf ? v : 0), 0);
      const ch = o.reduce((a, v, j) => a + (P[v] !== base[j] ? 1 : 0), 0);
      let short = 0; for (const [who, mn] of mins) for (let t = 1; t <= end; t++) short += Math.max(0, mn - (ld.get(P.indexOf(who) * 10 + t) || 0));
      const cand = [end, lo, ch, short], key = order.map((nm) => cand[at[nm]]);
      if (!best || key.findIndex((v, j) => v !== bestKey[j]) === key.findIndex((v, j) => v < bestKey[j]) && key.some((v, j) => v !== bestKey[j])) { best = cand; bestKey = key; }
      return;
    }
    for (let c = 0; c < per; c++) { o[i] = Math.floor(c / SP); s[i] = (c % SP) + 1; rec(i + 1); }
  })(0);
  return best;
}
test('oracle: optimal end sprint, load_of and minimum owner changes match brute force', { skip: SKIP, timeout: T_HEAVY }, () => {
  let checked = 0;
  for (let seed = 1; seed <= 14; seed++) {
    const p = plan({ n: 3 + (seed % 4), people: 2, density: 0.5, seed: seed * 3, cap: 8, maxSp: 3 });
    const P = people(p), useLoad = seed % 2 === 0 && P.length > 1; if (useLoad) p.config.minimize_load_of = P[0];
    const want = oracle(p, useLoad ? P[0] : null);
    const r = solve(p);
    assert.equal(r.code, 0, `seed ${seed}: ${r.stdout}`); assert.equal(r.meta.status, 'OPTIMAL');
    assert.deepEqual(check(p, r.schedule), []);
    assert.equal(r.meta.end_sprint, want[0], `seed ${seed} end`);
    if (useLoad) assert.equal(r.meta.load_of, want[1], `seed ${seed} load_of`);
    assert.equal(r.meta.owner_changes, want[2], `seed ${seed} owner changes`);
    checked++;
  }
  assert.equal(checked, 14);
});

// ---- Task 21: configurable stage order, anytime output, decomposition and LNS polish
const OWNER_FIRST = ['end_sprint', 'shortfall', 'owner_changes', 'load_of'];
test('stage_order: config order is honored in the meta stages; the default keeps end, shortfall, load_of, owner_changes', { skip: SKIP, timeout: T_MEDIUM }, () => {
  const p = plan({ n: 12, people: 3, density: 0.2, seed: 11, cap: 10 }); const P = people(p);
  p.config.minimize_load_of = P[0]; p.config.min_per_sprint = { [P[1]]: 1 };
  const d = solve(p); assert.equal(d.code, 0, d.stdout);
  assert.deepEqual(d.meta.stages.map((s) => s.name), ['end_sprint', 'shortfall', 'load_of', 'owner_changes']);
  assert.deepEqual(d.meta.stage_order, ['end_sprint', 'shortfall', 'load_of', 'owner_changes']);
  const o = solve({ ...p, config: { ...p.config, stage_order: OWNER_FIRST } }); assert.equal(o.code, 0, o.stdout);
  assert.deepEqual(o.meta.stages.map((s) => s.name), OWNER_FIRST); assert.deepEqual(o.meta.stage_order, OWNER_FIRST);
  assert.deepEqual(check(p, o.schedule), []);
  // stages that do not apply are dropped, stages left out are appended in the default order
  const part = solve({ ...p, config: { ...p.config, min_per_sprint: {}, stage_order: ['owner_changes', 'end_sprint'] } }); assert.equal(part.code, 0, part.stdout);
  assert.deepEqual(part.meta.stages.map((s) => s.name), ['owner_changes', 'end_sprint', 'load_of']);
  assert.equal(part.meta.end_sprint_proved, false, 'an end sprint minimised after another stage is not the global minimum');
});

test('stage_order: the default written by `brain init` keeps today\'s order (peak_load before owner_changes with balance_load)', { skip: SKIP, timeout: T_MEDIUM }, () => {
  const repo = fs.mkdtempSync(path.join(tmpRoot, 'init-')); spawnSync('git', ['init', '-q'], { cwd: repo });
  const ir = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'brain'), 'init'], { cwd: repo, encoding: 'utf8', env: { ...process.env, BRAIN_DIR: '' } });
  assert.equal(ir.status, 0, ir.stderr);
  const so = JSON.parse(fs.readFileSync(path.join(repo, '.brain', 'config.json'), 'utf8')).stage_order;
  assert.deepEqual(so, ['end_sprint', 'shortfall', 'load_of', 'peak_load', 'owner_changes']);
  const p = plan({ n: 10, people: 3, density: 0.2, seed: 12, cap: 10 }); p.config.balance_load = true; p.config.min_per_sprint = { [people(p)[0]]: 1 };
  const a = solve(p, ['--deterministic']), b = solve({ ...p, config: { ...p.config, stage_order: so } }, ['--deterministic']);
  assert.deepEqual(a.meta.stages.map((s) => s.name), ['end_sprint', 'shortfall', 'peak_load', 'owner_changes']);
  assert.deepEqual(b.meta.stages.map((s) => s.name), ['end_sprint', 'shortfall', 'peak_load', 'owner_changes']); assert.equal(b.raw, a.raw);
});

test('stage_order: invalid values exit 2 with a fixed message that does not echo the value, and write nothing', { skip: SKIP, timeout: T_MEDIUM }, () => {
  const p = plan({ n: 5, people: 2, density: 0.2, seed: 3, cap: 10 });
  const cases = [
    [['end_sprint', 'EVIL<x>\nOPTIMAL'], 'MODEL_INVALID: stage_order names an unknown stage (known: end_sprint, shortfall, load_of, peak_load, owner_changes)'],
    [['end_sprint', 'end_sprint'], 'MODEL_INVALID: stage_order lists a stage twice'],
    ['end_sprint,owner_changes', 'MODEL_INVALID: stage_order must be a list of stage names'],
    [['end_sprint', true], 'MODEL_INVALID: stage_order must be a list of stage names'],
    [['__proto__'], 'MODEL_INVALID: stage_order names an unknown stage (known: end_sprint, shortfall, load_of, peak_load, owner_changes)'],
  ];
  for (const [so, msg] of cases) {
    const r = solve({ ...p, config: { ...p.config, stage_order: so } });
    assert.equal(r.code, 2, r.stdout); assert.equal(r.stdout, msg + '\n', JSON.stringify(so)); assert.equal(r.raw, null); assert.equal(r.metaRaw, null);
  }
});

test('oracle: owner-first stage order matches the brute-force (end, owner changes, load_of) optimum', { skip: SKIP, timeout: T_HEAVY }, () => {
  let differs = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const p = plan({ n: 3 + (seed % 4), people: 2, density: 0.5, seed: seed * 5, cap: 8, maxSp: 3 }); const P = people(p);
    if (P.length < 2) continue;
    p.config.minimize_load_of = P[0]; p.config.stage_order = OWNER_FIRST;
    const want = oracle(p, P[0], ['end', 'changes', 'load']), dflt = oracle(p, P[0]);
    if (want[2] !== dflt[2] || want[1] !== dflt[1]) differs++;
    const r = solve(p); assert.equal(r.code, 0, `seed ${seed}: ${r.stdout}`); assert.equal(r.meta.status, 'OPTIMAL');
    assert.deepEqual(check(p, r.schedule), []);
    assert.equal(r.meta.end_sprint, want[0], `seed ${seed} end`); assert.equal(r.meta.owner_changes, want[2], `seed ${seed} owner changes`);
    assert.equal(r.meta.load_of, want[1], `seed ${seed} load_of`);
  }
  assert.ok(differs >= 2, `the instances must make the order matter (${differs})`);
});

test('oracle: shortfall placed before end_sprint counts only sprints up to the end (brute force, shortfall-first order)', { skip: SKIP, timeout: T_HEAVY }, () => {
  for (let seed = 1; seed <= 10; seed++) {
    const p = plan({ n: 3 + (seed % 3), people: 2, density: 0.4, seed: seed * 7, cap: 6, maxSp: 3 }); const P = people(p);
    if (P.length < 2) continue;
    p.config.min_per_sprint = { [P[0]]: 2 }; p.config.stage_order = ['shortfall', 'end_sprint', 'owner_changes'];
    const want = oracle(p, null, ['short', 'end', 'changes']);
    const r = solve(p); assert.equal(r.code, 0, `seed ${seed}: ${r.stdout}`); assert.equal(r.meta.status, 'OPTIMAL', `seed ${seed}`);
    assert.deepEqual(check(p, r.schedule), []); assert.deepEqual(r.meta.stage_order, ['shortfall', 'end_sprint', 'owner_changes']);
    assert.equal(r.meta.shortfall, want[3], `seed ${seed} shortfall`); assert.equal(r.meta.end_sprint, want[0], `seed ${seed} end`);
    assert.equal(r.meta.owner_changes, want[2], `seed ${seed} owner changes`);
  }
});

test('stage_order: shortfall first, when the default order reaches zero shortfall, ends in the same sprint (instances where the end is below the horizon)', { skip: SKIP, timeout: T_HEAVY }, () => {
  let below = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const p = plan({ n: 8 + (seed % 5), people: 2, density: 0.3, seed: seed * 13, cap: 5, maxSp: 3 }); const P = people(p);
    if (P.length < 2) continue;
    p.config.min_per_sprint = { [P[0]]: 3 };
    const d = solve(p, ['--deterministic']), s = solve({ ...p, config: { ...p.config, stage_order: ['shortfall', 'end_sprint', 'owner_changes'] } }, ['--deterministic']);
    assert.equal(d.meta.status, 'OPTIMAL', `seed ${seed}`); assert.equal(s.meta.status, 'OPTIMAL', `seed ${seed}`); assert.deepEqual(check(p, s.schedule), []);
    assert.ok(s.meta.shortfall <= d.meta.shortfall, `seed ${seed}`);
    if (d.meta.shortfall === 0) assert.equal(s.meta.end_sprint, d.meta.end_sprint, `seed ${seed}: zero shortfall is reachable at the minimum end sprint`);
    if (d.meta.end_sprint < s.meta.horizon) below++;
  }
  assert.ok(below >= 2, `instances must leave room between the end sprint and the model horizon (${below})`);
});

test('stage_order: on a replan instance with a feasible current plan, owner-first never changes more owners than the default', { skip: SKIP, timeout: T_HEAVY }, () => {
  let strictly = 0;
  for (const seed of [21, 22, 23]) {
    const p = plan({ n: 26, people: 3, density: 0.15, seed }); const P = people(p);
    const ld = new Map(), sp = new Map(p.tickets.map((t) => [t.key, t.sp]));
    for (const s of p.schedule) ld.set(`${s.owner}|${s.sprint}`, (ld.get(`${s.owner}|${s.sprint}`) || 0) + sp.get(s.key));
    p.config.caps = { default: Math.max(...ld.values()) };   // the tightest capacity under which the current plan is still feasible
    assert.deepEqual(check(p, p.schedule.map((s) => ({ item: s.key, owner: s.owner, sprint: s.sprint }))), [], 'current plan must be feasible');
    p.config.minimize_load_of = P[0];
    const d = solve(p), o = solve({ ...p, config: { ...p.config, stage_order: OWNER_FIRST } });
    assert.equal(d.code, 0, d.stdout); assert.equal(o.code, 0, o.stdout); assert.equal(d.meta.status, 'OPTIMAL'); assert.equal(o.meta.status, 'OPTIMAL');
    assert.deepEqual(check(p, o.schedule), []); assert.equal(o.meta.end_sprint, d.meta.end_sprint);
    assert.ok(o.meta.owner_changes <= d.meta.owner_changes, `seed ${seed}: ${o.meta.owner_changes} > ${d.meta.owner_changes}`);
    if (o.meta.owner_changes < d.meta.owner_changes) strictly++;
  }
  assert.ok(strictly >= 1, 'at least one instance must show the order mattering');
});

// Review C1: the horizon came from the earliest-ending constructive pass, so with owner_changes before end_sprint every schedule ending later
// (including a valid current plan) was outside the model and the solver claimed OPTIMAL while adding owner changes the current plan does not need.
test('stage_order: owner_changes first never adds owner changes a valid current plan does not need (repro: 4 tickets, current ends S3)', { skip: SKIP, timeout: T_LIGHT * 2 }, () => {
  const p = { tickets: ['T-1', 'T-2', 'T-3', 'T-4'].map((k) => ({ key: k, sp: 3 })), edges: [],
    schedule: [{ key: 'T-1', owner: 'Ana', sprint: 1 }, { key: 'T-2', owner: 'Ana', sprint: 2 }, { key: 'T-3', owner: 'Ana', sprint: 3 }, { key: 'T-4', owner: 'Ben', sprint: 1 }],
    config: { first_sprint: 1, end_sprint: 10, caps: { default: 5 }, stage_order: ['owner_changes', 'end_sprint'] } };
  const r = solve(p, ['--deterministic'], { time: 5 });
  assert.equal(r.code, 0, r.stdout + r.stderr); assert.deepEqual(check(p, r.schedule), []);
  assert.equal(r.meta.owner_changes, 0, r.stdout); assert.equal(r.meta.end_sprint, 3, r.stdout);
  assert.equal(r.stdout, `OPTIMAL: ends sprint 3 (target 10), owner changes 0 vs current, shortfall 0 SP; wrote ${r.out}\n`);
  assert.equal(r.meta.proved, true); assert.ok(r.meta.horizon >= 10, `horizon ${r.meta.horizon} must contain the current plan and the target`);
});

test('property: owner-first stage order never has more owner changes than a feasible current plan (0: the current plan is the baseline)', { skip: SKIP, timeout: T_HEAVY }, () => {
  let checked = 0;
  for (let seed = 41; seed <= 52; seed++) {
    const p = plan({ n: 30 + ((seed * 11) % 31), people: 3, density: 0.12, seed });
    const ld = new Map(), sp = new Map(p.tickets.map((t) => [t.key, t.sp]));
    for (const s of p.schedule) ld.set(`${s.owner}|${s.sprint}`, (ld.get(`${s.owner}|${s.sprint}`) || 0) + sp.get(s.key));
    p.config.caps = { default: Math.max(...ld.values()) };   // tightest capacity under which the current plan is still feasible
    const cur = p.schedule.map((s) => ({ item: s.key, owner: s.owner, sprint: s.sprint }));
    assert.deepEqual(check(p, cur), [], `seed ${seed}: current plan must be feasible`);
    p.config.stage_order = ['owner_changes', 'end_sprint'];
    const r = solve(p, ['--deterministic'], { time: 20 });
    assert.ok(r.code === 0 || r.code === 4, `seed ${seed}: ${r.stdout}`); assert.deepEqual(check(p, r.schedule), [], `seed ${seed}`);
    assert.equal(r.meta.owner_changes, 0, `seed ${seed}: ${r.stdout}`);
    assert.ok(r.meta.end_sprint <= endOf(cur), `seed ${seed}: ends ${r.meta.end_sprint} after the current plan (${endOf(cur)})`);
    if (r.meta.proved) assert.equal(r.meta.status, 'OPTIMAL');
    checked++;
  }
  assert.equal(checked, 12);
});

test('status honesty: a stage before end_sprint above its horizon-free lower bound is proved only within the horizon, never OPTIMAL', { skip: SKIP, timeout: T_LIGHT * 2 }, () => {
  const p = { tickets: [{ key: 'A-1', sp: 3, v2_owner: 'Ana' }, { key: 'A-2', sp: 3, v2_owner: 'Ana' }], edges: [{ consumer: 'A-2', producer: 'A-1', kind: 'plan_need', note: '' }],
    schedule: [{ key: 'A-1', owner: 'Ana', sprint: 1 }, { key: 'A-2', owner: 'Ana', sprint: 2 }],
    config: { first_sprint: 1, end_sprint: 4, caps: { default: 5 }, min_per_sprint: { Ana: 5 }, stage_order: ['shortfall', 'end_sprint'] } };
  const r = solve(p, ['--deterministic'], { time: 5 });
  assert.equal(r.code, 0, r.stdout); assert.deepEqual(check(p, r.schedule), []);
  assert.equal(r.meta.shortfall, 4); assert.equal(r.meta.status, 'FEASIBLE'); assert.equal(r.meta.proved, false); assert.equal(r.meta.proof_scope, 'horizon');
  assert.match(r.stdout, /^FEASIBLE \(optimal only among schedules ending by sprint \d+: a stage before end_sprint is not proved globally\): ends sprint/);
});

// 600 tickets, owner changes first so the solution callback fires within seconds: the solver keeps --out at the best verified schedule while it
// works, so SIGTERM leaves a valid file. The kill waits for a callback write (stage without ':done'), not the forced end-of-stage write.
test('anytime: SIGTERM after the first CP-SAT callback solution leaves a verified --out written atomically', { skip: SKIP, timeout: T_HEAVY }, async () => {
  // load_of first: the owner-keeping construction already has 0 owner changes (the start since the C1 fix), so an owner-first order would
  // give CP-SAT nothing to improve; moving work off Ana improves at once
  const p = plan({ n: 600, people: 4, density: 0.175, seed: 3, cap: 40 }); p.config.stage_order = ['load_of', 'end_sprint']; p.config.minimize_load_of = 'Ana';
  const dir = writePlan(p), out = path.join(dir, 'out.json');
  const child = spawn(RUN, ['--jsonl-dir', dir, '--out', out, '--time', '120', '--verbose'], { cwd: tmpRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '', last = null, killedAt = null;
  const done = new Promise((res) => child.on('close', (code, signal) => res({ code, signal })));
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (s) => {
    err += s;
    for (const line of err.split('\n').slice(0, -1)) if (line.startsWith('anytime ')) last = JSON.parse(line.slice(8));
    err = err.slice(err.lastIndexOf('\n') + 1);
    if (last && last.source === 'cp-sat' && !last.stage.endsWith(':done') && killedAt === null) { killedAt = Date.now(); child.kill('SIGTERM'); }
  });
  const killer = setTimeout(() => child.kill('SIGKILL'), 150000);
  const end = await done; clearTimeout(killer);
  assert.ok(killedAt !== null, `no anytime cp-sat callback line before exit (${end.code}/${end.signal})`); assert.equal(last.stage, 'load_of');
  assert.equal(end.signal ?? (end.code === 143 ? 'SIGTERM' : end.code), 'SIGTERM');
  const st1 = fs.statSync(out); await new Promise((res) => setTimeout(res, 3000)); const st2 = fs.statSync(out);
  assert.equal(st2.mtimeMs, st1.mtimeMs, 'no solver process keeps writing after the signal (the launcher passed SIGTERM on)');
  const sched = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepEqual(check(p, sched), []); assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
  assert.equal(endOf(sched), last.end_sprint); assert.equal(changes(sched, new Map(p.schedule.map((s) => [s.key, s.owner]))), last.owner_changes);
  const meta = JSON.parse(fs.readFileSync(out + '.meta.json', 'utf8'));
  assert.equal(meta.partial, true); assert.equal(meta.status, 'FEASIBLE'); assert.equal(meta.proved, false); assert.equal(meta.verified, true);
});

test('anytime: a verifier rejection restores the --out that existed before the run, byte for byte', { skip: SKIP, timeout: T_LIGHT * 2 }, () => {
  const src = fs.readFileSync(SOLVE, 'utf8');
  const mut = src.replace("if const[p][k] + sum(w for _, w in terms[p][k]) > pr.capf(pr.P[p]): m.Add(e + const[p][k] <= pr.capf(pr.P[p]))", 'pass');
  assert.notEqual(mut, src); const script = path.join(tmpRoot, 'brain-solve-mutant2'); fs.writeFileSync(script, mut, { mode: 0o755 });
  const p = plan({ n: 12, people: 2, density: 0.1, seed: 6, cap: 5 }); const dir = writePlan(p), out = path.join(dir, 'out.json');
  fs.writeFileSync(out, 'precious\n');
  const r = spawnSync(RUN, ['--jsonl-dir', dir, '--out', out, '--time', '30', '--verbose'], { encoding: 'utf8', cwd: tmpRoot, timeout: 300000, env: { ...process.env, BRAIN_SOLVE_SCRIPT: script } });
  assert.equal(r.status, 6, r.stdout + r.stderr); assert.match(r.stderr, /^anytime \{"source":"constructive"/m, 'the constructive schedule was written first');
  assert.equal(fs.readFileSync(out, 'utf8'), 'precious\n');
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
});

const twoPlans = () => {
  const a = plan({ n: 100, people: 3, density: 0.2, seed: 31, cap: 12 }), b = plan({ n: 80, people: 3, density: 0.2, seed: 32, cap: 12, prefix: 'U' });
  return { tickets: [...a.tickets, ...b.tickets], edges: [...a.edges, ...b.edges], schedule: [...a.schedule, ...b.schedule], config: { ...a.config, end_sprint: Math.max(a.config.end_sprint, b.config.end_sprint) } };
};
// ---- Task 21 review fixes: no new work in past sprints, anytime verifier gate, LNS acceptance, partial-meta order
const tk = (key, owner, sp, status = 'To Do') => ({ key, summary: key, epic: 'E', sp, jira_status: status, v2_owner: owner, v2_sprint: 3, verdict: 'READY' });
const stagesConsistent = (r) => {
  for (const s of r.meta.stages) {
    assert.notEqual(s.status, 'INFEASIBLE', JSON.stringify(r.meta.stages)); assert.equal(s.note, undefined, JSON.stringify(s));
    if ('objective' in s) assert.ok(s.objective >= s.bound - 1e-6, `stage ${s.name}: objective ${s.objective} below bound ${s.bound}`);
  }
};
test('window: first_sprint 3 with a Done ticket frozen in sprint 1: the free ticket lands in sprint 3 or later, no stage is infeasible', { skip: SKIP, timeout: T_LIGHT * 2 }, () => {
  const p = { tickets: [tk('F-1', 'Ana', 30, 'Done'), tk('N-1', 'Ana', 1)], edges: [],
    schedule: [{ key: 'F-1', owner: 'Ana', sprint: 1 }, { key: 'N-1', owner: 'Ana', sprint: 2 }],
    config: { first_sprint: 3, end_sprint: 6, caps: { default: 30 }, frozen_statuses: ['Done'], ignore_link_kinds: [] } };
  const r = solve(p); assert.equal(r.code, 0, r.stdout + r.stderr);
  const frozen = new Map([['F-1', { owner: 'Ana', sprint: 1 }]]);
  assert.deepEqual(check(p, r.schedule, frozen), []);
  assert.ok(r.schedule.find((x) => x.item === 'N-1').sprint >= 3, JSON.stringify(r.schedule));
  stagesConsistent(r); assert.equal(r.meta.status, 'OPTIMAL', r.stdout); assert.equal(r.meta.end_sprint, 3, 'the free ticket fits in sprint 3');
  assert.equal(r.meta.objective.end_sprint, 3); assert.equal(r.meta.end_sprint_bound, 3);
});
test('window: a three-ticket chain is never started in a past sprint to end earlier', { skip: SKIP, timeout: T_LIGHT * 2 }, () => {
  const p = { tickets: [tk('F-1', 'Ana', 1, 'Done'), tk('C-1', 'Ana', 10), tk('C-2', 'Ana', 10), tk('C-3', 'Ana', 10), tk('B-1', 'Ben', 1)],
    edges: [{ consumer: 'C-2', producer: 'C-1', kind: 'plan_need', note: '' }, { consumer: 'C-3', producer: 'C-2', kind: 'plan_need', note: '' }],
    schedule: [{ key: 'F-1', owner: 'Ana', sprint: 1 }, { key: 'C-1', owner: 'Ana', sprint: 3 }, { key: 'C-2', owner: 'Ana', sprint: 4 }, { key: 'C-3', owner: 'Ana', sprint: 5 }, { key: 'B-1', owner: 'Ben', sprint: 3 }],
    config: { first_sprint: 3, end_sprint: 8, caps: { default: 10 }, frozen_statuses: ['Done'], ignore_link_kinds: [] } };
  const r = solve(p); assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(check(p, r.schedule, new Map([['F-1', { owner: 'Ana', sprint: 1 }]])), []);
  assert.ok(r.schedule.every((x) => x.item === 'F-1' || x.sprint >= 3), JSON.stringify(r.schedule));
  stagesConsistent(r); assert.equal(r.meta.status, 'OPTIMAL'); assert.equal(r.meta.end_sprint, 5, 'three sprints of 10 SP each, from sprint 3');
});

// Review I1: frozen_statuses [] (the `brain init` value) froze nothing, so the solver moved a Done producer into first_sprint.
test('frozen: Done and closed_statuses tickets stay frozen with frozen_statuses []', { skip: SKIP, timeout: T_LIGHT * 2 }, () => {
  const p = { tickets: [tk('T-1', 'Ana', 3, 'Done'), tk('T-2', 'Ana', 2), tk('T-3', 'Ben', 2, 'Closed')],
    edges: [{ consumer: 'T-2', producer: 'T-1', kind: 'plan_need', note: '' }],
    schedule: [{ key: 'T-1', owner: 'Ana', sprint: 1 }, { key: 'T-2', owner: 'Ana', sprint: 3 }, { key: 'T-3', owner: 'Ben', sprint: 1 }],
    config: { first_sprint: 2, end_sprint: 6, caps: { default: 10 }, frozen_statuses: [], closed_statuses: ['Done', 'Closed'], ignore_link_kinds: [] } };
  const r = solve(p, ['--deterministic'], { time: 5 }); assert.equal(r.code, 0, r.stdout + r.stderr);
  const at = (k) => r.schedule.find((x) => x.item === k);
  assert.deepEqual(at('T-1'), { item: 'T-1', owner: 'Ana', sprint: 1 }); assert.deepEqual(at('T-3'), { item: 'T-3', owner: 'Ben', sprint: 1 });
  assert.equal(r.meta.frozen, 2);
  assert.deepEqual(check(p, r.schedule, new Map([['T-1', { owner: 'Ana', sprint: 1 }], ['T-3', { owner: 'Ben', sprint: 1 }]])), []);
});

// Review I2: the solver truncated fractional story points (int(sp)), so two 2.6 SP tickets shared a 5 SP cell that `brain verify` rejects.
const brainVerify = (p, schedule) => verifyPlan(buildModel({ tickets: p.tickets, edges: p.edges, config: p.config,
  schedule: schedule.map((r) => ({ key: r.item, owner: r.owner, sprint: r.sprint })) })).map((v) => `${v.code} ${v.key} ${v.detail}`);
test('fractional story points: the solver models them exactly and its output passes brain verify (repro: 2 x 2.6 SP, cap 5)', { skip: SKIP, timeout: T_LIGHT * 2 }, () => {
  const p = { tickets: [tk('T-1', 'Ana', 2.6), tk('T-2', 'Ana', 2.6)], edges: [], schedule: [{ key: 'T-1', owner: 'Ana', sprint: 1 }, { key: 'T-2', owner: 'Ana', sprint: 2 }],
    config: { first_sprint: 1, end_sprint: 6, caps: { default: 5 }, ignore_link_kinds: [] } };
  const r = solve(p, ['--deterministic'], { time: 5 }); assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(brainVerify(p, r.schedule), []); assert.equal(r.meta.end_sprint, 2); assert.equal(r.meta.status, 'OPTIMAL');
  // a float tie (0.1 + 0.2 > 0.3 in binary floating point, as brain verify sums) is never packed into one cell
  const q = { tickets: [tk('A', 'Ana', 0.1), tk('B', 'Ana', 0.2)], edges: [], schedule: [{ key: 'A', owner: 'Ana', sprint: 1 }, { key: 'B', owner: 'Ana', sprint: 2 }],
    config: { first_sprint: 1, end_sprint: 6, caps: { default: 0.3 }, ignore_link_kinds: [] } };
  const t = solve(q, ['--deterministic'], { time: 5 }); assert.equal(t.code, 0, t.stdout + t.stderr); assert.deepEqual(brainVerify(q, t.schedule), []);
  // too many decimals: refused with a fixed message, nothing written
  const z = solve({ ...p, tickets: [tk('T-1', 'Ana', 0.30000000000000004), tk('T-2', 'Ana', 1)] }, [], { time: 5 });
  assert.equal(z.code, 2); assert.equal(z.stdout, 'MODEL_INVALID: story points, caps and min_per_sprint must be numbers with at most 4 decimal places\n'); assert.equal(z.raw, null);
});
test('property: fractional story points and caps give schedules that pass brain verify, with load figures in story points', { skip: SKIP, timeout: T_HEAVY }, () => {
  for (let seed = 1; seed <= 10; seed++) {
    const p = plan({ n: 8 + seed, people: 2 + (seed % 2), density: 0.2, seed: seed + 60 }), r0 = rng(seed);
    const steps = [0.1, 0.25, 0.5, 0.3, 0.7];
    for (const t of p.tickets) t.sp = Number((Math.round((0.5 + r0() * 4) / steps[seed % 5]) * steps[seed % 5]).toFixed(2));
    p.config.caps = { default: Number((Math.max(...p.tickets.map((t) => t.sp)) + 1.1 + (seed % 3)).toFixed(2)) };
    const P = people(p); p.config.minimize_load_of = P[0]; p.config.min_per_sprint = { [P[1]]: 0.5 };
    const r = solve(p, ['--deterministic'], { time: 20 });
    assert.ok(r.code === 0 || r.code === 4, `seed ${seed}: ${r.stdout}`);
    assert.deepEqual(brainVerify(p, r.schedule), [], `seed ${seed}`);
    const lo = r.schedule.filter((x) => x.owner === P[0]).reduce((a, x) => a + p.tickets.find((t) => t.key === x.item).sp, 0);
    assert.ok(Math.abs(r.meta.load_of - lo) < 1e-9, `seed ${seed}: load_of ${r.meta.load_of} vs ${lo}`);
  }
});

// Python unit checks on bin/brain-solve itself (stdlib only: prepare, verify, Anytime, atomic_write and gap_pct need no OR-Tools).
const HAVE_PY3 = has('python3', ['--version']);
const PY_HEAD = `
import importlib.machinery, importlib.util, json, os, stat, sys, types
loader = importlib.machinery.SourceFileLoader('brain_solve', sys.argv[1]); spec = importlib.util.spec_from_loader('brain_solve', loader)
m = importlib.util.module_from_spec(spec); loader.exec_module(m)
A = types.SimpleNamespace(baseline='current', freeze=None, freeze_file=None, end=None, balance=False)
TK = [{'key': 'F-1', 'sp': 1, 'jira_status': 'Done', 'v2_owner': 'Ana', 'v2_sprint': 1}, {'key': 'N-1', 'sp': 1, 'jira_status': 'To Do', 'v2_owner': 'Ana', 'v2_sprint': 3}]
pr = m.prepare(A, TK, [], {'current': {'F-1': ('Ana', 1), 'N-1': ('Ana', 2)}}, {'first_sprint': 3, 'end_sprint': 6, 'caps': {'default': 10}, 'frozen_statuses': ['Done']})
`;
const py = (body, ...args) => spawnSync('python3', ['-I', '-c', PY_HEAD + body, SOLVE, ...args], { encoding: 'utf8', cwd: tmpRoot, timeout: 60000 });
test('window: the Python verifier rejects a free ticket before first_sprint and exempts a frozen one', { skip: HAVE_PY3 ? false : 'skipped: no python3' }, () => {
  const r = py(`print(json.dumps([m.verify(pr, {'F-1': ('Ana', 1), 'N-1': ('Ana', 2)}), m.verify(pr, {'F-1': ('Ana', 1), 'N-1': ('Ana', 3)}),
  m.verify(pr, {'F-1': ('Ana', 2), 'N-1': ('Ana', 3)}), [s for _, s in sorted(m.construct(pr).items())], [s for _, s in sorted(m.construct_free(pr).items())]]))`);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), [['N-1 sprint 2 before the first sprint 3'], [], ['frozen F-1 moved'], [[0, 1], [0, 3]], [[0, 1], [0, 3]]]);
});
test('anytime: the partial meta is written before the schedule; --meta none turns anytime writes off; gap_pct never shows a gap below the bound; atomic_write fsyncs the directory', { skip: HAVE_PY3 ? false : 'skipped: no python3' }, () => {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'order-')); const out = path.join(dir, 'out.json');
  const r = py(`
real = m.atomic_write; calls = []
m.atomic_write = lambda path, text: calls.append(os.path.basename(path))
NS = lambda **k: types.SimpleNamespace(**{'out': sys.argv[2], 'format': 'array', 'meta': None, 'verbose': False, **k})
res = {}
for label, ns in (('default', NS()), ('meta_none', NS(meta='none')), ('object_meta_none', NS(format='object', meta='none'))):
    calls.clear(); at = m.Anytime(pr, ns, {}); at.order = ['end_sprint']
    at.offer(lambda: {0: (0, 1), 1: (0, 3)}, 'constructive', 'start', force=True); res[label] = [list(calls), at.off]
res['gap'] = [m.gap_pct(3, 4.0), m.gap_pct(4, 3.0), m.gap_pct(3, 3.0)]
dirs = []; fs_ = os.fsync
def rec(fd): dirs.append(stat.S_ISDIR(os.fstat(fd).st_mode)); fs_(fd)
os.fsync = rec; real(sys.argv[2], 'x\\n'); res['fsync_dirs'] = dirs
print(json.dumps(res, sort_keys=True))`, out);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { default: [['out.json.meta.json', 'out.json'], false], meta_none: [[], true], object_meta_none: [['out.json'], false],
    gap: [0, 25, 0], fsync_dirs: [false, true] });
  assert.equal(fs.readFileSync(out, 'utf8'), 'x\n');
});
test('anytime: --meta none writes nothing during the run (no anytime line) and the final schedule only at the end', { skip: SKIP, timeout: T_LIGHT * 2 }, () => {
  const p = plan({ n: 12, people: 2, density: 0.2, seed: 6, cap: 10 });
  const r = solve(p, ['--meta', 'none', '--verbose']); assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stderr, /^anytime /m); assert.match(r.stderr, /^stage /m); assert.equal(r.metaRaw, null); assert.deepEqual(check(p, r.schedule), []);
});

const CAP_ANCHOR = "if const[p][k] + sum(w for _, w in terms[p][k]) > pr.capf(pr.P[p]): m.Add(e + const[p][k] <= pr.capf(pr.P[p]))";
test('anytime: a CP-SAT callback solution the verifier rejects never reaches --out (capacity-dropping mutant, SIGKILL mid-run)', { skip: SKIP, timeout: T_LIGHT * 2 }, async () => {
  const src = fs.readFileSync(SOLVE, 'utf8');
  // capacity constraints dropped, so CP-SAT reports schedules that break capacity; restore disabled, so --out keeps whatever anytime wrote last
  const mut = src.replace(CAP_ANCHOR, 'pass').replace('        if not s.wrote: return\n', '        return\n');
  assert.equal(mut.split('\n').length, src.split('\n').length); assert.ok(!mut.includes('if not s.wrote: return') && !mut.includes(CAP_ANCHOR), 'both mutation anchors exist');
  const script = path.join(tmpRoot, 'brain-solve-mutant-gate'); fs.writeFileSync(script, mut, { mode: 0o755 });
  const p = plan({ n: 12, people: 2, density: 0.1, seed: 6, cap: 5 }); const dir = writePlan(p), out = path.join(dir, 'out.json');
  const child = spawn(RUN, ['--jsonl-dir', dir, '--out', out, '--time', '30', '--verbose'], { cwd: tmpRoot, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, BRAIN_SOLVE_SCRIPT: script } });
  let err = '', all = '', stdout = '', killed = false;
  const done = new Promise((res) => child.on('close', (code, signal) => res({ code, signal })));
  child.stdout.setEncoding('utf8'); child.stdout.on('data', (s) => { stdout += s; });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (s) => {
    err += s; all += s;
    if (!killed && /^anytime \{"source":"cp-sat"/m.test(err)) { killed = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
    err = err.slice(err.lastIndexOf('\n') + 1);
  });
  const guard = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 200000);
  const end = await done; clearTimeout(guard);
  assert.match(all, /^anytime \{"source":"constructive"/m, 'the constructive schedule was written first');
  assert.ok(killed || (end.code === 6 && /^VERIFY_FAILED/.test(stdout)), `the mutant must produce schedules the verifier rejects (${end.code}): ${stdout}`);
  assert.deepEqual(check(p, JSON.parse(fs.readFileSync(out, 'utf8'))), [], `killed=${killed}`);
});

test('polish: the LNS acceptance check keeps only lexicographic improvements (sub-solve mutant returns a valid but worse schedule)', { skip: SKIP, timeout: T_HEAVY }, () => {
  const src = fs.readFileSync(SOLVE, 'utf8'); const anchor = '    sub = copy.copy(pr); fz = dict(pr.frozen)\n';
  // every free ticket one sprint later: handoffs and capacity still hold (no frozen tickets in this plan), the end sprint is one worse
  const mut = src.replace(anchor, '    return {i: (o, s + (0 if i in pr.frozen else 1)) for i, (o, s) in inc.items()}\n' + anchor);
  assert.notEqual(mut, src, 'mutation anchor must exist'); const script = path.join(tmpRoot, 'brain-solve-mutant-lns'); fs.writeFileSync(script, mut, { mode: 0o755 });
  const p = twoPlans();
  const r = solve(p, ['--lns', '--deterministic'], { time: 10, env: { BRAIN_SOLVE_SCRIPT: script } }); assert.ok([0, 4].includes(r.code), r.stdout + r.stderr);
  const pol = r.meta.polish; assert.ok(pol && pol.rounds >= 1, JSON.stringify(pol));
  assert.equal(pol.improved, 0, JSON.stringify(pol)); assert.deepEqual(pol.after, pol.before);
  const key = (o) => r.meta.stage_order.map((n) => o[n]), [bk, ak] = [key(pol.before), key(pol.after)];
  assert.ok(ak.join() === bk.join() || ak.findIndex((v, i) => v !== bk[i]) === ak.findIndex((v, i) => v < bk[i]), `${bk} -> ${ak}`);
  assert.deepEqual(check(p, r.schedule), []); assert.equal(r.meta.end_sprint, pol.before.end_sprint);
});

test('polish: --lns and --decompose keep a verified schedule, never worsen it, and report what they did', { skip: SKIP, timeout: T_HEAVY }, () => {
  const p = twoPlans();
  const base = new Map(p.schedule.map((s) => [s.key, s.owner]));
  for (const flag of ['--lns', '--decompose']) {
    const r = solve(p, [flag, '--deterministic'], { time: 10 }); assert.ok([0, 4].includes(r.code), r.stdout);
    assert.deepEqual(check(p, r.schedule), [], flag);
    const pol = r.meta.polish; assert.ok(pol, `${flag}: polish meta present: ${r.stdout}`);
    assert.equal(pol.method, flag.slice(2));
    if (flag === '--decompose') assert.equal(pol.components, 2);
    assert.ok(pol.rounds >= 1, JSON.stringify(pol)); assert.equal(r.meta.proved, false);
    const key = (o) => r.meta.stage_order.map((n) => o[n]);
    const [bk, ak] = [key(pol.before), key(pol.after)];
    assert.ok(ak.join() === bk.join() || ak.findIndex((v, i) => v !== bk[i]) === ak.findIndex((v, i) => v < bk[i]), `${flag}: lexicographically not worse ${bk} -> ${ak}`);
    assert.equal(pol.after.owner_changes, r.meta.owner_changes); assert.equal(changes(r.schedule, base), r.meta.owner_changes);
  }
  const one = solve(plan({ n: 30, people: 3, density: 0.3, seed: 4, cap: 10 }), ['--decompose']); assert.equal(one.code, 0, one.stdout);
  assert.ok(!one.meta.polish || one.meta.polish.components === 1, 'one component: nothing to decompose');
});

test('polish: --lns --deterministic gives byte-identical output twice', { skip: SKIP, timeout: T_HEAVY }, () => {
  const dir = writePlan(twoPlans());
  const runs = [0, 1].map((i) => {
    const out = path.join(dir, `l${i}.json`);
    const r = spawnSync(RUN, ['--jsonl-dir', dir, '--out', out, '--deterministic', '--lns', '--time', '6'], { encoding: 'utf8', cwd: tmpRoot, timeout: 300000 });
    assert.ok([0, 4].includes(r.status), r.stdout + r.stderr);
    return fs.readFileSync(out, 'utf8') + fs.readFileSync(out + '.meta.json', 'utf8');
  });
  assert.equal(runs[1], runs[0]);
});

test('infeasible: frozen slots contradict a link; the explanation names it; nothing is written', { skip: SKIP, timeout: T_LIGHT * 2 }, () => {
  const t = (key, owner, sp = 2) => ({ key, summary: key, epic: 'E', sp, jira_status: 'To Do', v2_owner: owner, v2_sprint: 1, verdict: 'READY' });
  const p = {
    tickets: [t('PRD-1', 'Ana'), t('CON-1', 'Ana'), t('DEC-1', 'Ben'), t('DEC-2', 'Ben')],
    edges: [{ consumer: 'CON-1', producer: 'PRD-1', kind: 'plan_need', note: '' }, { consumer: 'DEC-2', producer: 'DEC-1', kind: 'plan_need', note: '' }],
    schedule: [{ key: 'PRD-1', owner: 'Ana', sprint: 3 }, { key: 'CON-1', owner: 'Ana', sprint: 2 }, { key: 'DEC-1', owner: 'Ben', sprint: 1 }, { key: 'DEC-2', owner: 'Ben', sprint: 2 }],
    config: { first_sprint: 1, end_sprint: 5, caps: { default: 20 }, ignore_link_kinds: [] },
  };
  const r = solve(p, ['--freeze', 'PRD-1,CON-1']);
  assert.equal(r.code, 1, r.stdout); assert.equal(r.raw, null);
  assert.match(r.stdout, /^INFEASIBLE/); assert.match(r.stdout, /CON-1>PRD-1/); assert.doesNotMatch(r.stdout, /DEC-2>DEC-1/);
  assert.equal(r.meta.status, 'INFEASIBLE'); assert.deepEqual(r.meta.explanation.links, ['CON-1>PRD-1']); assert.equal(r.meta.explanation.n_links, 1);
  const ok = solve(p); // not frozen: feasible, so the explanation above is about the freeze, not a solver artefact
  assert.equal(ok.code, 0, ok.stdout); assert.deepEqual(check(p, ok.schedule), []);
});

test('infeasible: a free ticket squeezed between two frozen ones; the relaxed model names one link of the minimum cut', { skip: SKIP, timeout: T_LIGHT * 2 }, () => {
  const t = (key, owner) => ({ key, summary: key, epic: 'E', sp: 1, jira_status: 'To Do', v2_owner: owner, v2_sprint: 1, verdict: 'READY' });
  const p = {
    tickets: [t('Q-1', 'Ben'), t('MID-1', 'Ana'), t('TOP-1', 'Ana'), t('FREE-1', 'Ben')],
    edges: [{ consumer: 'MID-1', producer: 'Q-1', kind: 'plan_need', note: '' }, { consumer: 'TOP-1', producer: 'MID-1', kind: 'plan_need', note: '' }, { consumer: 'FREE-1', producer: 'Q-1', kind: 'plan_need', note: '' }],
    schedule: [{ key: 'Q-1', owner: 'Ben', sprint: 3 }, { key: 'MID-1', owner: 'Ana', sprint: 4 }, { key: 'TOP-1', owner: 'Ana', sprint: 2 }, { key: 'FREE-1', owner: 'Ben', sprint: 3 }],
    config: { first_sprint: 1, end_sprint: 6, caps: { default: 20 }, ignore_link_kinds: [] },
  };
  const r = solve(p, ['--freeze', 'Q-1,TOP-1']);
  assert.equal(r.code, 1, r.stdout); assert.equal(r.meta.explanation.n_links, 1);
  assert.ok(['MID-1>Q-1', 'TOP-1>MID-1'].includes(r.meta.explanation.links[0]), r.stdout); assert.doesNotMatch(r.stdout, /FREE-1/);
});

test('infeasible: capacity-only conflict is reported as such (no link to blame)', { skip: SKIP, timeout: T_LIGHT * 2 }, () => {
  const t = (key) => ({ key, summary: key, epic: 'E', sp: 5, jira_status: 'To Do', v2_owner: 'Ana', v2_sprint: 1, verdict: 'READY' });
  const p = { tickets: [t('A-1'), t('A-2')], edges: [], schedule: [{ key: 'A-1', owner: 'Ana', sprint: 1 }, { key: 'A-2', owner: 'Ana', sprint: 1 }],
    config: { first_sprint: 1, end_sprint: 3, caps: { default: 6 }, ignore_link_kinds: [] } };
  const r = solve(p, ['--freeze', 'A-1,A-2']);
  assert.equal(r.code, 1, r.stdout); assert.match(r.stdout, /capacity or frozen slots/); assert.equal(r.raw, null);
});

test('determinism: --deterministic gives byte-identical schedule and metadata three times', { skip: SKIP, timeout: T_LIGHT * 2 }, () => {
  const p = plan({ n: 25, people: 3, density: 0.2, seed: 4, cap: 10 }); const dir = writePlan(p);
  const runs = [0, 1, 2].map((i) => {
    const out = path.join(dir, `o${i}.json`);
    const r = spawnSync(RUN, ['--jsonl-dir', dir, '--out', out, '--deterministic', '--seed', '7', '--time', '20'], { encoding: 'utf8', cwd: tmpRoot, timeout: 120000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    return { out: fs.readFileSync(out, 'utf8'), meta: fs.readFileSync(out + '.meta.json', 'utf8'), stdout: r.stdout.replaceAll(out, 'OUT') };
  });
  assert.equal(runs[1].out, runs[0].out); assert.equal(runs[2].out, runs[0].out);
  assert.equal(runs[1].meta, runs[0].meta); assert.equal(runs[2].meta, runs[0].meta);
  assert.equal(runs[1].stdout, runs[0].stdout);
  const meta = JSON.parse(runs[0].meta); assert.equal(meta.deterministic, true); assert.equal(meta.workers, 1); assert.equal(meta.seed, 7); assert.equal(meta.wall_s, undefined);
});

test('frozen: --freeze, --freeze-file, frozen_statuses and frozen_before_sprint keep slots, which would otherwise move', { skip: SKIP, timeout: T_MEDIUM }, () => {
  const p = plan({ n: 22, people: 3, density: 0.2, seed: 9, cap: 1000 });
  const free = solve(p); const cur = curOf(p);
  const moved = free.schedule.filter((r) => cur.get(r.item).owner !== r.owner || cur.get(r.item).sprint !== r.sprint).map((r) => r.item);
  assert.ok(moved.length >= 2, 'fixture must move some tickets without a freeze');
  const keep = moved.slice(0, 3), want = new Map(keep.map((k) => [k, cur.get(k)]));
  const asserts = (r, label, extra = want) => { assert.equal(r.code, 0, `${label}: ${r.stdout}`); assert.deepEqual(check(p, r.schedule, extra), [], label); assert.equal(r.meta.frozen, extra.size, label); };
  asserts(solve(p, ['--freeze', keep.join(',')]), 'flag');
  const ff = path.join(tmpRoot, 'freeze.json'); fs.writeFileSync(ff, JSON.stringify(keep));
  asserts(solve(p, ['--freeze-file', ff]), 'file');
  const byStatus = { ...p, tickets: p.tickets.map((t) => (keep.includes(t.key) ? { ...t, jira_status: 'Done' } : t)), config: { ...p.config, frozen_statuses: ['Done'] } };
  asserts(solve(byStatus), 'status');
  const before = 2, early = new Map(p.schedule.filter((s) => s.sprint < before).map((s) => [s.key, { owner: s.owner, sprint: s.sprint }]));
  assert.ok(early.size > 0);
  asserts(solve({ ...p, config: { ...p.config, frozen_before_sprint: before } }), 'before', early);
  const bad = solve(p, ['--freeze', 'NOPE-1']); assert.equal(bad.code, 2); assert.match(bad.stdout, /^MODEL_INVALID/);
});

test('frozen tickets still consume capacity', { skip: SKIP, timeout: T_LIGHT * 2 }, () => {
  const t = (key, owner) => ({ key, summary: key, epic: 'E', sp: 4, jira_status: 'To Do', v2_owner: owner, v2_sprint: 1, verdict: 'READY' });
  const p = { tickets: [t('F-1', 'Ana'), t('F-2', 'Ana'), t('F-3', 'Ben')], edges: [],
    schedule: [{ key: 'F-1', owner: 'Ana', sprint: 1 }, { key: 'F-2', owner: 'Ana', sprint: 2 }, { key: 'F-3', owner: 'Ben', sprint: 1 }],
    config: { first_sprint: 1, end_sprint: 3, caps: { default: 5 }, ignore_link_kinds: [] } };
  const r = solve(p, ['--freeze', 'F-1,F-2']);
  assert.equal(r.code, 0, r.stdout); assert.deepEqual(check(p, r.schedule, new Map([...curOf(p)].filter(([k]) => k !== 'F-3'))), []);
  const f3 = r.schedule.find((x) => x.item === 'F-3'); assert.ok(!(f3.owner === 'Ana' && f3.sprint <= 2), 'F-3 cannot share a full person-sprint with a frozen ticket');
});

test('baseline: owner changes are counted against the selected baseline', { skip: SKIP, timeout: T_MEDIUM }, () => {
  const p = plan({ n: 14, people: 3, density: 0.2, seed: 5, cap: 10 }); const P = people(p);
  const rot = (o) => P[(P.indexOf(o) + 1) % P.length];
  const q = { ...p, tickets: p.tickets.map((t) => ({ ...t, v2_owner: rot(t.v2_owner) })), schedule: [...p.schedule, ...p.schedule.map((s) => ({ ...s, version: 'old', owner: rot(rot(s.owner)) }))] };
  const base = { current: new Map(p.schedule.map((s) => [s.key, s.owner])), v2: new Map(q.tickets.map((t) => [t.key, t.v2_owner])), old: new Map(p.schedule.map((s) => [s.key, rot(rot(s.owner))])) };
  const got = {};
  for (const b of ['current', 'v2', 'old']) {
    const r = solve(q, ['--baseline', b === 'current' ? 'current' : b]); assert.equal(r.code, 0, r.stdout); assert.deepEqual(check(q, r.schedule), []);
    assert.equal(r.meta.baseline, b); assert.equal(r.meta.owner_changes, changes(r.schedule, base[b]), b); assert.equal(r.meta.end_sprint, got.end ?? r.meta.end_sprint); got.end = r.meta.end_sprint;
    got[b] = r.schedule;
  }
  for (const b of ['v2', 'old']) assert.ok(changes(got[b], base[b]) <= changes(got.current, base[b]), `${b}: baseline run does not change more owners than the current-baseline run`);
  const miss = solve(q, ['--baseline', 'nope']); assert.equal(miss.code, 2); assert.match(miss.stdout, /baseline 'nope' not found/);
  // a solution fed back as the current schedule and used as baseline needs zero owner changes at the same end sprint
  const first = solve(p), again = solve({ ...p, schedule: first.schedule.map((r) => ({ key: r.item, owner: r.owner, sprint: r.sprint })) });
  assert.equal(again.meta.owner_changes, 0); assert.equal(again.meta.end_sprint, first.meta.end_sprint); assert.equal(again.meta.status, 'OPTIMAL');
});

test('--end 0 and --time 0 are values, not "unset"', { skip: SKIP, timeout: T_LIGHT * 2 }, () => {
  const p = plan({ n: 8, people: 2, density: 0.2, seed: 2, cap: 10 });
  const e = solve(p, ['--end', '0']);
  assert.equal(e.meta.target_end, 0); assert.equal(e.code, 4, e.stdout); assert.equal(e.meta.target_met, false); assert.match(e.stdout, /MISSED/); assert.ok(e.schedule, 'schedule still written when the target is missed');
  const z = solve(p, ['--time', '0'], { time: 0 });
  assert.equal(z.meta.time_budget, 0); assert.notEqual(z.meta.status, 'OPTIMAL'); assert.equal(z.meta.proved, false);
  assert.ok(z.meta.stages.every((s) => s.status === 'SKIPPED'), JSON.stringify(z.meta.stages));
  if (z.schedule) assert.deepEqual(check(p, z.schedule), []);
});

test('status honesty: a tiny budget on a 1400-ticket plan is never reported OPTIMAL', { skip: SKIP, timeout: T_MEDIUM }, () => {
  const p = plan({ n: 1400, people: 4, density: 0.175, seed: 3, cap: 40 });
  const t0 = Date.now(); const r = solve(p, [], { time: 4 }); const wall = (Date.now() - t0) / 1000;
  assert.ok(['FEASIBLE', 'UNKNOWN'].includes(r.meta.status), `${r.meta.status}: ${r.stdout}`);
  assert.equal(r.meta.proved, false); assert.doesNotMatch(r.stdout, /^OPTIMAL/);
  assert.ok(r.meta.links_modeled < r.meta.links_total || r.meta.links_total > 0);
  if (r.schedule) { assert.deepEqual(check(p, r.schedule), []); assert.equal(r.meta.verified, true); } else assert.equal(r.code, 5);
  console.log(`# 1400 tickets, ${r.meta.links_total} links (${r.meta.links_modeled} modeled), budget 4s: ${r.meta.status}, wall ${wall.toFixed(1)}s, solver-reported ${r.meta.wall_s}s, stages ${r.meta.stages.map((s) => `${s.name}=${s.status}${s.gap_pct != null ? `(gap ${s.gap_pct}%)` : ''}`).join(' ')}`);
});

test('transitive reduction keeps the optimum (same end sprint and owner changes with and without)', { skip: SKIP, timeout: T_HEAVY }, () => {
  let reducedSomething = 0;
  for (let seed = 1; seed <= 14; seed++) {
    const p = plan({ n: 6 + ((seed * 5) % 14), people: 2 + (seed % 3), density: 0.45, seed: seed + 100, cap: 8 + (seed % 3) * 4 });
    const a = solve(p), b = solve(p, ['--no-reduce']);
    assert.equal(a.meta.status, 'OPTIMAL'); assert.equal(b.meta.status, 'OPTIMAL');
    assert.equal(a.meta.end_sprint, b.meta.end_sprint, `seed ${seed}`); assert.equal(a.meta.owner_changes, b.meta.owner_changes, `seed ${seed}`);
    assert.deepEqual(check(p, a.schedule), []); assert.equal(b.meta.links_modeled, b.meta.links_total);
    if (a.meta.links_modeled < a.meta.links_total) reducedSomething++;
  }
  assert.ok(reducedSomething >= 5, 'the instances must actually contain redundant links');
});

test('invalid models: loop, unknown config person, oversized ticket; usage and exit codes', { skip: SKIP, timeout: T_LIGHT * 2 }, () => {
  const p = plan({ n: 5, people: 2, density: 0.3, seed: 1, cap: 10 });
  const loop = { ...p, edges: [{ consumer: 'T-1', producer: 'T-2', kind: 'x', note: '' }, { consumer: 'T-2', producer: 'T-1', kind: 'x', note: '' }] };
  const l = solve(loop); assert.equal(l.code, 2); assert.match(l.stdout, /loop/); assert.equal(l.raw, null);
  const ghost = solve({ ...p, config: { ...p.config, caps: { default: 10, Zed: 3 } } }); assert.equal(ghost.code, 2); assert.match(ghost.stdout, /Zed/);
  const big = solve({ ...p, config: { ...p.config, caps: { default: 2 } } }); assert.equal(big.code, 2); assert.match(big.stdout, /more than every person capacity/);
  const noOut = spawnSync(RUN, ['--jsonl-dir', writePlan(p)], { encoding: 'utf8' }); assert.equal(noOut.status, 2);
});

test('refuses to write when the independent verifier rejects (mutated model is caught)', { skip: SKIP, timeout: T_LIGHT * 2 }, () => {
  // the launcher runs a copy of the solver whose capacity constraints are removed; the verifier must stop it
  const src = fs.readFileSync(SOLVE, 'utf8');
  const mut = src.replace("if const[p][k] + sum(w for _, w in terms[p][k]) > pr.capf(pr.P[p]): m.Add(e + const[p][k] <= pr.capf(pr.P[p]))", 'pass');
  assert.notEqual(mut, src, 'mutation anchor must exist');
  const script = path.join(tmpRoot, 'brain-solve-mutant'); fs.writeFileSync(script, mut, { mode: 0o755 });
  const p = plan({ n: 12, people: 2, density: 0.1, seed: 6, cap: 5 });
  const r = solve(p, [], { env: { BRAIN_SOLVE_SCRIPT: script } });
  assert.equal(r.code, 6, r.stdout + r.stderr); assert.match(r.stdout, /^VERIFY_FAILED.*capacity/); assert.equal(r.raw, null); assert.equal(r.meta.status, 'VERIFY_FAILED');
});

test('exit 3 and an actionable message when OR-Tools is missing', { skip: HAVE_PY || !has('python3', ['--version']) ? 'skipped: python3 has ortools (or no python3), cannot simulate a missing solver' : false }, () => {
  const r = spawnSync('python3', [SOLVE, '--out', path.join(tmpRoot, 'x.json')], { encoding: 'utf8' });
  assert.equal(r.status, 3); assert.match(r.stderr, /OR-Tools is not installed/); assert.match(r.stderr, /ortools==/);
});

// ---- input hardening: clamps, path confinement, symlink refusal
test('clamp: --workers 100000 and --time 999999 are clamped and the meta records the effective values', { skip: SKIP, timeout: T_LIGHT * 2 }, () => {
  const p = plan({ n: 6, people: 2, density: 0.2, seed: 3, cap: 10 });
  const r = solve(p, ['--workers', '100000'], { time: 999999 });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.meta.workers, 32); assert.equal(r.meta.time_limit, 3600); assert.deepEqual(r.meta.clamped, ['workers', 'time']);
});

test('clamp: config.json workers and time_limit_seconds are clamped too; in-range values record no clamp', { skip: SKIP, timeout: T_LIGHT * 2 }, () => {
  const p = plan({ n: 6, people: 2, density: 0.2, seed: 3, cap: 10 }); p.config.workers = 0; p.config.time_limit_seconds = 99999;
  const dir = writePlan(p), out = path.join(dir, 'out.json');
  const r = spawnSync(RUN, ['--jsonl-dir', dir, '--out', out], { encoding: 'utf8', cwd: tmpRoot, timeout: 300000 });
  const m = JSON.parse(fs.readFileSync(out + '.meta.json', 'utf8'));
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.equal(m.workers, 1); assert.equal(m.time_limit, 3600); assert.deepEqual(m.clamped, ['workers', 'time']);
  const ok = solve(p, ['--workers', '4']); assert.equal(ok.meta.workers, 4); assert.equal(ok.meta.clamped, undefined);
});

test('clamp: non-numeric --workers is a usage error (exit 2)', { skip: SKIP, timeout: T_LIGHT * 2 }, () => {
  const r = solve(plan({ n: 4, people: 2, density: 0.2, seed: 3, cap: 10 }), ['--workers', 'many']);
  assert.equal(r.code, 2, r.stdout + r.stderr); assert.equal(r.raw, null);
});

test('confinement: a --jsonl-dir outside the repository root exits 2', { skip: SKIP, timeout: T_LIGHT * 2 }, () => {
  const repo = fs.mkdtempSync(path.join(tmpRoot, 'repo-')); spawnSync('git', ['init', '-q'], { cwd: repo });
  const r = spawnSync(RUN, ['--jsonl-dir', path.join(repo, '..', '..'), '--out', path.join(repo, 'out.json')], { encoding: 'utf8', cwd: repo, timeout: 120000 });
  assert.equal(r.status, 2, r.stdout + r.stderr); assert.match(r.stdout + r.stderr, /directory outside the repository/);
  assert.equal(fs.existsSync(path.join(repo, 'out.json')), false);
});

test('confinement: --out whose parent resolves outside the repository exits 2', { skip: SKIP, timeout: T_LIGHT * 2 }, () => {
  const repo = fs.mkdtempSync(path.join(tmpRoot, 'repo-')); spawnSync('git', ['init', '-q'], { cwd: repo });
  const dir = writePlan(plan({ n: 4, people: 2, density: 0.2, seed: 3, cap: 10 })); const outside = fs.mkdtempSync(path.join(tmpRoot, 'outside-'));
  fs.cpSync(dir, path.join(repo, 'in'), { recursive: true });
  const r = spawnSync(RUN, ['--jsonl-dir', path.join(repo, 'in'), '--out', path.join(outside, 'out.json')], { encoding: 'utf8', cwd: repo, timeout: 120000 });
  assert.equal(r.status, 2, r.stdout + r.stderr); assert.equal(fs.existsSync(path.join(outside, 'out.json')), false);
});

test('symlink --out is refused and its target is left unchanged', { skip: SKIP, timeout: T_LIGHT * 2 }, () => {
  const dir = writePlan(plan({ n: 4, people: 2, density: 0.2, seed: 3, cap: 10 }));
  const target = path.join(dir, 'victim.txt'); fs.writeFileSync(target, 'precious');
  const out = path.join(dir, 'out.json'); fs.symlinkSync(target, out);
  const r = spawnSync(RUN, ['--jsonl-dir', dir, '--out', out], { encoding: 'utf8', cwd: tmpRoot, timeout: 120000 });
  assert.equal(r.status, 2, r.stdout + r.stderr); assert.match(r.stdout + r.stderr, /refusing to write through a symlink/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'precious'); assert.ok(fs.lstatSync(out).isSymbolicLink());
});

// ---- review fixes: non-finite limits, deeper confinement, write-time re-check, download disclosure
const strictMeta = (r) => { assert.ok(r.metaRaw === null || !/NaN|Infinity/.test(r.metaRaw), 'meta must be strict JSON'); return r.metaRaw === null ? null : JSON.parse(r.metaRaw); };
function solveCfg(cfgPatch, args = []) {
  const p = plan({ n: 4, people: 2, density: 0.2, seed: 3, cap: 10 }); const dir = writePlan(p), out = path.join(dir, 'out.json');
  const patched = { ...p.config, time_limit_seconds: 5 }; for (const k of Object.keys(cfgPatch)) patched[k] = `@@${k}@@`;
  let cfg = JSON.stringify(patched); for (const [k, raw] of Object.entries(cfgPatch)) cfg = cfg.replace(`"@@${k}@@"`, raw);
  fs.writeFileSync(path.join(dir, 'config.json'), cfg);
  const r = spawnSync(RUN, ['--jsonl-dir', dir, '--out', out, ...args], { encoding: 'utf8', cwd: tmpRoot, timeout: 300000 });
  const metaRaw = fs.existsSync(out + '.meta.json') ? fs.readFileSync(out + '.meta.json', 'utf8') : null;
  return { code: r.status, text: r.stdout + r.stderr, metaRaw, out };
}
test('limits: --time nan is a usage error and writes nothing', { skip: SKIP, timeout: T_MEDIUM }, () => {
  const r = solve(plan({ n: 4, people: 2, density: 0.2, seed: 3, cap: 10 }), ['--time', 'nan'], { time: 5 });
  assert.equal(r.code, 2, r.stdout + r.stderr); assert.match(r.stdout + r.stderr, /--time must be a finite number/); assert.equal(r.raw, null); assert.equal(r.metaRaw, null);
});
test('limits: --time inf clamps to 3600 and is listed; -inf clamps to 0', { skip: SKIP, timeout: T_MEDIUM }, () => {
  const p = plan({ n: 4, people: 2, density: 0.2, seed: 3, cap: 10 });
  const r = solve(p, [], { time: /** @type {any} */ ('inf') }); const m = strictMeta(r);
  assert.equal(r.code, 0, r.stdout + r.stderr); assert.equal(m.time_limit, 3600); assert.ok(m.clamped.includes('time'));
  const r2 = solve(p, ['--time=-inf'], { time: 5 }); const m2 = strictMeta(r2);
  assert.equal(m2.time_limit, 0); assert.ok(m2.clamped.includes('time'));
});
test('limits: --workers inf clamps to 32; nan and 8.9 exit 2', { skip: SKIP, timeout: T_MEDIUM }, () => {
  const p = plan({ n: 4, people: 2, density: 0.2, seed: 3, cap: 10 });
  const r = solve(p, ['--workers', 'inf']); assert.equal(r.code, 0, r.stdout + r.stderr); assert.equal(strictMeta(r).workers, 32); assert.ok(r.meta.clamped.includes('workers'));
  const n = solve(p, ['--workers', 'nan']); assert.equal(n.code, 2); assert.match(n.stdout + n.stderr, /--workers must be a finite number/);
  const f = solve(p, ['--workers', '8.9']); assert.equal(f.code, 2); assert.match(f.stdout + f.stderr, /--workers must be a whole number/);
});
test('limits: config time_limit_seconds "nan" exits 2', { skip: SKIP, timeout: T_MEDIUM }, () => {
  const r = solveCfg({ time_limit_seconds: '"nan"' }); assert.equal(r.code, 2, r.text); assert.match(r.text, /time_limit_seconds must be a finite number/); assert.equal(r.metaRaw, null);
});
test('limits: config time_limit_seconds NaN (bare JSON token) exits 2', { skip: SKIP, timeout: T_MEDIUM }, () => {
  const r = solveCfg({ time_limit_seconds: 'NaN' }); assert.equal(r.code, 2, r.text); assert.equal(r.metaRaw, null);
});
test('limits: config workers Infinity clamps to 32, 8.9 and true exit 2, strict meta', { skip: SKIP, timeout: T_MEDIUM }, () => {
  const i = solveCfg({ workers: 'Infinity' }); assert.equal(i.code, 0, i.text); const m = strictMeta(i); assert.equal(m.workers, 32); assert.ok(m.clamped.includes('workers'));
  const f = solveCfg({ workers: '8.9' }); assert.equal(f.code, 2, f.text); assert.match(f.text, /workers must be a whole number/);
  const b = solveCfg({ workers: 'true' }); assert.equal(b.code, 2, b.text); assert.match(b.text, /workers must be a number/);
});
test('limits: --time -0 is recorded as 0.0, not -0.0', { skip: SKIP, timeout: T_MEDIUM }, () => {
  const r = solve(plan({ n: 4, people: 2, density: 0.2, seed: 3, cap: 10 }), ['--time=-0'], { time: 5 });
  assert.ok(!/-0(\.0)?[,}\s]/.test(r.metaRaw ?? ''), r.metaRaw); assert.equal(Object.is(r.meta.time_limit, -0), false); assert.equal(r.meta.time_limit, 0);
});
test('limits: huge config integers (10**400) clamp and are listed instead of exiting 2', { skip: SKIP, timeout: T_MEDIUM }, () => {
  const huge = '1' + '0'.repeat(400);
  const r = solveCfg({ workers: huge, time_limit_seconds: huge }); assert.equal(r.code, 0, r.text); const m = strictMeta(r);
  assert.equal(m.workers, 32); assert.equal(m.time_limit, 3600); assert.deepEqual([...m.clamped].sort(), ['time', 'workers']);
  const neg = solveCfg({ workers: '-' + huge, time_limit_seconds: 5 }); assert.equal(neg.code, 0, neg.text); assert.equal(strictMeta(neg).workers, 1);
});
test('limits: a bad config value is echoed at most 40 characters long with control characters replaced by ?', { skip: SKIP, timeout: T_MEDIUM }, () => {
  const r = solveCfg({ workers: JSON.stringify('A\u001b[31mB\u0007' + 'z'.repeat(100)) }); assert.equal(r.code, 2, r.text);
  assert.match(r.text, /workers must be a number, got 'A\?\[31mB\?z+'/); assert.ok(!/[\u0000-\u0008\u000b-\u001f]/.test(r.text), 'no control characters echoed');
  const shown = /got '([^']*)'/.exec(r.text)[1]; assert.ok(shown.length <= 40, /** @type {any} */ (shown.length));
});
test('characterization: confinement: --out with .. segments or a double slash that resolve outside the root exit 2', { skip: SKIP, timeout: T_MEDIUM }, () => {
  const repo = fs.mkdtempSync(path.join(tmpRoot, 'repo-')); spawnSync('git', ['init', '-q'], { cwd: repo });
  const dir = writePlan(plan({ n: 4, people: 2, density: 0.2, seed: 3, cap: 10 })); fs.cpSync(dir, path.join(repo, 'in'), { recursive: true });
  const sibling = path.join(path.dirname(repo), `${path.basename(repo)}-sib`); fs.mkdirSync(sibling);
  for (const out of [`${repo}/sub/../../${path.basename(sibling)}/out.json`, `/${sibling}/out.json`, `${repo}/..//${path.basename(sibling)}//out.json`]) {
    fs.mkdirSync(path.join(repo, 'sub'), { recursive: true });
    const r = spawnSync(RUN, ['--jsonl-dir', path.join(repo, 'in'), '--out', out], { encoding: 'utf8', cwd: repo, timeout: 120000 });
    assert.equal(r.status, 2, out + '\n' + r.stdout + r.stderr); assert.equal(fs.existsSync(path.join(sibling, 'out.json')), false);
  }
});
test('characterization: confinement: a .brainrc dir outside the repository exits 2', { skip: SKIP, timeout: T_MEDIUM }, () => {
  const repo = fs.mkdtempSync(path.join(tmpRoot, 'repo-')); spawnSync('git', ['init', '-q'], { cwd: repo });
  fs.writeFileSync(path.join(repo, '.brainrc'), JSON.stringify({ dir: '../../elsewhere' }));
  const r = spawnSync(RUN, ['--out', path.join(repo, 'out.json')], { encoding: 'utf8', cwd: repo, timeout: 120000, env: { ...process.env, BRAIN_DIR: '' } });
  assert.equal(r.status, 2, r.stdout + r.stderr); assert.match(r.stdout + r.stderr, /directory outside the repository/);
});
test('atomic_write re-checks the confinement at write time (a parent swapped for a symlink after the check is refused)', { skip: SKIP, timeout: T_LIGHT }, () => {
  const repo = fs.mkdtempSync(path.join(tmpRoot, 'repo-')); spawnSync('git', ['init', '-q'], { cwd: repo });
  const outside = fs.mkdtempSync(path.join(tmpRoot, 'outside-')); fs.mkdirSync(path.join(repo, 'sub'));
  const code = `
import importlib.machinery, importlib.util, os, sys
loader = importlib.machinery.SourceFileLoader('brain_solve', sys.argv[1]); spec = importlib.util.spec_from_loader('brain_solve', loader)
m = importlib.util.module_from_spec(spec); loader.exec_module(m)
target = os.path.join('sub', 'out.json'); m.check_out(target)           # passes: sub is a real directory inside the repo
os.rmdir('sub'); os.symlink(sys.argv[2], 'sub')                          # the swap, between check and write
try: m.atomic_write(target, 'x'); print('WROTE')
except m.Fail as f: print('REFUSED', f.msg)
os.unlink('sub'); os.mkdir('sub')
open('sub/out.json', 'w').close(); os.rename('sub/out.json', 'sub/real.json'); os.symlink('real.json', 'sub/out.json')   # --out became a symlink
try: m.atomic_write(target, 'x'); print('WROTE')
except m.Fail as f: print('REFUSED', f.msg)
`;
  const r = spawnSync('python3', ['-I', '-c', code, SOLVE, outside], { encoding: 'utf8', cwd: repo, timeout: 60000 });
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.deepEqual(r.stdout.trim().split('\n'), ['REFUSED directory outside the repository', 'REFUSED refusing to write through a symlink']);
  assert.deepEqual(fs.readdirSync(outside), []);
});
test('docs: SOLVER.md discloses the first-use download (pypi.org, --locked)', () => {
  const d = fs.readFileSync(path.join(ROOT, 'docs', 'SOLVER.md'), 'utf8');
  assert.match(d, /What the first run downloads/); assert.match(d, /pypi\.org/); assert.match(d, /--locked/);
});

// ---- limitations wave: solver edge cases ----
// (a) a 0-SP free ticket adds nothing to a cell's float sum, so it may join frozen tickets whose story points are not binary floats and that
// sit exactly at capacity (the float-tie rule keeps only tickets WITH load strictly below capacity there). Oracle: brain verify (lib/verify.mjs)
// reports the same violations for the result as for the frozen tickets alone (their float sum 0.1 + 0.2 > 0.3 is pre-existing).
test('(a) a 0-SP ticket may join frozen non-binary story points at an exact capacity tie; verify sees no new violation', { skip: SKIP, timeout: T_MEDIUM }, () => {
  const p = { tickets: [{ key: 'F-1', sp: 0.1, v2_owner: 'Ana', v2_sprint: 1 }, { key: 'F-2', sp: 0.2, v2_owner: 'Ana', v2_sprint: 1 }, { key: 'Z-1', sp: 0, v2_owner: 'Ana', v2_sprint: 1 }],
    edges: [], schedule: [{ version: 'current', key: 'F-1', owner: 'Ana', sprint: 1 }, { version: 'current', key: 'F-2', owner: 'Ana', sprint: 1 }, { version: 'current', key: 'Z-1', owner: 'Ana', sprint: 1 }],
    config: { first_sprint: 1, end_sprint: 1, caps: { default: 0.3 }, min_per_sprint: {}, ignore_link_kinds: [] } };
  const r = solve(p, ['--freeze', 'F-1,F-2', '--deterministic'], { time: 10 });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^OPTIMAL: ends sprint 1 /);
  assert.deepEqual(r.schedule.find((x) => x.item === 'Z-1'), { item: 'Z-1', owner: 'Ana', sprint: 1 });
  const alone = { ...p, tickets: p.tickets.slice(0, 2), schedule: p.schedule.slice(0, 2) };
  assert.deepEqual(brainVerify(p, r.schedule), brainVerify(alone, r.schedule.filter((x) => x.item !== 'Z-1')));
  assert.deepEqual(brainVerify(p, r.schedule), ['CAPACITY Ana S1 0.30000000000000004/0.3']); // the frozen float sum, not the solver's doing
});

// (c) numbers that reach CP-SAT are bounded: story points, caps and min_per_sprint at most 1e9 after scaling to whole numbers; sprint numbers
// from config (first_sprint, end_sprint / --end, frozen_before_sprint) whole numbers from -1e6 to 1e6. Each is a MODEL_INVALID (exit 2) with a
// fixed message, never a traceback (a float first_sprint used to crash with exit 1, the infeasible code) or a 300-digit target.
test('(c) huge or non-integer numbers are MODEL_INVALID with a fixed message (caps, sp, min_per_sprint, sprint fields)', { skip: SKIP, timeout: T_HEAVY }, () => {
  const NUM = 'MODEL_INVALID: story points, caps and min_per_sprint must be at most 1000000000 after scaling to whole numbers';
  const base = () => ({ tickets: [tk('T-1', 'Ana', 1), tk('T-2', 'Ana', 2)], edges: [], schedule: [{ key: 'T-1', owner: 'Ana', sprint: 1 }],
    config: { first_sprint: 1, end_sprint: 3, caps: { default: 5 }, ignore_link_kinds: [] } });
  /** @type {Array<[(p: any) => void, string[], string | null]>} */
  const cases = [
    [(p) => { p.config.caps.default = 1e300; }, [], NUM],
    [(p) => { p.config.caps.Ana = 1000000001; }, [], NUM],
    [(p) => { p.config.caps.default = 100000.5; }, [], null], // scales to 1000005 (x 10): within the bound, solved
    [(p) => { p.tickets[0].sp = 1e10; p.config.caps.default = 2e10; }, [], NUM],
    [(p) => { p.config.min_per_sprint = { Ana: 1e300 }; }, [], NUM],
    [(p) => { p.config.caps.default = 100001; p.tickets[0].sp = 0.0001; }, [], NUM], // 100001 x 10^4 > 1e9
    [(p) => { p.config.first_sprint = 1e300; }, [], 'MODEL_INVALID: first_sprint must be a whole number from -1000000 to 1000000'],
    [(p) => { p.config.first_sprint = 1.5; }, [], 'MODEL_INVALID: first_sprint must be a whole number from -1000000 to 1000000'],
    [(p) => { p.config.first_sprint = 'x'; }, [], 'MODEL_INVALID: first_sprint must be a whole number from -1000000 to 1000000'],
    [(p) => { p.config.first_sprint = true; }, [], 'MODEL_INVALID: first_sprint must be a whole number from -1000000 to 1000000'],
    [(p) => { p.config.end_sprint = 1e300; }, [], 'MODEL_INVALID: end_sprint must be a whole number from -1000000 to 1000000'],
    [(p) => { p.config.end_sprint = '9'; }, [], 'MODEL_INVALID: end_sprint must be a whole number from -1000000 to 1000000'],
    [() => {}, ['--end', '99999999999'], 'MODEL_INVALID: end_sprint must be a whole number from -1000000 to 1000000'],
    [(p) => { p.config.frozen_before_sprint = 'x'; }, [], 'MODEL_INVALID: frozen_before_sprint must be a whole number from -1000000 to 1000000'],
  ];
  for (const [i, [mut, args, msg]] of cases.entries()) {
    const p = base(); mut(p);
    const r = solve(p, args, { time: 2 });
    if (msg === null) { assert.equal(r.code, 0, `case ${i}: ${r.stdout}${r.stderr}`); continue; }
    assert.equal(r.code, 2, `case ${i}: ${r.stdout}${r.stderr}`);
    assert.equal(r.stdout.trim(), msg, `case ${i}`);
    assert.equal(r.stderr, '', `case ${i}: no traceback`);
  }
  const ok = base(); ok.config.caps.default = 1e9; ok.tickets[0].sp = 1e9; // exactly at the bound
  const r = solve(ok, [], { time: 5 }); assert.equal(r.code, 0, r.stdout + r.stderr);
});

// (e) a FEASIBLE stage whose bound is 0 (the owner-changes LP bound often is) had gap_pct 100: a number that says nothing. It is now null with
// gap_note 'n/a (bound 0)' in the stage record, the meta gap_pct is null (gap_note names the stages) and the status line says gap=n/a (bound 0).
test('(e) a stage with bound 0 reports the gap as n/a (bound 0), never 100%; other gaps are unchanged', { skip: HAVE_PY3 ? false : 'skipped: no python3' }, () => {
  const r = py(`
res = {'gap': [m.gap_pct(5, 0.0), m.gap_pct(5, 0), m.gap_pct(0, 0.0), m.gap_pct(10, 8.0), m.gap_pct(3, 4.0)]}
st = [{'name': 'end_sprint', 'status': 'OPTIMAL', 'objective': 3, 'bound': 3.0, 'gap_pct': 0.0},
      {'name': 'owner_changes', 'status': 'FEASIBLE', 'objective': 327, 'bound': 0.0, 'gap_pct': m.gap_pct(327, 0.0)}]
m.note_gaps(st)
res['stages'] = st; res['summary'] = m.gap_summary(st, False); res['lead'] = m.gap_lead(st[1])
st2 = [{'name': 'end_sprint', 'status': 'FEASIBLE', 'objective': 32, 'bound': 27.0, 'gap_pct': m.gap_pct(32, 27.0)}]
m.note_gaps(st2); res['summary2'] = m.gap_summary(st2, False); res['lead2'] = m.gap_lead(st2[0]); res['summary3'] = m.gap_summary([], True)
print(json.dumps(res, sort_keys=True))`);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {
    gap: [null, null, 0, 20, 0],
    stages: [{ name: 'end_sprint', status: 'OPTIMAL', objective: 3, bound: 3, gap_pct: 0 },
      { name: 'owner_changes', status: 'FEASIBLE', objective: 327, bound: 0, gap_pct: null, gap_note: 'n/a (bound 0)' }],
    summary: { gap_pct: null, gap_note: 'n/a (bound 0): owner_changes' },
    lead: ' (gap=n/a (bound 0), stage owner_changes)',
    summary2: { gap_pct: 15.625 }, lead2: ' (gap=15.625%, bound=27.0, stage end_sprint)', summary3: { gap_pct: 0 },
  });
});

// (b) SIGKILL on the launcher. bin/brain-solve-run now execs the solver's Python itself (uv only prepares the locked environment), so the
// launcher's pid IS the solver and a SIGKILL leaves no process behind. On the fallback path where `uv run` stays the parent
// (BRAIN_SOLVE_LAUNCH=uv-run forces it), the solver watches its parent and exits without another write once uv is gone. Either way --out
// keeps the last verified anytime schedule with its partial meta, and nothing writes it after the kill.
const procsWith = (needle) => spawnSync('ps', ['-A', '-o', 'pid=,command='], { encoding: 'utf8' }).stdout.split('\n').filter((l) => l.includes(needle));
async function killTest(env, { exec = false } = {}) {
  const p = plan({ n: 600, people: 4, density: 0.175, seed: 3, cap: 40 }); p.config.stage_order = ['load_of', 'end_sprint']; p.config.minimize_load_of = 'Ana';
  const dir = writePlan(p), out = path.join(dir, 'out.json');
  const child = spawn(RUN, ['--jsonl-dir', dir, '--out', out, '--time', '120', '--verbose'], { cwd: tmpRoot, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  let err = '', killed = false;
  // 'exit', not 'close': an orphan that survives the launcher (the failure this test exists to catch) keeps the pipes open, and 'close' would
  // wait for it; 'exit' fires when the launcher's process is gone, so a failing run fails at once and the finally below reaps the orphan
  const done = new Promise((res) => child.on('exit', (code, signal) => res({ code, signal })));
  child.stderr.setEncoding('utf8');
  let launcherCmd = '';
  child.stderr.on('data', (s) => {
    err += s;
    if (!killed && /^anytime \{"source":"cp-sat"/m.test(err)) {
      launcherCmd = spawnSync('ps', ['-o', 'command=', '-p', String(child.pid)], { encoding: 'utf8' }).stdout.trim();
      killed = true; child.kill('SIGKILL');
    }
  });
  const reap = () => { for (const l of procsWith(out)) try { process.kill(Number(l.trim().split(/\s+/)[0]), 'SIGKILL'); } catch {} };
  const guard = setTimeout(reap, 200000);
  try { // every exit (a failed assertion included) clears the guard and kills whatever still runs on this --out: no process outlives the test
    const end = await done;
    assert.ok(killed, `no anytime cp-sat line before exit (${end.code}/${end.signal}): ${err.slice(-400)}`);
    assert.equal(end.signal, 'SIGKILL');
    // exec path: the launcher's pid runs the solver script itself (one process): its command is `<interpreter> <bin/brain-solve> ...`. The
    // interpreter's image name is not always lower-case `python`: a macOS framework build (Homebrew, python.org) has bin/python3.x exec (same
    // pid) Python.framework/.../Resources/Python.app/Contents/MacOS/Python. Fallback: the pid is uv.
    if (exec) {
      const at = launcherCmd.indexOf(` ${SOLVE} `);
      assert.ok(at > 0 && /^python[0-9.]*$/i.test(path.basename(launcherCmd.slice(0, at))), `the launcher pid is not the solver's interpreter: ${launcherCmd}`);
    } else assert.equal(path.basename(launcherCmd.split(' ')[0]), 'uv', launcherCmd);
    let left = procsWith(out);
    for (let i = 0; i < 50 && left.length; i++) { await new Promise((res) => setTimeout(res, 100)); left = procsWith(out); } // the watchdog polls every 0.2 s
    assert.deepEqual(left, [], 'no solver process survives the launcher');
    const st1 = fs.statSync(out); await new Promise((res) => setTimeout(res, 2500)); const st2 = fs.statSync(out);
    assert.equal(st2.mtimeMs, st1.mtimeMs, 'nothing writes --out after the kill');
    const sched = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.deepEqual(check(p, sched), []); assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
    const meta = JSON.parse(fs.readFileSync(out + '.meta.json', 'utf8'));
    assert.equal(meta.partial, true); assert.equal(meta.verified, true); assert.equal(meta.proved, false); // marked as a mid-run schedule
  } finally { clearTimeout(guard); reap(); }
}
test('(b) SIGKILL on the launcher leaves no solver process and a valid, marked --out (exec path)', { skip: SKIP || (HAVE_UV ? false : 'skipped: no uv'), timeout: T_HEAVY }, () => killTest({}, { exec: true }));
test('(b) SIGKILL on a `uv run` launcher: the orphaned solver notices and exits without writing (watchdog path)', { skip: SKIP || (HAVE_UV ? false : 'skipped: no uv'), timeout: T_HEAVY }, () => killTest({ BRAIN_SOLVE_LAUNCH: 'uv-run' }));
