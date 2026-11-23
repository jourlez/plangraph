// Review I1: `brain verify FILE` checks the file against the frozen tickets of the CURRENT schedule (FROZEN_MOVED), and `brain schedule-load`
// refuses (exit 4, nothing written) a schedule that moves or drops a frozen ticket: closed (Done, closed_statuses), frozen_statuses,
// frozen_before_sprint. There is no override flag (docs/CONTRACT.md has none): unfreeze the ticket in the data first.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';

const BRAIN = path.join(import.meta.dirname, '..', 'bin', 'brain');
const GIT = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
let BASE = '', REPO = '';
const env = () => ({ PATH: process.env.PATH, HOME: path.join(BASE, 'home'), CLAUDE_PLUGIN_DATA: path.join(BASE, 'data'), LC_ALL: 'C', BRAIN_DIR: '', TMPDIR: BASE, ...GIT });
const run = (/** @type {string[]} */ ...a) => spawnSync(process.execPath, [BRAIN, ...a], { cwd: REPO, env: env(), encoding: 'utf8', timeout: 60000 });
const jl = (/** @type {any[]} */ rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const digest = () => { const h = crypto.createHash('sha256'), dir = path.join(REPO, '.brain'); for (const f of fs.readdirSync(dir).sort()) h.update(`${f}\0`).update(fs.readFileSync(path.join(dir, f))); return h.digest('hex'); };
const T = (/** @type {string} */ key, /** @type {string} */ jira_status) => ({ key, sp: 1, jira_status, verdict: 'READY' });
// D-1 Done (closed), P-1 In Progress (frozen_statuses), O-1 in sprint 1 (below frozen_before_sprint 2), F-1 free.
const CUR = { 'D-1': ['Ana', 2], 'P-1': ['Ben', 3], 'O-1': ['Ana', 1], 'F-1': ['Ben', 2] };
const file = (/** @type {Record<string, [string, number] | null>} */ over) => {
  const rows = Object.entries({ ...CUR, ...over }).filter(([, v]) => v).map(([item, v]) => ({ item, owner: /** @type {any} */ (v)[0], sprint: /** @type {any} */ (v)[1] }));
  const f = path.join(BASE, `s${crypto.randomUUID()}.json`); fs.writeFileSync(f, JSON.stringify(rows)); return f;
};

before(() => {
  BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-fguard-')));
  for (const d of ['home', 'data', 'repo']) fs.mkdirSync(path.join(BASE, d));
  REPO = path.join(BASE, 'repo');
  execFileSync('git', ['init', '-q'], { cwd: REPO, env: env() });
  assert.equal(run('init').status, 0);
  const B = path.join(REPO, '.brain');
  fs.writeFileSync(path.join(B, 'tickets.jsonl'), jl([T('D-1', 'Done'), T('P-1', 'In Progress'), T('O-1', 'To Do'), T('F-1', 'To Do')]));
  fs.writeFileSync(path.join(B, 'edges.jsonl'), '');
  fs.writeFileSync(path.join(B, 'schedule.jsonl'), jl(Object.entries(CUR).map(([key, [owner, sprint]]) => ({ version: 'current', key, owner, sprint }))));
  fs.writeFileSync(path.join(B, 'config.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(B, 'config.json'), 'utf8')), first_sprint: 1, caps: { default: 10 }, frozen_statuses: ['In Progress'], frozen_before_sprint: 2 }));
  const b = run('build'); assert.equal(b.status, 0, b.stderr);
});
after(() => { if (BASE) fs.rmSync(BASE, { recursive: true, force: true }); });

test('brain verify FILE reports FROZEN_MOVED for each frozen ticket the file moves or drops (closed, frozen_statuses, frozen_before_sprint)', () => {
  let r = run('verify', file({ 'F-1': ['Ana', 3] }));
  assert.deepEqual([r.status, r.stdout], [0, 'OK plan valid (4 tickets)\n']);
  r = run('verify', file({ 'D-1': ['Ben', 2], 'P-1': ['Ben', 4], 'O-1': null }));
  assert.equal(r.status, 1);
  assert.equal(r.stdout, ['UNPLACED O-1 no valid owner/sprint', 'FROZEN_MOVED D-1 was Ana S2, now Ben S2', 'FROZEN_MOVED O-1 was Ana S1, now unplaced', 'FROZEN_MOVED P-1 was Ben S3, now Ben S4', ''].join('\n'));
});

test('brain schedule-load refuses a schedule that moves a frozen ticket: exit 4, fixed message, nothing written', () => {
  for (const [over, want] of /** @type {Array<[Record<string, [string, number] | null>, string]>} */ ([
    [{ 'D-1': ['Ben', 2] }, 'D-1'], [{ 'P-1': ['Ben', 4] }, 'P-1'], [{ 'O-1': null }, 'O-1'], [{ 'D-1': ['Ana', 3], 'O-1': ['Ana', 2] }, 'D-1 O-1'],
  ])) {
    const before = digest(), r = run('schedule-load', file(over), `old-${crypto.randomUUID().slice(0, 8)}`);
    const n = want.split(' ').length;
    assert.equal(r.status, 4, r.stderr);
    assert.equal(r.stderr.split('\n')[0], `error: refusing to load: the schedule moves ${n} frozen ticket${n === 1 ? '' : 's'} (${want}); a frozen ticket keeps its slot`);
    assert.equal(r.stdout, '');
    assert.equal(digest(), before, 'nothing written');
  }
  const r = run('schedule-load', file({ 'F-1': ['Ana', 3] }), 'kept');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^loaded as current; previous plan kept as kept/);
});
