// Tracker operations still missing (spec 5.2 step 4), as data for the agent to run through the vendor tool. Pure: nothing here calls a tracker.
// A plan task is a ticket whose key starts with `sp:`. Observations are the tracker cache rows (drift.ts DriftObs shape): `fields` is an object
// or its JSON text and may hold `status`; `fields.task` names the plan task a tracker ticket was created for.
import type { Model } from '../model.ts';
import type { Xref } from '../graph/files.ts';
import { closedStatuses } from '../frozen.ts';
import { deriveAll } from './state.ts';
import type { EventIn } from './state.ts';
import { depsFromModel } from './deps.ts';

export interface ActionObs { sys: string; xid: string; type?: string; fields: unknown; links?: unknown; seen?: string }
export interface Action { op: 'create_ticket' | 'transition_ticket' | 'link'; sys: string; task: string; fields: Record<string, unknown> }
export interface ActionExtras { xrefs?: readonly Xref[]; events?: readonly EventIn[]; /** the tracker for new tickets, default `jira` */ sys?: string; /** the status that means done, default `Done` */ doneStatus?: string }

const isObj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);
const fieldsOf = (o: ActionObs): Record<string, unknown> => {
  let f = o.fields;
  if (typeof f === 'string') { try { f = JSON.parse(f); } catch { f = null; } }
  return isObj(f) ? f : {};
};
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function actions(model: Model, obs: readonly ActionObs[], extras: ActionExtras = {}): Action[] {
  const sys = extras.sys ?? 'jira', done = extras.doneStatus ?? 'Done', closed = new Set([...closedStatuses(model.config)].map((s) => s.toLowerCase()));
  const tasks = [...model.tickets.keys()].filter((k) => k.startsWith('sp:')).sort(cmp);
  const state = deriveAll(tasks, extras.events ?? [], depsFromModel(model));
  const tracked = new Map<string, Xref>();
  for (const x of extras.xrefs ?? []) if (x.type === 'ticket' && tasks.includes(x.id) && !tracked.has(x.id)) tracked.set(x.id, x);
  const seen = new Map(obs.map((o) => [`${o.sys}\0${o.xid}`, o]));
  const out: Action[] = [];
  for (const task of tasks) {
    const t = model.tickets.get(task), st = (state.get(task) as { state: string }).state, x = tracked.get(task);
    if (!x) {
      const linked = obs.find((o) => fieldsOf(o).task === task);
      if (linked) out.push({ op: 'link', sys: linked.sys, task, fields: { xid: linked.xid } });
      else if (st !== 'removed' && st !== 'skipped') out.push({ op: 'create_ticket', sys, task, fields: { summary: t?.summary ?? task, ...(t?.sp != null ? { sp: t.sp } : {}), ...(t?.epic ? { epic: t.epic } : {}) } });
      continue;
    }
    const planDone = st === 'done' || t?.impl_status === 'done', o = seen.get(`${x.sys}\0${x.xid}`), status = o ? fieldsOf(o).status : undefined;
    if (planDone && typeof status === 'string' && !closed.has(status.toLowerCase()) && status.toLowerCase() !== done.toLowerCase()) out.push({ op: 'transition_ticket', sys: x.sys, task, fields: { xid: x.xid, from: status, to: done } });
  }
  return out;
}
