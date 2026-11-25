// Frozen history (lib/frozen.ts rule): a closed producer satisfies its links, links between two frozen tickets and cells of frozen load
// are fixed facts, not violations; a constraint exists only where at least one side is free. Library repros of the review (C1); the solver
// side of the same repros is in test/solver.test.ts.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { buildModel } from '../lib/model.ts';
import type { Edge, PlanConfig, ScheduleRow, Ticket } from '../lib/model.ts';
import { verifyPlan } from '../lib/verify.ts';
import { whatif, relieve, renderRelieve } from '../lib/whatif.ts';
import { readiness } from '../lib/ready.ts';

const tk = (key: string, sp: number, jira_status = 'To Do', extra: Partial<Ticket> = {}): Ticket => ({ key, sp, jira_status, ...extra });
const at = (key: string, owner: string, sprint: number): ScheduleRow => ({ key, owner, sprint });
const need = (consumer: string, producer: string): Edge => ({ consumer, producer, kind: 'plan_need' });
const codes = (v: ReadonlyArray<{ code: string; key: string }>) => v.map((x) => `${x.code} ${x.key}`);

test('repro (a): two Done tickets linked inside a past sprint are history: verify passes', () => {
  const m = buildModel({ tickets: [tk('API-1', 3, 'Done'), tk('UI-1', 2, 'Done')], edges: [need('UI-1', 'API-1')],
    schedule: [at('API-1', 'Ana', 1), at('UI-1', 'Ben', 1)], config: { first_sprint: 2, caps: { default: 10 } } });
  assert.deepEqual(verifyPlan(m), []);
});

test('repro (b): Done 6+6 SP in Ana S1 with cap 10 is history; a free story point there is over capacity, a 0-SP one is not', () => {
  const base = { tickets: [tk('D-1', 6, 'Done'), tk('D-2', 6, 'Done'), tk('F-1', 1), tk('Z-1', 0)], config: { first_sprint: 1, caps: { default: 10 } } };
  const m = buildModel({ ...base, schedule: [at('D-1', 'Ana', 1), at('D-2', 'Ana', 1), at('F-1', 'Ana', 2), at('Z-1', 'Ana', 2)] });
  assert.deepEqual(verifyPlan(m), []);
  const m2 = buildModel({ ...base, schedule: [at('D-1', 'Ana', 1), at('D-2', 'Ana', 1), at('F-1', 'Ana', 1), at('Z-1', 'Ana', 2)] });
  assert.deepEqual(codes(verifyPlan(m2)), ['CAPACITY Ana S1']);
  const m3 = buildModel({ ...base, schedule: [at('D-1', 'Ana', 1), at('D-2', 'Ana', 1), at('F-1', 'Ana', 2), at('Z-1', 'Ana', 1)] });
  assert.deepEqual(verifyPlan(m3), []);
  // whatif: the free 1-SP ticket may not join the frozen cell (room max(0, 10 - 12) = 0); the 0-SP one may
  assert.deepEqual(whatif(m, { key: 'F-1', sprint: 1 }, { noSuggest: true }).reasons.map((r) => r.code), ['CAPACITY']);
  assert.equal(whatif(m, { key: 'Z-1', sprint: 1 }, { noSuggest: true }).ok, true);
});

test('repro (c): a consumer of a Done producer sitting later is ready, verifies, and whatif never blames the producer', () => {
  const m = buildModel({ tickets: [tk('API-1', 3, 'Done'), tk('UI-1', 2)], edges: [need('UI-1', 'API-1')],
    schedule: [at('API-1', 'Ana', 6), at('UI-1', 'Ben', 3)], config: { first_sprint: 1, end_sprint: 8, caps: { default: 10 } } });
  assert.equal(readiness(m, 'UI-1').ready, true);
  assert.deepEqual(verifyPlan(m), []);
  const w = whatif(m, { key: 'UI-1', sprint: 4 }, { noSuggest: true });
  assert.equal(w.ok, true, JSON.stringify(w.reasons));
  assert.deepEqual(w.ripple.map((r) => r.key), ['UI-1']);
});

test('a constraint exists where one side is free: a free producer of a frozen consumer, a frozen (not closed) producer of a free consumer', () => {
  const cfg = { first_sprint: 1, caps: { default: 10 }, frozen_statuses: ['In Progress'] };
  // frozen consumer (Done) needs a free producer that sits later: HANDOFF (the free producer is late)
  const a = buildModel({ tickets: [tk('P', 1), tk('C', 1, 'Done')], edges: [need('C', 'P')], schedule: [at('P', 'Ana', 3), at('C', 'Ana', 2)], config: cfg });
  assert.deepEqual(codes(verifyPlan(a)), ['HANDOFF C']);
  // a frozen but not closed producer (In Progress) still binds a free consumer
  const b = buildModel({ tickets: [tk('P', 1, 'In Progress'), tk('C', 1)], edges: [need('C', 'P')], schedule: [at('P', 'Ana', 3), at('C', 'Ben', 3)], config: cfg });
  assert.deepEqual(codes(verifyPlan(b)), ['HANDOFF C']);
  // two frozen, not closed tickets: history
  const c = buildModel({ tickets: [tk('P', 1, 'In Progress'), tk('C', 1, 'In Progress')], edges: [need('C', 'P')], schedule: [at('P', 'Ana', 3), at('C', 'Ben', 3)], config: cfg });
  assert.deepEqual(verifyPlan(c), []);
  // opts.frozen and frozen_before_sprint freeze too
  const d = buildModel({ tickets: [tk('P', 1), tk('C', 1)], edges: [need('C', 'P')], schedule: [at('P', 'Ana', 3), at('C', 'Ben', 3)], config: { caps: { default: 10 } } });
  assert.deepEqual(codes(verifyPlan(d)), ['HANDOFF C']);
  assert.deepEqual(verifyPlan(d, d.sched, { frozen: new Map([['P', { owner: 'Ana', sprint: 3 }], ['C', { owner: 'Ben', sprint: 3 }]]) }), []);
  const e = buildModel({ tickets: [tk('P', 1), tk('C', 1)], edges: [need('C', 'P')], schedule: [at('P', 'Ana', 3), at('C', 'Ben', 3)], config: { caps: { default: 10 }, frozen_before_sprint: 4 } });
  assert.deepEqual(verifyPlan(e), []);
});

