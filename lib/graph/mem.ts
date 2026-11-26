// In-memory adjacency over typed arrays for the queries SQL does badly: shortest path and critical path (report 08: a recursive CTE with a
// depth column blows up, a BFS in memory takes about 20 ms on 500k edges). Compressed sparse rows, forward and reverse, neighbors sorted by
// node index, so every answer is the same on every run. Nodes are integers 0..n-1 and relations are small integers; the caller maps names.
import { PlangraphError } from '../../src/errors.ts';

function inc(a: Int32Array, i: number, by: number): void { a[i] = (a[i] as number) + by; }

export interface EdgeRow { src: number; dst: number; rel: number }
export interface Adjacency {
  n: number;
  /** forward rows: edges of node v are at [off[v], off[v + 1]) in to and rel */
  off: Int32Array; to: Int32Array; rel: Int32Array;
  /** the same edges seen from the head */
  roff: Int32Array; rto: Int32Array; rrel: Int32Array;
}
export interface Visit { node: number; depth: number; via: number }

/** One CSR direction: edges ordered by (from, to), ties in input order (two stable counting sorts). */
function csr(n: number, from: Int32Array, to: Int32Array, rl: Int32Array): { off: Int32Array; to: Int32Array; rel: Int32Array } {
  const m = from.length, sortBy = (key: Int32Array, order: Int32Array | null) => {
    const cnt = new Int32Array(n + 1);
    for (let i = 0; i < m; i++) inc(cnt, (key[i] as number) + 1, 1);
    for (let v = 0; v < n; v++) inc(cnt, v + 1, cnt[v] as number);
    const out = new Int32Array(m);
    for (let j = 0; j < m; j++) { const i = order ? (order[j] as number) : j; out[(cnt[key[i] as number] as number)] = i; inc(cnt, key[i] as number, 1); }
    return out;
  };
  const byTo = sortBy(to, null), byFrom = sortBy(from, byTo);
  const off = new Int32Array(n + 1), oto = new Int32Array(m), orel = new Int32Array(m);
  for (let i = 0; i < m; i++) inc(off, (from[i] as number) + 1, 1);
  for (let v = 0; v < n; v++) inc(off, v + 1, off[v] as number);
  for (let j = 0; j < m; j++) { const i = byFrom[j] as number; oto[j] = to[i] as number; orel[j] = rl[i] as number; }
  return { off, to: oto, rel: orel };
}

/** Compressed sparse rows for `rows` over nodes 0..n-1 (src to dst). */
export function buildAdjacency(rows: readonly EdgeRow[], n: number): Adjacency {
  if (!Number.isInteger(n) || n < 0) throw new RangeError('n must be a whole number');
  const m = rows.length, s = new Int32Array(m), d = new Int32Array(m), r = new Int32Array(m);
  for (let i = 0; i < m; i++) {
    const e = rows[i] as EdgeRow;
    if (!Number.isInteger(e.src) || !Number.isInteger(e.dst) || e.src < 0 || e.dst < 0 || e.src >= n || e.dst >= n) throw new RangeError(`edge ${i} names a node outside 0..${n - 1}`);
    s[i] = e.src; d[i] = e.dst; r[i] = e.rel | 0;
  }
  const f = csr(n, s, d, r), b = csr(n, d, s, r);
  return { n, off: f.off, to: f.to, rel: f.rel, roff: b.off, rto: b.to, rrel: b.rel };
}

const node = (adj: Adjacency, v: number, what: string): void => { if (!Number.isInteger(v) || v < 0 || v >= adj.n) throw new RangeError(`${what} is not a node of the graph`); };
/** A relation filter as a lookup: undefined keeps every relation. */
const keep = (rels?: readonly number[]): ((r: number) => boolean) => { if (!rels) return () => true; const set = new Set(rels); return (r) => set.has(r); };

/** Nodes within maxDepth steps of `from` (the node itself left out), breadth first, each once at its least depth with the node it came
 * through. Order: by depth, then by the order the frontier was expanded (neighbors by node index). `reverse` follows edges backwards. */
