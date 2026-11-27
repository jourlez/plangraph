// plangraph flow next|brief|status|actions: read-only. Nothing is written and no tracker is called (`actions` only prints what the agent would do
// through the vendor tool). Every title, summary, requirement and command from the plan or a tracker prints inside a fence.
import { oneLine, fenceInline } from '../../lib/sanitize.ts';
import { deriveAll } from '../../lib/flow/state.ts';
import { depsFromModel } from '../../lib/flow/deps.ts';
import { buildBrief } from '../../lib/flow/brief.ts';
import { rtm } from '../../lib/flow/rtm.ts';
import { actions } from '../../lib/flow/actions.ts';
import { isClosed } from '../../lib/frozen.ts';
import { fenceBlock, usage, verbose, needBrain } from './shared.ts';
import { loadFlow, needTask } from './flow-util.ts';
import type { Repo } from '../../lib/graph/files.ts';
import type { Ctx, Args } from '../context.ts';
import type { CommandMap } from '../registry.ts';

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
type V = { for?: string; limit?: number; req?: string };

function next(ctx: Ctx, args: Args<V>): number {
  const { model, extras } = loadFlow(ctx), me = args.values.for, limit = args.values.limit ?? 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw usage('--limit must be a whole number from 1 to 200');
  const keys = [...model.tickets.keys()].filter((k) => !isClosed(model, k)).sort(cmp);
  const st = deriveAll(keys, extras.events, depsFromModel(model), { now: ctx.now() });
  const rows = keys.filter((k) => st.get(k)?.state === 'ready').map((k) => ({ k, owner: String(model.sched.get(k)?.owner ?? ''), sprint: Number(model.sched.get(k)?.sprint ?? 1e9), t: model.tickets.get(k)?.summary ?? '' }));
  rows.sort((a, b) => Number(Boolean(me) && b.owner === me) - Number(Boolean(me) && a.owner === me) || a.sprint - b.sprint || cmp(a.k, b.k));
  const shown = rows.slice(0, limit);
  ctx.io.data?.({ ready: shown.map((r) => ({ key: r.k, owner: r.owner || null, own: Boolean(me) && r.owner === me })), omitted: rows.length - shown.length }, { next: [] });
  if (!shown.length) { ctx.io.out('no ready task'); return 0; }
  for (const r of shown) ctx.io.out(`${oneLine(r.k, 80)}${me && r.owner === me ? ' (yours)' : ''} ${r.owner ? oneLine(r.owner, 40) : 'unowned'} ${fenceInline(r.t, 60)}`);
  if (rows.length > shown.length) ctx.io.out(`omitted ${rows.length - shown.length}, raise --limit`);
  return 0;
}

function brief(ctx: Ctx, args: Args): number {
  const key = args.positionals[1];
  if (!key) throw usage('usage: plangraph flow brief KEY [-v]');
  const { model, extras } = loadFlow(ctx);
  needTask(model, key);
  const files = [...new Set(extras.repos.flatMap((r) => r.touched[key] ?? []))].sort(cmp);
  const b = buildBrief(model, key, { requirements: extras.requirements, decisions: extras.decisions, repos: extras.repos as unknown as Repo[], links: extras.links, task: { files } });
  ctx.io.data?.({ key: b.key, title: b.title, owner: b.owner, repos: b.repos, requirements: b.requirements, decisions: b.decisions, files: b.files, ask: b.ask, omitted: b.omitted }, { next: [] });
  ctx.io.outBlock(b.text.split('\n'));
  if (verbose(args)) {
    const d = deriveAll([key], extras.events, depsFromModel(model), { now: ctx.now() }).get(key);
    ctx.io.out(`state ${d?.state ?? 'ready'}${d?.evidence.length ? ` evidence ${d.evidence.map((e) => oneLine(e, 60)).join(' ')}` : ''}`);
    for (const f of d?.findings ?? []) ctx.io.out(`${f.code} ${oneLine(f.detail, 120)}`);
  }
  return 0;
}

function status(ctx: Ctx, args: Args<V>): number {
  const { model, extras } = loadFlow(ctx), want = args.values.req;
  let rows = rtm(model, extras.events, { requirements: extras.requirements, links: extras.links });
  if (want !== undefined) { rows = rows.filter((r) => r.requirement === want); if (!rows.length) throw usage(`no requirement ${oneLine(want, 80)}`); }
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
  ctx.io.data?.({ requirements: rows.map((r) => ({ id: r.requirement, status: r.status, tasks: r.tasks })), counts }, { next: [] });
  if (!rows.length) { ctx.io.out('no requirement'); return 0; }
  const cap = verbose(args) ? 500 : 40;
  for (const r of rows.slice(0, cap)) ctx.io.out(`${fenceInline(r.requirement, 40)} ${r.status}${r.tasks.length ? ` ${r.tasks.slice(0, 6).map((t) => `${oneLine(t.key, 40)}:${t.state}`).join(' ')}${r.tasks.length > 6 ? ` +${r.tasks.length - 6}` : ''}` : ''}`);
  if (rows.length > cap) ctx.io.out(`omitted ${rows.length - cap}, -v lifts the cap`);
  return 0;
}

function acts(ctx: Ctx, args: Args): number {
  const { model, extras } = loadFlow(ctx);
  const db = ctx.db();
  const obs = db.older ? [] : (db.all('SELECT sys, xid, "type", fields, links, seen FROM obs') as never[]);
  const list = actions(model, obs, { xrefs: extras.xrefs as never, events: extras.events });
  ctx.io.data?.({ actions: list.slice(0, 2000) }, { next: [] });
  if (!list.length) { ctx.io.out('no tracker action'); return 0; }
  const cap = verbose(args) ? 200 : 40;
  const lines = list.slice(0, cap).map((a) => `${a.op} ${oneLine(a.sys, 60)} ${oneLine(a.task, 80)} ${oneLine(JSON.stringify(a.fields), 200)}`);
  ctx.io.outBlock(fenceBlock('flow', lines));
  if (list.length > cap) ctx.io.out(`omitted ${list.length - cap}`);
  return 0;
}

function flow(ctx: Ctx, args: Args<V>): number {
  needBrain(ctx);
  const sub = args.positionals[0];
  if (sub === 'next') return next(ctx, args);
  if (sub === 'brief') return brief(ctx, args);
  if (sub === 'status') return status(ctx, args);
  if (sub === 'actions') return acts(ctx, args);
  throw usage('usage: plangraph flow next [--for PERSON] [--limit N] | brief KEY [-v] | status [--req ID] | actions');
}

export const commands: CommandMap = {
  flow: {
    run: flow as never, positionals: [1, 2], writes: 'none', guard: 'soft', options: { for: { type: 'string' }, limit: { type: 'integer' }, req: { type: 'string' } },
    summary: 'next [--for PERSON] [--limit N] | brief KEY [-v] | status [--req ID] | actions: ready tasks, the task brief, requirement traceability, tracker actions (read-only)',
  },
};
