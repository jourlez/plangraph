// Property (e): lib/stale.ts computeStale closure == an independent graph-closure oracle (oracle.ts consumerClosure) on every graph
// in the bounds below. Setup per graph: every node is a ticket; audited nodes have a refs row pointing at their own plan section; the rows
// are fingerprinted once with refsUpdate against plan text v1 (so they are clean), then the plan text of a seed set is changed to v2.
// Checked against docs/STALE.md:
//   - with no change, nothing is stale (fresh rows are clean, whatever the graph, loops and self-links included);
//   - stale keys == consumer closure of the seeds (any depth, through unaudited tickets too); clean == audited tickets outside it;
//   - reasons: a seed has `plan`; a ticket with a stale direct producer has `producer_changed`; nothing else;
//   - via == the stale direct producer with the fewest hops from a changed source (ties: smallest key), where the changed sources are the
//     audited stale tickets (a seed, or an audited ticket whose recorded producer digest no longer matches: every audited ticket with a
//     stale producer) and hops are counted along consumer links; null when no direct producer is stale.
// NOT covered: graphs beyond BOUNDS, inputs other than plan text (files, jira, links, rules are the same mechanism per class; covered by
// test/stale.test.ts), legacy rows without fp_prods, the git adapter.
import assert from 'node:assert/strict';
import { buildModel } from '../../lib/model.ts';
import { computeStale, refsUpdate } from '../../lib/stale.ts';
import { consumerClosure } from './oracle.ts';
import { allGraphs, subsets, keysOf } from './enum.ts';
import type { Level } from './enum.ts';

type Pair = [string, string];

const planOf = (k: string): string => `plans/${k}.md`;
const depsFor = (changed: Set<string>) => ({ readPlanText: (_ref: string, p: string): string => `## Task 1: work\n${changed.has(p) ? 'v2' : 'v1'}\n`, listFiles: () => ({}) });

function oracleVia(keys: string[], edges: Pair[], S: Set<string>, audited: Set<string>, seeds: Set<string>): Map<string, string | null> {
  const d0 = keys.filter((k) => S.has(k) && audited.has(k) && (seeds.has(k) || edges.some(([c, p]) => c === k && S.has(p))));
  const dist = new Map<string, number>(d0.map((k): [string, number] => [k, 0])); let fr = d0;
  while (fr.length) { const nx: string[] = []; for (const p of fr) for (const [c, q] of edges) if (q === p && !dist.has(c)) { dist.set(c, (dist.get(p) as number) + 1); nx.push(c); } fr = nx; }
  const via = new Map<string, string | null>();
  for (const k of S) {
    const ps = [...new Set(edges.filter(([c, p]) => c === k && S.has(p)).map(([, p]) => p))].sort((a, b) => (dist.get(a) as number) - (dist.get(b) as number) || (a < b ? -1 : 1));
    via.set(k, ps.length ? ps[0] : null);
  }
  return via;
}

function checkGraph(keys: string[], edges: Pair[], audited: Set<string>, seedSets: Array<Set<string>>): number {
  const model = buildModel({ tickets: keys.map((key) => ({ key, sp: 1 })), edges: edges.map(([consumer, producer]) => ({ consumer, producer, kind: 'plan_need' })) });
  const raw = keys.filter((k) => audited.has(k)).map((key) => ({ key, plans: [{ plan: planOf(key), task: '1' }], files: {} }));
  const rows = refsUpdate(model, raw, depsFor(new Set()), {}, [...audited]).rows;
  let n = 0;
  for (const seeds of seedSets) {
    const res = computeStale(model, rows, depsFor(new Set([...seeds].map(planOf))), {});
    const S = consumerClosure(edges, [...seeds]), via = oracleVia(keys, edges, S, audited, seeds);
    const got = res.stale.map((s) => s.key).join(','), want = [...S].sort().join(',');
    const ctx = () => JSON.stringify({ keys, edges, audited: [...audited], seeds: [...seeds], lib: res.stale, oracle: { S: [...S], via: [...via] } });
    if (got !== want) assert.fail(`stale: closure differs\n${ctx()}`);
    if (res.clean !== [...audited].filter((k) => !S.has(k)).length) assert.fail(`stale: clean count differs\n${ctx()}`);
    for (const s of res.stale) {
      const want2 = [...(seeds.has(s.key) ? ['plan'] : []), ...(via.get(s.key) !== null ? ['producer_changed'] : [])].join(',');
      if (s.reasons.join(',') !== want2 || s.via !== via.get(s.key)) assert.fail(`stale: reasons/via differ for ${s.key}\n${ctx()}`);
    }
    n++;
  }
  return n;
}

