// plangraph fmt: rewrites every entity file whose only problem is NOT_CANONICAL (sorted fields, LF, trailing newline) into canonical form.
// A file with a conflict, a bad line or any other problem is left alone (plangraph check names it).
import { fmtStore } from '../../lib/store2/check.ts';
import { oneLine } from '../../lib/sanitize.ts';
import { needBrain, nextList } from './shared.ts';
import type { Ctx } from '../context.ts';
import type { CommandMap } from '../registry.ts';

function fmt(ctx: Ctx): number {
  needBrain(ctx);
  const { rewritten } = fmtStore(ctx.dir);
  ctx.io.data?.({ rewritten: rewritten.length, files: rewritten.slice(0, 50) }, { next: nextList(rewritten.length ? ['plangraph check'] : []) });
  for (const f of rewritten.slice(0, 20)) ctx.io.out(`rewrote ${oneLine(f, 120)}`);
  if (rewritten.length > 20) ctx.io.out(`... and ${rewritten.length - 20} more`);
  ctx.io.out(rewritten.length ? `fmt: ${rewritten.length} file${rewritten.length === 1 ? '' : 's'} rewritten` : 'fmt: nothing to rewrite');
  return 0;
}

export const commands: CommandMap = {
  fmt: {
    run: fmt as never, positionals: [0, 0], writes: 'text', guard: 'soft',
    summary: 'rewrite every non-canonical entity file (nodes/**/*.pg) into canonical form; a damaged file is left alone',
  },
};
