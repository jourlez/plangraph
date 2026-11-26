// Timing helpers (Task 21A). The size-axis rule: a timing assertion compares two runs of the same code at input sizes n and 4n, measured
// in the same process, never an absolute number of milliseconds, so a slow or busy machine slows both runs alike and the ratio holds.
// Only timing files (test/*-timing.test.ts) may call scaling(); the deterministic workScaling() and builtinWork() below need no clock.
// PLANGRAPH_PERF_FACTOR multiplies the allowed ratio (default 1) for an unusually noisy machine.
export const factor = (): number => { const f = Number(process.env.PLANGRAPH_PERF_FACTOR); return Number.isFinite(f) && f > 0 ? f : 1; };
// Relative complexity check: time fn(n) and fn(4n), each min of `reps`. Linear => ~4x; quadratic => ~16x.
// `maxRatio` default 9 sits between them; sizes must be big enough that noise is small against the run time.
export interface Scaling { small: number; large: number; ratio: number; maxRatio: number }
// `now` is the clock (milliseconds; default performance.now): a test injects a fake one to prove the check itself. The returned maxRatio
// already includes PLANGRAPH_PERF_FACTOR, so callers compare ratio < maxRatio.
export function scaling(fn: (n: number) => unknown, n: number, { reps = 3, maxRatio = 9, attempts = 3, now = () => performance.now() }: { reps?: number; maxRatio?: number; attempts?: number; now?: () => number } = {}): Scaling {
  maxRatio *= factor();
  // Timing noise (GC, a busy runner) can inflate one measurement; a genuinely super-linear function is slow in EVERY attempt, so the best attempt is reported.
  const time = (m: number) => { let best = Infinity; for (let k = 0; k < reps; k++) { const t = now(); fn(m); best = Math.min(best, now() - t); } return best; };
  fn(Math.max(1, n >> 2)); // warm-up
  let best: Scaling | null = null;
  for (let i = 0; i < attempts; i++) {
    const a = time(n), b = time(4 * n), r = { small: a, large: b, ratio: b / Math.max(a, 0.05), maxRatio };
    if (!best || r.ratio < best.ratio) best = r;
    if (best.ratio < maxRatio) break;
  }
  return best as Scaling; // attempts is at least 1 in every caller, so the loop ran
}

// Deterministic complexity check (no clock): count the elements that common Array and String built-ins touch while fn runs (its promise
// included), then compare fn(n) with fn(4n). The same input gives the same count on every machine and under any load, so a quadratic
// mutant fails it the same way on a fast runner and a slow laptop. Node's own internals call the built-ins through primordials (copies
// taken at start-up), so they are not counted. Weights: an array call counts this.length (slice: the slice length); a string indexOf or
// includes counts the characters from the start offset to the end, slice the slice length, every other listed string call this.length.
// NOT covered: work in hand-written loops or in built-ins outside the lists (scaling() above still times the whole path).
const ARRAY_CALLS = ['concat', 'every', 'filter', 'find', 'findIndex', 'flatMap', 'forEach', 'includes', 'indexOf', 'join', 'map', 'reduce', 'slice', 'some'] as const;
const STRING_CALLS = ['includes', 'indexOf', 'match', 'matchAll', 'replace', 'replaceAll', 'search', 'slice', 'split'] as const;
type AnyFn = (this: unknown, ...a: unknown[]) => unknown;
export async function builtinWork(fn: () => unknown): Promise<number> {
  let work = 0;
  const saved: Array<[object, string, AnyFn]> = [];
  const wrap = (proto: object, name: string, weigh: (self: { length: number }, args: unknown[], out: unknown) => number) => {
    const orig = (proto as Record<string, AnyFn>)[name] as AnyFn;
    saved.push([proto, name, orig]);
    Object.defineProperty(proto, name, { configurable: true, writable: true, enumerable: false, value: function (this: { length: number }, ...args: unknown[]) {
      const out = orig.apply(this, args);
      work += weigh(this, args, out);
      return out;
    } });
  };
  const len = (x: unknown) => (x as { length?: number }).length ?? 0;
  for (const name of ARRAY_CALLS) wrap(Array.prototype, name, (self, _a, out) => (name === 'slice' ? len(out) : self.length));
  for (const name of STRING_CALLS) wrap(String.prototype, name, (self, args, out) => {
    if (name === 'slice') return len(out);
    if (name === 'indexOf' || name === 'includes') return Math.max(0, self.length - Math.max(0, Math.trunc(Number(args[1] ?? 0)) || 0));
    return self.length;
  });
  try { await fn(); } finally { for (const [proto, name, orig] of saved.reverse()) Object.defineProperty(proto, name, { configurable: true, writable: true, enumerable: false, value: orig }); }
  return work;
}
export interface WorkScaling { small: number; large: number; ratio: number; maxRatio: number }
/** builtinWork of fn(n) and fn(4n) (after one fn(n) warm-up, so lazy one-time work is left out): linear => ~4x or less, quadratic => ~16x. */
export async function workScaling(fn: (n: number) => unknown, n: number, { maxRatio = 9 } = {}): Promise<WorkScaling> {
  await fn(n);
  const small = await builtinWork(() => fn(n)), large = await builtinWork(() => fn(4 * n));
  return { small, large, ratio: large / Math.max(small, 1), maxRatio };
}
