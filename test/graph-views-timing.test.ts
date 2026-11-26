// Timing file: the graph readers stay linear in the plan size. One index of 10,000 tickets and one of 100,000 are built in this process; a
// node lookup and a depth-1 reach (needs, assigned_to, scheduled_in, belongs_to over the view) are timed on each (min of reps). Linear gives
// about 10x for 10x the data; quadratic about 100x. A ratio between sizes in one process, never an absolute limit (test/helpers/perf.ts);
// PLANGRAPH_PERF_FACTOR multiplies the allowed ratio on a noisy machine.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildIndex, openIndex, INDEX_FILE } from '../src/db.ts';
import { graphReader, reach } from '../lib/graph/views.ts';
import { factor } from './helpers/perf.ts';

const tmps: string[] = [];
after(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });
const jl = (rows: Iterable<object>) => [...rows].map((r) => JSON.stringify(r)).join('\n') + '\n';

/** n tickets in chains of 20 (each needs the one before), 8 owners, an epic per 50, a person file and a link file. */
function index(n: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-gview-')); tmps.push(dir);
  const w = (f: string, rows: Iterable<object>) => fs.writeFileSync(path.join(dir, f), jl(rows));
  const key = (i: number) => `K-${i}`, owner = (i: number) => `P${i % 8}`;
  w('tickets.jsonl', Array.from({ length: n }, (_, i) => ({ key: key(i), summary: `s${i}`, epic: `E${Math.floor(i / 50)}`, sp: 1, jira_status: 'To Do', verdict: 'READY' })));
  w('edges.jsonl', Array.from({ length: n }, (_, i) => i % 20 === 0 ? null : { consumer: key(i), producer: key(i - 1), kind: 'plan_need' }).filter((x): x is { consumer: string; producer: string; kind: string } => x !== null));
  w('schedule.jsonl', Array.from({ length: n }, (_, i) => ({ version: 'current', key: key(i), owner: owner(i), sprint: 1 + (i % 20) })));
  w('people.jsonl', Array.from({ length: 8 }, (_, i) => ({ id: `P${i}` })));
  w('links.jsonl', Array.from({ length: Math.floor(n / 10) }, (_, i) => ({ from: key(i * 10), from_type: 'ticket', rel: 'relates_to', to: key(i * 10 + 5), to_type: 'ticket' })));
  buildIndex({ dir });
  return openIndex(path.join(dir, INDEX_FILE), { dir });
}

test('a node lookup and a depth-1 reach over the views scale linearly: 100000 tickets take at most 12 times as long as 10000', () => {
  using small = index(10000);
  using large = index(100000);
  const probe = (h: typeof small, n: number) => {
    const rd = graphReader(h, []);
    const start = { id: `K-${Math.floor(n / 2)}`, type: 'ticket' as const };
    const out = reach(h, start, ['needs', 'assigned_to', 'scheduled_in', 'belongs_to', 'relates_to'], 1, false);
    assert.ok(out.length >= 4, 'the probe reaches its owner, sprint, epic and producer');
    assert.equal(rd.node(start.id).length, 1);
    assert.equal(rd.producers(start.id).length <= 1, true);
  };
  const time = (h: typeof small, n: number) => { let best = Infinity; for (let k = 0; k < 7; k++) { const t = performance.now(); probe(h, n); best = Math.min(best, performance.now() - t); } return best; };
  probe(small, 10000); probe(large, 100000); // warm-up
  let best = Infinity;
  for (let attempt = 0; attempt < 4 && best >= 12 * factor(); attempt++) best = Math.min(best, time(large, 100000) / Math.max(time(small, 10000), 0.05));
  assert.ok(best < 12 * factor(), `not linear: ratio ${best.toFixed(1)} for 10x the tickets`);
});
