// plangraph docs list | check | export ID: read-only views of the generated documents (lib/docs). `check` regenerates in memory and compares with the
// files under docs.out: one line per generator (`<generator> fresh|stale|edited|missing`), exit 1 when any region is not fresh. `export` prints one
// document as neutral blocks for a remote mirror (--json: the whole document). `docs-build` (src/commands/docs-build.ts) is the writer.
import { openStore } from '../../lib/planstore.ts';
import { checkDocs, checkOut, listDocs } from '../../lib/docs/registry.ts';
import { exportDoc, exportableIds } from '../../lib/docs/export.ts';
import { loadExtras } from '../../lib/docs/extras.ts';
import { realFs } from '../../lib/docs/realfs.ts';
import { oneLine } from '../../lib/sanitize.ts';
import { modelFromDb, needBrain, usage } from './shared.ts';
import type { Ctx, Args } from '../context.ts';
import type { CommandMap } from '../registry.ts';
import type { RegionStatus } from '../../lib/docs/regions.ts';

const WORST: readonly RegionStatus[] = ['missing', 'edited', 'stale', 'fresh'];

function docs(ctx: Ctx, args: Args): number {
  const [sub, id] = args.positionals;
  if (sub !== 'list' && sub !== 'check' && sub !== 'export') throw usage('docs needs a subcommand: list | check | export ID');
  if (sub !== 'export' && id !== undefined) throw usage(`docs ${sub} takes no argument`);
  if (sub === 'export' && id === undefined) throw usage('docs export needs a document id (see `plangraph docs list`)');
  needBrain(ctx);
  const cfg = ctx.config();
  try { checkOut(cfg); } catch (e) { ctx.io.err(oneLine((e as Error).message, 200)); return 2; }
  const model = modelFromDb(ctx);
  const extras = loadExtras(openStore(ctx) as never);
  if (sub === 'list') {
    for (const l of listDocs(model, cfg, extras)) ctx.io.out(l);
    return 0;
  }
  if (sub === 'export') {
    try {
      const d = exportDoc(id as string, model, cfg, extras);
      ctx.io.data?.(d);
      ctx.io.outBlock([`# ${d.title}`, `fp ${d.fp} source ${d.source}`, ...d.blocks.flatMap((b) => ['', ...b.text.split('\n')])]);
      return 0;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'UNKNOWN_DOC') { ctx.io.err(`no document ${oneLine(id, 80)}; ids: ${exportableIds(model, cfg, extras).slice(0, 12).join(' ')}`); return 2; }
      if (code === 'D24_VIOLATION' || code === 'DATA_CLASS_VIOLATION') { ctx.io.err(oneLine((e as Error).message, 200)); return 2; }
      throw e;
    }
  }
  let res: ReturnType<typeof checkDocs>;
  try { res = checkDocs(model, cfg, realFs(ctx.root), extras); } catch (e) {
    if ((e as { code?: string }).code === 'OUT_OUTSIDE_ROOT') { ctx.io.err(oneLine((e as Error).message, 200)); return 2; }
    throw e;
  }
  const byGen = new Map<string, RegionStatus>();
  for (const r of res.rows) {
    const gen = r.id.split('.')[0] as string;
    const cur = byGen.get(gen);
    if (cur === undefined || WORST.indexOf(r.status) < WORST.indexOf(cur)) byGen.set(gen, r.status);
  }
  for (const [gen, st] of byGen) ctx.io.out(`${gen} ${st}`);
  return res.ok ? 0 : 1;
}

export const commands: CommandMap = {
  docs: {
    run: docs as never, positionals: [1, 2], writes: 'none', guard: 'soft',
    summary: 'list | check | export ID: generated documents; check prints one line per generator and exits 1 when a region is stale, edited or missing; export gives neutral blocks for a mirror',
  },
};
