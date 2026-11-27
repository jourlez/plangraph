// plangraph flow-claim KEY --by WHO: assert `claimed`. Refused (exit 2) when another actor holds the task (DOUBLE_CLAIM) or the move is illegal.
import { writeEvent } from './flow-util.ts';
import type { Ctx, Args } from '../context.ts';
import type { CommandMap } from '../registry.ts';

export const commands: CommandMap = {
  'flow-claim': {
    run: ((ctx: Ctx, args: Args<{ by?: string }>) => writeEvent(ctx, { key: args.positionals[0] as string, to: 'claimed', by: args.values.by })) as never,
    positionals: [1, 1], writes: 'text', guard: 'strict', options: { by: { type: 'string' } },
    summary: 'KEY [--by WHO]: claim a task; refused with exit 2 when another actor holds it (actor: --by, else the git user name hashed to a short id)',
  },
};
