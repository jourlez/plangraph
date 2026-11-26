// report: generate report.md and report.html from the plan (lib/report.ts, deterministic). It only writes the two files, atomically and
// confined to the repository; publishing and sharing belong to the Artifact and Slack tools, proposed by the plangraph:report skill.
// Race left: between the pre-check and the rename another process could swap a target for a symlink; the rename replaces the link itself.
import fs from 'node:fs';
import path from 'node:path';
import { oneLine } from '../../lib/sanitize.ts';
import { needBrain, usage, dataError, modelFromDb, readItems, loadJiraSnap, precheckTargets, writeState, rel } from './shared.ts';
import type { Ctx, Args } from '../context.ts';
import type { CommandMap } from '../registry.ts';
import type { Model } from '../../lib/model.ts';
import type { StaleOpts } from '../../lib/stale.ts';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

// The forecast state is the only part that can fail for thin or odd history; the report then says "not computed" rather than failing.
async function forecastTag(ctx: Ctx, model: Model) {
  try {
    const F = await import('../../lib/forecast.ts'), { readCapped } = await import('../../lib/jsonl.ts'), { MAX_DATA } = await import('./shared.ts');
    const rd = (n: string) => { const f = path.join(ctx.dir, n); return fs.existsSync(f) ? readCapped(f, MAX_DATA) : ''; };
    const H = F.parseHistory(rd('history.jsonl')), A = F.parseActuals(rd('actuals.jsonl'));
    const r = F.forecast({ history: H.records, actuals: A.rows, model, config: ctx.config(), seed: 1, sprints: ctx.db().all('SELECT n,"end" AS "end" FROM sprint') as Array<{ n: number; end: unknown }> });
    return { state: r.state, n: r.n };
  } catch { return null; }
}
async function staleCount(ctx: Ctx) {
  try {
    const S = await import('../../lib/stale.ts'), { loadModel } = await import('../../lib/model.ts'), cfg = ctx.config(), ref = S.resolveRef(cfg as { default_ref?: unknown }); // config.json's default_ref sits in PlanConfig's index signature: lib/model.ts does not name it (concern)
    const m = loadModel(ctx.dir, { config: cfg }), deps = S.gitDeps(ctx.root, ref, {});
    const res = S.computeStale(m, m.refs, deps, { ref, heading: cfg.ref_heading, rulesVersion: cfg.brain_rules_version, full: false } as StaleOpts); // ref_heading is config text: computeStale uses `heading || DEFAULT_HEADING` and compileHeading refuses a non-string (StaleOpts.heading should be unknown, concern)
    return { count: res.stale.length, ref: oneLine(ref, 60) };
  } catch { return null; }
}

async function report(ctx: Ctx, args: Args<{ out?: string; jira?: string; 'as-of'?: string }>): Promise<number> {
  needBrain(ctx);
  const v = args.values, outDir = path.resolve(ctx.root, v.out ?? rel(ctx, ctx.dir));
  if ((v.jira === undefined) !== (v['as-of'] === undefined)) throw usage('--jira and --as-of go together (the snapshot date, YYYY-MM-DD)');
  if (v['as-of'] !== undefined && !DATE.test(v['as-of'])) throw usage('--as-of must be a date like 2026-11-20');
  let st: fs.Stats | null; try { st = fs.statSync(outDir); } catch { st = null; }
  if (!st || !st.isDirectory()) throw dataError('the output directory does not exist', 'create it first, or omit --out');
  const files: [string, string] = [path.join(outDir, 'report.md'), path.join(outDir, 'report.html')];
  precheckTargets(ctx, files);
  const { buildReport } = await import('../../lib/report.ts'), model = modelFromDb(ctx), { items } = await readItems(ctx);
  const r = buildReport(model, {
    items, statuses: v.jira !== undefined ? await loadJiraSnap(v.jira) : null, jira: v.jira !== undefined ? { date: v['as-of'] } : null,
    forecast: await forecastTag(ctx, model), stale: await staleCount(ctx),
  });
  writeState(ctx, files[0], r.markdown); writeState(ctx, files[1], r.html);
  ctx.io.out(`wrote ${oneLine(rel(ctx, files[0]), 200)} and ${oneLine(rel(ctx, files[1]), 200)} (${r.data.tickets} tickets, ${r.data.ready.count} can start, ${r.data.over_cap} person-sprints over cap); publishing is a separate step`);
  return 0;
}

export const commands: CommandMap = {
  report: {
    run: report, positionals: [0, 0], writes: 'text', guard: 'strict', options: { out: { type: 'string' }, jira: { type: 'string' }, 'as-of': { type: 'string' } },
    summary: 'write report.md and report.html (deterministic; sprint load, can-start, blockers, chain); publishing is separate',
  },
};
