// Per-file coverage floor: the limits, caps, empty and unowned cases of the read-only flow commands (next, brief, status, actions).
// Synthetic plans only; the commands are called through their `commands` export over a fake context.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { commands as flow } from '../src/commands/flow.ts';
import { genPlan } from './fixtures/gen.ts';
import { appendEvent } from '../lib/store2/batches.ts';
import { flowFixture, run, cleanup } from './helpers/flow-ctx.ts';
import type { GenPlan } from './fixtures/gen.ts';

after(cleanup);
const ev = (f: { dir: string }, task: string, to: string, by: string, evidence: string[] = [], at = '2026-11-01T00:00:00Z') => appendEvent(f.dir, by, { task, to, by, evidence }, { now: new Date(at), branch: 'main' });

/** A plan whose tickets carry the given keys in the given order; owner '' leaves a task unowned. */
function planOf(keys: string[], owner: (k: string, i: number) => string = (_k, i) => (i % 2 ? 'Ben' : 'Ana'), sprint: (k: string, i: number) => number = () => 1): GenPlan {
  const plan = genPlan({ n: 1, people: 2, density: 0, seed: 3 });
  plan.tickets = keys.map((key, i) => ({ ...(plan.tickets[0] as object), key, summary: `task ${i}` })) as never;
  plan.schedule = keys.map((key, i) => ({ version: 'current', key, owner: owner(key, i), sprint: sprint(key, i) })) as never;
  plan.edges = [];
  return plan;
}
const withData = <T extends { ctx: unknown }>(f: T): { sink: unknown[] } & T => {
  const sink: unknown[] = [];
  (f.ctx as { io: { data?: (d: unknown) => void } }).io.data = (d) => { sink.push(d); };
  return Object.assign(f, { sink });
};

test('flow with an unknown or missing subcommand is a usage error', async () => {
  const f = flowFixture();
  assert.equal(await run(f, flow, 'flow', ['bogus']), 2);
  assert.match(f.err.join('\n'), /usage: plangraph flow next/);
});

test('flow next orders ties by sprint, then key, handles keys given out of order and unowned tasks, and reports the data', async () => {
  const f = withData(flowFixture({ plan: planOf(['T-9', 'T-3', 'T-7', 'T-1', 'T-5'], (k) => (k === 'T-3' ? '' : k === 'T-7' ? 'Ben' : 'Ana'), (k) => (k === 'T-9' ? 2 : 1)) }));
  assert.equal(await run(f, flow, 'flow', ['next']), 0);
  assert.deepEqual(f.out.map((l) => l.split(' ')[0]), ['T-1', 'T-3', 'T-5', 'T-7', 'T-9']);
  assert.match(f.out[1] as string, /^T-3 unowned /);
  assert.deepEqual((f.sink[0] as { ready: Array<{ key: string; owner: string | null; own: boolean }> }).ready.map((r) => [r.key, r.owner, r.own]), [['T-1', 'Ana', false], ['T-3', null, false], ['T-5', 'Ana', false], ['T-7', 'Ben', false], ['T-9', 'Ana', false]]);
  f.out.length = 0;
  await run(f, flow, 'flow', ['next'], { for: 'Ben', limit: 2 });
  assert.deepEqual(f.out.map((l) => l.split(' ')[0]), ['T-7', 'T-1', 'omitted']);
  assert.match(f.out[0] as string, /\(yours\)/);
  assert.equal((f.sink[1] as { omitted: number }).omitted, 3);
});

test('flow next --limit outside 1 to 200 or not whole is a usage error; with no ready task it says so', async () => {
  const f = flowFixture();
  for (const limit of [0, 201, 1.5, -3]) assert.equal(await run(f, flow, 'flow', ['next'], { limit }), 2, String(limit));
  assert.equal(await run(f, flow, 'flow', ['next'], { limit: 200 }), 0);
  const g = flowFixture({ plan: planOf([]) });
  assert.equal(await run(g, flow, 'flow', ['next']), 0);
  assert.deepEqual(g.out, ['no ready task']);
});

