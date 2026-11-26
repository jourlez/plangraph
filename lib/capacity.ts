// Per-sprint capacity rows (capacity.jsonl) as whatif and relieve read them. A row can only LOWER the capacity of its person and sprint:
// min(row.sp, capOf), so whatif never accepts a move that verify (which keeps capOf) rejects as CAPACITY. review_h is carried and ignored.
// lib/verify.ts, the solver and capOf do not import this file.
import { capOf } from './model.ts';
import type { PlanConfig } from './model.ts';
import type { CapacityRow } from './graph/files.ts';

const rowOf = (person: string, sprint: number, rows: readonly CapacityRow[]): CapacityRow | undefined => rows.find((r) => r.person === person && Number(r.sprint) === sprint && Number.isFinite(r.sp));

export function capacityFor(person: string, sprint: number, rows: readonly CapacityRow[], config: PlanConfig): number {
  const cap = capOf(config, person), row = rowOf(person, sprint, rows);
  return row ? Math.min(row.sp, cap) : cap;
}

/** The advisory line for a row above the config value (it changes nothing: the solver and verify use the config value), else null. */
export function capacityAdvice(person: string, sprint: number, rows: readonly CapacityRow[], config: PlanConfig): string | null {
  const row = rowOf(person, sprint, rows), cap = capOf(config, person);
  return row && row.sp > cap ? `capacity row for ${person} in S${sprint} is above the config value; the solver and verify use ${cap}` : null;
}
