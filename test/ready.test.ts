// The definition of ready lives in ONE pure function (lib/ready.ts): `brain ready` and `brain report` both call it.
// A ticket whose own status is closed (Jira status in Done + config.closed_statuses, or an sp: task with impl_status done) is DONE: not
// ready to start (exit 1, a negative answer) and not under "Can start today". `brain blockers` stays the stored verdict list.
// Not covered here: the readiness rules over a generated plan against the CLI and an independent brute-force oracle (test/report.test.ts).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { buildModel } from '../lib/model.ts';
import type { Ticket } from '../lib/model.ts';
import { readiness, readySet, closedStatuses } from '../lib/ready.ts';
import { buildReport } from '../lib/report.ts';

const ROOT = path.join(import.meta.dirname, '..'), BRAIN = path.join(ROOT, 'bin/brain');
let BASE: string, REPO: string;
const GIT = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const env = () => ({ PATH: process.env.PATH, HOME: path.join(BASE, 'home'), CLAUDE_PLUGIN_DATA: path.join(BASE, 'data'), LC_ALL: 'C', PLANGRAPH_DIR: '', TMPDIR: BASE, PLANGRAPH_STRICT_OUT: '1', ...GIT });
const run = (...a: string[]) => spawnSync(process.execPath, [BRAIN, ...a], { cwd: REPO, env: env(), encoding: 'utf8', timeout: 60000 });
const jl = (rows: readonly unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const TICKETS: Ticket[] = [
  { key: 'D-1', sp: 2, jira_status: 'Done', verdict: 'READY' }, { key: 'D-2', sp: 1, jira_status: 'Closed', verdict: 'BLOCKED' },
  { key: 'R-1', sp: 3, jira_status: 'To Do', verdict: 'READY' }, { key: 'B-1', sp: 1, jira_status: 'To Do', verdict: 'BLOCKED' },
  { key: 'W-1', sp: 1, jira_status: 'To Do', verdict: 'READY' }, { key: 'sp:a', sp: 1, verdict: 'READY', impl_status: 'done' },
];
const EDGES = [{ consumer: 'W-1', producer: 'R-1', kind: 'code' }, { consumer: 'R-1', producer: 'D-2', kind: 'code' }];
const CONFIG = { closed_statuses: ['Done', 'Closed'] };

before(() => {
  BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-ready-')));
  for (const d of ['home', 'data', 'repo']) fs.mkdirSync(path.join(BASE, d));
  REPO = path.join(BASE, 'repo');
  execFileSync('git', ['init', '-q'], { cwd: REPO, env: env() });
  assert.equal(run('init').status, 0);
  const B = path.join(REPO, '.plangraph');
  fs.writeFileSync(path.join(B, 'tickets.jsonl'), jl(TICKETS)); fs.writeFileSync(path.join(B, 'edges.jsonl'), jl(EDGES));
  fs.writeFileSync(path.join(B, 'schedule.jsonl'), jl(TICKETS.map((t, i) => ({ key: t.key, owner: 'Ana', sprint: 1 + (i % 3) }))));
  fs.writeFileSync(path.join(B, 'config.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(B, 'config.json'), 'utf8')), ...CONFIG }));
  const b = run('build'); assert.equal(b.status, 0, b.stderr);
});
after(() => { fs.rmSync(BASE, { recursive: true, force: true }); });

test('closedStatuses: Done always, plus the configured strings only', () => {
  assert.deepEqual([...closedStatuses({})].sort(), ['Done']);
  assert.deepEqual([...closedStatuses({ closed_statuses: ['Closed', 7, null, 'Won\'t do'] })].sort(), ['Closed', 'Done', 'Won\'t do']);
  assert.deepEqual([...closedStatuses({ closed_statuses: 'Closed' })], ['Done']);
});

test('readiness: own status closed -> done, never ready; the Jira snapshot status wins over the stored one', () => {
  const m = buildModel({ tickets: TICKETS, edges: EDGES, config: CONFIG });
  assert.deepEqual(readiness(m, 'D-1'), { found: true, ready: false, done: { by: 'status', status: 'Done' }, reasons: [] });
  assert.equal(readiness(m, 'D-2').done?.status, 'Closed');
  assert.deepEqual(readiness(m, 'sp:a').done, { by: 'impl', status: 'done' });
  assert.equal(readiness(m, 'R-1').ready, true, 'its producer D-2 is Closed');
  assert.equal(readiness(m, 'R-1', { statuses: { 'D-2': { status: 'To Do' } } }).ready, false);
  assert.equal(readiness(m, 'R-1', { statuses: { 'R-1': { status: 'Done' } } }).done?.status, 'Done');
  assert.deepEqual(readiness(m, 'NOPE'), { found: false, ready: false, done: null, reasons: [] });
  assert.deepEqual(readySet(m).ready, ['R-1']);
  assert.deepEqual(readySet(m).done, ['D-1', 'D-2', 'sp:a']);
});

test('brain ready on a Done ticket says DONE with exit 1 (a negative answer), also in --json', () => {
  let r = run('ready', 'D-1');
  assert.deepEqual([r.status, r.stdout, r.stderr], [1, 'DONE D-1 (status Done)\n', '']);
  r = run('ready', 'D-2');
  assert.deepEqual([r.status, r.stdout], [1, 'DONE D-2 (status Closed)\n']);
  r = run('ready', 'sp:a');
  assert.deepEqual([r.status, r.stdout], [1, 'DONE sp:a (impl_status done)\n']);
  const j = JSON.parse(run('ready', 'D-1', '--json').stdout);
  assert.deepEqual([j.exit, j.ok, j.data.found, j.data.ready, j.data.done], [1, false, true, false, true]);
  r = run('ready', 'R-1');
  assert.equal(r.status, 0); assert.match(r.stdout, /^READY TO START R-1$/m);
});

test('report leaves done tickets out of Can start today; blockers keeps listing stored verdicts (a Closed BLOCKED ticket included)', () => {
  const b = run('blockers');
  assert.equal(b.status, 0);
  assert.equal(b.stdout, '2 tickets not READY\nBLOCKED (2): B-1 D-2\n', 'blockers is the verdict list (evals/ truth depends on it)');
  const m = buildModel({ tickets: TICKETS, edges: EDGES, config: CONFIG, schedule: TICKETS.map((t) => ({ key: t.key, owner: 'Ana', sprint: 1 })) });
  const rep = buildReport(m, {});
  assert.deepEqual(rep.data.ready.keys, ['R-1']);
  assert.ok(!rep.markdown.includes('D-1, ') && !/Can start today[^#]*D-1/.test(rep.markdown), rep.markdown);
});

test('one definition: report and ready import lib/ready.ts, and lib/report.ts keeps no copy of the rules', () => {
  const src = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  assert.doesNotMatch(src('lib/report.ts'), /function readySet|jira_status|impl_status/);
  assert.match(src('lib/report.ts'), /from '\.\/ready\.ts'/);
  assert.match(src('src/commands/queries.ts'), /lib\/ready\.ts/);
  assert.doesNotMatch(src('src/commands/queries.ts'), /readiness verdict is \$\{w\(t\.verdict\)\}/, 'ready formats the shared reasons, it does not re-derive them');
});
