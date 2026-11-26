// Wall-clock bounds of the in-memory adjacency layer at 100,000 nodes and 500,000 edges: 10x the medians of report 08 (load 300 ms,
// shortest path 20 ms). The assertions run only under CI_SLOW=1.
// NOT covered: correctness (test/graph-mem.test.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAdjacency, shortestPath } from '../lib/graph/mem.ts';
import { rng } from './fixtures/gen.ts';

const SLOW = process.env.CI_SLOW === '1';
test('load under 3 seconds and shortestPath under 1 second on 100k nodes and 500k edges', { skip: SLOW ? false : 'set CI_SLOW=1 to run the timing assertion' }, () => {
  const n = 100_000, m = 500_000, r = rng(3), rows: Array<{ src: number; dst: number; rel: number }> = [];
  for (let i = 0; i < m; i++) { const s = Math.floor(r() * n); rows.push({ src: s, dst: Math.min(n - 1, s + 1 + Math.floor(r() * 20)), rel: i % 4 }); } // forward-local, a chain through every node below
  for (let i = 0; i + 1 < n; i++) rows[i] = { src: i, dst: i + 1, rel: 0 };
  let t = performance.now();
  const adj = buildAdjacency(rows, n);
  const load = performance.now() - t;
  t = performance.now();
  const p = shortestPath(adj, 0, n - 1);
  const sp = performance.now() - t;
  console.log(`load ${load.toFixed(0)} ms, shortestPath ${sp.toFixed(1)} ms`);
  assert.ok(p && p[0] === 0 && p.at(-1) === n - 1);
  assert.ok(load < 3000, `load ${load} ms`);
  assert.ok(sp < 1000, `shortestPath ${sp} ms`);
});
