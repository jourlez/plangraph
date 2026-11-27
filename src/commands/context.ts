// plangraph context [KEY] [--branch] [-v] [--json]: the bounded digest for one task (lib/digest.ts buildContext), at most 400 estimated tokens.
// No KEY: the ticket named by the branch (`git rev-parse --abbrev-ref HEAD` through ctx.git); none found prints one line and exits 0. Read-only.
import { buildContext, render, ticketFromBranch, CONTEXT_BUDGET } from '../../lib/digest.ts';
import { modelFromDb, needBrain } from './shared.ts';
import { loadExtras } from '../../lib/extras.ts';
import type { Ctx, Args } from '../context.ts';
import type { CommandMap } from '../registry.ts';

function context(ctx: Ctx, args: Args<{ branch?: boolean }>): number {
  needBrain(ctx);
  const model = modelFromDb(ctx);
  let target: string | null = args.positionals[0] ?? null;
  if (target === null) {
    let branch = '';
    try { branch = String(ctx.git('rev-parse', '--abbrev-ref', 'HEAD')).trim(); } catch { /* no git: no branch */ }
    target = ticketFromBranch(branch, model.tickets.keys());
  }
  const d = buildContext(model, target, { maxTokens: CONTEXT_BUDGET, extras: loadExtras(ctx, { model }) });
  ctx.io.data?.(d.data, { next: [] });
  ctx.io.outBlock(render(d).text.split('\n'));
  return 0;
}
export const commands: CommandMap = {
  context: {
    run: context as never, positionals: [0, 1], writes: 'none', guard: 'soft', options: { branch: { type: 'boolean' } },
    summary: '[KEY] [--branch] [-v]: the digest for one task (owner, blockers, repos, requirements, decisions), at most 400 estimated tokens; no KEY uses the branch name',
  },
};
