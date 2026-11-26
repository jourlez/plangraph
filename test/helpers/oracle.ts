// Brute-force oracle for the differential tests: a plan is valid when every link satisfies sprint[c] >= sprint[p] + (owner differs ? 1 : 0),
// no cell (person, sprint) holds more story points than its cap, and every sprint is in first..last. It shares no code with lib/verify.ts,
// lib/whatif.ts or the solver; it reads only the plain records genPlan returns (no frozen tickets, no minimum load).
import { buildModel } from '../../lib/model.ts';
import type { Model, Placement } from '../../lib/model.ts';
import type { GenPlan } from '../fixtures/gen.ts';

export interface Slot { owner: string; sprint: number }
export type Assign = ReadonlyMap<string, Slot>;

export const peopleOf = (plan: GenPlan): string[] => [...new Set(plan.schedule.map((r) => r.owner))].sort();
const capOf = (plan: GenPlan, who: string): number => plan.config.caps[who] ?? plan.config.caps.default;

/** true when the assignment (every ticket placed) breaks no link and no capacity, with sprints from `first`; gate: tickets that are blocked and sprints that are closed */
export function oracleValid(plan: GenPlan, a: Assign, first = 1, gate: { blocked?: ReadonlySet<string>; closed?: ReadonlySet<number> } = {}): boolean {
  const sp = new Map(plan.tickets.map((t) => [t.key, t.sp as number]));
  const load = new Map<string, number>();
  for (const [k, s] of a) {
    if (s.sprint < first) return false;
    if (gate.blocked?.has(k) || gate.closed?.has(s.sprint)) return false; // a blocked ticket, or a ticket in a closed sprint (the oracle's tickets are all open and free)
    const c = `${s.owner}\t${s.sprint}`; load.set(c, (load.get(c) ?? 0) + (sp.get(k) ?? 0));
    if ((load.get(c) as number) > capOf(plan, s.owner)) return false;
  }
  for (const e of plan.edges) {
    const c = a.get(e.consumer), p = a.get(e.producer);
    if (c && p && c.sprint < p.sprint + (c.owner === p.owner ? 0 : 1)) return false;
  }
  return true;
}

/** a model of the plan with the given placements (what verifyPlan and whatif read) */
export function modelWith(plan: GenPlan, a: Assign): Model {
  const schedule = [...a].map(([key, s]) => ({ version: 'current', key, owner: s.owner, sprint: s.sprint }));
  return buildModel({ tickets: plan.tickets, edges: plan.edges, schedule, config: plan.config });
}
export const schedOf = (a: Assign): Map<string, Placement> => new Map([...a].map(([k, s]) => [k, { owner: s.owner, sprint: s.sprint }]));
export const assignOf = (plan: GenPlan): Map<string, Slot> => new Map(plan.schedule.map((r) => [r.key, { owner: r.owner, sprint: r.sprint }]));

/** every slot of people x 1..sprints, in a fixed order */
export const slots = (people: readonly string[], sprints: number): Slot[] => people.flatMap((owner) => Array.from({ length: sprints }, (_, i) => ({ owner, sprint: i + 1 })));

/** calls fn for each of the (people*sprints)^n assignments; stops early when fn returns true */
export function eachAssign(plan: GenPlan, sprints: number, fn: (a: Assign) => unknown): void {
  const keys = plan.tickets.map((t) => t.key), all = slots(peopleOf(plan), sprints), cur = new Map<string, Slot>();
  const rec = (i: number): boolean => {
    if (i === keys.length) return fn(cur) === true;
    for (const s of all) { cur.set(keys[i] as string, s); if (rec(i + 1)) return true; }
    cur.delete(keys[i] as string); return false;
  };
  rec(0);
}

/** the smallest end sprint over valid assignments within 1..sprints (null: none is valid). Pruned depth-first search: genPlan edges run from a lower index to a higher one. */
export function bestEnd(plan: GenPlan, sprints: number): number | null {
  const keys = plan.tickets.map((t) => t.key), sp = plan.tickets.map((t) => t.sp as number), all = slots(peopleOf(plan), sprints);
  const ix = new Map(keys.map((k, i) => [k, i])), prods: number[][] = keys.map(() => []);
  for (const e of plan.edges) (prods[ix.get(e.consumer) as number] as number[]).push(ix.get(e.producer) as number);
  const at: Slot[] = [], load = new Map<string, number>(); let best: number | null = null;
  const rec = (i: number, end: number): void => {
    if (best !== null && end >= best) return;
    if (i === keys.length) { best = end; return; }
    for (const s of all) {
      const c = `${s.owner}\t${s.sprint}`, v = (load.get(c) ?? 0) + (sp[i] as number);
      if (v > capOf(plan, s.owner)) continue;
      if ((prods[i] as number[]).some((p) => s.sprint < (at[p] as Slot).sprint + ((at[p] as Slot).owner === s.owner ? 0 : 1))) continue;
      at[i] = s; load.set(c, v); rec(i + 1, Math.max(end, s.sprint)); load.set(c, v - (sp[i] as number));
    }
  };
  rec(0, 0);
  return best;
}
