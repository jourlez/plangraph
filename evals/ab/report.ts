// Summaries and report for the A/B benchmark: Wilson 95 percent intervals, nearest-rank percentiles, token calibration. No model call.
import { wilson } from '../graph-format/report.ts';

export { wilson };
export type Arm = { name: string; family: 'graph' | 'coding'; plugin: boolean; tools: string[] };
/** baseline = plugin off with Read, Grep, Bash only; graph = plugin on; plugin-default vs plugin-off compare default injections on coding tasks. */
export const ARMS: Arm[] = [
  { name: 'baseline', family: 'graph', plugin: false, tools: ['Read', 'Grep', 'Bash'] },
  { name: 'graph', family: 'graph', plugin: true, tools: ['Read', 'Grep', 'Bash'] },
  { name: 'plugin-off', family: 'coding', plugin: false, tools: ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash'] },
  { name: 'plugin-default', family: 'coding', plugin: true, tools: ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash'] },
];

export type Row = { arm: string; model: string; id: string; correct: boolean; tokens: number; calls: number; cost: number };
export type Summary = { arm: string; n: number; accuracy: { p: number; lo: number; hi: number }; tokens: { median: number; p90: number }; calls: { median: number }; cost: { median: number } };

// nearest-rank percentile; 0 for no data
const pct = (xs: number[], q: number): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(q * s.length) - 1)] as number;
};
const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};

export function summarize(rows: Row[]): Summary[] {
  const arms = [...new Set(rows.map((r) => r.arm))].sort();
  return arms.map((arm) => {
    const r = rows.filter((x) => x.arm === arm), k = r.filter((x) => x.correct).length, [lo, hi] = wilson(k, r.length);
    return { arm, n: r.length, accuracy: { p: k / r.length, lo, hi }, tokens: { median: median(r.map((x) => x.tokens)), p90: pct(r.map((x) => x.tokens), 0.9) }, calls: { median: median(r.map((x) => x.calls)) }, cost: { median: median(r.map((x) => x.cost)) } };
  });
}

/** One line per known arm (an arm with no rows prints n=0), then one per other arm found in the rows. */
export function renderReport(rows: Row[]): string {
  const sums = summarize(rows), by = new Map(sums.map((s) => [s.arm, s]));
  const names = [...ARMS.map((a) => a.name), ...sums.map((s) => s.arm).filter((a) => !ARMS.some((x) => x.name === a))];
  return names.map((name) => {
    const s = by.get(name);
    if (!s) return `${name} n=0`;
    return `${name} n=${s.n} acc=${s.accuracy.p.toFixed(2)} (95% ${s.accuracy.lo.toFixed(2)}-${s.accuracy.hi.toFixed(2)}) tokens med=${s.tokens.median} p90=${s.tokens.p90} calls med=${s.calls.median} cost med=$${s.cost.median.toFixed(4)}`;
  }).join('\n');
}

/** Characters per token from count_tokens samples: total characters over total tokens, two decimals. */
export function calibrate(samples: { text: string; tokens: number }[]): number {
  if (samples.length === 0) throw new Error('calibrate: no samples');
  let chars = 0, tokens = 0;
  for (const s of samples) { if (!(s.tokens > 0)) throw new Error('calibrate: tokens must be positive'); chars += s.text.length; tokens += s.tokens; }
  return Math.round((chars / tokens) * 100) / 100;
}
