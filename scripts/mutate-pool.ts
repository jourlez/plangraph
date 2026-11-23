// Bounded worker pool for scripts/mutate.ts: runs fn over items with at most `jobs` calls in flight and returns the results in input order,
// so the report does not depend on which mutant finished first. Worker w (0 <= w < jobs) runs one item at a time, which lets each worker own
// one repository copy. The first error stops new work and rejects (calls already in flight are left to finish).

/**
 * @template T, R
 * @param {T[]} items @param {number} jobs @param {(item: T, index: number, worker: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
export async function pool<T, R>(items: T[], jobs: number, fn: (item: T, index: number, worker: number) => Promise<R>): Promise<R[]> {
  const n = Math.max(1, Math.min(Math.trunc(jobs) || 1, items.length));
  /** @type {R[]} */ const out = new Array(items.length);
  let next = 0, failed = false;
  await Promise.all(Array.from({ length: items.length ? n : 0 }, async (_, w) => {
    while (!failed && next < items.length) {
      const k = next++;
      try { out[k] = await fn(items[k], k, w); } catch (e) { failed = true; throw e; }
    }
  }));
  return out;
}

/** `--jobs N` from argv (a positive integer), else `dflt`. @param {string[]} argv @param {number} dflt @returns {number} */
export function parseJobs(argv: string[], dflt: number): number {
  const k = argv.indexOf('--jobs');
  if (k < 0) return dflt;
  const v = argv[k + 1];
  if (v === undefined || !/^[1-9]\d*$/.test(v)) throw new Error(`--jobs needs a positive integer, got ${JSON.stringify(v ?? null)}`);
  return Number(v);
}
