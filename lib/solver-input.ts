// The solver's input directory: derived from the plan, git-ignored, rewritten whenever the index is built or re-stamped. It holds v1-shaped
// canonical JSONL (tickets, edges, the schedule of the current version, open items, sprints) and a copy of config.json, so
// `bin/plangraph-solve --jsonl-dir <plan dir>/cache/solver-input` reads exactly what the index holds. The bytes depend only on the plan's rows
// (canonical order, no clock), so the same logical plan gives the same files. Nothing in this directory is a source of truth.
import fs from 'node:fs';
import path from 'node:path';
import { canonFile, SCHEMAS } from './store.ts';
import type { Schema } from './store.ts';
import { readStoreAt, kindFile } from './planstore.ts';
import type { Kind } from './planstore.ts';
import { readCapped } from './jsonl.ts';
import { writeAtomicSafe } from './fsafe.ts';

export const SOLVER_INPUT_DIR = 'cache/solver-input';
const KINDS: ReadonlyArray<readonly [Kind, string]> = [['ticket', 'tickets.jsonl'], ['edge', 'edges.jsonl'], ['schedule', 'schedule.jsonl'], ['openitem', 'open-items.jsonl'], ['sprint', 'sprints.jsonl']];
const CONFIG_MAX = 1024 * 1024;

function putter(dir: string, wrote: string[]): (name: string, text: string) => void {
  const out = path.join(dir, SOLVER_INPUT_DIR);
  return (name, text) => {
    const f = path.join(out, name);
    try { if (fs.readFileSync(f, 'utf8') === text) return; } catch { /* absent or unreadable: written below */ }
    fs.mkdirSync(out, { recursive: true, mode: 0o700 });
    writeAtomicSafe(f, text, { root: dir, mode: 0o600 });
    wrote.push(name);
  };
}
function putConfig(dir: string, put: (name: string, text: string) => void): void {
  let cfg: string | null = null; try { cfg = readCapped(path.join(dir, 'config.json'), CONFIG_MAX, { follow: false }); } catch { /* no config.json: the solver refuses that itself */ }
  if (cfg !== null) put('config.json', cfg);
}
/** Writes the solver input of the plan directory `dir` (mode 0600, a file is left alone when its bytes are unchanged); returns the files written. */
export function writeSolverInput(dir: string): string[] {
  const store = readStoreAt(dir), wrote: string[] = [], put = putter(dir, wrote);
  for (const [kind, name] of KINDS) put(name, canonFile(store.readKind(kind, { defaults: false }), SCHEMAS[kindFile(kind)] as Schema));
  putConfig(dir, put);
  return wrote;
}
/** Only the config.json copy (config.json is not an index source, so a build with unchanged data still refreshes it). */
export function writeSolverConfig(dir: string): void { putConfig(dir, putter(dir, [])); }
