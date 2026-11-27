// The facts the generators read that lib/model.ts does not carry: requirements, decisions, repos, teams, events, modules.
// loadExtras reads each from the store that holds it and leaves the field out when that node kind does not exist yet or has no rows.
// Task 12 adds the requirement, decision, team, event and module kinds: fill the marked branches then (map a stored row to the shape in types.ts).
import type { Extras, Repo } from './types.ts';

/** What the loader needs of a plan store (PlanStore of lib/planstore.ts satisfies it). exists is asked first; a kind the store does not know is never read. */
export type ExtrasStore = { exists(kind: string): boolean; readKind(kind: string, opts?: { defaults?: boolean }): readonly Record<string, unknown>[] };

const isObj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);
const strs = (x: unknown): string[] | undefined => (Array.isArray(x) && x.every((s) => typeof s === 'string') ? [...(x as string[])].sort() : undefined);

function rows(store: ExtrasStore, kind: string): readonly Record<string, unknown>[] {
  try { return store.exists(kind) ? store.readKind(kind, { defaults: false }) : []; } catch { return []; } // a kind the store does not know, or an unreadable file: no facts, never a failed build
}

function repoOf(r: Record<string, unknown>): Repo | null {
  if (typeof r.id !== 'string' || r.id === '') return null;
  const out: Repo = { id: r.id };
  const stack = strs(r.stack);
  if (stack) out.stack = stack;
  if (isObj(r.commands)) {
    const c: Record<string, string> = {};
    for (const k of Object.keys(r.commands).sort()) if (typeof r.commands[k] === 'string') c[k] = r.commands[k] as string;
    out.commands = c;
  }
  return out;
}

/** Extras from a plan store. Today only `repo` exists; requirement, decision, team, event and module stay absent (generators print their Unknown lines). */
export function loadExtras(store: ExtrasStore): Extras {
  const out: Extras = {};
  const repos = rows(store, 'repo').map(repoOf).filter((r): r is Repo => r !== null).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (repos.length > 0) out.repos = repos;
  // TODO(task 12): requirements, decisions, teams, events and modules, each read with rows(store, '<kind>') and mapped to its type in ./types.ts.
  return out;
}
