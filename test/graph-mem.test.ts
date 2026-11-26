// The in-memory adjacency layer (lib/graph/mem.ts): bfs against the SQL reach over the index views, criticalPath against a brute-force
// oracle, the cycle error, shortestPath, determinism.
// NOT covered: the command wiring (later task) and the timing bounds (test/graph-mem-perf.test.ts).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildIndex, openIndex, INDEX_FILE } from '../src/db.ts';
import { PlangraphError } from '../src/errors.ts';
import { reach } from '../lib/graph/views.ts';
import { buildAdjacency, bfs, shortestPath, criticalPath } from '../lib/graph/mem.ts';
import { genPlan, rng } from './fixtures/gen.ts';
import { adoptPlanDir } from './helpers/plan-dir.ts';

const tmps: string[] = [];
after(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });
const jl = (rows: readonly object[]) => rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');

test('bfs equals the SQL reach over needs on generated fixtures, depths 1 to 3, both directions', () => {
  for (let seed = 1; seed <= 12; seed++) {
    const p = genPlan({ n: 6 + seed * 3, people: 2, density: 0.25, seed });
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'graph-mem-'))); tmps.push(dir);
    fs.writeFileSync(path.join(dir, 'tickets.jsonl'), jl(p.tickets));
    fs.writeFileSync(path.join(dir, 'edges.jsonl'), jl(p.edges));
    adoptPlanDir(dir); buildIndex({ dir });
    using h = openIndex(path.join(dir, INDEX_FILE), { dir });
    const keys = p.tickets.map((t) => t.key), idx = new Map(keys.map((k, i) => [k, i]));
    const adj = buildAdjacency(p.edges.map((e) => ({ src: idx.get(e.consumer) as number, dst: idx.get(e.producer) as number, rel: 0 })), keys.length);
    for (const key of keys) for (const reverse of [false, true]) for (const depth of [1, 2, 3]) {
      const want = reach(h, { id: key, type: 'ticket' }, ['needs'], depth, reverse).map((r) => r.id).toSorted();
      const got = bfs(adj, idx.get(key) as number, { maxDepth: depth, reverse }).map((r) => keys[r.node] as string).toSorted();
      assert.deepEqual(got, want, `${key} depth ${depth} reverse ${reverse} seed ${seed}`);
    }
  }
});

test('bfs reports depth and the node it came through, in breadth-first order with ties by node index', () => {
  const adj = buildAdjacency([{ src: 0, dst: 2, rel: 0 }, { src: 0, dst: 1, rel: 0 }, { src: 1, dst: 3, rel: 0 }, { src: 2, dst: 3, rel: 0 }, { src: 3, dst: 4, rel: 1 }], 5);
  assert.deepEqual(bfs(adj, 0, { maxDepth: 5 }), [{ node: 1, depth: 1, via: 0 }, { node: 2, depth: 1, via: 0 }, { node: 3, depth: 2, via: 1 }, { node: 4, depth: 3, via: 3 }]);
  assert.deepEqual(bfs(adj, 0, { maxDepth: 5, rels: [0] }).map((r) => r.node), [1, 2, 3]); // rel 1 is filtered out
  assert.deepEqual(bfs(adj, 3, { maxDepth: 1, reverse: true }).map((r) => r.node), [1, 2]);
  assert.deepEqual(bfs(adj, 0, { maxDepth: 0 }), []);
});

test('shortestPath: fewest hops, null when unreachable, one node for a to a, rels filter, bad index refused', () => {
  const adj = buildAdjacency([{ src: 0, dst: 1, rel: 0 }, { src: 1, dst: 2, rel: 0 }, { src: 0, dst: 3, rel: 1 }, { src: 3, dst: 2, rel: 1 }, { src: 2, dst: 4, rel: 0 }], 6);
  assert.deepEqual(shortestPath(adj, 0, 4), [0, 1, 2, 4]); // ties by lower node index
  assert.deepEqual(shortestPath(adj, 0, 4, [1]), null);
  assert.deepEqual(shortestPath(adj, 0, 2, [1]), [0, 3, 2]);
  assert.deepEqual(shortestPath(adj, 4, 0), null);
  assert.deepEqual(shortestPath(adj, 5, 5), [5]);
  assert.throws(() => shortestPath(adj, 0, 9), RangeError);
  assert.throws(() => buildAdjacency([{ src: 0, dst: 9, rel: 0 }], 3), RangeError);
});

/** Longest node-weighted path by trying every path from every node. */
function oracle(n: number, edges: Array<{ src: number; dst: number }>, w: number[]): number {
  let best = 0;
  const go = (v: number, acc: number): void => { acc += w[v] as number; best = Math.max(best, acc); for (const e of edges) if (e.src === v) go(e.dst, acc); };
  for (let v = 0; v < n; v++) go(v, 0);
  return best;
}

test('criticalPath equals a brute-force oracle on 200 random DAGs of at most 8 nodes', () => {
  const r = rng(77);
  for (let i = 0; i < 200; i++) {
    const n = 1 + Math.floor(r() * 8), perm = Array.from({ length: n }, (_, k) => k).sort(() => r() - 0.5);
    const edges: Array<{ src: number; dst: number; rel: number }> = [];
    for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) if (r() < 0.4) edges.push({ src: perm[a] as number, dst: perm[b] as number, rel: 0 });
    const w = Array.from({ length: n }, () => 1 + Math.floor(r() * 9));
    const res = criticalPath(buildAdjacency(edges, n), w, [0]);
    assert.equal(res.length, oracle(n, edges, w), `case ${i}`);
    assert.equal(res.path.reduce((s, v) => s + (w[v] as number), 0), res.length);
    res.path.slice(1).forEach((v, k) => assert.ok(edges.some((e) => e.src === res.path[k] && e.dst === v)));
  }
});

test('criticalPath: empty graph, rels filter, and a cycle gives the DATA error', () => {
  assert.deepEqual(criticalPath(buildAdjacency([], 0), [], [0]), { path: [], length: 0 });
  const adj = buildAdjacency([{ src: 0, dst: 1, rel: 0 }, { src: 1, dst: 2, rel: 1 }, { src: 2, dst: 0, rel: 1 }], 3);
  assert.deepEqual(criticalPath(adj, [1, 1, 1], [0]), { path: [0, 1], length: 2 }); // the cycle is on rel 1 only
  assert.throws(() => criticalPath(adj, [1, 1, 1], [0, 1]), (e) => e instanceof PlangraphError && e.code === 'DATA' && /dependency cycle/.test(e.message));
});

test('output is identical across runs and across input edge order of distinct edges', () => {
  const r = rng(5), edges: Array<{ src: number; dst: number; rel: number }> = [];
  for (let a = 0; a < 40; a++) for (let b = a + 1; b < 40; b++) if (r() < 0.1) edges.push({ src: a, dst: b, rel: 0 });
  const w = Array.from({ length: 40 }, (_, k) => 1 + (k % 3));
  const run = (es: typeof edges) => { const a = buildAdjacency(es, 40); return JSON.stringify([bfs(a, 0, { maxDepth: 9 }), shortestPath(a, 0, 39), criticalPath(a, w, [0])]); };
  assert.equal(run(edges), run(edges));
  assert.equal(run(edges), run(edges.toReversed()));
});
