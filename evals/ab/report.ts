// Summaries and report for the A/B benchmark: Wilson 95 percent intervals, nearest-rank percentiles, token calibration. No model call.
import { wilson } from '../graph-format/report.ts';

export { wilson };
export type Arm = {
  name: string; family: 'graph' | 'coding'; plugin: boolean; tools: string[];
  /** Plugin hooks (SessionStart card, prompt hook) stay on; only meaningful with `plugin`. */
  hooks: boolean;
  /** The plugin's MCP server is loaded; only meaningful with `plugin`. */
  mcp: boolean;
  /** Not part of the default matrix; named explicitly with --arms. */
  optional?: boolean;
};
const GRAPH_TOOLS = ['Read', 'Grep', 'Bash'], CODING_TOOLS = ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash'];
/**
 * baseline = plugin off with Read, Grep, Bash; graph = plugin on (hooks on, MCP off as in the pilot). Coding: plugin-off; plugin-default = every default injection
 * (hooks and the MCP server); plugin-pull-only = plugin loaded with hooks emptied and MCP off, so the model only sees the skill list. Every arm, plugin or not,
 * is also given Claude Code's own Skill tool (`argvFor`), so the comparison isolates the plugin.
 */
export const ARMS: Arm[] = [
  { name: 'baseline', family: 'graph', plugin: false, tools: GRAPH_TOOLS, hooks: false, mcp: false },
  { name: 'graph', family: 'graph', plugin: true, tools: GRAPH_TOOLS, hooks: true, mcp: false },
  { name: 'plugin-off', family: 'coding', plugin: false, tools: CODING_TOOLS, hooks: false, mcp: false },
  { name: 'plugin-default', family: 'coding', plugin: true, tools: CODING_TOOLS, hooks: true, mcp: true },
  { name: 'plugin-pull-only', family: 'coding', plugin: true, tools: CODING_TOOLS, hooks: false, mcp: false, optional: true },
];

/**
 * One finished run. `firstIn` is the input of the FIRST API call (input + cache creation + cache reads: the fixed prefix is visible there);
 * `tokensIn` and `tokensOut` are the sums over all calls of the run; `tokens` = tokensIn + tokensOut; `ms` is the wall time of the agent run.
 */
export type Row = { arm: string; model: string; id: string; correct: boolean; firstIn: number; tokensIn: number; tokensOut: number; tokens: number; calls: number; cost: number; ms: number };
type Stat = { median: number; p90: number };
export type Summary = {
  arm: string; model?: string; n: number; accuracy: { p: number; lo: number; hi: number };
  firstIn: Stat; tokensIn: Stat; tokensOut: Stat; tokens: Stat; calls: Stat; cost: Stat; ms: Stat;
};

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
const stat = (xs: number[]): Stat => ({ median: median(xs), p90: pct(xs, 0.9) });

function summarizeGroup(arm: string, model: string | undefined, r: Row[]): Summary {
  const k = r.filter((x) => x.correct).length, [lo, hi] = wilson(k, r.length);
  return { arm, ...(model === undefined ? {} : { model }), n: r.length, accuracy: { p: k / r.length, lo, hi }, firstIn: stat(r.map((x) => x.firstIn)), tokensIn: stat(r.map((x) => x.tokensIn)), tokensOut: stat(r.map((x) => x.tokensOut)), tokens: stat(r.map((x) => x.tokens)), calls: stat(r.map((x) => x.calls)), cost: stat(r.map((x) => x.cost)), ms: stat(r.map((x) => x.ms)) };
}

/** One summary per arm (models pooled). */
export function summarize(rows: Row[]): Summary[] {
  return [...new Set(rows.map((r) => r.arm))].sort().map((arm) => summarizeGroup(arm, undefined, rows.filter((x) => x.arm === arm)));
}
/** One summary per (arm, model). */
function summarizeByModel(rows: Row[]): Summary[] {
  const sep = '\u0000', keys = [...new Set(rows.map((r) => `${r.arm}${sep}${r.model}`))].sort();
  return keys.map((k) => { const [arm, model] = k.split(sep) as [string, string]; return summarizeGroup(arm, model, rows.filter((x) => x.arm === arm && x.model === model)); });
}

const f0 = (n: number): string => Math.round(n).toLocaleString('en-US');
const HEAD = ['arm', 'model', 'n', 'accuracy (95% Wilson)', 'first-call in med', 'total in med', 'total out med', 'calls med', 'cost med', 'time med s'];
const line = (cells: string[]): string => `| ${cells.join(' | ')} |`;
const row = (s: Summary): string => line([s.arm, s.model ?? 'all', String(s.n), `${s.accuracy.p.toFixed(2)} (${s.accuracy.lo.toFixed(2)}-${s.accuracy.hi.toFixed(2)})`, f0(s.firstIn.median), f0(s.tokensIn.median), f0(s.tokensOut.median), String(s.calls.median), `$${s.cost.median.toFixed(4)}`, (s.ms.median / 1000).toFixed(1)]);

/**
 * A markdown table: one line per (arm, model) with first-call input tokens (the fixed prefix), total input and output tokens, calls, cost, time and accuracy
 * with a Wilson interval; an arm with several models also gets a pooled `all` line. A default arm with no rows prints n=0 (an optional arm only when it has rows);
 * other arms found in the rows follow.
 */
export function renderReport(rows: Row[]): string {
  const per = summarizeByModel(rows), pooled = summarize(rows);
  const names = [...ARMS.map((a) => a.name), ...pooled.map((s) => s.arm).filter((a) => !ARMS.some((x) => x.name === a))];
  const out = [line(HEAD), line(HEAD.map(() => '---'))];
  for (const name of names) {
    const mine = per.filter((s) => s.arm === name), all = pooled.find((s) => s.arm === name);
    if (!all) { if (!ARMS.find((a) => a.name === name)?.optional) out.push(line([name, '-', '0', 'n=0', '-', '-', '-', '-', '-', '-'])); continue; }
    for (const s of mine) out.push(row(s));
    if (mine.length > 1) out.push(row(all));
  }
  return out.join('\n');
}

/** Characters per token from count_tokens samples: total characters over total tokens, two decimals. */
export function calibrate(samples: { text: string; tokens: number }[]): number {
  if (samples.length === 0) throw new Error('calibrate: no samples');
  let chars = 0, tokens = 0;
  for (const s of samples) { if (!(s.tokens > 0)) throw new Error('calibrate: tokens must be positive'); chars += s.text.length; tokens += s.tokens; }
  return Math.round((chars / tokens) * 100) / 100;
}
