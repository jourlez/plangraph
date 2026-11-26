// plangraph identity propose [--sys S] | list: read-only. `propose` matches the assignees seen in the observation cache against plan people
// and prints suggestions (writes nothing); `list` prints the local map (cache/identities.json). Tracker text is untrusted: printed fenced.
import { oneLine } from '../../lib/sanitize.ts';
import { proposeIdentities, matchIdentity, readIdentityMap } from '../../lib/identity.ts';
import { openStore } from '../../lib/planstore.ts';
import { PlangraphError } from '../errors.ts';
import { fenceBlock, needBrain, usage } from './shared.ts';
import type { Ctx, Args } from '../context.ts';
import type { CommandMap } from '../registry.ts';

const MAX_LINES = 200;
const isObj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);

/** Observed assignees of the obs cache: one entry per distinct `<sys>:<assignee>`, sorted. */
function observed(ctx: Ctx, sys: string | undefined): { ref: string; display: string }[] {
  const db = ctx.db();
  if (db.older) throw new PlangraphError('STALE', 'the index was built by an older plangraph', { hint: 'run `plangraph build`' });
  const seen = new Map<string, string>();
  for (const r of db.all('SELECT sys, fields FROM obs') as { sys: string; fields: unknown }[]) {
    if (sys !== undefined && r.sys !== sys && !r.sys.startsWith(`${sys}:`)) continue;
    let f: unknown = r.fields; if (typeof f === 'string') { try { f = JSON.parse(f); } catch { f = null; } }
    const who = isObj(f) && typeof f.assignee === 'string' ? f.assignee.trim() : '';
    if (who) seen.set(`${r.sys}:${who}`, who);
  }
  return [...seen].map(([ref, display]) => ({ ref, display })).sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
}

function identity(ctx: Ctx, args: Args<{ sys?: string }>): number {
  const [sub] = args.positionals;
  if (sub !== 'propose' && sub !== 'list') throw usage('identity needs a subcommand: propose [--sys S] | list');
  needBrain(ctx);
  if (sub === 'list') {
    const entries = Object.entries(readIdentityMap(ctx.dir).byRef).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    ctx.io.out(`${entries.length} mapped`);
    if (entries.length) ctx.io.outBlock(fenceBlock('identities', entries.slice(0, MAX_LINES).map(([r, p]) => `${oneLine(r, 120)} ${oneLine(p, 60)}`)));
    return 0;
  }
  const people = openStore(ctx).readKind('person', { defaults: false });
  const map = readIdentityMap(ctx.dir), obs = observed(ctx, args.values.sys).filter((o) => map.byRef[o.ref] === undefined);
  const props = proposeIdentities(obs, people), got = new Set(props.map((p) => p.ref));
  const ambiguous = obs.filter((o) => !got.has(o.ref) && (matchIdentity(o.display, people)?.persons.length ?? 0) > 1);
  ctx.io.out(`${props.length} proposed, ${ambiguous.length} ambiguous`);
  const lines = [...props.map((p) => `${oneLine(p.ref, 120)} ${oneLine(p.person, 60)} ${p.conf} ${p.why}`), ...ambiguous.map((o) => `${oneLine(o.ref, 120)} ambiguous`)];
  if (lines.length) ctx.io.outBlock(fenceBlock('proposals', lines.slice(0, MAX_LINES)));
  if (lines.length > MAX_LINES) ctx.io.out(`truncated ${lines.length - MAX_LINES}`);
  if (props.length) ctx.io.out('apply with: plangraph identity-map REF PERSON');
  return 0;
}

export const commands: CommandMap = {
  identity: {
    run: identity as never, positionals: [1, 1], writes: 'none', guard: 'soft', options: { sys: { type: 'string' } },
    summary: 'propose [--sys S]: suggest which plan person each observed tracker assignee is (prints only); list: show the local identity map',
  },
};
