// Characterization goldens for lib/report.ts (test/golden/mutation-kills/report.json, UPDATE_GOLDEN=1 rewrites; regenerate and review
// after an intended report change), written to kill mutants that survived scripts/mutate-all.ts: the ready set with every reason
// (verdict, open findings and items, closed items, producers not done, sp: tasks, Jira statuses), sprint load at and over capacity,
// per-person rows, the critical chain with ties, a loop and unplaced tickets, the LIMIT cut (more than 50 rows), each source label
// and the forecast/stale/jira options with odd values. Plans are generated (invented names).
// NOT covered: the CLI command (test/report.test.ts); the HTML is pinned byte for byte but not rendered.
import { test } from 'node:test';
import { buildReport } from '../lib/report.ts';
import { readySet } from '../lib/ready.ts';
import { buildModel } from '../lib/model.ts';
import type { ModelRecords } from '../lib/model.ts';
import type { Statuses } from '../lib/ready.ts';
import { genPlan } from './fixtures/gen.ts';
import { golden, outcome } from './helpers/golden-json.ts';

const G = (name: string, fn: () => unknown) => golden('report', name, outcome(fn));

/** A generated plan, loosened so the tests can plant bad data in it. */
type LoosePlan = { tickets: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>>; schedule: Array<Record<string, unknown>>; findings?: Array<Record<string, unknown>> };
const rich = () => {
  const p = (genPlan({ n: 16, people: 3, seed: 21, cap: 6, density: 0.2 }) as LoosePlan); // loosened so the test can plant bad data
  p.tickets[0].verdict = 'BLOCKED'; p.tickets[3].verdict = ''; p.tickets[5].jira_status = 'Done'; p.tickets[6].sp = 'x';
  p.tickets.push({ key: 'sp:p/1', sp: 1, impl_status: 'done' }, { key: 'sp:p/2', sp: 2, impl_status: 'in_progress' }, { key: 'sp:p/3', sp: 1 }, { key: 'LOOSE', sp: 2 });
  p.edges.push({ consumer: 'sp:p/3', producer: 'sp:p/2', kind: 'plan_need', note: '' }, { consumer: 'sp:p/2', producer: 'sp:p/1', kind: 'plan_need', note: '' });
  p.schedule.push({ version: 'current', key: 'sp:p/2', owner: 'Ana', sprint: 2 }, { version: 'current', key: 'sp:p/3', owner: '', sprint: 3 }, { version: 'current', key: 'GHOST', owner: 'Ben', sprint: 1 });
  p.findings = [{ key: 'T-2', kind: 'risk', text: 'r' }, { key: 'T-3', kind: 'question', text: 'q' }, { key: 'T-3', kind: 'risk', text: 'r2' }];
  return buildModel(p as unknown as ModelRecords); // deliberate misuse: the planted bad data is not Ticket-shaped
};
const items = [{ key: 'T-3', kind: 'question', status: 'done' }, { key: 'T-4', kind: 'manual', status: 'open' }];

test('ready set reasons and the full report for a rich plan', () => {
  const m = rich();
  G('ready', () => readySet(m, items));
  G('ready-statuses', () => readySet(m, items, ({ 'T-1': { status: 'Done' }, 'T-2': { status: 'In Progress' }, 'T-9': null } as Statuses))); // a Jira snapshot with a null entry ('T-9')
  G('report', () => buildReport(m, { items, forecast: { state: 'PROVISIONAL', n: 12.7 }, stale: { count: 3.9, ref: 'main' }, jira: { date: '2026-05-01' }, statuses: { 'T-1': { status: 'Done' } } }));
  G('report-odd-options', () => buildReport(m, { forecast: { state: 'X', n: NaN }, stale: { count: -4 }, jira: { date: 'yesterday' } }).data);
  G('report-bare', () => buildReport(buildModel({})));
});

