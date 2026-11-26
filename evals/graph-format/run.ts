// Runner and ruling for the 0.4.0 graph answer-format benchmark (task 7B). `runFormats` is LIVE and refuses without EVAL_LIVE=1; `rule` is pure.
import { spawnSync } from 'node:child_process';
import { questions } from './questions.ts';
import { wilson, estTokens } from './report.ts';
import type { Result } from './report.ts';

/** The format with the best Wilson lower bound wins; within 0.005 of it, fewer mean tokens win. No rows means no winner. */
export function rule(rows: Result[]): { winner: string | null; reason: string } {
  const formats = [...new Set(rows.map((r) => r.format))].sort();
  if (formats.length === 0) return { winner: null, reason: 'no results' };
  const stats = formats.map((f) => {
    const r = rows.filter((x) => x.format === f);
    return { f, lo: wilson(r.filter((x) => x.correct).length, r.length)[0], tokens: r.reduce((s, x) => s + x.tokens, 0) / r.length };
  });
  const best = Math.max(...stats.map((s) => s.lo));
  const pick = stats.filter((s) => best - s.lo <= 0.005).sort((a, b) => a.tokens - b.tokens || a.f.localeCompare(b.f))[0];
  return { winner: pick?.f ?? null, reason: `lower bound ${pick?.lo.toFixed(3)}, mean tokens ${pick?.tokens.toFixed(1)}` };
}

/** LIVE. For each question and format, run the golden command with `--format <name>` appended, hand the output to the model through `ask`, and score the reply. */
export function runFormats(formats: string[], cwd: string, ask: (text: string, output: string) => { reply: string; calls: number }): Result[] {
  if (process.env.EVAL_LIVE !== '1') throw new Error('live run refused: set EVAL_LIVE=1');
  const out: Result[] = [];
  for (const q of questions()) for (const format of formats) {
    const p = spawnSync('plangraph', [...q.golden, '--format', format], { cwd, encoding: 'utf8' });
    const a = ask(q.text, p.stdout);
    out.push({ id: q.id, format, correct: a.reply.split(/[\s,]+/).includes(q.answer) || a.reply.trim() === q.answer, tokens: estTokens(p.stdout), toolCalls: a.calls });
  }
  return out;
}
