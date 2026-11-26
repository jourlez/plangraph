// Question set generator: about 100 questions over the fixed plan. Ground truth is computed here from the plan data (fixpoint, not SQL);
// the test recomputes it a second way. Each question carries the golden query an agent should run, as the argv after `plangraph`.
import { TICKETS } from './plan.ts';
import type { Ticket } from './plan.ts';

export type Question = { id: string; kind: 'owner' | 'sprint' | 'deps' | 'downstream'; text: string; answer: string; golden: string[] };

const by = new Map<string, Ticket>(TICKETS.map((t) => [t.key, t]));
const get = (k: string): Ticket => by.get(k) as Ticket;

// every ticket that needs `key`, directly or not, by repeated widening until nothing new appears
export function downstream(key: string): string[] {
  const seen = new Set<string>([key]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const t of TICKETS) if (!seen.has(t.key) && t.deps.some((d) => seen.has(d))) { seen.add(t.key); grew = true; }
  }
  seen.delete(key);
  return [...seen].sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)));
}

export function questions(): Question[] {
  const out: Question[] = [];
  const keys = TICKETS.map((t) => t.key);
  for (const k of keys) out.push({ id: `owner-${k}`, kind: 'owner', text: `Who owns ${k}?`, answer: get(k).owner, golden: ['ticket', k] });
  for (const k of keys) out.push({ id: `sprint-${k}`, kind: 'sprint', text: `Which sprint is ${k} in?`, answer: get(k).sprint, golden: ['ticket', k] });
  for (const k of keys.slice(2, 27)) out.push({ id: `deps-${k}`, kind: 'deps', text: `Which tickets does ${k} depend on directly?`, answer: get(k).deps.join(','), golden: ['graph', k, '--rel', 'blocked_by'] });
  for (const k of keys.slice(0, 15)) out.push({ id: `down-${k}`, kind: 'downstream', text: `How many tickets are blocked by ${k}, directly or not?`, answer: String(downstream(k).length), golden: ['graph', k, '--rel', 'blocked_by', '--reverse', '--depth', '6'] });
  return out;
}
