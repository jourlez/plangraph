// Drift between the plan and the observation cache (docs/superpowers/plans/2026-11-25-graph-v2-amendment.md section 3.4). Pure: rows in,
// findings out, no file, no clock, no network. The plan files are the authority for the planned owner, sprint and `needs`; the tracker
// observation is the authority for status, real assignee and real sprint. A finding is advisory: nothing here writes a file.
// Codes: DRIFT_ASSIGNEE, UNMAPPED_ASSIGNEE, DRIFT_SPRINT, DRIFT_DONE, DRIFT_LINK, XREF_STALE, XREF_ORPHAN. The same input gives the same findings in the same order.

import { resolve } from '../identity.ts';
import type { IdentityMap } from '../identity.ts';

const DRIFT_CODES = Object.freeze(['DRIFT_ASSIGNEE', 'UNMAPPED_ASSIGNEE', 'DRIFT_SPRINT', 'DRIFT_DONE', 'DRIFT_LINK', 'XREF_STALE', 'XREF_ORPHAN'] as const);
type DriftCode = (typeof DRIFT_CODES)[number];
export const DEFAULT_STALE_DAYS = 14;

interface DriftTicket { key: string; jira_status?: unknown; impl_status?: unknown }
interface DriftSchedule { key: string; owner?: unknown; sprint?: unknown }
interface DriftEdge { consumer: string; producer: string }
interface DriftXref { type: string; id: string; sys: string; xid: string }
interface DriftObs { sys: string; xid: string; type: string; fields: unknown; links: unknown; seen: string }
export interface DriftInput {
  tickets: readonly DriftTicket[]; /** rows of the `current` schedule version only */ schedule: readonly DriftSchedule[];
  edges: readonly DriftEdge[]; xrefs: readonly DriftXref[]; obs: readonly DriftObs[];
  /** the closed tracker statuses (`Done` and config.closed_statuses), compared case-insensitively */ closed: ReadonlySet<string>;
  staleDays: number; /** YYYY-MM-DD */ today: string;
  /** the local identity map (task 14). Absent: an assignee differing from the owner is DRIFT_ASSIGNEE as before. Present: DRIFT_ASSIGNEE only when
   * `<sys>:<assignee>` resolves to a person other than the owner, and UNMAPPED_ASSIGNEE when it resolves to none. */
  identities?: IdentityMap | undefined;
}
/** One finding. `key` is the plan node (a ticket key) or, for an xref finding that names no ticket, `<sys>:<xid>`. `plan` is the plan side
 * (plangraph text), `ext` the observed side (untrusted tracker text: the printer fences it). */
export interface Finding { code: DriftCode; key: string; sys: string; xid: string; plan?: string; ext?: string }

