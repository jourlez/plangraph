// Tests for scripts/mutate-pool.mjs (the bounded worker pool `npm run mutate` uses to run its mutants in parallel) and the CLI surface of
// scripts/mutate.mjs that does not need a full mutation run (--list, --jobs validation).
// Covered: results come back in input order whatever order the work finishes in; never more than `jobs` calls run at once; every item runs
// exactly once; each worker index is in [0, jobs) and one worker never runs two items at once (each worker owns one repository copy);
// an error stops new work and rejects; jobs is clamped to [1, items]; an empty list; `--jobs` rejects non-integers and values below 1.
// NOT covered: the full mutation run (`npm run mutate`, the CI mutation job, runs every mutant and must kill all of them).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pool, parseJobs } from '../scripts/mutate-pool.mjs';

const ROOT = path.join(import.meta.dirname, '..');
const tick = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

test('pool: results are in input order even when later items finish first', async () => {
  const delays = [40, 5, 30, 1, 20, 2, 10, 0];
  const done = /** @type {number[]} */ ([]);
  const out = await pool(delays, 3, async (d, k) => { await tick(d); done.push(k); return `r${k}`; });
  assert.deepEqual(out, delays.map((_, k) => `r${k}`));
  assert.notDeepEqual(done, delays.map((_, k) => k), 'the work really finished out of order');
});

test('pool: at most `jobs` calls run at once, each item exactly once, one item per worker at a time', async () => {
  for (const jobs of [1, 2, 4, 7]) {
    let live = 0, peak = 0;
    const seen = /** @type {number[]} */ ([]);
    const busy = new Set();
    const items = Array.from({ length: 23 }, (_, k) => k);
    await pool(items, jobs, async (x, k, w) => {
      assert.equal(x, k);
      assert.ok(Number.isInteger(w) && w >= 0 && w < jobs, `worker ${w} out of range for jobs ${jobs}`);
      assert.ok(!busy.has(w), `worker ${w} ran two items at once`);
      busy.add(w); live++; peak = Math.max(peak, live);
      await tick((k * 7) % 5);
      live--; busy.delete(w); seen.push(k);
    });
    assert.deepEqual([...seen].sort((a, b) => a - b), items, `jobs ${jobs}: every item once`);
    assert.equal(peak, Math.min(jobs, items.length), `jobs ${jobs}: peak concurrency`);
  }
});

test('pool: jobs is clamped to [1, items]; an empty list resolves to []', async () => {
  assert.deepEqual(await pool([], 4, async () => 1), []);
  let peak = 0, live = 0;
  await pool([1, 2], 50, async (_x, _k, w) => { assert.ok(w < 2); live++; peak = Math.max(peak, live); await tick(5); live--; });
  assert.equal(peak, 2);
  const ws = new Set();
  await pool([1, 2, 3], 0, async (_x, _k, w) => { ws.add(w); });
  assert.deepEqual([...ws], [0]);
});

test('pool: an error rejects and no new item starts after it', async () => {
  const started = /** @type {number[]} */ ([]);
  await assert.rejects(pool(Array.from({ length: 20 }, (_, k) => k), 2, async (k) => {
    started.push(k);
    if (k === 3) throw new Error('boom');
    await tick(5);
  }), /boom/);
  await tick(50);
  assert.ok(started.length <= 5, `started after the error: ${started}`);
});

test('parseJobs: a positive integer, else the default; bad values throw', () => {
  assert.equal(parseJobs([], 3), 3);
  assert.equal(parseJobs(['--jobs', '2'], 3), 2);
  assert.equal(parseJobs(['--list', '--jobs', '1'], 4), 1);
  for (const bad of ['0', '-1', '1.5', 'x', '']) assert.throws(() => parseJobs(['--jobs', bad], 3), /--jobs/);
  assert.throws(() => parseJobs(['--jobs'], 3), /--jobs/);
});

test('mutate.mjs: --list prints one line per mutant and runs nothing; a bad --jobs exits 2 before copying anything', () => {
  const l = spawnSync(process.execPath, ['scripts/mutate.mjs', '--list'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(l.status, 0);
  // a mutant whose text spans lines prints over several lines, so count the lines that start a mutant
  const rows = l.stdout.split('\n').filter((r) => /^(lib|src)\/[^:]+\.mjs: .+ -> /.test(r));
  assert.ok(rows.length >= 60, `only ${rows.length} mutants listed`);
  const b = spawnSync(process.execPath, ['scripts/mutate.mjs', '--jobs', '0'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(b.status, 2);
  assert.match(b.stderr, /--jobs/);
});
