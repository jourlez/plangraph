// The task state machine (spec 5.3), pure: events and an injected Deps in, a state, its evidence and findings out. No I/O, no model import.
// `ready` and `blocked` are computed from Deps, never stored. An event `to: 'ready'` is a release: it clears the asserted state back to the computed one.
// An event `to: 'blocked'` is always BAD_TRANSITION. Order is (at, seq, actor, bh8), then the event's own content, so file order never matters.

export type TaskState = 'proposed' | 'ready' | 'claimed' | 'in_progress' | 'in_review' | 'done' | 'blocked' | 'needs_input' | 'failed' | 'skipped' | 'removed';
type TaskEvent = { at: string; seq: number; actor: string; task: string; to: TaskState; by: string; evidence: string[]; note?: string; force?: boolean };
export type FlowFinding = { code: 'UNVERIFIED_DONE' | 'DONE_WITHOUT_EVIDENCE' | 'STALE_CLAIM' | 'DOUBLE_CLAIM' | 'BAD_TRANSITION'; key: string; detail: string };

/** What an event file row looks like on input: `to` is unchecked, `evidence` may be missing, `bh8` is the branch hash from lib/store2/batches.ts. */
export type EventIn = Omit<TaskEvent, 'to' | 'evidence'> & { to: string; evidence?: readonly string[]; bh8?: string };
/** Dependency and gate facts for a task, injected so this file never reads the model (see lib/flow/deps.ts). */
export interface Deps { openDeps(key: string): string[]; gated(key: string): boolean }
export interface DeriveOpts {
  /** Is this evidence ref (`pr:...`) a pull request merged to the default branch, per the observation cache? Default: nothing is merged. */
  merged?: (ref: string) => boolean;
  /** Now, for STALE_CLAIM. Without it no claim is stale. */
  now?: Date | number;
  /** `flow.claim_days`, default 7. */
  claimDays?: number;
  /** Is this producer done by an event? deriveAll fills it; a dependency that is done never blocks. */
  isDone?: (key: string) => boolean;
}
export interface Derived { state: TaskState; evidence: string[]; findings: FlowFinding[]; verified: boolean }

const ALL: readonly TaskState[] = ['proposed', 'ready', 'claimed', 'in_progress', 'in_review', 'done', 'blocked', 'needs_input', 'failed', 'skipped', 'removed'];
const isState = (s: unknown): s is TaskState => typeof s === 'string' && (ALL as readonly string[]).includes(s);
const T: Record<TaskState, readonly TaskState[]> = {
  proposed: ['ready', 'skipped', 'removed', 'needs_input'],
  ready: ['proposed', 'claimed', 'in_progress', 'needs_input', 'skipped', 'removed'],
  blocked: ['proposed', 'ready', 'needs_input', 'skipped', 'removed'],
  claimed: ['claimed', 'ready', 'in_progress', 'in_review', 'done', 'needs_input', 'failed', 'skipped', 'removed'],
  in_progress: ['in_progress', 'ready', 'in_review', 'needs_input', 'failed', 'done', 'skipped', 'removed'],
  in_review: ['in_review', 'in_progress', 'ready', 'needs_input', 'failed', 'done', 'skipped', 'removed'],
  done: ['in_progress', 'in_review', 'removed'],
  needs_input: ['needs_input', 'ready', 'claimed', 'in_progress', 'failed', 'skipped', 'removed'],
  failed: ['ready', 'claimed', 'in_progress', 'skipped', 'removed'],
  skipped: ['proposed', 'ready', 'removed'],
  removed: ['proposed', 'ready'],
};
/** May a task asserted as `from` be moved to `to`? (`ready` as `from` also stands for a task with no asserted state.) */
export const canTransition = (from: TaskState, to: TaskState): boolean => isState(from) && isState(to) && T[from].includes(to);

