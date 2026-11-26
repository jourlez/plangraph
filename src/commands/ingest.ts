// plangraph ingest git [--repo ID] [--since DAYS] [--full]: mine git history into cache/git.jsonl (module facts) and cache/git.cursor,
// both 0600 and git-ignored caches. The one writer command of ingest: every subcommand writes. Prints one summary line, never history text.
import { readIdentityMap } from '../../lib/identity.ts';
import { oneLine } from '../../lib/sanitize.ts';
import { needBrain, usage } from './shared.ts';
import type { Ctx, Args } from '../context.ts';
import type { CommandMap } from '../registry.ts';

const REPO_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

async function ingest(ctx: Ctx, args: Args<{ repo?: string; since?: number; full?: boolean }>): Promise<number> {
  const [sub] = args.positionals;
  if (sub !== 'git') throw usage(`usage: plangraph ingest git [--repo ID] [--since DAYS] [--full] (unknown subcommand ${oneLine(sub, 20)})`);
  const { repo, since, full } = args.values;
  if (repo !== undefined && !REPO_ID.test(repo)) throw usage('--repo: an id of letters, digits and . _ : - (at most 64)');
  needBrain(ctx);
  const { ingestGit } = await import('../../lib/history/git.ts'); // loaded on first use: the miner is not on the start-up path
  const res = await ingestGit(ctx, { ...(repo !== undefined ? { repo } : {}), ...(since !== undefined ? { since } : {}), ...(full ? { full: true } : {}), identity: readIdentityMap(ctx.dir) });
  ctx.io.out(`ingested ${res.written} modules from ${res.commits} commits (${res.incremental ? 'incremental' : 'full'})`);
  return 0;
}

export const commands: CommandMap = {
  ingest: {
    run: ingest as never, positionals: [1, 1], writes: 'file', guard: 'soft',
    options: { repo: { type: 'string' }, since: { type: 'integer', min: 1, max: 36500 }, full: { type: 'boolean' } },
    summary: 'git [--repo ID] [--since DAYS] [--full]: mine git history into local module facts (cache/git.jsonl, 0600); a shallow clone is refused',
  },
};
