// plangraph refresh [--fast] [--budget SECONDS] [--quiet]: bring the derived state up to date without ever blocking a session or a git operation.
// Order (cheap and local first, so a stop at the budget loses the least): rebuild the index when stale, fetch the trusted targets (not with
// --fast), rebuild the index again when the fetch changed the cache, regenerate stale generated documents into the git-ignored live copy.
// It writes only the index, cache/ and the live copy (docs.out, and only when git ignores it; docs.commit_out when docs.commit is true).
// A hand-edited document region is kept and reported on one line. It prints nothing on success. With --quiet it exits 0 whatever happens.
// No plan directory: it returns before any heavy module loads (src/entry.js does the same check even before the CLI loads).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Ctx, Args } from '../context.ts';
import { PlangraphError } from '../errors.ts';
import type { CommandMap } from '../registry.ts';

type Values = { fast?: boolean; budget?: number; quiet?: boolean };
/** Test seams, never set by the shell: syncFetch replaces the fetch step, beforeStep runs (and may delay) before each step. */
export interface RefreshDeps { syncFetch?(ctx: Ctx): Promise<unknown>; beforeStep?(name: string): Promise<void> | void; buildCommand?: readonly string[] }
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

/** The index build runs in a child process (`plangraph build`) with a hard deadline: buildIndex is synchronous, so inside this process the budget
 *  could never fire while it ran, and a hook killed by its own timeout would stop it partway. At the deadline the child gets SIGKILL and the temp
 *  files it made (`<index>.tmp-<its pid>` and the SQLite sidecars of that name) are removed; the build writes a temp file and renames it, so the
 *  old index is untouched. A failed build throws (the command turns that into exit 0 under --quiet). */
async function rebuildIndex(ctx: Ctx, ms: number, command?: readonly string[]): Promise<void> {
  if (!(await indexStale(ctx))) return;
  const { checkFormat } = await import('../../lib/store.ts');
  checkFormat(ctx.dir); // a directory of another format version is left alone
  ctx.config(); // a bad config.json is refused as everywhere
  const { INDEX_FILE } = await import('../db.ts');
  const [exe, ...argv] = command ?? [process.execPath, fileURLToPath(new URL('../entry.js', import.meta.url)), 'build'];
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(ctx.env)) if (typeof v === 'string') env[k] = v;
  const child = spawn(exe as string, argv, { cwd: ctx.root, env, stdio: 'ignore', windowsHide: true });
  let late = false;
  const code = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => { late = true; child.kill('SIGKILL'); }, Math.max(0, ms)); // the close event follows the kill
    child.on('error', () => { clearTimeout(timer); resolve(1); });
    child.on('close', (c) => { clearTimeout(timer); resolve(c); });
  });
  if (late || code !== 0) {
    const prefix = `${INDEX_FILE}.tmp-${child.pid}`;
    try { for (const f of fs.readdirSync(ctx.dir)) if (f === prefix || f.startsWith(`${prefix}-`)) fs.rmSync(path.join(ctx.dir, f), { force: true }); } catch { /* best effort: removeStaleTemps takes a dead pid's leftovers at the next build */ }
  }
  if (!late && code === 2) throw new PlangraphError('DATA', 'the index build failed: the plan holds damaged data', { hint: '`plangraph check` names the file' }); // the child refused the data: exit 2 as `build` does
  if (!late && code !== 0) throw new Error('the index build failed');
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
  const step = async (name: string, fn: () => unknown, grace = 0): Promise<boolean> => {
    if (left() <= 0) return false;
    return within((async () => { await deps.beforeStep?.(name); return fn(); })(), left() + grace); // grace: a step with its own hard deadline gets time to clean up after it
  };
  if (!(await step('index', () => rebuildIndex(ctx, left(), deps.buildCommand), 1000))) return;
  if (!fast) {
    const fetchStep = async (): Promise<void> => {
      try {
        const quiet = { ...ctx, io: quietIo() } as Ctx;
        if (deps.syncFetch) await deps.syncFetch(quiet);
        else await ((await import('./sync-fetch.ts')).commands['sync-fetch']!.run as (c: Ctx, a: Args) => unknown)(quiet, { values: {}, positionals: [] });
      } catch { /* a fetch failure never fails the session; the cache and the index stay as they were */ }
    };
    if (!(await step('fetch', fetchStep))) return;
    if (!(await step('index', () => rebuildIndex(ctx, left(), deps.buildCommand), 1000))) return;
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
