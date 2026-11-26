// The synthetic project for the A/B graph questions. Pure data, no randomness. It extends the graph-format plan (owner, sprint, deps)
// with a stack tag and a requirement per ticket and a short history. `planMarkdown()` renders it as the plan text an agent can read.
import { TICKETS, PEOPLE, SPRINTS } from '../graph-format/plan.ts';
import type { Ticket } from '../graph-format/plan.ts';

export type HistoryEvent = { ticket: string; at: string; field: 'owner' | 'status'; from: string; to: string };
export const STACKS = ['node', 'sql', 'web', 'infra'];
export const REQUIREMENTS = Array.from({ length: 10 }, (_, k) => `R-${k + 1}`);

const pad = (n: number): string => String(n).padStart(2, '0');
const num = (k: string): number => Number(k.slice(2));

const stack: Record<string, string> = {};
const requirement: Record<string, string> = {};
const history: HistoryEvent[] = [];
for (const t of TICKETS) {
  const i = num(t.key);
  stack[t.key] = STACKS[(i * 7) % STACKS.length] as string;
  requirement[t.key] = REQUIREMENTS[i % REQUIREMENTS.length] as string;
  if (i % 2 === 0) history.push({ ticket: t.key, at: `2026-${pad(1 + (i % 9))}-${pad(1 + (i % 20))}`, field: 'owner', from: PEOPLE[(i + 1) % PEOPLE.length] as string, to: t.owner });
  else history.push({ ticket: t.key, at: `2026-${pad(1 + ((i * 5) % 12))}-${pad(10 + (i % 18))}`, field: 'status', from: 'in-progress', to: 'done' });
}

export const PROJECT: { tickets: Ticket[]; people: string[]; sprints: string[]; stack: Record<string, string>; requirement: Record<string, string>; history: HistoryEvent[] } =
  { tickets: TICKETS, people: PEOPLE, sprints: SPRINTS, stack, requirement, history };

/** The plan as one markdown document: what the baseline arm reads and what the graph arm ingests. */
export function planMarkdown(): string {
  const lines = ['# Synthetic project plan', '', '## Tickets', ''];
  for (const t of TICKETS) lines.push(`- ${t.key} owner=${t.owner} sprint=${t.sprint} epic=${t.epic} stack=${stack[t.key]} requirement=${requirement[t.key]} blocked_by=${t.deps.join(',') || 'none'}`);
  lines.push('', '## History', '');
  for (const h of history) lines.push(`- ${h.at} ${h.ticket} ${h.field}: ${h.from} -> ${h.to}`);
  return lines.join('\n') + '\n';
}
