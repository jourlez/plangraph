// Timing file (Task 21A): the build of 100k ticket records must stay linear in the record count. Builds of 25k and 100k records are timed in
// this process's children (min of 3 each); linear gives about 4x (node start-up only lowers it), quadratic about 16x. A ratio, never an
// absolute limit. test/build-extra.test.ts holds the other cases of the build.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { factor } from './helpers/perf.ts';

const BRAIN = path.join(import.meta.dirname, '../bin/plangraph');
const tmps: string[] = [];
after(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-btime-data-')); tmps.push(DATA);
const run = (cwd: string, ...args: string[]) => execFileSync('node', [BRAIN, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CLAUDE_PLUGIN_DATA: DATA } });
function repo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-btime-'));
  tmps.push(d);
  execFileSync('git', ['init', '-q'], { cwd: d });
  run(d, 'init');
  return d;
}
const bdir = (d: string) => path.join(d, '.plangraph');
const tk = (key: string, more: Record<string, unknown> = {}) => ({ key, summary: 's' + key, epic: 'E', sp: 3, jira_status: 'To Do', v2_owner: 'Ana', v2_sprint: 1, verdict: 'READY', verdict_source: 'a', first_verdict: 'READY', ...more });
const count = (d: string, t: string) => { const db = new DatabaseSync(path.join(bdir(d), 'plangraph.sqlite'), { readOnly: true }); try { return (db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c; } finally { db.close(); } }; // COUNT(*) always returns one row

test('(e) 100k ticket records build in linear time (25k vs 100k, min of 3)', () => {
  const d = repo();
  const timeBuild = (n: number, reps: number) => {
    const lines = [];
    for (let i = 0; i < n; i++) lines.push(JSON.stringify(tk('K-' + i, i % 10 === 0 ? { extra_x: i } : {})));
    fs.writeFileSync(path.join(bdir(d), 'tickets.jsonl'), lines.join('\n') + '\n');
    let best = Infinity;
    for (let k = 0; k < reps; k++) { const t0 = performance.now(); run(d, 'build'); best = Math.min(best, performance.now() - t0); }
    assert.equal(count(d, 'ticket'), n);
    return best;
  };
  const small = timeBuild(25000, 3), large = timeBuild(100000, 3);
  // prepared-once statements, no per-record prepare
  assert.ok(large / small < 9 * factor(), `build is not linear: 25k took ${small.toFixed(0)} ms, 100k took ${large.toFixed(0)} ms`);
});
