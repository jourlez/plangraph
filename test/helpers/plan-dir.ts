// Plan fixtures. Tests that author a plan write it however is convenient (inline old-layout files or writePlanDir) and call
// adoptPlanDir(dir) before the first read: it converts the old files into entity files (the only backend there is).
import fs from 'node:fs';
import path from 'node:path';
import { readStoreAt, kindOfFile } from '../../lib/planstore.ts';
import { parseJsonlText } from '../../lib/store.ts';
import { adoptOldLayout } from '../../lib/store2/adopt.ts';
import type { Kind, Row } from '../../lib/planstore.ts';
import type { GenPlan } from '../fixtures/gen.ts';

/** Extra kinds to write beside the genPlan ones (people, sprints, epics, repos, capacity, links, xrefs, findings, ...). */
export type Extras = Partial<Record<Kind, readonly Row[]>>;

/** Converts old-layout plan files under the plan directory `dir` (what a fixture writes inline) into entity files and stamps format.json as init
 * does; the old file is removed. A directory that holds no old file is only stamped, so the call is safe to repeat. */
export const adoptPlanDir = adoptOldLayout;

/** The canonical text of a kind under its old file name (`tickets.jsonl`, ...), as the plan holds it now ('' when the kind has no data). The
 * entity layout keeps no such file: this is what a reader of the old file saw. */
export function readPlanFile(dir: string, name: string): string {
  const kind = kindOfFile(name);
  if (!kind) throw new Error(`not a plan kind file: ${name}`);
  return readStoreAt(dir).readText(kind) ?? '';
}
/** Replaces a whole kind (by its old file name) with the rows of `text` (JSONL), through the store: the edit a test used to make with writeFileSync. */
export function writePlanFile(dir: string, name: string, text: string): void {
  const kind = kindOfFile(name);
  if (!kind) throw new Error(`not a plan kind file: ${name}`);
  readStoreAt(dir).writeKind(kind, parseJsonlText(text, name));
}

/** Writes a genPlan-style plan (tickets, edges, schedule, config.json) and any extras through the PlanStore of `dir`. */
export function writePlanDir(dir: string, plan: GenPlan, extras: Extras = {}): void {
  fs.mkdirSync(dir, { recursive: true });
  const s = readStoreAt(dir);
  s.writeKind('ticket', plan.tickets as Row[]);
  s.writeKind('edge', plan.edges);
  s.writeKind('schedule', plan.schedule);
  for (const [k, rows] of Object.entries(extras)) if (rows) s.writeKind(k as Kind, rows);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(plan.config, null, 2) + '\n');
}

/** Replaces the layout-specific parts of a golden: fingerprints become <FP>, short commit ids <SHA7>, plan file names <FILE>. */
export function normalizeGolden(text: string): string {
  return text
    .replace(/"(fp|built)":"[0-9a-f]{8,16}"/g, '"$1":"<FP>"')
    .replace(/\bplangraph [0-9a-f]{8} \|/g, 'plangraph <FP> |')
    .replace(/ violations @[0-9a-f]{8}\b/g, ' violations @<FP>')
    .replace(/(stale vs \S+ \(|updated for \d+ tickets at |"audited_at":")[0-9a-f]{7}\b/g, '$1<SHA7>') // the commit of the fixture holds the plan files, so its short sha depends on the layout
    .replace(/\b(?:tickets|edges|schedule|refs|evidence|findings|open-items|learnings|people|sprints|epics|repos|capacity|links|xrefs)\.jsonl\b/g, '<FILE>');
}

/** Test files that mention old-layout names only as text or in memory, or that test the raw JSONL readers and canonical-text functions that remain
 * (lib/jsonl.ts, lib/store.ts), or that author the solver's own v1-shaped input directory: no plan directory is authored, so there is nothing to adopt. */
export const TEXT_ONLY: readonly string[] = [
  'glob-linear.test.ts', // in-memory validators['repos.jsonl'] calls, no plan files
  'assure-regressions.test.ts', // canonical-text functions of lib/store.ts, in memory
  'mutation-kills-jsonl.test.ts', // the raw JSONL reader and parser of lib/jsonl.ts
  'mutation-kills-openitems-ids.test.ts',
  'mutation-kills-sanitize.test.ts',
  'mutation-kills-store.test.ts', // canonical text, locks and format.json of lib/store.ts
  'planstore.test.ts', // writes through the store itself (openStore), never old-layout files
  'store.test.ts', // canonical text, locks and format.json of lib/store.ts
  'toctou-race.test.ts', // the index build's own temp-name rules, on a world it builds through the CLI
  'schema.test.ts', // the raw readers readJsonl and readRecords on raw files
  'solver-trust.test.ts', // these write the solver's own input directory (v1-shaped JSONL for --jsonl-dir), not a plan directory
  'solver.test.ts',
  'whatif-repair.test.ts',
  'evals-bashwrite.test.ts',
  'evals-runp.test.ts',
  'evals-schema.test.ts',
  'fsafe.test.ts',
  'graph-repo.test.ts',
  'graph-repo-depth.test.ts', // names repos.jsonl only to pick the validator of the kind, in memory
  'jira-output-mode.test.ts',
  'openitems.test.ts',
];

/** Every file under `dir` (recursively, sorted, '/'-separated relative names; the transaction staging directory and the index files are skipped) with its text. */
export function readTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.name === '.txn' || e.name.startsWith('plangraph.sqlite')) continue;
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f); else out[path.relative(dir, f).split(path.sep).join('/')] = fs.readFileSync(f, 'utf8');
    }
  };
  walk(dir);
  return out;
}

/** A test's `put(root, rel, text)`: writes `text` at `rel` under `root` (parents created), except that `<plan dir>/<kind>.jsonl` of a plan kind goes into the store. Returns the path. */
export function putFile(root: string, rel: string, text: string): string {
  const f = path.join(root, rel), name = path.basename(rel);
  if (kindOfFile(name) && kindOfFile(name) !== 'meta' && path.basename(path.dirname(f)) === '.plangraph') { writePlanFile(path.dirname(f), name, text); return f; }
  fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text);
  return f;
}