/** Tracker status to state, default map of `flow.status_map`. A disagreement with the plan is the caller's drift finding, never an overwrite. */
const DEFAULT_STATUS_MAP: Readonly<Record<string, TaskState>> = { 'To Do': 'ready', 'In Progress': 'in_progress', 'In Review': 'in_review', Done: 'done' };
export function mapTrackerStatus(status: string, map: Readonly<Record<string, string>> = DEFAULT_STATUS_MAP): TaskState | null {
  const v = Object.hasOwn(map, status) ? map[status] : Object.hasOwn(DEFAULT_STATUS_MAP, status) ? DEFAULT_STATUS_MAP[status] : undefined;
  return isState(v) ? v : null;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const content = (e: EventIn): string => JSON.stringify([e.to, e.by, e.note ?? '', e.evidence ?? []]);
const order = (a: EventIn, b: EventIn): number => cmp(a.at, b.at) || a.seq - b.seq || cmp(a.actor, b.actor) || cmp(a.bh8 ?? '', b.bh8 ?? '') || cmp(content(a), content(b));
const DAY = 86_400_000;
const HELD: readonly TaskState[] = ['claimed', 'in_progress', 'in_review', 'needs_input'];
/** The states in which one actor holds the task: only that actor (or an event with `force: true`) moves it out. */
const HOLDING: readonly TaskState[] = ['claimed', 'in_progress', 'in_review'];

interface Asserted { state: TaskState | null; evidence: string[]; findings: FlowFinding[]; lastAt: string; lastClaim: boolean; verified: boolean }

/** Replay one task's events (already filtered to the key) into its asserted state: null means none, so the state is computed. */
function assertState(key: string, evs: readonly EventIn[], opts: DeriveOpts): Asserted {
  const sorted = [...evs].sort(order), findings: FlowFinding[] = [];
  let state: TaskState | null = null, evidence: string[] = [], holder: string | null = null, lastAt = '', lastClaim = false, verified = false;
  for (const e of sorted) {
    const from: TaskState = state ?? 'ready';
    const bad = (why: string): void => { findings.push({ code: 'BAD_TRANSITION', key, detail: `${from} -> ${String(e.to)} at ${e.at}#${e.seq}${why}` }); };
    if (!isState(e.to) || e.to === 'blocked') { bad(' (not an assertable state)'); continue; }
    const forced = (e as { force?: unknown }).force === true, holding = state !== null && HOLDING.includes(state);
    if (!forced && e.to === 'claimed' && holder !== null && holder !== e.by && state !== null && HELD.includes(state)) { findings.push({ code: 'DOUBLE_CLAIM', key, detail: `${e.by} claimed at ${e.at}#${e.seq} while ${holder} holds it` }); continue; }
    if (!forced && holding && holder !== null && holder !== e.by) { bad(` (held by ${holder}; only the holder, or an event with force, moves it)`); continue; }
    if (!canTransition(from, e.to)) { bad(''); continue; }
    const ev = [...(e.evidence ?? [])];
    let to: TaskState = e.to;
    if (to === 'done') {
      if (!ev.length) { findings.push({ code: 'DONE_WITHOUT_EVIDENCE', key, detail: `done at ${e.at}#${e.seq} has no evidence; state stays in_review` }); to = 'in_review'; }
      else verified = ev.some((r) => r.startsWith('pr:') && !!opts.merged?.(r));
    }
    if (to === 'ready') state = null; else state = to;
    if (HOLDING.includes(to) && (!holding || forced)) holder = e.by; // a task entered at a holding state belongs to the actor who entered it
    if (state === null || !HELD.includes(state)) holder = null;
    evidence = ev; lastAt = e.at; lastClaim = to === 'claimed';
    if (to !== 'done') verified = false;
  }
  if (state === 'done' && !verified && evidence.length) findings.push({ code: 'UNVERIFIED_DONE', key, detail: `no merged pr among ${evidence.join(', ')}` });
  const now = opts.now === undefined ? null : typeof opts.now === 'number' ? opts.now : opts.now.getTime();
  const at = Date.parse(lastAt);
  if (state === 'claimed' && lastClaim && now !== null && Number.isFinite(at) && now - at > (opts.claimDays ?? 7) * DAY) findings.push({ code: 'STALE_CLAIM', key, detail: `claimed at ${lastAt}, no later event` });
  return { state, evidence, findings, lastAt, lastClaim, verified };
}

function finish(key: string, a: Asserted, deps: Deps, opts: DeriveOpts): Derived {
  if (a.state !== null) return { state: a.state, evidence: a.evidence, findings: a.findings, verified: a.verified };
  const open = deps.openDeps(key).filter((p) => !opts.isDone?.(p));
  return { state: open.length || deps.gated(key) ? 'blocked' : 'ready', evidence: [], findings: a.findings, verified: false };
}

/** The state of one task from the events about it (events of other tasks are ignored). A dependency counts as done only through deps or opts.isDone. */
export function deriveState(key: string, events: readonly EventIn[], deps: Deps, opts: DeriveOpts = {}): Derived {
  return finish(key, assertState(key, events.filter((e) => e.task === key), opts), deps, opts);
}

/** The state of many tasks in one pass over the events (linear). A producer done by an event no longer blocks its consumers. */
export function deriveAll(keys: readonly string[], events: readonly EventIn[], deps: Deps, opts: DeriveOpts = {}): Map<string, Derived> {
  const by = new Map<string, EventIn[]>();
  for (const e of events) { const l = by.get(e.task); if (l) l.push(e); else by.set(e.task, [e]); }
  const asserted = new Map<string, Asserted>();
  for (const k of keys) asserted.set(k, assertState(k, by.get(k) ?? [], opts));
  const isDone = (k: string): boolean => asserted.get(k)?.state === 'done' || !!opts.isDone?.(k);
  const out = new Map<string, Derived>();
  for (const k of keys) out.set(k, finish(k, asserted.get(k) as Asserted, deps, { ...opts, isDone }));
  return out;
}
