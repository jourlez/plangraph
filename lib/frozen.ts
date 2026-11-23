// lib/frozen.ts: the frozen-history rule, in ONE place (pure: plain model data in, booleans out; no I/O). lib/verify.ts, lib/whatif.ts
// (whatif, proposeMove, relieve) and lib/ready.ts read it from here; bin/brain-solve mirrors it in Python (prepare: pr.closed, pr.frozen),
// and test/frozen.test.ts compares the two on a grid.
//
// CLOSED: the ticket is finished. An `sp:` task whose impl_status is `done`, or any ticket whose jira_status is `Done` or one of
//   config.closed_statuses.
// FROZEN: the ticket keeps its current slot. Closed, or jira_status in config.frozen_statuses (exactly what config lists: `In Progress` is
//   frozen only when listed there), or a key of opts.frozen (`--freeze`), or its CURRENT sprint (model.sched, not the schedule being checked)
//   below config.frozen_before_sprint.
// THE RULE (stated once; docs/CONTRACT.md "Frozen history" points here). A constraint exists only where at least one side is FREE:
//   - a link (consumer needs producer) whose producer is CLOSED is satisfied: a finished producer cannot be late, wherever it sits;
//   - a link between two FROZEN tickets is a fixed fact of history: never a violation, never a constraint;
//   - every other link obeys the strict handoff rule sprint[c] >= sprint[p] + (owner differs ? 1 : 0);
//   - a person-sprint cell's capacity binds only its FREE load: the free load must fit in max(0, cap - frozen load). So a cell of frozen
//     tickets only is never over capacity, and a cell whose frozen load already reaches cap takes no free story point (a 0-SP ticket may
//     still join it). Equivalently: a cell is over capacity when its total load is above cap AND it holds a free ticket with story points.
import type { Model, PlanConfig } from './model.ts';

const isSp = (k: unknown) => String(k).startsWith('sp:');
// Stricter than its type: owner !== '' is also required.
const placed = (p: { owner?: unknown; sprint?: unknown } | null | undefined): p is { owner: string; sprint: number } => !!p && typeof p.owner === 'string' && p.owner !== '' && Number.isInteger(p.sprint);
const strs = (a: unknown): string[] => (Array.isArray(a) ? a.filter((x) => typeof x === 'string') : []);

/** The closed Jira statuses: `Done` always, plus the strings of config.closed_statuses. */
export const closedStatuses = (config: PlanConfig | undefined): Set<string> => new Set(['Done', ...strs(config?.closed_statuses)]);

/** Is this ticket closed (finished)? */
export function isClosed(model: Model, key: string): boolean {
  const t = model.tickets.get(key);
  if (!t) return false;
  if (isSp(key) && t.impl_status === 'done') return true;
  return typeof t.jira_status === 'string' && closedStatuses(model.config).has(t.jira_status);
}

/** A frozen test for one model: (key) => boolean. opts.frozen: Map (or Set) of keys pinned by the caller. */
export function frozenTest(model: Model, opts: { frozen?: { has: (k: string) => boolean } } = {}): (key: string) => boolean {
  const cfg = model.config || {}, closed = closedStatuses(cfg), fst = new Set(strs(cfg.frozen_statuses)), fb = cfg.frozen_before_sprint;
  return (key: string) => {
    const t = model.tickets.get(key);
    if (opts.frozen && opts.frozen.has(key)) return true;
    if (!t) return false;
    if (isSp(key) && t.impl_status === 'done') return true;
    const st = typeof t.jira_status === 'string' ? t.jira_status : '';
    if (closed.has(st) || fst.has(st)) return true;
    const cur = model.sched.get(key);
    return Number.isFinite(fb) && placed(cur) && cur.sprint < (fb as number); // Number.isFinite is the check
  };
}

/** The frozen tickets of the CURRENT schedule with their slots: Map key -> {owner, sprint} (only placed tickets). `brain verify FILE`
 * passes it as opts.frozen (so FROZEN_MOVED fires) and `brain schedule-load` refuses a schedule that moves one. */
export function frozenSlots(model: Model): Map<string, { owner: string; sprint: number }> {
  const frozen = frozenTest(model), out = new Map<string, { owner: string; sprint: number }>();
  for (const [k, p] of model.sched) if (model.tickets.has(k) && placed(p) && frozen(k)) out.set(k, { owner: p.owner, sprint: p.sprint });
  return out;
}

/** Does the link consumer <- producer constrain anything? false when the producer is closed or both ends are frozen. */
export const linkBinds = (model: Model, frozen: (k: string) => boolean, c: string, p: string): boolean => !isClosed(model, p) && !(frozen(c) && frozen(p));
