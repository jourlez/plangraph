// Differential test: the solver's end sprint equals the brute-force optimum on small random plans (at most 6 tickets, 3 people, 4 sprints).
// Skips when neither uv nor a python3 with ortools exists. Run through the launcher with --jsonl-dir, as test/solver.test.ts does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { genPlan } from '../fixtures/gen.ts';
import type { GenPlan } from '../fixtures/gen.ts';
import { bestEnd, modelWith, oracleValid } from '../helpers/oracle.ts';
import { verifyPlan } from '../../lib/verify.ts';

const RUN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'plangraph-solve-run');
const has = (cmd: string, args: string[]) => { try { return spawnSync(cmd, args, { stdio: 'ignore', timeout: 120000 }).status === 0; } catch { return false; } };
const SKIP = has('uv', ['--version']) || has('python3', ['-c', 'import ortools']) ? false : 'skipped: neither uv nor a python3 with ortools is available';
const SPRINTS = 4;

const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'plangraph-diff-solver-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
spawnSync('git', ['init', '-q'], { cwd: tmp }); // the solver confines paths to the git root of its cwd
const wjl = (f: string, rows: readonly unknown[]) => fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

function solve(plan: GenPlan, n: number): { end: number; rows: Array<{ item: string; owner: string; sprint: number }> } {
  const dir = path.join(tmp, `p${n}`); fs.mkdirSync(dir);
  wjl(path.join(dir, 'tickets.jsonl'), plan.tickets); wjl(path.join(dir, 'edges.jsonl'), plan.edges); wjl(path.join(dir, 'schedule.jsonl'), plan.schedule);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(plan.config));
  const out = path.join(dir, 'out.json');
  const r = spawnSync(RUN, ['--jsonl-dir', dir, '--out', out, '--time', '30'], { encoding: 'utf8', timeout: 300000, cwd: tmp });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  const meta = JSON.parse(fs.readFileSync(`${out}.meta.json`, 'utf8')) as { status: string; end_sprint: number };
  assert.equal(meta.status, 'OPTIMAL');
  return { end: meta.end_sprint, rows: JSON.parse(fs.readFileSync(out, 'utf8')) };
}

test('the solver end sprint equals the brute-force optimum', { skip: SKIP, timeout: 600000 }, () => {
  let checked = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const plan = genPlan({ n: 3 + (seed % 4), people: 1 + (seed % 3), density: 0.5, seed: seed * 7, cap: 6, maxSp: 3 });
    const want = bestEnd(plan, SPRINTS); if (want === null) continue; // no schedule within 4 sprints: nothing to compare
    const got = solve(plan, seed);
    assert.equal(got.end, want, `seed ${seed}`);
    const a = new Map(got.rows.map((r) => [r.item, { owner: r.owner, sprint: r.sprint }]));
    assert.ok(oracleValid(plan, a), `seed ${seed}: the solver schedule breaks a rule the oracle checks`);
    assert.deepEqual(verifyPlan(modelWith(plan, a)), [], `seed ${seed}`);
    checked++;
  }
  assert.ok(checked >= 6, `enough instances compared (${checked})`);
});
