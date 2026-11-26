// The one blocker definition (lib/ready.ts, `plangraph ready`, `plangraph report` all reach it). `blockersOf` reads only gate and order
// relations through a BlockerSource: the verdict, the findings and open items of a ticket (held_by), and its producers (needs). A relation
// of any other meaning (REL_SEMANTICS in files.ts: trace, identity, info, group, load, slot) is never asked, so no link, xref or repo
// edge can change an answer. The source is the index (graphReader) or the in-memory model (modelSource): the same rules over both.
import { blockingItems, closedSet } from '../openitems.ts';
import type { OpenItem } from '../openitems.ts';
import type { Model, PlanRecord } from '../model.ts';
import type { BlockerSource } from './views.ts';
export type { BlockerSource } from './views.ts';

const spKey = (k: unknown): boolean => String(k).startsWith('sp:');
const isPlaced = (s: { owner: unknown; sprint: unknown } | null | undefined): s is { owner: string; sprint: number } => !!s && typeof s.owner === 'string' && s.owner !== '' && Number.isInteger(s.sprint);

/** Why a ticket is not ready, discriminated on code (an OPEN_ITEM further on from). */
export type BlockerReason = { code: 'VERDICT'; verdict: string } | { code: 'OPEN_ITEM'; from: 'finding'; kind: string; text: string }
  | { code: 'OPEN_ITEM'; from: 'item'; kind: string; owner: string; text: string }
  | { code: 'WAITS'; key: string; status: string | null; impl: boolean; place: { sprint: number; owner: string } | null };
/** How a ticket is done by its own status. */
export interface Done { by: 'status' | 'impl'; status: string }
export interface Readiness { found: boolean; ready: boolean; done: Done | null; reasons: BlockerReason[] }
/** A Jira snapshot of statuses: { KEY: { status } }, unchecked (each status is tested before use). */
export type Statuses = Readonly<Record<string, { status?: unknown } | null | undefined>>;
export interface BlockerOpts { statuses?: Statuses | null; closed: ReadonlySet<string>; ignore?: ReadonlySet<string> }

/** The status a ticket has now: the snapshot's when it names the key, else the stored one. */
const statusOf = (statuses: Statuses | null | undefined, key: string, stored: unknown): unknown => (statuses && Object.hasOwn(statuses, key) ? statuses[key]?.status : stored);

/** Is this ticket done by its own status? null when not, else how (an sp: task by impl_status, any other by its Jira status). */
export function doneIn(src: BlockerSource, key: string, { statuses = null, closed }: Pick<BlockerOpts, 'statuses' | 'closed'>): Done | null {
  const t = src.ticket(key);
  if (!t) return null;
  if (spKey(key)) return t.impl_status === 'done' ? ({ by: 'impl', status: 'done' } as const) : null; // literal object: by and status keep their literal types
  const st = statusOf(statuses, key, t.jira_status);
  return typeof st === 'string' && closed.has(st) ? ({ by: 'status', status: st } as const) : null; // literal object: by keeps its literal type
}

/** May this ticket be started now: the reasons it may not, in the order of the header of lib/ready.ts. */
export function blockersOf(src: BlockerSource, key: string, { statuses = null, closed, ignore }: BlockerOpts): Readiness {
  const t = src.ticket(key);
  if (!t) return { found: false, ready: false, done: null, reasons: [] };
  const done = doneIn(src, key, { statuses, closed });
  if (done) return { found: true, ready: false, done, reasons: [] };
  const reasons: BlockerReason[] = [], seen = new Set<string>();
  if (t.verdict && t.verdict !== 'READY') reasons.push({ code: 'VERDICT', verdict: t.verdict });
  for (const f of src.findings(key)) if (!src.shut(key, f.kind)) { seen.add(f.kind); reasons.push({ code: 'OPEN_ITEM', from: 'finding', kind: f.kind, text: f.text }); }
  for (const i of src.openItems(key)) if (!seen.has(i.kind)) reasons.push({ code: 'OPEN_ITEM', from: 'item', kind: i.kind, owner: i.owner, text: i.text });
  for (const { key: p, kind } of src.producers(key)) {
    if (kind !== null && ignore?.has(kind)) continue;
    const pt = src.ticket(p);
    if (!pt) continue; // a link to a ticket that is not in the plan
    // producer-done is doneIn(producer) for ANY consumer: a done producer never blocks, wherever it sits (frozen history)
    if (doneIn(src, p, { statuses, closed })) continue;
    const s = src.place(p), place = isPlaced(s) ? { sprint: s.sprint, owner: s.owner } : null;
    if (spKey(p)) reasons.push({ code: 'WAITS', key: p, status: pt.impl_status || 'todo', impl: true, place });
    else { const st = statusOf(statuses, p, pt.jira_status); reasons.push({ code: 'WAITS', key: p, status: st ? String(st) : null, impl: false, place }); }
  }
  return { found: true, ready: !reasons.length, done: null, reasons };
}

const str = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
/** A BlockerSource over the loaded model (model.prods already leaves ignored link kinds out). items: open-items rows; findingsOf: the findings by key. */
export function modelSource(model: Model, { items = [], findingsOf }: { items?: readonly PlanRecord[]; findingsOf?: Map<string, PlanRecord[]> | undefined } = {}): BlockerSource {
  const rows = items as readonly OpenItem[], shut = closedSet(rows);
  return {
    ticket(key) {
      const t = model.tickets.get(key);
      return t ? { verdict: str(t.verdict), jira_status: str(t.jira_status), impl_status: t.impl_status === null || t.impl_status === undefined ? null : str(t.impl_status) } : null;
    },
    shut: (key, kind) => shut.has(`${key}|${kind}`),
    place: (key) => model.sched.get(key) ?? null,
    findings(key) {
      return (findingsOf ? findingsOf.get(key) || [] : (model.findings || []).filter((f) => f.key === key)).map((f) => ({ kind: f.kind as string, text: (f.text ?? '') as string })); // findings rows are validated: kind and text are strings
    },
    openItems: (key) => blockingItems(rows, key).map((i) => ({ key: i.key, kind: i.kind, status: str(i.status), owner: i.owner || '', text: i.text || '' })),
    producers: (key) => (model.prods.get(key) || []).map((p) => ({ key: p, kind: null })),
  };
}
