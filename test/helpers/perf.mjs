// Load-tolerant timing helpers. A fixed deterministic CPU loop is timed (min of 3) and compared with the idle
// reference; budget(ms) scales an absolute bound by that ratio, so a busy machine gets proportionally more time.
// BRAIN_PERF_FACTOR multiplies on top. Hard cap keeps a real hang/blow-up failing.
const REF_MS = 15; // idle reference for one calibration loop on the dev machine
const CAP = 20;
const loop = () => { let x = 1; for (let i = 0; i < 1.6e7; i++) x = (Math.imul(x, 1664525) + 1013904223) | 0; return x; };
export function baselineMs() {
  let best = Infinity;
  for (let k = 0; k < 3; k++) { const t = performance.now(); loop(); best = Math.min(best, performance.now() - t); }
  return best;
}
export const factor = () => { const f = Number(process.env.BRAIN_PERF_FACTOR); return Number.isFinite(f) && f > 0 ? f : 1; };
export const ratio = () => Math.min(CAP, Math.max(1, baselineMs() / REF_MS));
export const budget = (/** @type {number} */ ms) => Math.round(ms * ratio() * factor());
// Relative complexity check: time fn(n) and fn(4n), each min of `reps`. Linear => ~4x; quadratic => ~16x.
// `maxRatio` default 9 sits between them; sizes must be big enough that noise is small against the run time.
/** @param {(n: number) => unknown} fn @param {number} n @param {{ reps?: number, maxRatio?: number, attempts?: number }} [opts] */
export function scaling(fn, n, { reps = 3, maxRatio = 9, attempts = 3 } = {}) {
  // Timing noise (GC, a busy runner) can inflate one measurement; a genuinely super-linear function is slow in EVERY attempt, so the best attempt is reported.
  const time = (/** @type {number} */ m) => { let best = Infinity; for (let k = 0; k < reps; k++) { const t = performance.now(); fn(m); best = Math.min(best, performance.now() - t); } return best; };
  fn(Math.max(1, n >> 2)); // warm-up
  let best = null;
  for (let i = 0; i < attempts; i++) {
    const a = time(n), b = time(4 * n), r = { small: a, large: b, ratio: b / Math.max(a, 0.05), maxRatio };
    if (!best || r.ratio < best.ratio) best = r;
    if (best.ratio < maxRatio) break;
  }
  return best;
}
