// lib/ready.ts: the definition of ready, in ONE place. `plangraph ready` (src/commands/queries.ts; its bulk form `--person/--sprint` through
// readyScope) and `plangraph report` (lib/report.ts) call it, so they cannot drift apart; the rules themselves are lib/graph/blockers.ts
// blockersOf, which readiness runs over the model (or over any BlockerSource). Pure: plain model data in, plain data out; no I/O, no clock.
// May this ticket be started now? In this order:
//  1. not in the plan -> { found: false };
//  2. DONE: its own status is closed (an sp: task: impl_status done; any other: the Jira status from the snapshot when given, else the
//     stored jira_status, is `Done` or one of config.closed_statuses) -> never ready, no further reasons;
//  3. reasons, in this order: a readiness verdict other than READY; each finding of the ticket whose kind has no closed open item (finding
//     order); each open register item of the ticket whose kind no finding already named (lib/openitems.ts blockingItems order); each
//     producer in the plan (model.prods: sorted, ignored link kinds left out) that is not done by doneOf (an sp: producer: its impl_status;
//     any other: its status), whatever the consumer's kind and wherever the producer sits. No reason -> ready.
import { blockersOf, doneIn, modelSource } from './graph/blockers.ts';
import type { BlockerReason, BlockerSource, Done, Readiness, Statuses } from './graph/blockers.ts';
import type { Model, Placement, PlanRecord } from './model.ts';
export type { Done, Readiness, Statuses } from './graph/blockers.ts';

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const isPlaced = (s: Placement | undefined): s is { owner: string; sprint: number } => !!s && typeof s.owner === 'string' && s.owner !== '' && Number.isInteger(s.sprint);

/** The closed Jira statuses: `Done` always, plus the strings of config.closed_statuses. */
export const closedStatuses = (config: { closed_statuses?: unknown } | null | undefined): Set<string> => new Set(['Done', ...(Array.isArray(config?.closed_statuses) ? config.closed_statuses.filter((s: unknown): s is string => typeof s === 'string') : [])]);

/** Why a ticket is not ready, discriminated on code (an OPEN_ITEM further on from). */
export type Reason = BlockerReason;
/** items: open-items rows; findingsOf: the findings of each key (readySet builds it once); source: the blocker facts when not the model's own. */
export interface ReadyOpts { items?: readonly PlanRecord[]; statuses?: Statuses | null; closed?: Set<string>; findingsOf?: Map<string, PlanRecord[]>; source?: BlockerSource }

/** Is this ticket done by its own status? null when not, else how. */
export function doneOf(model: Model, key: string, { statuses = null, closed = closedStatuses(model.config) }: ReadyOpts = {}): Done | null {
  return doneIn(modelSource(model), key, { statuses, closed });
}

export function readiness(model: Model, key: string, { items = [], statuses = null, closed = closedStatuses(model.config), findingsOf, source = modelSource(model, { items, findingsOf }) }: ReadyOpts = {}): Readiness {
  return blockersOf(source, key, { statuses, closed });
}

/** Every ticket (or only `keys`: the tickets of the plan among them), sorted by key: ready (may start now), done (own status closed),
 * blocked (with the open finding or item kinds), waiting (a producer not closed), verdict (a readiness verdict other than READY). A
 * not-ready ticket can be in several of blocked, waiting and verdict. items: open-items rows; statuses: an optional { KEY: { status } }
 * Jira snapshot. */
export interface ReadySet { ready: string[]; done: string[]; blocked: Array<{ key: string; kinds: string[] }>; waiting: string[]; verdict: string[] }
export function readySet(model: Model, items: readonly PlanRecord[] = [], statuses: Statuses | null = null, { keys }: { keys?: Iterable<string> } = {}): ReadySet {
  const closed = closedStatuses(model.config), findingsOf = new Map<string, PlanRecord[]>();
  for (const f of model.findings || []) { if (!findingsOf.has(f.key as string)) findingsOf.set(f.key as string, []); (findingsOf.get(f.key as string) as PlanRecord[]).push(f); } // findings rows are validated: key is a string; set just before
  const source = modelSource(model, { items, findingsOf }); // built once for the whole set
  const ready: string[] = [], done: string[] = [], blocked: Array<{ key: string; kinds: string[] }> = [], waiting: string[] = [], verdict: string[] = [];
  const list = keys === undefined ? [...model.tickets.keys()] : [...new Set(keys)].filter((k) => model.tickets.has(k));
  for (const key of list.sort(cmp)) {
    const r = readiness(model, key, { items, statuses, closed, findingsOf, source });
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
