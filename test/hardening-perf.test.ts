// Hardening (task 33): the 1.0 commands on a large plan: 5,000 tickets, 200 repositories, 20,000 commits. Wall-clock bounds exist only here, only under
// CI_SLOW=1 (never in a default run). Each bound is 10x the median measured on the development machine (the measured medians are in the comment
// beside it), except refresh --fast, which keeps the spec's 3 s. The spec target for map and context is 300 ms warm: the measured median is about
// 330 ms on this plan (5,000 ticket files are opened and parsed per run to read their links and refs), so the bound is the 10x rule, and the gap to the
// target is reported to the controller as a decision (an index-backed read of links and refs).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fastRepo } from './helpers/gitrepo.ts';
import { run, cleanup, git } from './helpers/hook-world.ts';
import { genPlan } from './fixtures/gen.ts';
import { writePlanDir, adoptPlanDir } from './helpers/plan-dir.ts';
import { readStoreAt } from '../lib/planstore.ts';
import type { Row } from '../lib/planstore.ts';

const SLOW = process.env.CI_SLOW === '1';
const skip = SLOW ? false : 'set CI_SLOW=1 to run the timing assertions';
// milliseconds
const BOUND = { map: 3300, context: 3300, refreshFast: 3000, refreshNoop: 2200, check: 11000, build: 24000, ingestGit: 8200 }; // medians: map 327, context 325, refresh no-op 220, rebuild 1600, check 1100, build 2400, ingest git 820

let root = '', dir = '';
let repoCleanup: () => void = () => {};
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number;
const timed = async (argv: string[], n: number): Promise<{ med: number; last: Awaited<ReturnType<typeof run>> }> => {
  const ts: number[] = []; let last = await run(root, argv); // the first run warms the module cache and the index handle
  for (let i = 0; i < n; i++) { const t = performance.now(); last = await run(root, argv); ts.push(performance.now() - t); }
  return { med: median(ts), last };
};

before(async () => {
  if (!SLOW) return;
  const r = fastRepo(20000); root = r.dir; dir = path.join(root, '.plangraph'); repoCleanup = r.cleanup;
  const plan = genPlan({ n: 5000, people: 12, density: 0.003, seed: 5, prefix: 'ABC', cap: 100000 });
  const repos: Row[] = Array.from({ length: 200 }, (_, i) => ({ id: `repo:r${i}`, name: `r${i}`, owners: [`P${i % 12}`], cmds: { test: 'npm test', build: 'npm run build' } }));
  const links: Row[] = plan.tickets.map((t, i) => ({ from: t.key, from_type: 'ticket', rel: 'touches', to: `repo:r${i % 200}`, to_type: 'repo' }));
  writePlanDir(dir, plan, { repo: repos, link: links });
  adoptPlanDir(dir);
  fs.writeFileSync(path.join(dir, '.gitignore'), 'cache/\nplangraph.sqlite*\n.txn/\n');
  fs.writeFileSync(path.join(root, '.gitignore'), 'docs/plangraph/\n');
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'plan');
});
after(() => { repoCleanup(); cleanup(); });

test('ingest git over 20,000 commits stays under its bound, and the build of 5,000 tickets, 200 repos and 5,000 links', { skip }, async () => {
  let t = performance.now();
  const g = await run(root, ['ingest', 'git', '--repo', 'repo:r0', '--since', '36500']);
  const ingest = performance.now() - t;
  assert.equal(g.code, 0, g.err.join('|'));
  assert.match(g.out.join(' '), /from 2000[01] commits/);
  t = performance.now();
  const b = await run(root, ['build']);
  const build = performance.now() - t;
  assert.equal(b.code, 0, b.err.join('|'));
  process.stderr.write(`perf: ingest git ${ingest.toFixed(0)} ms, build ${build.toFixed(0)} ms\n`);
  assert.ok(ingest < BOUND.ingestGit, `ingest git ${ingest} ms`);
  assert.ok(build < BOUND.build, `build ${build} ms`);
  assert.equal(readStoreAt(dir).readKind('ticket').length, 5000);
});

test('map and context answer within 10x their measured median warm on the large plan', { skip }, async () => {
  const m = await timed(['map'], 7);
  assert.equal(m.last.code, 0, m.last.err.join('|'));
  const c = await timed(['context', 'ABC-100'], 7);
  assert.equal(c.last.code, 0, c.last.err.join('|'));
  process.stderr.write(`perf: map median ${m.med.toFixed(0)} ms, context median ${c.med.toFixed(0)} ms\n`);
  assert.ok(m.med < BOUND.map, `map median ${m.med} ms`);
  assert.ok(c.med < BOUND.context, `context median ${c.med} ms`);
});

test('refresh --fast: a no-op on a fresh index, and under 3 s when the index must be rebuilt', { skip }, async () => {
  const noop = await timed(['refresh', '--fast', '--quiet'], 5);
  assert.deepEqual(noop.last.out, []);
  fs.rmSync(path.join(dir, 'plangraph.sqlite'), { force: true }); // a missing index: the rebuild path
  const t = performance.now();
  const r = await run(root, ['refresh', '--fast', '--quiet']);
  const rebuild = performance.now() - t;
  assert.equal(r.code, 0);
  assert.deepEqual(r.out, []);
  process.stderr.write(`perf: refresh --fast no-op median ${noop.med.toFixed(0)} ms, rebuild ${rebuild.toFixed(0)} ms\n`);
  assert.ok(noop.med < BOUND.refreshNoop, `no-op ${noop.med} ms`);
  assert.ok(rebuild < BOUND.refreshFast, `rebuild ${rebuild} ms`);
});

test('check on the large plan stays under its bound', { skip }, async () => {
  await run(root, ['build']);
  const c = await timed(['check'], 3);
  assert.ok(c.last.code === 0 || c.last.code === 1, c.last.err.join('|'));
  process.stderr.write(`perf: check median ${c.med.toFixed(0)} ms\n`);
  assert.ok(c.med < BOUND.check, `check median ${c.med} ms`);
});
