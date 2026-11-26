// Expanding-window replay and Monte Carlo interval (amendment 3.14 item 7). Pure, no I/O: the caller passes the exported history.
// When the history is missing or too short the functions say so (ok: false, reason); they never invent data.
import { listSchedule } from './heuristic.ts';
import type { HItem } from './heuristic.ts';

/** A completed ticket: the sprint it was actually done in, its points, owner and producers. */
export interface Done { key: string; sprint: number; sp: number; owner: string; deps: readonly string[] }
/** A planner: from the tickets finished before sprint `from` (known) and the rest (open), a predicted sprint per open key. */
export type Planner = (known: readonly Done[], open: readonly Done[], from: number) => Map<string, number>;
export interface Window { from: number; n: number; hits: number; within1: number }
export type Replay = { ok: false; reason: string } | { ok: true; windows: Window[]; n: number; hits: number; hitRate: number; within1Rate: number };

/** Default planner: capacity per owner = the most points that owner finished in one past sprint; list scheduling from sprint `from`. */
export const heuristicPlanner: Planner = (known, open, from) => {
  const per = new Map<string, number>();
  const sums = new Map<string, number>();
  for (const k of known) sums.set(`${k.owner}|${k.sprint}`, (sums.get(`${k.owner}|${k.sprint}`) ?? 0) + k.sp);
  for (const [id, v] of sums) { const o = id.slice(0, id.lastIndexOf('|')); per.set(o, Math.max(per.get(o) ?? 0, v)); }
  const cap: Record<string, number> = {};
  for (const o of new Set(open.map((t) => t.owner))) cap[o] = Math.max(per.get(o) ?? 0, 1);
  const keys = new Set(open.map((t) => t.key));
  const items: HItem[] = open.map((t) => ({ key: t.key, owner: t.owner, sp: t.sp, deps: t.deps.filter((d) => keys.has(d)) }));
  return listSchedule(items, { first: from, cap }).sprint;
};

/** Expanding-window replay: for each sprint s (after minTrain completed sprints) plan every ticket not done before s with the data
 * before s, then compare the predicted sprint with the actual one per ticket. */
export function replay(done: readonly Done[], opts: { minTrain?: number; planner?: Planner } = {}): Replay {
  const minTrain = opts.minTrain ?? 3; const plan = opts.planner ?? heuristicPlanner;
  const sprints = [...new Set(done.map((d) => d.sprint))].sort((a, b) => a - b);
  if (sprints.length <= minTrain) return { ok: false, reason: `history has ${sprints.length} completed sprints, need more than ${minTrain}` };
  const windows: Window[] = [];
  for (const s of sprints.slice(minTrain)) {
    const known = done.filter((d) => d.sprint < s); const open = done.filter((d) => d.sprint >= s);
    const pred = plan(known, open, s); let hits = 0, within1 = 0;
    for (const t of open) { const p = pred.get(t.key); if (p === t.sprint) hits++; if (p !== undefined && Math.abs(p - t.sprint) <= 1) within1++; }
    windows.push({ from: s, n: open.length, hits, within1 });
  }
  const n = windows.reduce((a, w) => a + w.n, 0), hits = windows.reduce((a, w) => a + w.hits, 0), w1 = windows.reduce((a, w) => a + w.within1, 0);
  return { ok: true, windows, n, hits, hitRate: n ? hits / n : 0, within1Rate: n ? w1 / n : 0 };
}

/** Seeded generator (mulberry32). */
export function rng32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export type Interval = { ok: false; reason: string } | { ok: true; runs: number; p10: number; p50: number; p90: number; neverDone: number };

/** Monte Carlo: resample the historical per-sprint throughput (points done per sprint) until `remaining` points are done; the answer is the
 * number of sprints needed, as percentiles. Runs that do not finish within the horizon count as never done and rank last. */
export function monteCarlo(throughput: readonly number[], remaining: number, opts: { runs?: number; seed?: number; horizon?: number } = {}): Interval {
  const hist = throughput.filter((x) => Number.isFinite(x) && x >= 0);
  if (!hist.length) return { ok: false, reason: 'no throughput history: nothing to resample' };
  if (!hist.some((x) => x > 0)) return { ok: false, reason: 'throughput history is all zero' };
  if (!(remaining >= 0)) return { ok: false, reason: 'remaining points must be a non-negative number' };
  const runs = opts.runs ?? 1000, horizon = opts.horizon ?? 520, r = rng32(opts.seed ?? 1);
  const out: number[] = []; let never = 0;
  for (let i = 0; i < runs; i++) {
    let left = remaining, n = 0;
    while (left > 0 && n < horizon) { left -= hist[Math.floor(r() * hist.length)]; n++; }
    if (left > 0) { never++; out.push(Infinity); } else out.push(n);
  }
  out.sort((a, b) => a - b);
  const q = (p: number) => out[Math.min(runs - 1, Math.floor(p * runs))];
  return { ok: true, runs, p10: q(0.1), p50: q(0.5), p90: q(0.9), neverDone: never };
}

/** Points done per sprint, from completed tickets (sprints with no completion count as 0 between the first and last). */
export function throughputOf(done: readonly Done[]): number[] {
  if (!done.length) return [];
  const lo = Math.min(...done.map((d) => d.sprint)), hi = Math.max(...done.map((d) => d.sprint));
  const arr = new Array<number>(hi - lo + 1).fill(0);
  for (const d of done) arr[d.sprint - lo] += d.sp;
  return arr;
}
