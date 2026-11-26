// Analysis: forecast (history-based delivery forecast) and simulate (Monte Carlo of the plan with noisy ticket sizes).
import fs from 'node:fs';
import path from 'node:path';
import { readCapped } from '../../lib/jsonl.ts';
import { oneLine } from '../../lib/sanitize.ts';
import { STALE_WARNING } from '../context.ts';
import { CUR, MAX_DATA, capOf, dbFile, verbose, dataError, modelFromDb } from './shared.ts';
import type { Ctx, Args } from '../context.ts';
import type { CommandMap } from '../registry.ts';
import type { Dense } from './shared.ts';
/** The columns each SELECT below names, as the index stores them. */
interface PlaceRow { key: string; owner: string; sprint: number }

// forecast's freshness keeps what bin/plangraph's forecast checked: besides the source fingerprint (ctx.db()), an open-items.jsonl newer
// than the index (1 s slack) makes the answer STALE too. Only one warning is printed either way.
const SLACK_MS = 1000;
function openItemsNewer(ctx: Ctx): boolean {
  try { return fs.statSync(path.join(ctx.dir, 'open-items.jsonl')).mtimeMs > fs.statSync(dbFile(ctx)).mtimeMs + SLACK_MS; } catch { return false; }
}

async function forecast(ctx: Ctx, args: Args<{ seed?: number }>): Promise<number> {
  const F = await import('../../lib/forecast.ts');
  const rd = (n: string) => { const f = path.join(ctx.dir, n); return fs.existsSync(f) ? readCapped(f, MAX_DATA) : ''; };
  const H = F.parseHistory(rd('history.jsonl')), A = F.parseActuals(rd('actuals.jsonl'));
  for (const e of [...H.errors.map((x) => `history.jsonl ${x}`), ...A.errors.map((x) => `actuals.jsonl ${x}`)]) ctx.io.err(e);
  const model = modelFromDb(ctx);
  if (!ctx.db().stale && !ctx.flags['if-present'] && openItemsNewer(ctx)) ctx.io.err(STALE_WARNING);
  const r = F.forecast({ history: H.records, actuals: A.rows, model, config: ctx.config(), seed: args.values.seed ?? 1, sprints: ctx.db().all('SELECT n,"end" AS "end" FROM sprint') as Array<{ n: number; end: unknown }> });
  ctx.io.out(r.text);
  if (verbose(args)) for (const w of H.warnings) ctx.io.out(`note: ${w}`);
  return 0;
}

