// Cost estimate for an eval run, BEFORE spending anything. Pure arithmetic over the cases, with every assumption named here.
// projectTokens(case, bound) projects one agent run from the case's own numbers (its prompt length, its max_turns cap, its fixture size):
// context at turn t = base + prompt + (t-1) * growth; each new increment is written to the prompt cache once and read on later turns.
//   low  bound: min(3, max_turns) turns, small tool results (the plugin's bounded answers)
//   high bound: every run uses all max_turns, large tool results (an agent reading big JSONL files: the bare arm's worst case)
// Native `claude plugin eval` cases carry no per-run dollar cap (only max_turns and timeout_seconds), so the suite-wide
// --max-cost-usd is the hard stop (checked before each run launches; overrun bounded by the runs in flight).
// Prices: USD per million tokens from the Claude API model table (cached 2026-11-03); cache writes assumed 1.25x input, cache reads as
// listed. These are list prices, not your bill. UNVERIFIED against a real run: the first paid run's aggregate-result.json costUsd is the
// number to trust; re-estimate from it.
export interface Price { in: number; out: number; read: number; write: number }
export type Bound = 'lo' | 'hi';
export type Arm = 'with' | 'without';
export interface CostCase { prompt: string; limits: { max_turns: number }; fixture: { size: string }; graders: Array<{ type?: string; arm?: string }> }
export interface Pass<C extends CostCase = CostCase> { name: string; cases: C[]; arms: Arm[] }
export interface Estimate { passes: Array<{ name: string; cases?: number; runs?: number; lo: number; hi: number }>; lo: number; hi: number; runsTotal: number }
export const PRICES: Record<string, Price> = {
  'claude-sonnet-5-5': { in: 2, out: 10, read: 0.1, write: 2.5 },
  'claude-opus-5-5': { in: 4, out: 20, read: 0.2, write: 5 },
  'claude-haiku-5-5': { in: 0.1, out: 0.5, read: 0.01, write: 0.125 },
};
export const ASSUME = {
  base: { with: 24000, without: 20000 }, // system prompt + tool schemas (+ skill listing and session card in the plugin arm)
  growth: { lo: { S: 600, M: 900, L: 1200, R: 1500 }, hi: { S: 4000, M: 10000, L: 18000, R: 22000 } },
  turnsLo: 3,
  out: { lo: 250, hi: 1500 },
  judge: { tokens: 15000, votes: 3 }, // an llm grader reads the final message (or trace) and votes 2-of-3
};
const est = (s: unknown) => Math.ceil(String(s).length / 4);

export function projectTokens(c: CostCase, bound: Bound | string, arm: Arm = 'with') {
  const T = bound === 'lo' ? Math.min(ASSUME.turnsLo, c.limits.max_turns) : c.limits.max_turns;
  const g = ASSUME.growth[bound as Bound][c.fixture.size as 'S'], b = ASSUME.base[arm] + est(c.prompt); // as Bound / as 'S': the bound is lo or hi, the size one of the four keys (validateCase)
  const total = T * b + (g * T * (T - 1)) / 2, write = b + (T - 1) * g;
  return { turns: T, input: total, write, read: total - write, output: T * ASSUME.out[bound as Bound] }; // as Bound: lo or hi
}
const usd = (t: { write: number; read: number; output: number }, p: Price) => (t.write * p.write + t.read * p.read + t.output * p.out) / 1e6;

// passes: [{ name, cases, arms: ['with','without'] | ['with'] }]. Returns per-pass and total {lo, hi} in USD.
export function estimate(passes: Pass[], { runs, model, judgeModel }: { runs: number; model: string; judgeModel: string }): Estimate | null {
  const p = PRICES[model], pj = PRICES[judgeModel];
  if (!p || !pj) return null;
  const out: Estimate = { passes: [], lo: 0, hi: 0, runsTotal: 0 };
  for (const pass of passes) {
    let lo = 0, hi = 0, n = 0;
    for (const c of pass.cases) for (const arm of pass.arms) {
      lo += usd(projectTokens(c, 'lo', arm), p) * runs; hi += usd(projectTokens(c, 'hi', arm), p) * runs; n += runs;
      const judges = c.graders.filter((g) => g.type === 'llm' && (arm === 'with' || g.arm === 'both')).length;
      const j = (judges * runs * ASSUME.judge.votes * ASSUME.judge.tokens * pj.in) / 1e6;
      lo += j; hi += j;
    }
    out.passes.push({ name: pass.name, cases: pass.cases.length, runs: n, lo, hi });
    out.lo += lo; out.hi += hi; out.runsTotal += n;
  }
  return out;
}
// A budget suggestion between the bounds (geometric mean, rounded up to 5 USD): enough for typical runs, with the hard cap as the stop.
export const suggestBudget = (e: { lo: number; hi: number }) => Math.max(5, Math.ceil(Math.sqrt(Math.max(e.lo, 0.01) * Math.max(e.hi, 0.01)) / 5) * 5);