const isObj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);
const parse = (x: unknown): unknown => { if (typeof x !== 'string') return x; try { return JSON.parse(x); } catch { return null; } };
const fieldsOf = (o: DriftObs): Record<string, unknown> => { const f = parse(o.fields); return isObj(f) ? f : {}; };
const linksOf = (o: DriftObs): Array<{ rel: string; sys: string; xid: string }> => {
  const l = parse(o.links);
  return Array.isArray(l) ? l.filter((x): x is { rel: string; sys: string; xid: string } => isObj(x) && typeof x.rel === 'string' && typeof x.xid === 'string') : [];
};
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
const lc = (v: unknown): string => str(v).toLowerCase();
/** Whole days from `a` to `b` (YYYY-MM-DD each); NaN when either is not a date. */
function daysBetween(a: string, b: string): number { return Math.floor((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000); }
const sysName = (s: string): string => (s.includes(':') ? s.slice(0, s.indexOf(':')) : s);
/** Providers whose observation id is the plan ticket key itself (`jira:<alias>` and `sp`). */
const DIRECT = new Set(['jira', 'sp']);

export function drift(inp: DriftInput): Finding[] {
  const tickets = new Map(inp.tickets.map((t) => [t.key, t]));
  const sched = new Map(inp.schedule.map((s) => [s.key, s]));
  const edges = new Set(inp.edges.map((e) => `${e.consumer}\0${e.producer}`));
  const closed = new Set([...inp.closed].map((s) => s.toLowerCase()));
  const byRef = new Map<string, string[]>(); // `sys\0xid` -> plan ticket keys that carry that xref
  for (const x of inp.xrefs) if (x.type === 'ticket') { const k = `${x.sys}\0${x.xid}`, l = byRef.get(k); if (l) l.push(x.id); else byRef.set(k, [x.id]); }
  const obsKeys = new Set(inp.obs.map((o) => `${o.sys}\0${o.xid}`)), obsSys = new Set(inp.obs.map((o) => o.sys));
  const planKeysOf = (sys: string, xid: string): string[] => {
    const out = new Set(byRef.get(`${sys}\0${xid}`) ?? []);
    if (DIRECT.has(sysName(sys)) && tickets.has(xid)) out.add(xid);
    return [...out].filter((k) => tickets.has(k)).sort();
  };
  const out: Finding[] = [], seen = new Set<string>();
  const push = (f: Finding): void => { const id = `${f.code}\0${f.key}\0${f.sys}\0${f.xid}`; if (!seen.has(id)) { seen.add(id); out.push(f); } };
  const isDone = (t: DriftTicket): boolean => t.impl_status === 'done' || closed.has(lc(t.jira_status));

  for (const o of inp.obs) {
    const f = fieldsOf(o), keys = planKeysOf(o.sys, o.xid), base = { sys: o.sys, xid: o.xid };
    if (keys.length) {
      const age = daysBetween(o.seen, inp.today);
      if (Number.isFinite(age) && age > inp.staleDays) push({ code: 'XREF_STALE', key: keys[0] as string, ...base, plan: `${age} days old` });
    }
    if (o.type !== 'ticket') continue;
    for (const key of keys) {
      const t = tickets.get(key) as DriftTicket, s = sched.get(key);
      const owner = str(s?.owner), who = str(f.assignee);
      if (owner && who && owner.toLowerCase() !== who.toLowerCase()) {
        if (!inp.identities) push({ code: 'DRIFT_ASSIGNEE', key, ...base, plan: owner, ext: who });
        else {
          const person = resolve(inp.identities, `${o.sys}:${who}`);
          if (person === null) push({ code: 'UNMAPPED_ASSIGNEE', key, ...base, plan: owner, ext: who });
          else if (person.toLowerCase() !== owner.toLowerCase()) push({ code: 'DRIFT_ASSIGNEE', key, ...base, plan: owner, ext: who });
        }
      }
      const sp = Number.isSafeInteger(s?.sprint) ? String(s?.sprint) : '', real = str(f.sprint).split(',').map((x) => x.trim()).filter(Boolean).at(-1) ?? '';
      if (sp && real && sp !== real) push({ code: 'DRIFT_SPRINT', key, ...base, plan: `S${sp}`, ext: real });
      const status = str(f.status);
      if (status) {
        const trackerDone = closed.has(status.toLowerCase()), planDone = isDone(t);
        if (trackerDone !== planDone) push({ code: 'DRIFT_DONE', key, ...base, plan: planDone ? 'done' : 'open', ext: status });
      }
      for (const l of linksOf(o)) { // a tracker `A blocks B` is the plan edge `B needs A`
        if (!l.rel.endsWith('/blocks')) continue;
        for (const b of planKeysOf(l.sys, l.xid)) if (b !== key && !edges.has(`${b}\0${key}`)) push({ code: 'DRIFT_LINK', key: b, ...base, plan: `needs ${key} missing` });
      }
    }
  }
  // an xref whose target the cache does not hold, in a system the cache does hold something for (no cache for the system: nothing to compare)
  for (const x of inp.xrefs) if (obsSys.has(x.sys) && !obsKeys.has(`${x.sys}\0${x.xid}`)) push({ code: 'XREF_ORPHAN', key: x.type === 'ticket' ? x.id : `${x.type}/${x.id}`, sys: x.sys, xid: x.xid });
  const order = new Map(DRIFT_CODES.map((c, i) => [c, i]));
  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return out.sort((a, b) => (order.get(a.code) as number) - (order.get(b.code) as number) || cmp(a.key, b.key) || cmp(a.sys, b.sys) || cmp(a.xid, b.xid));
}