interface Bound { n: number; all?: boolean; loops?: boolean; seedsAll?: boolean; auditMax?: number }
export const BOUNDS: Record<Level, Bound[]> = {
  full: [{ n: 1, all: true }, { n: 2, all: true }, { n: 3, all: true }, { n: 4, loops: true, seedsAll: true }, { n: 5, loops: false }],
  quick: [{ n: 1, all: true }, { n: 2, all: true }, { n: 3, all: true, auditMax: 1 }, { n: 3, loops: true, seedsAll: true }],
};

export function assureStale(lvl: Level): { graphs: number; cases: number } {
  const counts = { graphs: 0, cases: 0 };
  for (const b of BOUNDS[lvl]) {
    const keys = keysOf(b.n);
    // all: every graph with self-links x every audited subset (quick: of at most auditMax tickets, so unaudited chains of 2 hops occur)
    // x every seed subset of it.
    // loops: every graph with self-links, everything audited but the last node, every seed subset.
    // n=5: every graph WITHOUT self-links up to isomorphism (9608 classes): last node unaudited with every seed subset, and everything
    // audited with seeds {}, each single node and all; self-links are covered up to n=4.
    const graphs = b.loops === false ? loopless(keys) : allGraphs(keys);
    for (const g of graphs) {
      if (b.all) for (const aud of subsets(keys).filter((x) => x.length <= (b.auditMax ?? keys.length))) { counts.graphs++; counts.cases += checkGraph(keys, g, new Set(aud), [new Set(), ...subsets(aud).filter((x) => x.length).map((x) => new Set(x))]); }
      else {
        const aud = new Set(keys.slice(0, -1)); counts.graphs++;
        counts.cases += checkGraph(keys, g, aud, subsets([...aud]).map((x) => new Set(x)));
        if (!b.seedsAll) counts.cases += checkGraph(keys, g, new Set(keys), [new Set(), ...keys.map((k) => new Set([k])), new Set(keys)]);
      }
    }
  }
  return counts;
}
// Every directed graph WITHOUT self-links on `keys`, one per isomorphism class (the representative with the smallest edge mask over all
// relabelings). 9608 classes for 5 nodes. Relabeling only changes key order, which n<=4 covers with every labeling.
function loopless(keys: string[]): Generator<Pair[]> {
  const n = keys.length, pairs: Array<[number, number]> = [];
  for (let c = 0; c < n; c++) for (let p = 0; p < n; p++) if (c !== p) pairs.push([c, p]);
  const bit = new Map(pairs.map(([c, p], i) => [c * n + p, i])), perms: number[][] = [];
  const perm = (a: number[], rest: number[]): void => { if (!rest.length) perms.push(a); for (const x of rest) perm([...a, x], rest.filter((y) => y !== x)); };
  perm([], [...Array(n).keys()]);
  // per permutation, byte tables mapping 8 mask bits at a time
  const tables = perms.map((pm) => [0, 8, 16, 24].filter((o) => o < pairs.length).map((o) => { const t = new Int32Array(256); for (let v = 0; v < 256; v++) { let r = 0; for (let j = 0; j < 8 && o + j < pairs.length; j++) if (v & (1 << j)) { const [c, p] = pairs[o + j]; r |= 1 << (bit.get(pm[c] * n + pm[p]) as number); /* every ordered pair of distinct nodes is in `bit` */ } t[v] = r; } return { o, t }; }));
  return (function* () {
    for (let m = 0; m < 1 << pairs.length; m++) {
      let rep = true;
      for (const tb of tables) { let x = 0; for (const { o, t } of tb) x |= t[(m >>> o) & 255]; if (x < m) { rep = false; break; } }
      if (rep) yield pairs.filter((_, i) => m & (1 << i)).map(([c, p]): Pair => [keys[c], keys[p]]);
    }
  })();
}
