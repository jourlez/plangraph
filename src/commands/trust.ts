// plangraph trust SYS:TARGET: record a fetch target (github:owner/repo, jira:TENANT, confluence:TENANT/SPACE) in cache/trusted.json (0600,
// git-ignored). `sync-fetch` refuses any target named by committed config until the user runs this, so a hostile repository cannot aim the
// user's credentials at a target of its choice. The one thing this command writes. Never echoes the argument it refuses.
import { trust as recordTrust } from '../../lib/fetch/trust.ts';
import { needBrain, usage } from './shared.ts';
import type { Ctx, Args } from '../context.ts';
import type { CommandMap } from '../registry.ts';

const SHOWN = /^[a-z][a-z0-9-]{0,23}:[A-Za-z0-9._#@/-][A-Za-z0-9._#@/ -]{0,199}$/;

function trustCmd(ctx: Ctx, args: Args): number {
  const target = args.positionals[0] as string;
  needBrain(ctx);
  try { recordTrust(ctx.dir, target); } catch { throw usage('trust needs SYS:TARGET with plain characters, for example github:owner/repo (no URL, no ..)'); }
  ctx.io.out(`trusted ${SHOWN.test(target) ? target : ''}`.trim());
  return 0;
}

export const commands: CommandMap = {
  trust: {
    run: trustCmd as never, positionals: [1, 1], writes: 'file', guard: 'soft', options: {},
    summary: 'SYS:TARGET: allow sync-fetch to read this target with your own credentials (github:owner/repo, jira:TENANT, confluence:TENANT/SPACE); recorded in the git-ignored cache/trusted.json',
  },
};
