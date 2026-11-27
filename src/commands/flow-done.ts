// plangraph flow-done KEY --evidence K:V ...: finish a task. Evidence is required (exit 2 without), as a done event with none is DONE_WITHOUT_EVIDENCE.
import { evidenceOf, writeEvent } from './flow-util.ts';
import { usage } from './shared.ts';
import type { Ctx, Args } from '../context.ts';
import type { CommandMap } from '../registry.ts';

function done(ctx: Ctx, args: Args<{ by?: string; evidence?: string[]; note?: string }>): number {
  const evidence = evidenceOf(args.values.evidence);
  if (!evidence.length) throw usage('flow-done needs --evidence KIND:VALUE (for example pr:org/repo#12 or test:suite)');
  return writeEvent(ctx, { key: args.positionals[0] as string, to: 'done', by: args.values.by, evidence, note: args.values.note });
}
export const commands: CommandMap = {
  'flow-done': {
    run: done as never, positionals: [1, 1], writes: 'text', guard: 'strict',
    options: { by: { type: 'string' }, evidence: { type: 'string', multiple: true }, note: { type: 'string' } },
    summary: 'KEY --evidence K:V ... [--note T] [--by WHO]: mark a task done; exit 2 without evidence',
  },
};
