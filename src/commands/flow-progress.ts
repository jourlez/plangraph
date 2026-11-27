// plangraph flow-progress KEY --to STATE [--evidence K:V] [--note T]: append one state event. An illegal transition exits 2.
import { evidenceOf, writeEvent } from './flow-util.ts';
import { usage } from './shared.ts';
import type { Ctx, Args } from '../context.ts';
import type { CommandMap } from '../registry.ts';

const STATES = ['ready', 'claimed', 'in_progress', 'in_review', 'needs_input', 'failed', 'skipped', 'removed', 'proposed', 'done'];
type V = { to?: string; by?: string; evidence?: string[]; note?: string };
function progress(ctx: Ctx, args: Args<V>): number {
  const to = args.values.to;
  if (!to || !STATES.includes(to)) throw usage(`--to must be one of: ${STATES.join(', ')}`);
  const evidence = evidenceOf(args.values.evidence);
  if (to === 'done' && !evidence.length) throw usage('done needs --evidence KIND:VALUE; use plangraph flow-done');
  return writeEvent(ctx, { key: args.positionals[0] as string, to, by: args.values.by, evidence, note: args.values.note });
}
export const commands: CommandMap = {
  'flow-progress': {
    run: progress as never, positionals: [1, 1], writes: 'text', guard: 'strict',
    options: { to: { type: 'string' }, by: { type: 'string' }, evidence: { type: 'string', multiple: true }, note: { type: 'string' } },
    summary: 'KEY --to STATE [--evidence K:V] [--note T] [--by WHO]: move a task to a state; an illegal transition or an unknown task exits 2',
  },
};
