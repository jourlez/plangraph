// plangraph refresh [--fast] [--budget SECONDS] [--quiet]: bring the derived state up to date without ever blocking a session or a git operation.
// Order (cheap and local first, so a stop at the budget loses the least): rebuild the index when stale, fetch the trusted targets (not with
// --fast), rebuild the index again when the fetch changed the cache, regenerate stale generated documents into the git-ignored live copy.
// It writes only the index, cache/ and the live copy (docs.out, and only when git ignores it; docs.commit_out when docs.commit is true).
// A hand-edited document region is kept and reported on one line. It prints nothing on success. With --quiet it exits 0 whatever happens.
// No plan directory: it returns before any heavy module loads (src/entry.js does the same check even before the CLI loads).
import fs from 'node:fs';
import path from 'node:path';
import type { Ctx, Args } from '../context.ts';
import type { CommandMap } from '../registry.ts';

type Values = { fast?: boolean; budget?: number; quiet?: boolean };
/** Test seams, never set by the shell: syncFetch replaces the fetch step, beforeStep runs (and may delay) before each step. */
export interface RefreshDeps { syncFetch?(ctx: Ctx): Promise<unknown>; beforeStep?(name: string): Promise<void> | void }
export const DEFAULT_BUDGET_SECONDS = 8;
const TIMED_OUT = Symbol('budget');

const quietIo = (): Ctx['io'] => ({ out() {}, err() {}, raw() {}, outBlock() {}, data() {} });

/** Run a step; false means the budget ran out while it was pending (the step itself may still finish in the background; every write it makes is atomic). */
async function within(work: Promise<unknown> | unknown, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const clock = new Promise<typeof TIMED_OUT>((r) => { timer = setTimeout(() => r(TIMED_OUT), Math.max(0, ms)); timer.unref(); });
  try { return (await Promise.race([Promise.resolve(work), clock])) !== TIMED_OUT; } finally { clearTimeout(timer); }
}

async function indexStale(ctx: Ctx): Promise<boolean> {
  const { openIndex, INDEX_FILE } = await import('../db.ts');
  const file = path.join(ctx.dir, INDEX_FILE);
  if (!fs.existsSync(file)) return true;
  try { using h = openIndex(file, { readOnly: true, dir: ctx.dir }); return Boolean(h.stale || h.older); } catch { return true; }
}

async function rebuildIndex(ctx: Ctx): Promise<void> {
  if (!(await indexStale(ctx))) return;
  const { checkFormat } = await import('../../lib/store.ts');
  checkFormat(ctx.dir); // a directory of another format version is left alone
  ctx.config(); // a bad config.json is refused as everywhere
  (await import('../db.ts')).buildIndex(ctx); // builds into a temp file and renames: a stop leaves the old or the new index, never a partial one
}

async function regenerateDocs(ctx: Ctx, say: (line: string) => void): Promise<void> {
  const { GENERATORS, checkOut, checkDocs, buildDocs } = await import('../../lib/docs/registry.ts');
  const { loadExtras } = await import('../../lib/docs/extras.ts');
  const { realFs } = await import('../../lib/docs/realfs.ts');
  const { openStore } = await import('../../lib/planstore.ts');
  const { modelFromDb } = await import('./shared.ts');
  const { openIndex, INDEX_FILE } = await import('../db.ts');
  const base = ctx.config(), docsCfg = (base.docs ?? {}) as Record<string, unknown>, commit = docsCfg.commit === true;
  const commitOut = typeof docsCfg.commit_out === 'string' && docsCfg.commit_out !== '' ? docsCfg.commit_out : 'docs/generated';
  const cfg = commit ? { ...base, docs: { ...docsCfg, out: commitOut } } : base;
  const out = checkOut(cfg);
  if (!commit) { try { ctx.git('check-ignore', '-q', `${out}/index.md`); } catch { return; } } // tracked or not ignored: never written without docs.commit
  using h = openIndex(path.join(ctx.dir, INDEX_FILE), { readOnly: true, dir: ctx.dir }); // a fresh handle: the one a card opened earlier predates the rebuild
  const model = modelFromDb({ ...ctx, db: () => h } as Ctx), extras = loadExtras(openStore(ctx) as never), fsx = realFs(ctx.root);
  const state = checkDocs(model, cfg, fsx, extras, { generators: GENERATORS });
  for (const r of state.rows) if (r.status === 'edited') say(`docs: hand edit in ${path.basename(r.path)} kept; the region was not regenerated`);
  if (!state.rows.some((r) => r.status === 'stale' || r.status === 'missing')) return;
  const res = buildDocs(model, cfg, fsx, extras, { generators: GENERATORS });
  if (res.violations.length > 0) say('docs: a generated document holds data the policy excludes; nothing written');
}

/** The whole refresh. Throws on a hard failure (the command turns it into exit 0 under --quiet). */
export async function runRefresh(ctx: Ctx, { fast = false, budgetMs = DEFAULT_BUDGET_SECONDS * 1000, say = () => {} }: { fast?: boolean; budgetMs?: number; say?: (line: string) => void } = {}): Promise<void> {
  if (!fs.existsSync(ctx.dir)) return;
  const deps = (ctx as Ctx & { refreshDeps?: RefreshDeps }).refreshDeps ?? {}, deadline = Date.now() + budgetMs, left = () => deadline - Date.now();
  const step = async (name: string, fn: () => unknown): Promise<boolean> => {
    if (left() <= 0) return false;
    return within((async () => { await deps.beforeStep?.(name); return fn(); })(), left());
  };
  if (!(await step('index', () => rebuildIndex(ctx)))) return;
  if (!fast) {
    const fetchStep = async (): Promise<void> => {
      try {
        const quiet = { ...ctx, io: quietIo() } as Ctx;
        if (deps.syncFetch) await deps.syncFetch(quiet);
        else await ((await import('./sync-fetch.ts')).commands['sync-fetch']!.run as (c: Ctx, a: Args) => unknown)(quiet, { values: {}, positionals: [] });
      } catch { /* a fetch failure never fails the session; the cache and the index stay as they were */ }
    };
    if (!(await step('fetch', fetchStep))) return;
    if (!(await step('index', () => rebuildIndex(ctx)))) return;
  }
  await step('docs', async () => { try { await regenerateDocs(ctx, say); } catch { /* the live copy is optional */ } });
}

async function refresh(ctx: Ctx, args: Args<Values>): Promise<number> {
  const v = args.values;
  if (!fs.existsSync(ctx.dir)) return 0;
  try {
    await runRefresh(ctx, { fast: Boolean(v.fast), budgetMs: (v.budget ?? DEFAULT_BUDGET_SECONDS) * 1000, say: (l) => ctx.io.err(l) });
  } catch (e) { if (!v.quiet) throw e; }
  return 0;
}

const B = { type: 'boolean' };
export const commands: CommandMap = {
  refresh: {
    run: refresh as never, positionals: [0, 0], writes: 'file', guard: 'none', options: { fast: B, budget: { type: 'integer', min: 1, max: 600 }, quiet: B },
    summary: '[--fast] [--budget SECONDS] [--quiet]: rebuild a stale index, fetch trusted targets (not with --fast), refresh the git-ignored live documents; silent, never fails with --quiet',
  },
};
