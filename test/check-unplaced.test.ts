// `plangraph check` and `plangraph verify` agree on unplaced tickets: a ticket with no schedule row (an `sp:` task is exempt, lib/verify.ts)
// is an UNPLACED violation for verify and the card, so check prints the count in its one line, exits 1, and --json carries `unplaced`.
// The unplaced predicate is verify's own (check calls verifyPlan), not a second copy. Real runs of bin/plangraph in mkdtemp repos.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { adoptPlanDir } from './helpers/plan-dir.ts';

const BRAIN = path.join(import.meta.dirname, '..', 'bin', 'plangraph'), made: string[] = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const GIT = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const jl = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const tk = (key: string, sp = 1) => ({ key, summary: `s ${key}`, epic: 'E', sp, verdict: 'READY' });
const at = (key: string, owner: string, sprint: number) => ({ version: 'current', key, owner, sprint });
function plan(tickets: object[], schedule: object[]) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-unpl-'))); made.push(base);
  for (const d of ['home', 'data', 'repo']) fs.mkdirSync(path.join(base, d));
  const repo = path.join(base, 'repo'), env = { PATH: process.env.PATH, HOME: path.join(base, 'home'), CLAUDE_PLUGIN_DATA: path.join(base, 'data'), LC_ALL: 'C', PLANGRAPH_DIR: '', TMPDIR: base, ...GIT };
  const run = (...a: string[]) => spawnSync(process.execPath, [BRAIN, ...a], { cwd: repo, env, encoding: 'utf8', timeout: 60000 });
  execFileSync('git', ['init', '-q'], { cwd: repo, env });
  assert.equal(run('init').status, 0);
  const B = path.join(repo, '.plangraph');
  fs.writeFileSync(path.join(B, 'tickets.jsonl'), jl(tickets)); fs.writeFileSync(path.join(B, 'schedule.jsonl'), jl(schedule));
  adoptPlanDir(B);
  const b = run('build'); assert.equal(b.status, 0, b.stderr);
  return run;
}
const TAIL = / \| unplaced (\d+) \(plangraph verify lists them\)$/m;

test('the repro: two tickets with no schedule row: check says so and exits 1, as verify and the card do', () => {
  const run = plan([tk('A-1'), tk('A-2'), tk('A-3')], [at('A-1', 'Ana', 1)]);
  const v = run('verify'); assert.equal(v.status, 1);
  assert.deepEqual(v.stdout.trim().split('\n').map((l) => l.split(' ').slice(0, 2).join(' ')), ['UNPLACED A-2', 'UNPLACED A-3']);
  const c = run('check'); assert.equal(c.status, 1, c.stdout);
  assert.equal(c.stdout, 'tickets 1 | links 0 | strict-rule violations 0 | person-sprints over cap 0 | loop-free true | last sprint 1 | unplaced 2 (plangraph verify lists them)\n');
  assert.match(run('card', '--line').stdout, /, 2 violations @/, 'the card counts the same two');
});

test('check --json carries the structured counts, with `unplaced`', () => {
  const run = plan([tk('A-1'), tk('A-2'), tk('A-3')], [at('A-1', 'Ana', 1)]);
  const j = JSON.parse(run('check', '--json').stdout);
  assert.equal(j.ok, false); assert.equal(j.exit, 1);
  assert.deepEqual(j.data, { tickets: 1, links: 0, violations: 0, overCap: 0, loopFree: true, lastSprint: 1, unplaced: 2 });
  assert.deepEqual(j.next, ['plangraph verify']);
  const ok = JSON.parse(plan([tk('A-1')], [at('A-1', 'Ana', 1)])('check', '--json').stdout);
  assert.deepEqual([ok.ok, ok.data.unplaced, ok.next], [true, 0, []]);
});

test('an unscheduled sp: task is exempt exactly as in verify: no fragment, exit 0, unplaced 0', () => {
  const run = plan([tk('A-1'), tk('sp:task-1'), tk('sp:task-2')], [at('A-1', 'Ana', 1)]);
  assert.equal(run('verify').status, 0);
  const c = run('check'); assert.deepEqual([c.status, c.stdout], [0, 'tickets 1 | links 0 | strict-rule violations 0 | person-sprints over cap 0 | loop-free true | last sprint 1\n']);
  assert.equal(JSON.parse(run('check', '--json').stdout).data.unplaced, 0);
});

test('mixed: only the non-sp: unscheduled tickets count', () => {
  const run = plan([tk('A-1'), tk('A-2'), tk('sp:task-1')], [at('A-1', 'Ana', 1)]);
  const c = run('check'); assert.equal(c.status, 1); assert.match(c.stdout, TAIL); assert.equal((TAIL.exec(c.stdout) as RegExpExecArray)[1], '1');
  assert.equal(run('verify').stdout.trim().split('\n').length, 1);
});

test('a plan with everything placed prints the old line unchanged (no unplaced fragment)', () => {
  const c = plan([tk('A-1'), tk('A-2')], [at('A-1', 'Ana', 1), at('A-2', 'Ana', 1)])('check');
  assert.deepEqual([c.status, c.stdout], [0, 'tickets 2 | links 0 | strict-rule violations 0 | person-sprints over cap 0 | loop-free true | last sprint 1\n']);
});