test('relieve: a cell over capacity only by frozen tickets needs no relief; free tickets must fit in what the frozen load leaves', () => {
  const cfg = { first_sprint: 1, end_sprint: 4, caps: { default: 10 } };
  const only = buildModel({ tickets: [tk('D-1', 6, 'Done'), tk('D-2', 6, 'Done')], schedule: [at('D-1', 'Ana', 1), at('D-2', 'Ana', 1)], config: cfg });
  assert.equal(relieve(only, { person: 'Ana', sprint: 1 }).status, 'none_needed');
  assert.deepEqual(renderRelieve(relieve(only, { person: 'Ana', sprint: 1 }), { cmd: () => null }), ['OK: Ana S1 is over capacity (12/10) only by frozen tickets, which are history: nothing to relieve']);
  // frozen 12 > cap 10 plus a free 3 SP ticket: the free one must leave (the frozen load stays), and that is enough
  const mixed = buildModel({ tickets: [tk('D-1', 6, 'Done'), tk('D-2', 6, 'Done'), tk('F-1', 3)], schedule: [at('D-1', 'Ana', 1), at('D-2', 'Ana', 1), at('F-1', 'Ana', 1)], config: cfg });
  const r = relieve(mixed, { person: 'Ana', sprint: 1 });
  assert.equal(r.status, 'relief', JSON.stringify(r.reasons));
  assert.deepEqual(r.moves.map((x) => `${x.key} ${x.to.owner} S${x.to.sprint}`), ['F-1 Ana S2']);
});

// CLI: `brain verify` and `brain check` read the same rule (check counts on its own, so it is tested on its own).
const BRAIN = path.join(import.meta.dirname, '..', 'bin', 'brain'), made: string[] = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const GIT = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
function brainRepo(tickets: Ticket[], edges: Edge[], schedule: ScheduleRow[], config: PlanConfig) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-frozen-'))); made.push(base);
  for (const d of ['home', 'data', 'repo']) fs.mkdirSync(path.join(base, d));
  const repo = path.join(base, 'repo'), env = { PATH: process.env.PATH, HOME: path.join(base, 'home'), CLAUDE_PLUGIN_DATA: path.join(base, 'data'), LC_ALL: 'C', PLANGRAPH_DIR: '', TMPDIR: base, ...GIT };
  const run = (...a: string[]) => spawnSync(process.execPath, [BRAIN, ...a], { cwd: repo, env, encoding: 'utf8', timeout: 60000 });
  execFileSync('git', ['init', '-q'], { cwd: repo, env });
  assert.equal(run('init').status, 0);
  const B = path.join(repo, '.plangraph'), jl = (rows: readonly unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(path.join(B, 'tickets.jsonl'), jl(tickets.map((t) => ({ verdict: 'READY', ...t }))));
  fs.writeFileSync(path.join(B, 'edges.jsonl'), jl(edges));
  fs.writeFileSync(path.join(B, 'schedule.jsonl'), jl(schedule.map((r) => ({ version: 'current', ...r }))));
  fs.writeFileSync(path.join(B, 'config.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(B, 'config.json'), 'utf8')), ...config }));
  const b = run('build'); assert.equal(b.status, 0, b.stderr);
  return { run, repo };
}
test('CLI repro (a) and (b): brain verify and brain check pass on frozen history, and still fail on a free violation', () => {
  const { run } = brainRepo([tk('API-1', 3, 'Done'), tk('UI-1', 2, 'Done'), tk('D-1', 6, 'Done'), tk('D-2', 6, 'Done'), tk('F-1', 1)], [need('UI-1', 'API-1')],
    [at('API-1', 'Ana', 1), at('UI-1', 'Ben', 1), at('D-1', 'Cleo', 1), at('D-2', 'Cleo', 1), at('F-1', 'Cleo', 2)], { first_sprint: 2, caps: { default: 10 } });
  let r = run('verify'); assert.deepEqual([r.status, r.stdout], [0, 'OK plan valid (5 tickets)\n']);
  r = run('check'); assert.equal(r.status, 0, r.stdout); assert.match(r.stdout, /strict-rule violations 0 \| person-sprints over cap 0 /);
  const bad = brainRepo([tk('API-1', 3, 'Done'), tk('UI-1', 2), tk('D-1', 6, 'Done'), tk('D-2', 6, 'Done'), tk('F-1', 1)], [need('UI-1', 'API-1'), need('F-1', 'UI-1')],
    [at('API-1', 'Ana', 1), at('UI-1', 'Ben', 2), at('D-1', 'Cleo', 2), at('D-2', 'Cleo', 2), at('F-1', 'Cleo', 2)], { first_sprint: 1, caps: { default: 10 } });
  r = bad.run('check'); assert.equal(r.status, 1); assert.match(r.stdout, /strict-rule violations 1 \| person-sprints over cap 1 /);
});
