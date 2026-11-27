// sp-ingest gives the plan's EPIC ticket sp 0 (it only groups its tasks) so the solver does not refuse the ingested plan with
// "every ticket needs an sp". Covered: the ingested records (epic sp 0, each task keeps its own Points) with no solver needed, and, when `uv` or a
// python3 with ortools exists (decided as in test/solver.test.ts), `plangraph build` then bin/plangraph-solve-run --jsonl-dir not failing with that message.
// NOT covered: the quality of the schedule (test/solver.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { readPlanFile } from './helpers/plan-dir.ts';

const ROOT = path.join(import.meta.dirname, '..');
const BRAIN = path.join(ROOT, 'bin', 'plangraph'), RUN = path.join(ROOT, 'bin', 'plangraph-solve-run');
const has = (cmd: string, args: string[]) => { try { return spawnSync(cmd, args, { stdio: 'ignore', timeout: 120000 }).status === 0; } catch { return false; } };
const SKIP = has('uv', ['--version']) || has('python3', ['-c', 'import ortools']) ? false : 'skipped: neither uv nor a python3 with ortools is available';
const POINTS = { 1: 2, 2: 3, 3: 5 };
const PLAN = ['# Demo Gadget Plan', '', '**Goal:** Ship a demo gadget.', '',
  ...Object.entries(POINTS).flatMap(([n, p]) => [`### Task ${n}: Part ${n}`, '', `Points: ${p}`, '', `Build part ${n}.`, ''])].join('\n');

function ingested() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-spsolve-')));
  process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  const rel = 'docs/superpowers/plans/demo.md';
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), PLAN);
  // a private plugin data directory under the temp root: the compile cache never goes to the real HOME
  const plangraph = (...a: string[]) => spawnSync(process.execPath, [BRAIN, ...a], { cwd: root, encoding: 'utf8', env: { ...process.env, PLANGRAPH_DIR: '', CLAUDE_PLUGIN_DATA: path.join(root, '.git', 'plangraph-data') } });
  let r = plangraph('init'); assert.equal(r.status, 0, r.stderr);
  r = plangraph('sp-ingest', rel, '--ledger', 'none', '--owner', 'Ana', '--sprint', '1'); assert.equal(r.status, 0, r.stdout + r.stderr);
  const tickets = readPlanFile(path.join(root, '.plangraph'), 'tickets.jsonl').trim().split('\n').map((l) => JSON.parse(l));
  return { root, plangraph, tickets };
}

test('sp-ingest: the epic ticket has sp 0 and each task keeps its own points', () => {
  const { tickets } = ingested();
  assert.equal(tickets.length, 4);
  const epic = tickets.find((t) => t.key === 'sp:demo');
  assert.equal(epic.sp, 0); assert.equal(epic.epic, '');
  for (const [n, p] of Object.entries(POINTS)) {
    const t = tickets.find((x) => x.key === `sp:demo/${n}`);
    assert.equal(t.sp, p, `task ${n}`); assert.equal(t.epic, 'sp:demo');
  }
});

test('sp-ingest then plangraph build then plangraph-solve-run: the solver does not refuse the plan for a ticket without sp', { skip: SKIP, timeout: 900000 }, () => {
  const { root, plangraph } = ingested();
  const b = plangraph('build'); assert.equal(b.status, 0, b.stdout + b.stderr);
  const dir = path.join(root, '.plangraph'), out = path.join(dir, 'solve-out.json');
  const r = spawnSync(RUN, ['--jsonl-dir', dir, '--out', out, '--time', '10'], { cwd: root, encoding: 'utf8', timeout: 600000 });
  const text = `${r.stdout}\n${r.stderr}`;
  assert.doesNotMatch(text, /every ticket needs an sp/);
  assert.doesNotMatch(text, /MODEL_INVALID/);
});
