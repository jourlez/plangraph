// plangraph resolve: finds entity files with merge conflict markers. A file whose conflict hunks hold only collection-field lines (links,
// xrefs, acceptance, members, owns, affects) is resolved by union and rewritten canonical; a hunk that touches a scalar field is left in
// place and reported with file and field. Exit 1 when anything is left for a person.
import { resolveConflicts } from '../../lib/store2/resolve.ts';
import { oneLine } from '../../lib/sanitize.ts';
import { needBrain, nextList } from './shared.ts';
import type { Ctx } from '../context.ts';
import type { CommandMap } from '../registry.ts';

function resolve(ctx: Ctx): number {
  needBrain(ctx);
  const { resolved, left } = resolveConflicts(ctx.dir);
  ctx.io.data?.({ resolved: resolved.length, left: left.length, files: resolved.slice(0, 50), conflicts: left.slice(0, 50) }, { next: nextList(resolved.length || left.length ? ['plangraph check'] : []) });
  for (const f of resolved.slice(0, 20)) ctx.io.out(`resolved ${oneLine(f, 120)}`);
  for (const l of left.slice(0, 20)) ctx.io.out(`left ${oneLine(l.path, 120)}: field ${l.field} (line ${l.line}) needs a person`);
  ctx.io.out(left.length ? `resolve: ${resolved.length} resolved, ${left.length} left for a person` : resolved.length ? `resolve: ${resolved.length} file${resolved.length === 1 ? '' : 's'} resolved` : 'resolve: no conflicts');
  return left.length ? 1 : 0;
}

export const commands: CommandMap = {
  resolve: {
    run: resolve as never, positionals: [0, 0], writes: 'text', guard: 'soft',
    summary: 'union-resolve merge conflicts in entity files when every hunk holds only collection-field lines (links, xrefs, ...); a scalar conflict is reported, exit 1',
  },
};
