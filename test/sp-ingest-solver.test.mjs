// sp-ingest gives the plan's EPIC ticket sp 0 (it only groups its tasks) so the solver does not refuse the ingested plan with
// "every ticket needs an sp". Covered: the ingested records (epic sp 0, each task keeps its own Points) with no solver needed, and, when `uv` or a
// python3 with ortools exists (decided as in test/solver.test.mjs), `brain build` then bin/brain-solve-run --jsonl-dir not failing with that message.
// NOT covered: the quality of the schedule (test/solver.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';

const ROOT = path.join(import.meta.dirname, '..');
const BRAIN = path.join(ROOT, 'bin', 'brain'), RUN = path.join(ROOT, 'bin', 'brain-solve-run');
const has = (cmd, args) => { try { return spawnSync(cmd, args, { stdio: 'ignore', timeout: 120000 }).status === 0; } catch { return false; } };
const SKIP = has('uv', ['--version']) || has('python3', ['-c', 'import ortools']) ? false : 'skipped: neither uv nor a python3 with ortools is available';
const POINTS = { 1: 2, 2: 3, 3: 5 };
const PLAN = ['# Demo Gadget Plan', '', '**Goal:** Ship a demo gadget.', '',
  ...Object.entries(POINTS).flatMap(([n, p]) => [`### Task ${n}: Part ${n}`, '', `Points: ${p}`, '', `Build part ${n}.`, ''])].join('\n');

function ingested() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-spsolve-')));
  process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  const rel = 'docs/superpowers/plans/demo.md';
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), PLAN);
  const brain = (...a) => spawnSync(process.execPath, [BRAIN, ...a], { cwd: root, encoding: 'utf8', env: { ...process.env, BRAIN_DIR: '' } });
  let r = brain('init'); assert.equal(r.status, 0, r.stderr);
  r = brain('sp-ingest', rel, '--ledger', 'none', '--owner', 'Ana', '--sprint', '1'); assert.equal(r.status, 0, r.stdout + r.stderr);
  const tickets = fs.readFileSync(path.join(root, '.brain', 'tickets.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return { root, brain, tickets };
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

test('sp-ingest then brain build then brain-solve-run: the solver does not refuse the plan for a ticket without sp', { skip: SKIP, timeout: 900000 }, () => {
  const { root, brain } = ingested();
  const b = brain('build'); assert.equal(b.status, 0, b.stdout + b.stderr);
  const dir = path.join(root, '.brain'), out = path.join(dir, 'solve-out.json');
  const r = spawnSync(RUN, ['--jsonl-dir', dir, '--out', out, '--time', '10'], { cwd: root, encoding: 'utf8', timeout: 600000 });
  const text = `${r.stdout}\n${r.stderr}`;
  assert.doesNotMatch(text, /every ticket needs an sp/);
  assert.doesNotMatch(text, /MODEL_INVALID/);
});
