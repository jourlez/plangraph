// Report helpers: Wilson interval, token estimate, answer budget. No model call lives in this directory; a runner feeds `Result` rows.
export type Result = { id: string; format: string; correct: boolean; tokens: number; toolCalls: number };

export function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 1];
  const p = k / n, d = 1 + (z * z) / n, c = p + (z * z) / (2 * n), m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)];
}

export const estTokens = (s: string): number => Math.ceil(s.length / 4);
export const ANSWER_BUDGET_TOKENS = 250; // the per-answer budget of `plangraph graph`

export function summarize(rows: Result[]): string {
  const formats = [...new Set(rows.map((r) => r.format))].sort();
  return formats.map((f) => {
    const r = rows.filter((x) => x.format === f), k = r.filter((x) => x.correct).length, [lo, hi] = wilson(k, r.length);
    const mean = (g: (x: Result) => number) => (r.reduce((s, x) => s + g(x), 0) / r.length).toFixed(1);
    return `${f}: ${k}/${r.length} correct (95% ${lo.toFixed(2)}-${hi.toFixed(2)}), tokens ${mean((x) => x.tokens)}, tool calls ${mean((x) => x.toolCalls)}`;
  }).join('\n');
}
