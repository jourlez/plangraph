// Whatif repair suggestion through the solver (amendment section 3.14 item 2, Task 15): the cone-fixed solver call, its complete hint and
// the stability objective. The pure parts (cone, scope, hint, schedule to suggestion) run everywhere; the solver run skips only when neither
// uv nor a python3 with ortools exists (as test/solver.test.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildModel } from '../lib/model.ts';
import { whatif, repairCone, repairSpec, suggestionFromSchedule } from '../lib/whatif.ts';
import type { SolverRow } from '../lib/whatif.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUN = path.join(ROOT, 'bin', 'plangraph-solve-run');
const T = (key: string, sp: number, extra: Record<string, unknown> = {}) => ({ key, sp, jira_status: 'To Do', ...extra });
const TICKETS = [T('A', 2), T('B', 2), T('C', 2), T('D', 1), T('X', 1)];
const EDGES = [{ consumer: 'B', producer: 'A' }, { consumer: 'C', producer: 'B' }]; // each hop changes owner: the handoff rule needs a later sprint
const SCHEDULE = [['A', 'Ana', 1], ['B', 'Ben', 2], ['C', 'Cleo', 3], ['D', 'Cleo', 4], ['X', 'Ben', 1]].map(([key, owner, sprint]) => ({ key, owner, sprint }));
const CONFIG = { first_sprint: 1, end_sprint: 5, caps: { default: 4 } };
const model = () => buildModel({ tickets: TICKETS, edges: EDGES, schedule: SCHEDULE, config: CONFIG });

test('repairCone: transitive consumers, a closed ticket passes nothing on', () => {
  assert.deepEqual(repairCone(model(), 'A'), ['B', 'C']);
  assert.deepEqual(repairCone(model(), 'B'), ['C']);
  assert.deepEqual(repairCone(model(), 'X'), []);
  const m = buildModel({ tickets: [TICKETS[0] as ReturnType<typeof T>, T('B', 2, { jira_status: 'Done' }), ...TICKETS.slice(2)], edges: EDGES, schedule: SCHEDULE, config: CONFIG });
  assert.deepEqual(repairCone(m, 'A'), ['B']);
});

test('repairSpec: the free scope is the ticket, its cone and the target cell; every other ticket stays out', () => {
  const sp = repairSpec(model(), { key: 'A', sprint: 2 }, { allowSlip: true });
  assert.ok(sp);
  assert.deepEqual(sp.free, ['A', 'B', 'C']);
  assert.deepEqual(sp.to, { owner: 'Ana', sprint: 2 });
  assert.deepEqual(repairSpec(model(), { key: 'A', to: 'Ben', sprint: 2 })?.free, ['A', 'B', 'C']); // B is also the target cell (Ben S2)
  assert.deepEqual(repairSpec(model(), { key: 'A', to: 'Ben', sprint: 1 })?.free, ['A', 'B', 'C', 'X'], 'the target cell Ben S1 holds X');
  assert.ok(!sp.free.includes('D') && !sp.free.includes('X'));
  assert.deepEqual(sp.args, ['--baseline', 'current', '--repair', 'A', '--repair-to', 'Ana', '--repair-sprint', '2']);
  const o = repairSpec(model(), { key: 'A', sprint: 2 }, { allowOwnerChange: true, allowEarlier: true });
  assert.ok(o); assert.deepEqual(o.args.slice(-2), ['--repair-owner-change', '--repair-earlier']);
});

test('repairSpec: the hint places every ticket: the current plan with the naive ripple of the move', () => {
  const sp = repairSpec(model(), { key: 'A', sprint: 2 }) as NonNullable<ReturnType<typeof repairSpec>>;
  assert.equal(sp.hint.size, 5);
  assert.deepEqual(sp.hint.get('A'), { owner: 'Ana', sprint: 2 });
  assert.deepEqual(sp.hint.get('B'), { owner: 'Ben', sprint: 3 });
  assert.deepEqual(sp.hint.get('C'), { owner: 'Cleo', sprint: 4 });
  assert.deepEqual(sp.hint.get('D'), { owner: 'Cleo', sprint: 4 });
  assert.deepEqual(sp.hint.get('X'), { owner: 'Ben', sprint: 1 });
});

test('repairSpec: no call for a move no repair can fix', () => {
  assert.equal(repairSpec(model(), { key: 'A', sprint: 9 }), null); // OUT_OF_RANGE
  assert.equal(repairSpec(model(), { key: 'NOPE', sprint: 2 }), null);
  assert.equal(repairSpec(model(), { key: 'A' }), null); // SAME_SLOT
});

const row = (item: string, owner: string, sprint: number): SolverRow => ({ item, owner, sprint });
const GOOD = [row('A', 'Ana', 2), row('B', 'Ben', 3), row('C', 'Cleo', 4), row('D', 'Cleo', 4), row('X', 'Ben', 1)];

