// plangraph identity-map REF PERSON: map one tracker ref (`<sys>:<display>`) to a plan person in the local cache/identities.json (0600, never
// committed). PERSON must be a person of the plan.
import { readIdentityMap, writeIdentityMap } from '../../lib/identity.ts';
import { oneLine } from '../../lib/sanitize.ts';
import { openStore } from '../../lib/planstore.ts';
import { needBrain, usage } from './shared.ts';
import type { Ctx, Args } from '../context.ts';
import type { CommandMap } from '../registry.ts';

function identityMap(ctx: Ctx, args: Args): number {
  const [ref, person] = args.positionals;
  if (!ref || !person) throw usage('usage: plangraph identity-map REF PERSON');
  needBrain(ctx);
  const known = new Set(openStore(ctx).readKind('person', { defaults: false }).map((p) => p.id).filter((i): i is string => typeof i === 'string'));
  if (!known.has(person)) throw usage(`unknown person ${oneLine(person, 60)}: it must be an id in people`);
  const map = readIdentityMap(ctx.dir);
  map.byRef[ref] = person;
  writeIdentityMap(ctx.dir, map);
  ctx.io.out(`mapped ${oneLine(ref, 120)} to ${oneLine(person, 60)}`);
  return 0;
}

export const commands: CommandMap = {
  'identity-map': {
    run: identityMap as never, positionals: [2, 2], writes: 'text', guard: 'strict',
    summary: 'REF PERSON: map a tracker ref to a plan person in the local cache/identities.json (0600, never committed); PERSON must exist',
  },
};