// ---- risk simulation: owners fixed, people follow the plan, noisy ticket sizes, strict handoff rule ----
function simulate(ctx: Ctx, args: Args<{ runs?: number; sigma?: number; limit?: number; seed?: number }>): number {
  const d = ctx.db(), cfg = ctx.config(), v = args.values, skip = new Set<unknown>(cfg.ignore_link_kinds || []), out = ctx.io.out;
  const runs = v.runs ?? 500, sigma = v.sigma ?? 0.35; let seed = (v.seed ?? 1) >>> 0;
  const rnd = () => { seed = (seed + 0x6D2B79F5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
  const sp = new Map((d.all('SELECT key,sp FROM ticket') as Array<{ key: string; sp: number | null }>).map((r) => [r.key, r.sp])); // the columns this SELECT names; sp may be NULL
  // a schedule row naming a key with no ticket (UNKNOWN_TICKET in `plangraph check`) has no size: it is left out, with one warning line
  const placed = d.all(`SELECT key,owner,sprint FROM schedule WHERE ${CUR}`) as PlaceRow[], ghosts = placed.filter((r) => !sp.has(r.key)).map((r) => r.key);
  if (ghosts.length) ctx.io.err(`warning: simulate skips ${ghosts.length} schedule row(s) with no ticket: ${ghosts.slice(0, 10).map((k) => oneLine(k, 80)).join(', ')}${ghosts.length > 10 ? ', ...' : ''} (run \`plangraph check\`)`);
  const sch = new Map(placed.filter((r) => sp.has(r.key)).map((r) => [r.key, r])) as Dense<string, PlaceRow>; // read only with its own keys
  const prod = (new Map([...sch.keys()].map((k) => [k, []])) as Dense<string, string[]>); // one list per scheduled key
  for (const e of d.all('SELECT consumer,producer,kind FROM edge') as Array<{ consumer: string; producer: string; kind: string }>) if (!skip.has(e.kind) && sch.has(e.consumer) && sch.has(e.producer)) prod.get(e.consumer).push(e.producer); // the columns this SELECT names
  const cons = (new Map([...sch.keys()].map((k) => [k, []])) as Dense<string, string[]>); for (const [c, ps] of prod) for (const p of ps) cons.get(p).push(c); // one list per scheduled key
  const left = (new Map([...prod].map(([k, ps]) => [k, ps.length])) as Dense<string, number>), order = ([] as string[]); // one count per scheduled key
  const bySprint = (a: string, b: string) => sch.get(a).sprint - sch.get(b).sprint || (a < b ? -1 : 1);
  const ready = [...sch.keys()].filter((k) => left.get(k) === 0).sort(bySprint);
  while (ready.length) { const k = ready.shift() as string; order.push(k); for (const c of cons.get(k)) { left.set(c, left.get(c) - 1); if (!left.get(c)) { ready.push(c); ready.sort(bySprint); } } } // ready is not empty inside the loop
  if (order.length !== sch.size) throw dataError('links contain a loop', 'run `plangraph check`');
  const planned = [...sch.values()].reduce((m, s) => Math.max(m, s.sprint), -Infinity), limit = v.limit ?? (cfg.end_sprint || planned) + 2;
  const once = (noise: boolean) => {
    const used = (new Map() as Map<string, number>), at = (new Map() as Dense<string, number>); let last = 0; // at: producers come first in order
    for (const k of order) {
      const o = sch.get(k).owner; let s = sch.get(k).sprint;
      for (const p of prod.get(k)) { const q = at.get(p); s = Math.max(s, sch.get(p).owner === o ? q : q + 1); }
      const size = noise ? (sp.get(k) as number) * Math.exp(sigma * gauss() - (sigma * sigma) / 2) : (sp.get(k) as number), cap = capOf(cfg, o); // every key in sch has a ticket (filtered above); a NULL sp counts as size 0
      while ((used.get(`${o}|${s}`) || 0) > 0 && (used.get(`${o}|${s}`) || 0) + size > cap) s++;
      used.set(`${o}|${s}`, (used.get(`${o}|${s}`) || 0) + size); at.set(k, s); if (s > last) last = s;
    }
    return last;
  };
  const base = once(false);
  const ends = Array.from({ length: runs }, () => once(true)).sort((a, b) => a - b), pct = (p: number) => ends[Math.min(runs - 1, Math.floor((p / 100) * runs))];
  const prob = (n: number) => `${((ends.filter((e) => e <= n).length / runs) * 100).toFixed(0)}%`;
  out(`baseline with exact sizes: ends sprint ${base} (planned ${planned}) ${base <= planned ? '[reproduces the plan]' : '[WARNING: baseline later than the plan; the model is stricter than the plan]'}`);
  out(`${runs} runs, lognormal noise sigma ${sigma} on ticket size (an assumption, not a measurement; mean-preserving):`);
  out(`end sprint P50 ${pct(50)} | P80 ${pct(80)} | P90 ${pct(90)} | P95 ${pct(95)} | worst ${ends[runs - 1]}`);
  out(`probability of finishing by sprint ${planned}: ${prob(planned)} | by ${planned + 1}: ${prob(planned + 1)} | by the limit ${limit}: ${prob(limit)}`);
  return 0;
}

export const commands: CommandMap = {
  forecast: { run: forecast, positionals: [0, 0], options: { seed: { type: 'integer' } }, summary: 'honest delivery forecast from history.jsonl (and actuals.jsonl); refuses on thin history' },
  simulate: {
    run: simulate, positionals: [0, 0], summary: 'risk: Monte Carlo of the plan with noisy ticket sizes',
    options: { runs: { type: 'integer', min: 1, max: 100000 }, sigma: { type: 'number', min: 0, max: 5 }, limit: { type: 'integer', min: 0, max: 100000 }, seed: { type: 'integer' } },
  },
};
