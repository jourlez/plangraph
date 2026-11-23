// Analysis: forecast (history-based delivery forecast) and simulate (Monte Carlo of the plan with noisy ticket sizes).
import fs from 'node:fs';
import path from 'node:path';
import { readCapped } from '../../lib/jsonl.mjs';
import { STALE_WARNING } from '../context.mjs';
import { CUR, MAX_DATA, capOf, dbFile, verbose, dataError, modelFromDb } from './shared.mjs';
/** @typedef {import('../context.mjs').Context} Ctx @typedef {import('../context.mjs').Args} Args */

// forecast's freshness keeps what bin/brain's forecast checked: besides the source fingerprint (ctx.db()), an open-items.jsonl newer
// than the index (1 s slack) makes the answer STALE too. Only one warning is printed either way.
const SLACK_MS = 1000;
/** @param {Ctx} ctx */
function openItemsNewer(ctx) {
  try { return fs.statSync(path.join(ctx.dir, 'open-items.jsonl')).mtimeMs > fs.statSync(dbFile(ctx)).mtimeMs + SLACK_MS; } catch { return false; }
}

/** @param {Ctx} ctx @param {Args} args */
async function forecast(ctx, args) {
  const F = await import('../../lib/forecast.mjs');
  const rd = (/** @type {string} */ n) => { const f = path.join(ctx.dir, n); return fs.existsSync(f) ? readCapped(f, MAX_DATA) : ''; };
  const H = F.parseHistory(rd('history.jsonl')), A = F.parseActuals(rd('actuals.jsonl'));
  for (const e of [...H.errors.map((x) => `history.jsonl ${x}`), ...A.errors.map((x) => `actuals.jsonl ${x}`)]) ctx.io.err(e);
  const model = modelFromDb(ctx);
  if (!ctx.db().stale && !ctx.flags['if-present'] && openItemsNewer(ctx)) ctx.io.err(STALE_WARNING);
  const r = F.forecast({ history: H.records, actuals: A.rows, model, config: ctx.config(), seed: args.values.seed ?? 1 });
  ctx.io.out(r.text);
  if (verbose(args)) for (const w of H.warnings) ctx.io.out(`note: ${w}`);
  return 0;
}

// ---- risk simulation: owners fixed, people follow the plan, noisy ticket sizes, strict handoff rule ----
/** @param {Ctx} ctx @param {Args} args */
function simulate(ctx, args) {
  const d = ctx.db(), cfg = ctx.config(), v = args.values, skip = new Set(cfg.ignore_link_kinds || []), out = ctx.io.out;
  const runs = v.runs ?? 500, sigma = v.sigma ?? 0.35; let seed = (v.seed ?? 1) >>> 0;
  const rnd = () => { seed = (seed + 0x6D2B79F5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
  const sch = new Map(d.all(`SELECT key,owner,sprint FROM schedule WHERE ${CUR}`).map((r) => [r.key, r]));
  const sp = new Map(d.all('SELECT key,sp FROM ticket').map((r) => [r.key, r.sp]));
  const prod = /** @type {Map<string, any>} */ (new Map([...sch.keys()].map((k) => [k, []])));
  for (const e of d.all('SELECT consumer,producer,kind FROM edge')) if (!skip.has(e.kind) && sch.has(e.consumer) && sch.has(e.producer)) prod.get(e.consumer).push(e.producer);
  const cons = /** @type {Map<string, any>} */ (new Map([...sch.keys()].map((k) => [k, []]))); for (const [c, ps] of prod) for (const p of ps) cons.get(p).push(c);
  const left = /** @type {Map<string, any>} */ (new Map([...prod].map(([k, ps]) => [k, ps.length]))), order = /** @type {string[]} */ ([]);
  const bySprint = (/** @type {string} */ a, /** @type {string} */ b) => sch.get(a).sprint - sch.get(b).sprint || (a < b ? -1 : 1);
  const ready = [...sch.keys()].filter((k) => left.get(k) === 0).sort(bySprint);
  while (ready.length) { const k = ready.shift(); order.push(k); for (const c of cons.get(k)) { left.set(c, left.get(c) - 1); if (!left.get(c)) { ready.push(c); ready.sort(bySprint); } } }
  if (order.length !== sch.size) throw dataError('links contain a loop', 'run `brain check`');
  const planned = [...sch.values()].reduce((m, s) => Math.max(m, s.sprint), -Infinity), limit = v.limit ?? (cfg.end_sprint || planned) + 2;
  const once = (/** @type {boolean} */ noise) => {
    const used = /** @type {Map<string, any>} */ (new Map()), at = /** @type {Map<string, any>} */ (new Map()); let last = 0;
    for (const k of order) {
      const o = sch.get(k).owner; let s = sch.get(k).sprint;
      for (const p of prod.get(k)) { const q = at.get(p); s = Math.max(s, sch.get(p).owner === o ? q : q + 1); }
      const size = noise ? sp.get(k) * Math.exp(sigma * gauss() - (sigma * sigma) / 2) : sp.get(k), cap = capOf(cfg, o);
      while ((used.get(`${o}|${s}`) || 0) > 0 && (used.get(`${o}|${s}`) || 0) + size > cap) s++;
      used.set(`${o}|${s}`, (used.get(`${o}|${s}`) || 0) + size); at.set(k, s); if (s > last) last = s;
    }
    return last;
  };
  const base = once(false);
  const ends = Array.from({ length: runs }, () => once(true)).sort((a, b) => a - b), pct = (/** @type {number} */ p) => ends[Math.min(runs - 1, Math.floor((p / 100) * runs))];
  const prob = (/** @type {number} */ n) => `${((ends.filter((e) => e <= n).length / runs) * 100).toFixed(0)}%`;
  out(`baseline with exact sizes: ends sprint ${base} (planned ${planned}) ${base <= planned ? '[reproduces the plan]' : '[WARNING: baseline later than the plan; the model is stricter than the plan]'}`);
  out(`${runs} runs, lognormal noise sigma ${sigma} on ticket size (an assumption, not a measurement; mean-preserving):`);
  out(`end sprint P50 ${pct(50)} | P80 ${pct(80)} | P90 ${pct(90)} | P95 ${pct(95)} | worst ${ends[runs - 1]}`);
  out(`probability of finishing by sprint ${planned}: ${prob(planned)} | by ${planned + 1}: ${prob(planned + 1)} | by the limit ${limit}: ${prob(limit)}`);
  return 0;
}

export const commands = {
  forecast: { run: forecast, positionals: [0, 0], options: { seed: { type: 'integer' } }, summary: 'honest delivery forecast from history.jsonl (and actuals.jsonl); refuses on thin history' },
  simulate: {
    run: simulate, positionals: [0, 0], summary: 'risk: Monte Carlo of the plan with noisy ticket sizes',
    options: { runs: { type: 'integer', min: 1, max: 100000 }, sigma: { type: 'number', min: 0, max: 5 }, limit: { type: 'integer', min: 0, max: 100000 }, seed: { type: 'integer' } },
  },
};
