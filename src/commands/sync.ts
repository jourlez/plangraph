// plangraph sync --plan: the read-only drift report between the plan files and the observation cache (lib/graph/drift.ts). One bounded line
// per finding, then a push list: what the agent would set in the tracker (through the Atlassian connector, after the user approves). Nothing
// is written. Tracker text (the real assignee, status, sprint) is untrusted and is printed inside a fence, never on a finding line.
import { oneLine } from '../../lib/sanitize.ts';
import { PlangraphError } from '../errors.ts';
import { fenceBlock, usage, verbose } from './shared.ts';
import type { Ctx, Args } from '../context.ts';
import type { CommandMap } from '../registry.ts';

const MAX_LINES = 40, MAX_LINES_V = 500, MAX_PUSH = 20, MAX_JSON = 2000;
const PUSH_OF: Record<string, string> = { DRIFT_ASSIGNEE: 'assignee', DRIFT_SPRINT: 'sprint' }; // the plan is authoritative for these two

async function sync(ctx: Ctx, args: Args<{ plan?: boolean }>): Promise<number> {
  if (!args.values.plan) throw usage('usage: plangraph sync --plan');
  const { drift, DEFAULT_STALE_DAYS } = await import('../../lib/graph/drift.ts');
  const { closedStatuses } = await import('../../lib/ready.ts');
  const { isoDay } = await import('../../lib/clock.ts');
  const { readIdentityMap } = await import('../../lib/identity.ts');
  const db = ctx.db();
  if (db.older) throw new PlangraphError('STALE', 'the index was built by an older plangraph', { hint: 'run `plangraph build`' });
  const cfg = ctx.config() as { graph?: { stale_days?: unknown } }, sd = cfg.graph?.stale_days;
  const staleDays = Number.isSafeInteger(sd) && (sd as number) >= 0 ? (sd as number) : DEFAULT_STALE_DAYS;
  let identities;
  try { identities = readIdentityMap(ctx.dir); } catch (e) { if ((e as { code?: unknown }).code === 'DATA') throw new PlangraphError('DATA', (e as Error).message, { hint: 'fix or delete cache/identities.json' }); throw e; }
  const all = (sql: string) => db.all(sql) as never[];
  const found = drift({
    tickets: all('SELECT "key", jira_status, impl_status FROM ticket'),
    schedule: all(`SELECT "key", owner, sprint FROM schedule WHERE version='current'`),
    edges: all('SELECT consumer, producer FROM edge'),
    xrefs: all('SELECT "type", "id", sys, xid FROM xref'),
    obs: all('SELECT sys, xid, "type", fields, links, seen FROM obs'),
    closed: closedStatuses(ctx.config()), staleDays, today: isoDay(ctx.now()), identities,
  });
  const counts: Record<string, number> = {};
  for (const f of found) counts[f.code] = (counts[f.code] ?? 0) + 1;
  const push = found.filter((f) => PUSH_OF[f.code] && f.ext !== undefined && f.sys.startsWith('jira'));
  const line = (f: (typeof found)[number]): string => `${f.code} ${oneLine(f.key, 120)}${f.plan !== undefined ? ` plan ${oneLine(f.plan, 80)}` : ''}`;
  const pushLine = (f: (typeof found)[number]): string => `push ${oneLine(f.xid, 60)} ${PUSH_OF[f.code]} ${oneLine(f.plan ?? '', 60)}`;

  ctx.io.data?.({
    findings: found.slice(0, MAX_JSON).map((f) => ({ code: f.code, key: oneLine(f.key, 120), sys: oneLine(f.sys, 60), xid: oneLine(f.xid, 120), plan: f.plan === undefined ? null : oneLine(f.plan, 80), observed: f.ext === undefined ? null : oneLine(f.ext, 200) })),
    counts, truncated: Math.max(0, found.length - MAX_JSON), push: push.slice(0, MAX_JSON).map((f) => ({ xid: oneLine(f.xid, 60), field: PUSH_OF[f.code], value: oneLine(f.plan ?? '', 60) })),
  }, { next: [] });
  if (!found.length) { ctx.io.out('no drift'); return 0; }
  const cap = verbose(args) ? MAX_LINES_V : MAX_LINES, shown = found.slice(0, cap);
  for (const f of shown) ctx.io.out(line(f));
  if (found.length > shown.length) ctx.io.out(`truncated ${found.length - shown.length}, -v lifts the cap`);
  const bySys = new Map<string, string[]>();
  for (const f of shown) if (f.ext !== undefined) { const l = bySys.get(f.sys), t = `${oneLine(f.key, 120)} ${f.code} observed ${oneLine(f.ext, 200)}`; if (l) l.push(t); else bySys.set(f.sys, [t]); }
  for (const s of [...bySys.keys()].sort()) ctx.io.outBlock(fenceBlock(oneLine(s, 60), bySys.get(s) as string[]));
  const pushed = push.slice(0, MAX_PUSH);
  if (pushed.length) { ctx.io.out('push list (apply after approval):'); for (const f of pushed) ctx.io.out(pushLine(f)); }
  if (push.length > pushed.length) ctx.io.out(`truncated ${push.length - pushed.length} push line(s)`);
  return 0;
}

export const commands: CommandMap = {
  sync: {
    run: sync as never, positionals: [0, 0], writes: 'none', guard: 'strict', options: { plan: { type: 'boolean' } },
    summary: '--plan: read-only drift report between the plan files and the observation cache (DRIFT_ASSIGNEE, DRIFT_SPRINT, DRIFT_DONE, DRIFT_LINK, XREF_STALE, XREF_ORPHAN) with a tracker push list; config.graph.stale_days (default 14)',
  },
};
