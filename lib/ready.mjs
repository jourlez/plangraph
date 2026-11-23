// lib/ready.mjs: the definition of ready, in ONE place. `brain ready` (src/commands/queries.mjs), `brain blockers` and `brain report`
// (lib/report.mjs) all call it, so they cannot drift apart. Pure: plain model data in, plain data out; no I/O, no clock.
// May this ticket be started now? In this order:
//  1. not in the plan -> { found: false };
//  2. DONE: its own status is closed (an sp: task: impl_status done; any other: the Jira status from the snapshot when given, else the
//     stored jira_status, is `Done` or one of config.closed_statuses) -> never ready, no further reasons;
//  3. reasons, in this order: a readiness verdict other than READY; each finding of the ticket whose kind has no closed open item (finding
//     order); each open register item of the ticket whose kind no finding already named (lib/openitems.mjs blockingItems order); each
//     producer in the plan (model.prods: sorted, ignored link kinds left out) whose status is not closed (an sp: producer of an sp: task: its
//     impl_status is not done). No reason -> ready.
import { blockingItems, closedSet } from './openitems.mjs';

const cmp = (/** @type {string} */ a, /** @type {string} */ b) => (a < b ? -1 : a > b ? 1 : 0);
const spKey = (/** @type {unknown} */ k) => String(k).startsWith('sp:');
const isPlaced = (/** @type {any} */ s) => !!s && typeof s.owner === 'string' && s.owner !== '' && Number.isInteger(s.sprint);

/** The closed Jira statuses: `Done` always, plus the strings of config.closed_statuses. @param {any} config @returns {Set<string>} */
export const closedStatuses = (config) => new Set(['Done', ...(Array.isArray(config?.closed_statuses) ? config.closed_statuses.filter((/** @type {unknown} */ s) => typeof s === 'string') : [])]);

/** @typedef {{ code: 'VERDICT', verdict: string } | { code: 'OPEN_ITEM', from: 'finding', kind: string, text: string }
 *   | { code: 'OPEN_ITEM', from: 'item', kind: string, owner: string, text: string }
 *   | { code: 'WAITS', key: string, status: string | null, impl: boolean, place: { sprint: number, owner: string } | null }} Reason */
/** @typedef {{ found: boolean, ready: boolean, done: { by: 'status' | 'impl', status: string } | null, reasons: Reason[] }} Readiness */
/** @typedef {{ items?: any[], statuses?: Record<string, { status?: unknown }> | null, closed?: Set<string>, findingsOf?: Map<string, any[]> }} ReadyOpts */

/** The status a ticket has now: the snapshot's when it names the key, else the stored one. */
/** @param {Record<string, any> | null | undefined} statuses @param {string} key @param {unknown} stored */
const statusOf = (statuses, key, stored) => (statuses && Object.hasOwn(statuses, key) ? statuses[key]?.status : stored);

/** Is this ticket done by its own status? null when not, else how. @param {any} model @param {string} key @param {ReadyOpts} [opts] */
export function doneOf(model, key, { statuses = null, closed = closedStatuses(model.config) } = {}) {
  const t = model.tickets.get(key);
  if (!t) return null;
  if (spKey(key)) return t.impl_status === 'done' ? /** @type {const} */ ({ by: 'impl', status: 'done' }) : null;
  const st = statusOf(statuses, key, t.jira_status);
  return typeof st === 'string' && closed.has(st) ? /** @type {const} */ ({ by: 'status', status: st }) : null;
}

/** @param {any} model @param {string} key @param {ReadyOpts} [opts] @returns {Readiness} */
export function readiness(model, key, { items = [], statuses = null, closed = closedStatuses(model.config), findingsOf } = {}) {
  const t = model.tickets.get(key);
  if (!t) return { found: false, ready: false, done: null, reasons: [] };
  const done = doneOf(model, key, { statuses, closed });
  if (done) return { found: true, ready: false, done, reasons: [] };
  /** @type {Reason[]} */ const reasons = [];
  if (t.verdict && t.verdict !== 'READY') reasons.push({ code: 'VERDICT', verdict: String(t.verdict) });
  const shut = closedSet(items), seen = new Set();
  const fs = findingsOf ? findingsOf.get(key) || [] : (model.findings || []).filter((/** @type {any} */ f) => f.key === key);
  for (const f of fs) if (!shut.has(`${key}|${f.kind}`)) { seen.add(f.kind); reasons.push({ code: 'OPEN_ITEM', from: 'finding', kind: f.kind, text: f.text ?? '' }); }
  for (const i of blockingItems(items, key)) if (!seen.has(i.kind)) reasons.push({ code: 'OPEN_ITEM', from: 'item', kind: i.kind, owner: i.owner || '', text: i.text || '' });
  for (const p of model.prods.get(key) || []) {
    const pt = model.tickets.get(p);
    if (!pt) continue; // a link to a ticket that is not in the plan
    const s = model.sched.get(p), place = isPlaced(s) ? { sprint: s.sprint, owner: s.owner } : null;
    if (spKey(key) && spKey(p)) { if (pt.impl_status !== 'done') reasons.push({ code: 'WAITS', key: p, status: pt.impl_status || 'todo', impl: true, place }); continue; }
    const st = statusOf(statuses, p, pt.jira_status);
    if (!(typeof st === 'string' && closed.has(st))) reasons.push({ code: 'WAITS', key: p, status: st ? String(st) : null, impl: false, place });
  }
  return { found: true, ready: !reasons.length, done: null, reasons };
}

/** Every ticket, sorted by key: ready (may start now), done (own status closed), blocked (with the open finding or item kinds), waiting
 * (a producer not closed). items: open-items rows; statuses: an optional { KEY: { status } } Jira snapshot. */
/** @param {any} model @param {any[]} [items] @param {Record<string, any> | null} [statuses] */
export function readySet(model, items = [], statuses = null) {
  const closed = closedStatuses(model.config), findingsOf = new Map();
  for (const f of model.findings || []) { if (!findingsOf.has(f.key)) findingsOf.set(f.key, []); findingsOf.get(f.key).push(f); }
  const ready = [], done = [], blocked = [], waiting = [];
  for (const key of [...model.tickets.keys()].sort(cmp)) {
    const r = readiness(model, key, { items, statuses, closed, findingsOf });
    if (r.done) { done.push(key); continue; }
    if (r.ready) { ready.push(key); continue; }
    const kinds = [...new Set(r.reasons.filter((x) => x.code === 'OPEN_ITEM').map((x) => String(/** @type {any} */ (x).kind)))].sort(cmp);
    if (kinds.length) blocked.push({ key, kinds });
    if (r.reasons.some((x) => x.code === 'WAITS')) waiting.push(key);
  }
  return { ready, done, blocked, waiting };
}
