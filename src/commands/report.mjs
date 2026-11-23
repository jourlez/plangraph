// report: generate report.md and report.html from the plan (lib/report.mjs, deterministic). It only writes the two files, atomically and
// confined to the repository; publishing and sharing belong to the Artifact and Slack tools, proposed by the brain-report skill.
// Race left: between the pre-check and the rename another process could swap a target for a symlink; the rename replaces the link itself.
import fs from 'node:fs';
import path from 'node:path';
import { oneLine } from '../../lib/sanitize.mjs';
import { needBrain, usage, dataError, modelFromDb, readItems, loadJiraSnap, precheckTargets, writeState, rel } from './shared.mjs';
/** @typedef {import('../context.mjs').Context} Ctx @typedef {import('../context.mjs').Args} Args */

const DATE = /^\d{4}-\d{2}-\d{2}$/;

// The forecast state is the only part that can fail for thin or odd history; the report then says "not computed" rather than failing.
/** @param {import('../context.mjs').Context} ctx @param {any} model */
async function forecastTag(ctx, model) {
  try {
    const F = await import('../../lib/forecast.mjs'), { readCapped } = await import('../../lib/jsonl.mjs'), { MAX_DATA } = await import('./shared.mjs');
    const rd = (/** @type {string} */ n) => { const f = path.join(ctx.dir, n); return fs.existsSync(f) ? readCapped(f, MAX_DATA) : ''; };
    const H = F.parseHistory(rd('history.jsonl')), A = F.parseActuals(rd('actuals.jsonl'));
    const r = F.forecast({ history: H.records, actuals: A.rows, model, config: ctx.config(), seed: 1 });
    return { state: r.state, n: r.n };
  } catch { return null; }
}
/** @param {Ctx} ctx */
async function staleCount(ctx) {
  try {
    const S = await import('../../lib/stale.mjs'), { loadModel } = await import('../../lib/model.mjs'), cfg = ctx.config(), ref = S.resolveRef(cfg);
    const m = loadModel(ctx.dir, { config: cfg }), deps = S.gitDeps(ctx.root, ref, {});
    const res = S.computeStale(m, m.refs, deps, { ref, heading: cfg.ref_heading, rulesVersion: cfg.brain_rules_version, full: false });
    return { count: res.stale.length, ref: oneLine(ref, 60) };
  } catch { return null; }
}

/** @param {Ctx} ctx @param {Args} args */
async function report(ctx, args) {
  needBrain(ctx);
  const v = args.values, outDir = path.resolve(ctx.root, v.out ?? rel(ctx, ctx.dir));
  if ((v.jira === undefined) !== (v['as-of'] === undefined)) throw usage('--jira and --as-of go together (the snapshot date, YYYY-MM-DD)');
  if (v['as-of'] !== undefined && !DATE.test(v['as-of'])) throw usage('--as-of must be a date like 2026-11-20');
  let st; try { st = fs.statSync(outDir); } catch { st = null; }
  if (!st || !st.isDirectory()) throw dataError('the output directory does not exist', 'create it first, or omit --out');
  const files = [path.join(outDir, 'report.md'), path.join(outDir, 'report.html')];
  precheckTargets(ctx, files);
  const { buildReport } = await import('../../lib/report.mjs'), model = modelFromDb(ctx), { items } = await readItems(ctx);
  const r = buildReport(model, {
    items, statuses: v.jira !== undefined ? await loadJiraSnap(v.jira) : null, jira: v.jira !== undefined ? { date: v['as-of'] } : null,
    forecast: await forecastTag(ctx, model), stale: await staleCount(ctx),
  });
  writeState(ctx, files[0], r.markdown); writeState(ctx, files[1], r.html);
  ctx.io.out(`wrote ${oneLine(rel(ctx, files[0]), 200)} and ${oneLine(rel(ctx, files[1]), 200)} (${r.data.tickets} tickets, ${r.data.ready.count} can start, ${r.data.over_cap} person-sprints over cap); publishing is a separate step`);
  return 0;
}

export const commands = {
  report: {
    run: report, positionals: [0, 0], writes: 'text', guard: 'strict', options: { out: { type: 'string' }, jira: { type: 'string' }, 'as-of': { type: 'string' } },
    summary: 'write report.md and report.html (deterministic; sprint load, can-start, blockers, chain); publishing is separate',
  },
};