test('flow brief needs a key and a known task; -v prints the state, its evidence and the findings', async () => {
  const f = flowFixture({ plan: planOf(['T-1', 'T-2']) });
  assert.equal(await run(f, flow, 'flow', ['brief']), 2);
  assert.match(f.err.join('\n'), /usage: plangraph flow brief KEY/);
  assert.equal(await run(f, flow, 'flow', ['brief', 'T-404']), 2);
  ev(f, 'T-1', 'claimed', 'ana', [], '2026-10-31T00:00:00Z');
  ev(f, 'T-1', 'in_review', 'ana', [], '2026-10-31T01:00:00Z');
  ev(f, 'T-1', 'done', 'ana', [], '2026-11-01T00:00:00Z');
  f.out.length = 0;
  assert.equal(await run(f, flow, 'flow', ['brief', 'T-1'], { verbose: true }), 0);
  assert.ok(f.out.some((l) => /^state in_review$/.test(l)), f.out.join('\n'));
  assert.ok(f.out.some((l) => /^DONE_WITHOUT_EVIDENCE /.test(l)));
  const g = flowFixture({ plan: planOf(['T-1']) });
  ev(g, 'T-1', 'claimed', 'ana', [], '2026-10-31T00:00:00Z');
  ev(g, 'T-1', 'done', 'ana', ['pr:o/r#1', 'test:unit'], '2026-11-01T00:00:00Z');
  g.out.length = 0;
  await run(g, flow, 'flow', ['brief', 'T-1'], { verbose: true });
  assert.ok(g.out.some((l) => /^state done evidence pr:o\/r#1 test:unit$/.test(l)), g.out.join('\n'));
  const h = flowFixture({ plan: planOf(['T-1']) });
  h.out.length = 0;
  await run(h, flow, 'flow', ['brief', 'T-1'], { verbose: true });
  assert.ok(h.out.some((l) => l === 'state ready'), h.out.join('\n'));
});

const reqs = (n: number) => Array.from({ length: n }, (_v, i) => ({ id: `R-${String(i).padStart(3, '0')}`, text: `requirement ${i}` }));
const sat = (from: string, to: string) => ({ from, from_type: 'ticket', rel: 'satisfies', to, to_type: 'requirement' });

test('flow status counts by status, shows at most 6 tasks per requirement and 40 rows, and -v lifts the row cap', async () => {
  const keys = Array.from({ length: 8 }, (_v, i) => `T-${i + 1}`);
  const f = withData(flowFixture({ plan: planOf(keys), extras: { requirement: reqs(45) as never, link: keys.map((k) => sat(k, 'R-000')) as never } }));
  assert.equal(await run(f, flow, 'flow', ['status']), 0);
  assert.equal(f.out.length, 41);
  assert.match(f.out[0] as string, /R-000.* proposed T-1:ready .* \+2$/);
  assert.equal(f.out.at(-1), 'omitted 5, -v lifts the cap');
  assert.deepEqual((f.sink[0] as { counts: object }).counts, { proposed: 1, orphan: 44 });
  f.out.length = 0;
  await run(f, flow, 'flow', ['status'], { verbose: true });
  assert.equal(f.out.length, 45);
  assert.equal(f.out.some((l) => l.startsWith('omitted')), false);
});

test('flow status --req picks one requirement; an unknown one is a usage error; no requirement at all says so', async () => {
  const f = flowFixture({ plan: planOf(['T-1']), extras: { requirement: reqs(2) as never } });
  assert.equal(await run(f, flow, 'flow', ['status'], { req: 'R-001' }), 0);
  assert.equal(f.out.length, 1);
  assert.match(f.out[0] as string, /^<untrusted n="[0-9a-f]{8}">R-001<\/untrusted> orphan$/);
  assert.equal(await run(f, flow, 'flow', ['status'], { req: 'R-777' }), 2);
  assert.match(f.err.join('\n'), /no requirement R-777/);
  const g = flowFixture({ plan: planOf(['T-1']) });
  assert.equal(await run(g, flow, 'flow', ['status']), 0);
  assert.deepEqual(g.out, ['no requirement']);
});

const spKeys = (n: number): string[] => Array.from({ length: n }, (_v, i) => `sp:t${String(i).padStart(3, '0')}`);

test('flow actions lists tracker operations in a fence, caps them at 40 (200 with -v) and says what was left out', async () => {
  const f = withData(flowFixture({ plan: planOf(spKeys(45)) }));
  assert.equal(await run(f, flow, 'flow', ['actions']), 0);
  assert.equal((f.sink[0] as { actions: unknown[] }).actions.length, 45);
  assert.equal(f.out.filter((l) => l.startsWith('create_ticket jira sp:')).length, 40);
  assert.equal(f.out.at(-1), 'omitted 5');
  f.out.length = 0;
  await run(f, flow, 'flow', ['actions'], { verbose: true });
  assert.equal(f.out.filter((l) => l.startsWith('create_ticket jira sp:')).length, 45);
  assert.equal(f.out.some((l) => l.startsWith('omitted')), false);
});

test('flow actions with nothing to do says so, and an older index contributes no tracker observations', async () => {
  const f = flowFixture({ plan: planOf(['T-1']) });
  assert.equal(await run(f, flow, 'flow', ['actions']), 0);
  assert.deepEqual(f.out, ['no tracker action']);
  const g = flowFixture({ plan: planOf(spKeys(1)), obs: [{ sys: 'jira:acme', xid: 'P-1', fields: { task: 'sp:t000' } }] });
  await run(g, flow, 'flow', ['actions']);
  assert.ok(g.out.some((l) => l.startsWith('link jira:acme sp:t000')), g.out.join('\n'));
  const h = flowFixture({ plan: planOf(spKeys(1)), obs: [{ sys: 'jira:acme', xid: 'P-1', fields: { task: 'sp:t000' } }] });
  const db = (h.ctx as { db: () => Record<string, unknown> }).db;
  (h.ctx as { db: () => unknown }).db = () => ({ ...db(), older: true });
  await run(h, flow, 'flow', ['actions']);
  assert.ok(h.out.some((l) => l.startsWith('create_ticket jira sp:t000')), h.out.join('\n'));
  assert.equal(h.out.some((l) => l.startsWith('link ')), false);
});