export function bfs(adj: Adjacency, from: number, opts: { rels?: readonly number[]; maxDepth: number; reverse?: boolean }): Visit[] {
  node(adj, from, 'from');
  const ok = keep(opts.rels), off = opts.reverse ? adj.roff : adj.off, to = opts.reverse ? adj.rto : adj.to, rel = opts.reverse ? adj.rrel : adj.rel;
  const depth = new Int32Array(adj.n).fill(-1), queue = new Int32Array(adj.n), via = new Int32Array(adj.n), out: Visit[] = [];
  let head = 0, tail = 0; depth[from] = 0; queue[tail++] = from;
  while (head < tail) {
    const v = queue[head++] as number, dv = depth[v] as number;
    if (dv >= opts.maxDepth) continue;
    for (let e = off[v] as number, end = off[v + 1] as number; e < end; e++) {
      const w = to[e] as number;
      if (depth[w] !== -1 || !ok(rel[e] as number)) continue;
      depth[w] = dv + 1; via[w] = v; queue[tail++] = w; out.push({ node: w, depth: dv + 1, via: v });
    }
  }
  return out;
}

/** A path with the fewest edges from a to b (ties go to the lower node index at each step), or null when b cannot be reached. */
export function shortestPath(adj: Adjacency, a: number, b: number, rels?: readonly number[]): number[] | null {
  node(adj, a, 'a'); node(adj, b, 'b');
  if (a === b) return [a];
  const ok = keep(rels), prev = new Int32Array(adj.n).fill(-1), queue = new Int32Array(adj.n);
  let head = 0, tail = 0; prev[a] = a; queue[tail++] = a;
  while (head < tail) {
    const v = queue[head++] as number;
    for (let e = adj.off[v] as number, end = adj.off[v + 1] as number; e < end; e++) {
      const w = adj.to[e] as number;
      if (prev[w] !== -1 || !ok(adj.rel[e] as number)) continue;
      prev[w] = v;
      if (w === b) { const path = [b]; for (let x = b; x !== a;) { x = prev[x] as number; path.push(x); } return path.reverse(); }
      queue[tail++] = w;
    }
  }
  return null;
}

/** The longest path by summed node weight over the edges of `rels`, and its weight. A cycle among those edges is a DATA error, as in `ready`. */
export function criticalPath(adj: Adjacency, weights: ArrayLike<number>, rels: readonly number[]): { path: number[]; length: number } {
  const n = adj.n, ok = keep(rels), indeg = new Int32Array(n);
  for (let v = 0; v < n; v++) for (let e = adj.off[v] as number, end = adj.off[v + 1] as number; e < end; e++) if (ok(adj.rel[e] as number)) inc(indeg, adj.to[e] as number, 1);
  const best = new Float64Array(n), prev = new Int32Array(n).fill(-1), queue = new Int32Array(n);
  let head = 0, tail = 0;
  for (let v = 0; v < n; v++) { best[v] = weights[v] as number; if (!indeg[v]) queue[tail++] = v; }
  while (head < tail) {
    const v = queue[head++] as number;
    for (let e = adj.off[v] as number, end = adj.off[v + 1] as number; e < end; e++) {
      if (!ok(adj.rel[e] as number)) continue;
      const w = adj.to[e] as number, cand = (best[v] as number) + (weights[w] as number);
      if (cand > (best[w] as number) || (cand === best[w] && prev[w] !== -1 && v < (prev[w] as number))) { best[w] = cand; prev[w] = v; }
      inc(indeg, w, -1);
      if (indeg[w] === 0) queue[tail++] = w;
    }
  }
  if (tail < n) {
    let c = 0; while (!indeg[c]) c++; // a node never released sits on or behind a cycle
    throw new PlangraphError('DATA', `dependency cycle through node ${c}`, { hint: 'run `plangraph check`' });
  }
  let end = -1;
  for (let v = 0; v < n; v++) if (end === -1 || (best[v] as number) > (best[end] as number)) end = v;
  if (end === -1) return { path: [], length: 0 };
  const path = [end]; for (let x = end; prev[x] !== -1;) { x = prev[x] as number; path.push(x); }
  return { path: path.reverse(), length: best[end] as number };
}
