// lib/ready.ts: the definition of ready, in ONE place. `plangraph ready` (src/commands/queries.ts; its bulk form `--person/--sprint` through
// readyScope), `plangraph blockers` and `plangraph report` (lib/report.ts) all call it, so they cannot drift apart. Pure: plain model data in, plain data out; no I/O, no clock.
// May this ticket be started now? In this order:
//  1. not in the plan -> { found: false };
//  2. DONE: its own status is closed (an sp: task: impl_status done; any other: the Jira status from the snapshot when given, else the
//     stored jira_status, is `Done` or one of config.closed_statuses) -> never ready, no further reasons;
//  3. reasons, in this order: a readiness verdict other than READY; each finding of the ticket whose kind has no closed open item (finding
//     order); each open register item of the ticket whose kind no finding already named (lib/openitems.ts blockingItems order); each
//     producer in the plan (model.prods: sorted, ignored link kinds left out) that is not done by doneOf (an sp: producer: its impl_status;
//     any other: its status), whatever the consumer's kind and wherever the producer sits. No reason -> ready.
import { blockingItems, closedSet } from './openitems.ts';
import type { OpenItem } from './openitems.ts';
import type { Model, Placement, PlanRecord } from './model.ts';

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const spKey = (k: unknown): boolean => String(k).startsWith('sp:');
const isPlaced = (s: Placement | undefined): s is { owner: string; sprint: number } => !!s && typeof s.owner === 'string' && s.owner !== '' && Number.isInteger(s.sprint);

/** The closed Jira statuses: `Done` always, plus the strings of config.closed_statuses. */
export const closedStatuses = (config: { closed_statuses?: unknown } | null | undefined): Set<string> => new Set(['Done', ...(Array.isArray(config?.closed_statuses) ? config.closed_statuses.filter((s: unknown): s is string => typeof s === 'string') : [])]);

/** Why a ticket is not ready, discriminated on code (an OPEN_ITEM further on from). */
export type Reason = { code: 'VERDICT'; verdict: string } | { code: 'OPEN_ITEM'; from: 'finding'; kind: string; text: string }
  | { code: 'OPEN_ITEM'; from: 'item'; kind: string; owner: string; text: string }
  | { code: 'WAITS'; key: string; status: string | null; impl: boolean; place: { sprint: number; owner: string } | null };
/** How a ticket is done by its own status. */
export interface Done { by: 'status' | 'impl'; status: string }
export interface Readiness { found: boolean; ready: boolean; done: Done | null; reasons: Reason[] }
/** A Jira snapshot of statuses: { KEY: { status } }, unchecked (each status is tested before use). */
export type Statuses = Readonly<Record<string, { status?: unknown } | null | undefined>>;
/** items: open-items rows; findingsOf: the findings of each key (readySet builds it once). */
export interface ReadyOpts { items?: readonly PlanRecord[]; statuses?: Statuses | null; closed?: Set<string>; findingsOf?: Map<string, PlanRecord[]> }

/** The status a ticket has now: the snapshot's when it names the key, else the stored one. */
const statusOf = (statuses: Statuses | null | undefined, key: string, stored: unknown): unknown => (statuses && Object.hasOwn(statuses, key) ? statuses[key]?.status : stored);

/** Is this ticket done by its own status? null when not, else how. */
export function doneOf(model: Model, key: string, { statuses = null, closed = closedStatuses(model.config) }: ReadyOpts = {}): Done | null {
  const t = model.tickets.get(key);
  if (!t) return null;
  if (spKey(key)) return t.impl_status === 'done' ? ({ by: 'impl', status: 'done' } as const) : null; // literal object: by and status keep their literal types
  const st = statusOf(statuses, key, t.jira_status);
  return typeof st === 'string' && closed.has(st) ? ({ by: 'status', status: st } as const) : null; // literal object: by keeps its literal type
}

