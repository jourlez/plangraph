// plangraph compact [--ci]: merge sealed months of events and runs into one content-hashed file per month and kind (lib/store2/batches.ts).
// Refuses unless CI=true or --ci, so two clones cannot race: CI runs it on the default branch only. Writes plan data, so it is its own writer command.
import { compact } from '../../lib/store2/batches.ts';
import { PlangraphError } from '../errors.ts';
import { needBrain } from './shared.ts';
import type { Ctx, Args } from '../context.ts';
import type { CommandMap } from '../registry.ts';

async function run(ctx: Ctx, args: Args<{ ci?: boolean }>): Promise<number> {
  needBrain(ctx);
  let r: ReturnType<typeof compact>;
  try { r = compact(ctx.dir, { ci: Boolean(args.values.ci) || ctx.env.CI === 'true' }); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'REFUSED') throw new PlangraphError('REFUSED', 'compact runs only in CI on the default branch', { hint: 'set CI=true or pass --ci', cause: e });
    throw e;
  }
  ctx.io.out(r.merged.length ? `compacted ${r.merged.length} file${r.merged.length === 1 ? '' : 's'}` : 'nothing to compact');
  if (r.skipped.length) ctx.io.out(`skipped ${r.skipped.length} month${r.skipped.length === 1 ? '' : 's'} with a bad line (run plangraph check): ${r.skipped.slice(0, 5).join(', ')}`);
  return 0;
}

export const commands: CommandMap = {
  compact: {
    run: run as never, positionals: [0, 0], writes: 'text', guard: 'strict',
    options: { ci: { type: 'boolean' } },
    summary: 'compact [--ci]: merge sealed months of events and runs into one file per month and kind (CI on the default branch only)',
  },
};
