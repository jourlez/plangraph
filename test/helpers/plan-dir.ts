// Backend-neutral plan fixtures. Tests that author a plan write it however is convenient (inline old-layout files or writePlanDir) and call
// adoptPlanDir(dir) before the first read; on the jsonl backend that is a no-op, on the entity backend (task 9) it converts the old files.
import fs from 'node:fs';
import path from 'node:path';
import { readStoreAt } from '../../lib/planstore.ts';
import type { Kind, Row } from '../../lib/planstore.ts';
import type { GenPlan } from '../fixtures/gen.ts';

export type Backend = 'jsonl' | 'entity';
/** Extra kinds to write beside the genPlan ones (people, sprints, epics, repos, capacity, links, xrefs, findings, ...). */
export type Extras = Partial<Record<Kind, readonly Row[]>>;

/** Converts old-layout plan files under the plan directory `dir` into the active backend. jsonl: nothing to do. */
export function adoptPlanDir(dir: string, opts: { backend?: Backend } = {}): void {
  const backend = opts.backend ?? 'jsonl';
  if (backend === 'jsonl') return;
  void dir;
  throw new Error('not implemented until task 9');
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

/** Replaces the backend-specific parts of a golden: fingerprints become <FP>, plan file names become <FILE>. */
export function normalizeGolden(text: string): string {
  return text
    .replace(/"(fp|built)":"[0-9a-f]{8,16}"/g, '"$1":"<FP>"')
    .replace(/\bplangraph [0-9a-f]{8} \|/g, 'plangraph <FP> |')
    .replace(/ violations @[0-9a-f]{8}\b/g, ' violations @<FP>')
    .replace(/\b(?:tickets|edges|schedule|refs|evidence|findings|open-items|learnings|people|sprints|epics|repos|capacity|links|xrefs)\.jsonl\b/g, '<FILE>');
}

/** Test files that deliberately assert raw JSONL bytes or the JSONL format; they are rewritten in task 10. */
export const FORMAT_BOUND: readonly string[] = [
  'assure-regressions.test.ts',
  'build-extra.test.ts',
  'clock.test.ts',
  'cli-core.test.ts',
  'driver-wiring.test.ts',
  'driver.test.ts',
  'first-use.test.ts',
  'graph-files.test.ts',
  'heal-marker.test.ts',
  'launchers.test.ts',
  'merge-bounded.test.ts',
  'merge.test.ts',
  'planstore.test.ts',
  'plan-branches.test.ts',
  'schema.test.ts',
  'store.test.ts',
  'toctou-race.test.ts',
  'mutation-kills-cli.test.ts',
  'mutation-kills-cli-more.test.ts',
  'mutation-kills-merge.test.ts',
  'mutation-kills-jsonl.test.ts',
  'mutation-kills-openitems-ids.test.ts',
  'mutation-kills-sanitize.test.ts',
  'mutation-kills-store.test.ts',
];

/** Test files that mention old-layout names only as text or in memory (no plan directory is authored), so there is nothing to adopt. */
export const TEXT_ONLY: readonly string[] = [
  'evals-bashwrite.test.ts',
  'evals-runp.test.ts',
  'evals-schema.test.ts',
  'fsafe.test.ts',
  'graph-repo.test.ts',
  'jira-output-mode.test.ts',
  'openitems.test.ts',
];