export function readiness(model: Model, key: string, { items = [], statuses = null, closed = closedStatuses(model.config), findingsOf }: ReadyOpts = {}): Readiness {
  const t = model.tickets.get(key);
  if (!t) return { found: false, ready: false, done: null, reasons: [] };
  const done = doneOf(model, key, { statuses, closed });
  if (done) return { found: true, ready: false, done, reasons: [] };
  const reasons: Reason[] = [];
  if (t.verdict && t.verdict !== 'READY') reasons.push({ code: 'VERDICT', verdict: String(t.verdict) });
  const shut = closedSet(items as readonly OpenItem[]), seen = new Set<unknown>(); // open-items rows: key and kind are checked on load (lib/schema)
  const fs = findingsOf ? findingsOf.get(key) || [] : (model.findings || []).filter((f) => f.key === key);
  for (const f of fs) if (!shut.has(`${key}|${f.kind}`)) { seen.add(f.kind); reasons.push({ code: 'OPEN_ITEM', from: 'finding', kind: f.kind as string, text: (f.text ?? '') as string }); } // findings rows are validated: kind and text are strings
  for (const i of blockingItems(items as readonly OpenItem[], key)) if (!seen.has(i.kind)) reasons.push({ code: 'OPEN_ITEM', from: 'item', kind: i.kind, owner: i.owner || '', text: i.text || '' }); // open-items rows: key and kind are checked on load (lib/schema)
  for (const p of model.prods.get(key) || []) {
    const pt = model.tickets.get(p);
    if (!pt) continue; // a link to a ticket that is not in the plan
    const s = model.sched.get(p), place = isPlaced(s) ? { sprint: s.sprint, owner: s.owner } : null;
    // producer-done is doneOf(producer) for ANY consumer: an sp: producer by its impl_status, a Jira producer by its status; a done producer
    // never blocks, wherever it sits (frozen history)
    if (doneOf(model, p, { statuses, closed })) continue;
    if (spKey(p)) reasons.push({ code: 'WAITS', key: p, status: pt.impl_status || 'todo', impl: true, place });
    else { const st = statusOf(statuses, p, pt.jira_status); reasons.push({ code: 'WAITS', key: p, status: st ? String(st) : null, impl: false, place }); }
  }
  return { found: true, ready: !reasons.length, done: null, reasons };
}

/** Every ticket (or only `keys`: the tickets of the plan among them), sorted by key: ready (may start now), done (own status closed),
 * blocked (with the open finding or item kinds), waiting (a producer not closed), verdict (a readiness verdict other than READY). A
 * not-ready ticket can be in several of blocked, waiting and verdict. items: open-items rows; statuses: an optional { KEY: { status } }
 * Jira snapshot. */
export interface ReadySet { ready: string[]; done: string[]; blocked: Array<{ key: string; kinds: string[] }>; waiting: string[]; verdict: string[] }
export function readySet(model: Model, items: readonly PlanRecord[] = [], statuses: Statuses | null = null, { keys }: { keys?: Iterable<string> } = {}): ReadySet {
  const closed = closedStatuses(model.config), findingsOf = new Map<string, PlanRecord[]>();
  for (const f of model.findings || []) { if (!findingsOf.has(f.key as string)) findingsOf.set(f.key as string, []); (findingsOf.get(f.key as string) as PlanRecord[]).push(f); } // findings rows are validated: key is a string; set just before
  const ready: string[] = [], done: string[] = [], blocked: Array<{ key: string; kinds: string[] }> = [], waiting: string[] = [], verdict: string[] = [];
  const list = keys === undefined ? [...model.tickets.keys()] : [...new Set(keys)].filter((k) => model.tickets.has(k));
  for (const key of list.sort(cmp)) {
    const r = readiness(model, key, { items, statuses, closed, findingsOf });
    if (r.done) { done.push(key); continue; }
    if (r.ready) { ready.push(key); continue; }
    const kinds = [...new Set(r.reasons.filter((x) => x.code === 'OPEN_ITEM').map((x) => String((x as Extract<Reason, { code: 'OPEN_ITEM' }>).kind)))].sort(cmp); // filtered to OPEN_ITEM just before
    if (kinds.length) blocked.push({ key, kinds });
    if (r.reasons.some((x) => x.code === 'WAITS')) waiting.push(key);
    if (r.reasons.some((x) => x.code === 'VERDICT')) verdict.push(key);
  }
  return { ready, done, blocked, waiting, verdict };
}

/** The bulk answer of `plangraph ready --person NAME --sprint N`: readySet over the tickets placed with that owner and/or in that sprint (at
 * least one filter; the owner is matched exactly: the caller resolves a name first). keys: the scope, sorted; notReady: the keys neither
 * ready nor done, so ready + done + notReady is the scope, each key once. */
export function readyScope(model: Model, { owner, sprint }: { owner?: string; sprint?: number } = {}, items: readonly PlanRecord[] = [], statuses: Statuses | null = null): ReadySet & { keys: string[]; notReady: string[] } {
  if (owner === undefined && sprint === undefined) throw new TypeError('readyScope needs an owner or a sprint');
  const keys: string[] = [];
  for (const [k, s] of model.sched) if (model.tickets.has(k) && isPlaced(s) && (owner === undefined || s.owner === owner) && (sprint === undefined || s.sprint === sprint)) keys.push(k);
  keys.sort(cmp);
  const r = readySet(model, items, statuses, { keys }), out = new Set([...r.ready, ...r.done]);
  return { keys, ...r, notReady: keys.filter((k) => !out.has(k)) };
}
