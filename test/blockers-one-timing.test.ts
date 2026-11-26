// Timing file: readySet stays linear in the plan size (it builds one blocker source and answers each ticket from it). A ratio between two
// sizes in one process, never an absolute limit (test/helpers/perf.ts); the assertion runs only under CI_SLOW=1.
import test from 'node:test';
import assert from 'node:assert/strict';
import { genPlan } from './fixtures/gen.ts';
import { buildModel } from '../lib/model.ts';
import type { Edge, PlanRecord, ScheduleRow, Ticket } from '../lib/model.ts';
import { readySet } from '../lib/ready.ts';
import { scaling } from './helpers/perf.ts';

const SLOW = process.env.CI_SLOW === '1';
function modelOf(n: number) {
  const g = genPlan({ n, people: 8, density: 0.02, seed: 4, cap: 9999 });
  const findings = Array.from({ length: Math.floor(n / 5) }, (_, i) => ({ key: `T-${i * 5 + 1}`, kind: 'risk', text: 'x' })) as PlanRecord[];
  return buildModel({ tickets: g.tickets as Ticket[], edges: g.edges as unknown as Edge[], schedule: g.schedule as unknown as ScheduleRow[], config: g.config, findings, evidence: [], learnings: [] });
}

test('readySet scales linearly: 4x the tickets take under the allowed ratio of the time', { skip: SLOW ? false : 'set CI_SLOW=1 to run the timing assertion' }, () => {
  const models = new Map<number, ReturnType<typeof modelOf>>();
  const m = (n: number) => { let x = models.get(n); if (!x) { x = modelOf(n); models.set(n, x); } return x; };
  const r = scaling((n) => readySet(m(n)), 5000, { maxRatio: 9 });
  assert.ok(r.ratio < r.maxRatio, `ratio ${r.ratio.toFixed(1)} (small ${r.small.toFixed(1)} ms, large ${r.large.toFixed(1)} ms), allowed ${r.maxRatio}`);
});
