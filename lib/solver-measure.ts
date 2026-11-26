// Pure helpers of the solver measurement (amendment 3.14 item 3): exact dominance weights for folding lexicographic stages into one
// objective, and the keep rule that compares two variants run on the same instances and seeds.

/** Weights that make a weighted sum equal the lexicographic order: stage i's weight exceeds the largest possible total of every later stage.
 * `ranges[i]` is the largest value stage i can take minus its smallest (non-negative integers, first stage = most important). */
export function dominanceWeights(ranges: readonly number[]): number[] {
  const w = new Array<number>(ranges.length).fill(1);
  for (let i = ranges.length - 2; i >= 0; i--) {
    const nx = ranges[i + 1] as number;
    if (!(nx >= 0) || !Number.isInteger(nx)) throw new RangeError(`stage range ${i + 1} must be a non-negative integer`);
    w[i] = (w[i + 1] as number) * (nx + 1);
  }
  if (w.some((x) => !Number.isSafeInteger(x))) throw new RangeError('dominance weights exceed the safe integer range');
  return w;
}

/** One solver run of a variant. objectives = the stage values in stage order, verified = the verify command accepted the schedule. */
export interface Run { seed: number; wallS: number; objectives: readonly number[]; verified: boolean }
export interface Verdict { keep: boolean; reason: string; medianBase: number; medianVariant: number }

const median = (a: readonly number[]): number => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2; };

/** Keep the variant only if, on every seed, it verifies and its objectives equal the baseline's, and its median wall time is lower. */
export function keepVariant(base: readonly Run[], variant: readonly Run[]): Verdict {
  const mb = base.length ? median(base.map((r) => r.wallS)) : NaN, mv = variant.length ? median(variant.map((r) => r.wallS)) : NaN;
  const out = (keep: boolean, reason: string): Verdict => ({ keep, reason, medianBase: mb, medianVariant: mv });
  if (!base.length || base.length !== variant.length) return out(false, 'runs missing: need the same seeds for both variants');
  for (const b of base) {
    const v = variant.find((x) => x.seed === b.seed);
    if (!v) return out(false, `seed ${b.seed} missing from the variant`);
    if (!v.verified || !b.verified) return out(false, `seed ${b.seed}: a schedule failed verify`);
    if (v.objectives.length !== b.objectives.length || v.objectives.some((x, i) => x !== (b.objectives[i] as number))) return out(false, `seed ${b.seed}: objectives differ`);
  }
  return mv < mb ? out(true, 'same results, faster') : out(false, 'not faster');
}

/** Structured neighborhoods win only when they beat random ones on the end-to-end objective in a majority of seeds (5 seeds in the spec). */
export function neighborhoodWins(structured: readonly number[], random: readonly number[]): boolean {
  if (!structured.length || structured.length !== random.length) return false;
  let w = 0, l = 0; structured.forEach((s, i) => { const q = random[i] as number; if (s < q) w++; else if (s > q) l++; });
  return w > l && w * 2 > structured.length;
}
