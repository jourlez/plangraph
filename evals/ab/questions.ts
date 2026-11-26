// Graph question set for the A/B benchmark: owner, blocker, stack, requirement trace and history questions over the synthetic project.
// Ground truth is computed here from the data (fixpoint, filters); test/eval-ab.test.ts recomputes it a second way.
import { questions as base } from '../graph-format/questions.ts';
import { PROJECT, STACKS, REQUIREMENTS } from './project.ts';

export type Topic = 'owner' | 'blocker' | 'stack' | 'requirement' | 'history';
export type Kind = 'owner' | 'sprint' | 'deps' | 'downstream' | 'stack' | 'stack-count' | 'trace' | 'implements' | 'sprint-count' | 'owner-count' | 'prev-owner' | 'closed';
/** `ref` is the ticket key, stack, requirement, sprint or person the question is about; `golden` is the argv after `plangraph` ([] when no single command answers it). */
export type GraphQuestion = { id: string; topic: Topic; kind: Kind; ref: string; text: string; answer: string; golden: string[] };

const TOPIC: Record<Kind, Topic> = { owner: 'owner', sprint: 'owner', 'sprint-count': 'owner', 'owner-count': 'owner', deps: 'blocker', downstream: 'blocker', stack: 'stack', 'stack-count': 'stack', trace: 'requirement', implements: 'requirement', 'prev-owner': 'history', closed: 'history' };
const byNum = (a: string, b: string): number => Number(a.slice(2)) - Number(b.slice(2));

export function graphQuestions(): GraphQuestion[] {
  const out: GraphQuestion[] = base().map((q) => ({ id: q.id, topic: TOPIC[q.kind], kind: q.kind, ref: q.golden[1] as string, text: q.text, answer: q.answer, golden: q.golden }));
  const keys = PROJECT.tickets.map((t) => t.key);
  const add = (kind: Kind, ref: string, text: string, answer: string, golden: string[]): void => { out.push({ id: `${kind}-${ref}`, topic: TOPIC[kind], kind, ref, text, answer, golden }); };
  for (const k of keys) add('stack', k, `Which stack is ${k} tagged with?`, PROJECT.stack[k] as string, ['ticket', k]);
  for (const s of STACKS) add('stack-count', s, `How many tickets are tagged with the ${s} stack?`, String(keys.filter((k) => PROJECT.stack[k] === s).length), []);
  for (const k of keys) add('trace', k, `Which requirement does ${k} trace to?`, PROJECT.requirement[k] as string, ['ticket', k]);
  for (const r of REQUIREMENTS) add('implements', r, `Which tickets implement ${r}?`, keys.filter((k) => PROJECT.requirement[k] === r).sort(byNum).join(','), []);
  for (const h of PROJECT.history) {
    if (h.field === 'owner') add('prev-owner', h.ticket, `Who owned ${h.ticket} before it was reassigned?`, h.from, ['ticket', h.ticket]);
    else add('closed', h.ticket, `On what date was ${h.ticket} marked done?`, h.at, ['ticket', h.ticket]);
  }
  for (const s of PROJECT.sprints) add('sprint-count', s, `How many tickets are planned in sprint ${s}?`, String(PROJECT.tickets.filter((t) => t.sprint === s).length), []);
  for (const p of PROJECT.people) add('owner-count', p, `How many tickets does ${p} own?`, String(PROJECT.tickets.filter((t) => t.owner === p).length), []);
  return out;
}
