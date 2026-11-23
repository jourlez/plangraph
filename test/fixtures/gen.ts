// Deterministic synthetic plans for tests and benchmarks. Names and keys are invented; never put real people or tickets in fixtures.
import type { Ticket, PlanConfig } from '../../lib/model.ts';
export function rng(seed = 1): () => number { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

const NAMES = ['Ana', 'Ben', 'Cleo', 'Dan', 'Eva', 'Finn', 'Gia', 'Hal'];

// genPlan({ n, people, density, seed, cap }): a feasible plan by construction (each ticket sprint = max over producers of
// producer sprint + 1 when owners differ, else +0; first sprint 1). Capacity is NOT enforced by construction: pass a large cap or check it.
export interface GenTicket { key: string; summary: string; epic: string; sp: number; jira_status: string; v2_owner: string; v2_sprint: number; verdict: string; verdict_source: string; first_verdict: string; [extra: string]: unknown }
export interface GenEdge { consumer: string; producer: string; kind: string; note: string; [extra: string]: unknown }
export interface GenScheduleRow { version: string; key: string; owner: string; sprint: number; [extra: string]: unknown }
export interface GenConfig extends PlanConfig { first_sprint: number; end_sprint: number; caps: { default: number } & Record<string, number>; min_per_sprint: Record<string, number>; ignore_link_kinds: string[]; weights: { shortfall: number; load: number; owner_change: number } }
/** tickets are typed as the shared Ticket so tests may push partial rows; the generated rows always carry the GenTicket fields */
export interface GenPlan { tickets: Ticket[]; edges: GenEdge[]; schedule: GenScheduleRow[]; config: GenConfig; [extra: string]: unknown }
export function genPlan({ n = 20, people = 3, density = 0.1, seed = 1, cap = 1000, maxSp = 5, prefix = 'T' }: { n?: number; people?: number; density?: number; seed?: number; cap?: number; maxSp?: number; prefix?: string } = {}): GenPlan {
  const r = rng(seed), names = NAMES.slice(0, people);
  const key = (i: number) => `${prefix}-${i + 1}`;
  const tickets: GenTicket[] = [], edges: GenEdge[] = [], sched: GenScheduleRow[] = [];
  const owner: string[] = [], sprint: number[] = [];
  for (let i = 0; i < n; i++) {
    owner[i] = names[Math.floor(r() * people)]; let s = 1;
    for (let j = 0; j < i; j++) if (r() < density * (i < 40 ? 1 : 40 / i)) { // forward edges only (j produces for i), so the graph is a DAG
      edges.push({ consumer: key(i), producer: key(j), kind: 'plan_need', note: '' });
      s = Math.max(s, sprint[j] + (owner[j] === owner[i] ? 0 : 1));
    }
    sprint[i] = s;
    tickets.push({ key: key(i), summary: `ticket ${i + 1}`, epic: `E${i % 4}`, sp: 1 + Math.floor(r() * maxSp), jira_status: 'To Do', v2_owner: owner[i], v2_sprint: s, verdict: 'READY', verdict_source: 'audit', first_verdict: 'READY' });
    sched.push({ version: 'current', key: key(i), owner: owner[i], sprint: s });
  }
  const config = { first_sprint: 1, end_sprint: Math.max(...sprint) + 2, caps: { default: cap }, min_per_sprint: {}, ignore_link_kinds: [], weights: { shortfall: 10000, load: 2, owner_change: 1 } };
  return { tickets, edges, schedule: sched, config };
}
