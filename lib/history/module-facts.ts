// The reader of cache/git.jsonl (one ModuleFact per line, written by `ingest git`): its own validator, because the file is a local cache but not an
// observation cache (it is not in CACHE_FILES and has no obsProblem). Used by the index build (the `module` advisory table) and by lib/extras.ts.
import { parseJsonl } from '../jsonl.ts';
import type { ModuleFact } from './git.ts';

export const MODULE_FILE = 'cache/git.jsonl';
const INTS = ['commits', 'churn', 'window', 'min_cochange', 'hot_percentile'] as const;

/** The first problem of a module row (names the field, never the value), or null. */
export function moduleProblem(r: Record<string, unknown>): string | null {
  for (const f of ['repo', 'path', 'last'] as const) if (typeof r[f] !== 'string') return `"${f}" must be a string`;
  for (const f of INTS) if (!(typeof r[f] === 'number' && Number.isSafeInteger(r[f]) && (r[f] as number) >= 0)) return `"${f}" must be a whole number`;
  for (const f of ['hotspot', 'bus1'] as const) if (typeof r[f] !== 'boolean') return `"${f}" must be true or false`;
  if (!Array.isArray(r.coupled) || r.coupled.some((x) => typeof x !== 'string')) return '"coupled" must be an array of strings';
  if (!Array.isArray(r.authors) || r.authors.some((a) => a === null || typeof a !== 'object' || typeof (a as Record<string, unknown>).person !== 'string' || typeof (a as Record<string, unknown>).share !== 'number')) return '"authors" must be an array of {person, share}';
  return null;
}

/** The module facts of the file text, checked line by line (a bad line is an IngestError naming file and line); a repeated (repo, path) keeps its first row. */
export function parseModuleFacts(text: string): ModuleFact[] {
  const seen = new Set<string>();
  return (parseJsonl(text, MODULE_FILE, { validate: moduleProblem }) as unknown as ModuleFact[]).filter((m) => { const k = `${m.repo}\0${m.path}`; if (seen.has(k)) return false; seen.add(k); return true; });
}