test('critical chain: ties, a loop, a self link', () => {
  const chain = (edges: Array<[string, string]>, keys: string[]) => buildReport(buildModel({ tickets: keys.map((key) => ({ key, sp: 1 })), edges: edges.map(([consumer, producer]) => ({ consumer, producer })), schedule: keys.map((key, i) => ({ key, owner: 'A', sprint: i + 1 })) })).data.critical_chain;
  G('chain-tie', () => chain([['C', 'A'], ['C', 'B'], ['D', 'C'], ['E', 'B']], ['A', 'B', 'C', 'D', 'E']));
  G('chain-loop', () => chain([['A', 'B'], ['B', 'A'], ['C', 'A']], ['A', 'B', 'C']));
  G('chain-self', () => chain([['A', 'A'], ['B', 'A']], ['A', 'B']));
  G('chain-none', () => chain([], ['A', 'B']));
  G('chain-long', () => chain([['B', 'A'], ['C', 'B'], ['D', 'C'], ['Z', 'Y']], ['Y', 'Z', 'A', 'B', 'C', 'D']));
});

test('more than LIMIT rows are cut with a count', () => {
  const p = (genPlan({ n: 70, people: 6, seed: 5, cap: 2, density: 0.02 }) as LoosePlan); // loosened so the test can plant bad data
  p.findings = p.tickets.slice(0, 60).map((t) => ({ key: t.key, kind: 'risk', text: 'r' }));
  G('report-limit', () => buildReport(buildModel(p as unknown as ModelRecords)).markdown); // deliberate misuse: the plan is loosened to plant bad data
});

test('report limits and escaping: 201 load rows, long keys and owners, two open kinds, a 35-ticket chain, a loop with a chain, special characters', () => {
  const K = (i: number) => `K-${String(i).padStart(3, '0')}${i === 0 ? 'x'.repeat(70) : ''}`;
  const tickets = Array.from({ length: 36 }, (_, i) => ({ key: K(i), sp: 1, summary: 's', verdict: i === 3 ? 'NEEDS' : 'READY' }));
  const edges = Array.from({ length: 35 }, (_, i) => ({ consumer: K(i + 1), producer: K(i) }));
  const schedule = tickets.map((t, i) => ({ key: t.key, owner: i === 1 ? `Ann & <Bo> *${'o'.repeat(50)}` : `P${i % 3}`, sprint: i + 1 }));
  // 201 person-sprints: extra placed tickets in distinct cells
  for (let i = 0; i < 170; i++) { tickets.push({ key: `L-${i}`, sp: 1, summary: 'l', verdict: 'READY' }); schedule.push({ key: `L-${i}`, owner: `Q${i % 5}`, sprint: 100 + i }); }
  const findings = [{ key: K(2), kind: 'risk', text: 'r' }, { key: K(2), kind: 'question'.repeat(6), text: 'q' }];
  const r = buildReport(buildModel({ tickets, edges, schedule, findings }), { forecast: { state: 'S'.repeat(30), n: 3 } });
  G('report-limits', () => r.markdown);
  G('report-limits-html', () => r.html.length);
  const loop = buildModel({ tickets: ['A', 'B', 'C', 'D'].map((key) => ({ key, sp: 1 })), edges: [{ consumer: 'B', producer: 'A' }, { consumer: 'A', producer: 'B' }, { consumer: 'D', producer: 'C' }], schedule: ['A', 'B', 'C', 'D'].map((key) => ({ key, owner: 'x', sprint: 1 })) });
  G('report-loop-text', () => buildReport(loop).markdown.split('\n').filter((l) => /chain|->/.test(l)));
});

test('report boundaries: exactly 50 ready, exactly 200 load rows, a 90-character owner, a chain of 31, a 45-character open kind', () => {
  const tickets = [], schedule = [], edges = [];
  for (let i = 0; i < 200; i++) { tickets.push({ key: `R-${String(i).padStart(3, '0')}`, sp: 1 }); schedule.push({ key: `R-${String(i).padStart(3, '0')}`, owner: i === 0 ? 'O'.repeat(90) : `P${i % 4}`, sprint: i + 1 }); }
  for (let i = 151; i < 182; i++) edges.push({ consumer: `R-${String(i).padStart(3, '0')}`, producer: `R-${String(i - 1).padStart(3, '0')}` });
  const findings = tickets.slice(50).map((t) => ({ key: t.key, kind: i45, text: 't' }));
  const r = buildReport(buildModel({ tickets, edges, schedule, findings }));
  G('report-boundaries', () => r.markdown.split('\n').filter((l) => /Showing|more|tickets pass|chain|OOOO|qqqq/.test(l)).map((l) => l.slice(0, 300)));
});
const i45 = 'q'.repeat(45);
