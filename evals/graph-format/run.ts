// Runner and ruling for the 0.4.0 graph answer-format benchmark (task 7B). `rule` is pure.
import { wilson } from './report.ts';
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
