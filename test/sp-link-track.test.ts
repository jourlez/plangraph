// sp-link --track: one tracked_by xref (xrefs.jsonl, sys jira) from an sp: ticket to a Jira key; refusals write nothing.
// Real runs of bin/plangraph in mkdtemp repos (removed in `after`). NOT covered: a symlinked xrefs.jsonl (the shared precheck in commands.test.ts).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { readPlanFile, writePlanFile } from './helpers/plan-dir.ts';

const BRAIN = path.join(import.meta.dirname, '../bin/plangraph');
const tmps: string[] = [];
after(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });
const ENV = { ...process.env, PLANGRAPH_DIR: '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const run = (cwd: string, args: string[]) => spawnSync(process.execPath, [BRAIN, ...args], { cwd, encoding: 'utf8', env: { ...ENV, CLAUDE_PLUGIN_DATA: path.join(cwd, '.data') } });
const jl = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

function repo() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-track-'))); tmps.push(d);
  execFileSync('git', ['init', '-q'], { cwd: d });
  assert.equal(run(d, ['init']).status, 0);
  writePlanFile(path.join(d, '.plangraph'), 'tickets.jsonl', jl([{ key: 'sp:a/1', title: 'one', points: 1 }, { key: 'J-1', title: 'jira one', points: 1 }]));
  return d;
}
const xrefs = (d: string) => { try { return readPlanFile(path.join(d, '.plangraph'), 'xrefs.jsonl'); } catch { return ''; } };

test('--track writes one jira xref row and a second run is a no-op', () => {
  const d = repo();
  let r = run(d, ['sp-link', 'sp:a/1', '--track', 'J-1']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^linked sp:a\/1 to J-1 \(tracked_by\)/);
  const rows = xrefs(d).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.deepEqual({ type: rows[0].type, id: rows[0].id, sys: rows[0].sys, xid: rows[0].xid }, { type: 'ticket', id: 'sp:a/1', sys: 'jira', xid: 'J-1' });
  const before = xrefs(d);
  r = run(d, ['sp-link', 'sp:a/1', '--track', 'J-1']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /already tracks J-1, nothing written/);
  assert.equal(xrefs(d), before);
});

test('--track refusals exit 2 and write nothing', () => {
  const d = repo();
  const bad = (args: string[], msg: RegExp) => { const r = run(d, args); assert.equal(r.status, 2, r.stderr); assert.match(r.stderr, msg); assert.equal(xrefs(d), ''); };
  bad(['sp-link', 'sp:a/1', '--track', 'nope'], /needs a Jira key/);
  bad(['sp-link', 'J-1', '--track', 'J-2'], /needs an sp: ticket/);
  bad(['sp-link', 'sp:zzz/9', '--track', 'J-1'], /unknown ticket sp:zzz\/9/);
  bad(['sp-link', 'sp:a/1', 'docs/p.md', '--track', 'J-1'], /no PLAN, no --tasks/);
  bad(['sp-link', 'sp:a/1', '--tasks', '1', '--track', 'J-1'], /no PLAN, no --tasks/);
});

test('--track refuses a second Jira key for one ticket and a second ticket for one Jira key', () => {
  const d = repo();
  assert.equal(run(d, ['sp-link', 'sp:a/1', '--track', 'J-1']).status, 0);
  const before = xrefs(d);
  let r = run(d, ['sp-link', 'sp:a/1', '--track', 'J-2']);
  assert.equal(r.status, 2); assert.match(r.stderr, /already tracks J-1/);
  writePlanFile(path.join(d, '.plangraph'), 'tickets.jsonl', readPlanFile(path.join(d, '.plangraph'), 'tickets.jsonl') + jl([{ key: 'sp:a/2', title: 'two', points: 1 }]));
  r = run(d, ['sp-link', 'sp:a/2', '--track', 'J-1']);
  assert.equal(r.status, 2); assert.match(r.stderr, /J-1 is already tracked by sp:a\/1/);
  assert.equal(xrefs(d), before);
});

test('the DOUBLE_PLACED_WORK hint names sp-link --track', () => {
  const d = repo();
  writePlanFile(path.join(d, '.plangraph'), 'schedule.jsonl', jl([{ key: 'sp:a/1', owner: 'Ana', sprint: 1 }, { key: 'J-1', owner: 'Ana', sprint: 1 }]));
  assert.equal(run(d, ['sp-link', 'sp:a/1', '--track', 'J-1']).status, 0);
  const r = run(d, ['build']);
  assert.match(r.stdout + r.stderr, /DOUBLE_PLACED_WORK.*`sp-link --track`/);
});
