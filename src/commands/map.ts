// plangraph map [--repo ID] [-v] [--json]: the bounded repository digest (lib/digest.ts buildMap), at most 500 estimated tokens. Read-only.
import { buildMap, render, MAP_BUDGET } from '../../lib/digest.ts';
import { modelFromDb, needBrain, verbose } from './shared.ts';
import { loadExtras } from '../../lib/extras.ts';
import type { Ctx, Args } from '../context.ts';
import type { CommandMap } from '../registry.ts';

function map(ctx: Ctx, args: Args<{ repo?: string }>): number {
  needBrain(ctx);
  const model = modelFromDb(ctx), extras = loadExtras(ctx, { model });
  const fp = (ctx.db() as { fingerprint?: string }).fingerprint;
  const d = buildMap(model, { maxTokens: MAP_BUDGET, extras, fresh: { fp: fp ?? '', ageDays: null }, ...(args.values.repo !== undefined ? { repo: args.values.repo } : {}), verbose: verbose(args) });
  ctx.io.data?.(d.data, { next: [] });
  ctx.io.outBlock(render(d).text.split('\n'));
  return 0;
}
export const commands: CommandMap = {
  map: {
    run: map as never, positionals: [0, 0], writes: 'none', guard: 'soft', options: { repo: { type: 'string' } },
    summary: '[--repo ID] [-v]: what an agent cannot find in the repository (owners, requirements, decisions, epics, hotspots), at most 500 estimated tokens',
  },
};