test('suggestionFromSchedule: counts the other tickets that moved', () => {
  const g = suggestionFromSchedule(model(), { key: 'A', sprint: 2 }, GOOD, { allowSlip: true });
  assert.deepEqual(g, { sprint: 2, owner: 'Ana', shifts: 2, ownerChanges: 0 });
});

test('suggestionFromSchedule: a ticket outside the scope that moved, or a wrong target, is no repair', () => {
  assert.deepEqual(suggestionFromSchedule(model(), { key: 'A', sprint: 2 }, GOOD.map((r) => (r.item === 'X' ? row('X', 'Ben', 2) : r))), { none: true });
  assert.deepEqual(suggestionFromSchedule(model(), { key: 'A', sprint: 2 }, GOOD.map((r) => (r.item === 'A' ? row('A', 'Cleo', 2) : r))), { none: true });
  assert.deepEqual(suggestionFromSchedule(model(), { key: 'A', sprint: 3 }, GOOD.map((r) => (r.item === 'A' ? row('A', 'Ana', 2) : r))), { none: true });
});

test('suggestionFromSchedule: a slip beyond the request is flagged unless the caller allowed it; a schedule with a new violation throws', () => {
  const slip = [row('A', 'Ana', 3), row('B', 'Ben', 4), row('C', 'Cleo', 5), row('D', 'Cleo', 4), row('X', 'Ben', 1)];
  assert.deepEqual(suggestionFromSchedule(model(), { key: 'A', sprint: 2 }, slip), { sprint: 3, owner: 'Ana', shifts: 2, ownerChanges: 0, flags: ['slip'] });
  assert.equal((suggestionFromSchedule(model(), { key: 'A', sprint: 2 }, slip, { allowSlip: true }) as { flags?: string[] }).flags, undefined);
  assert.throws(() => suggestionFromSchedule(model(), { key: 'A', sprint: 2 }, GOOD.map((r) => (r.item === 'C' ? row('C', 'Cleo', 3) : r))), /invalid plan/);
});

test('the TS repair and the solver agree with whatif: the move alone fails, the suggested plan passes', () => {
  const m = model();
  assert.equal(whatif(m, { key: 'A', sprint: 2 }, { noSuggest: true }).ok, false);
});

const has = (cmd: string, args: string[]) => { try { return spawnSync(cmd, args, { stdio: 'ignore', timeout: 120000 }).status === 0; } catch { return false; } };
const SKIP = has('uv', ['--version']) || has('python3', ['-c', 'import ortools']) ? false : 'skipped: neither uv nor a python3 with ortools is available, solver tests cannot run';

test('solver repair mode: stability stages first, only the scope moves, the complete hint is accepted, the result passes whatif', { skip: SKIP, timeout: 600000 }, () => {
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'plangraph-repair-'));
  try {
    spawnSync('git', ['init', '-q'], { cwd: tmp });
    const wjl = (f: string, rows: readonly unknown[]) => fs.writeFileSync(path.join(tmp, f), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    wjl('tickets.jsonl', TICKETS); wjl('edges.jsonl', EDGES); wjl('schedule.jsonl', SCHEDULE); fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify(CONFIG));
    const sp = repairSpec(model(), { key: 'A', sprint: 2 }) as NonNullable<ReturnType<typeof repairSpec>>;
    const out = path.join(tmp, 'out.json');
    const r = spawnSync(RUN, ['--jsonl-dir', tmp, '--out', out, '--time', '30', '--deterministic', ...sp.args], { encoding: 'utf8', cwd: tmp, timeout: 300000 });
    assert.ok([0, 4].includes(r.status as number), `${r.status}\n${r.stdout}${r.stderr}`);
    const rows = JSON.parse(fs.readFileSync(out, 'utf8')) as SolverRow[];
    const meta = JSON.parse(fs.readFileSync(`${out}.meta.json`, 'utf8')) as { stages: Array<{ name: string }>; verified: boolean; repair: { key: string } };
    assert.deepEqual(meta.stages.slice(0, 2).map((s) => s.name), ['owner_changes', 'sprint_moves']);
    assert.equal(meta.verified, true); assert.equal(meta.repair.key, 'A');
    for (const k of ['D', 'X']) assert.deepEqual(rows.find((x) => x.item === k), SCHEDULE.map((s) => row(s.key, s.owner, s.sprint)).find((x) => x.item === k), `${k} is outside the scope: fixed`);
    assert.deepEqual(suggestionFromSchedule(model(), { key: 'A', sprint: 2 }, rows), { sprint: 2, owner: 'Ana', shifts: 2, ownerChanges: 0 });
    const bad = spawnSync(RUN, ['--jsonl-dir', tmp, '--out', out, '--time', '30', '--baseline', 'v2', '--repair', 'A', '--repair-to', 'Ana', '--repair-sprint', '2'], { encoding: 'utf8', cwd: tmp, timeout: 300000 });
    assert.equal(bad.status, 2); assert.match(bad.stdout, /--repair needs --baseline current/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
