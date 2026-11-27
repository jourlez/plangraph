// Tests for lib/capacity.ts: a capacity row lowers the capacity whatif and relieve decide with; verify, check and the solver keep capOf.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildModel, capOf } from '../lib/model.ts';
import { verifyPlan } from '../lib/verify.ts';
import { capacityFor } from '../lib/capacity.ts';
import { whatif, relieve, findSlots, proposeMove, renderWhatif, applyMoves } from '../lib/whatif.ts';
import type { CapacityRow } from '../lib/graph/files.ts';
import { adoptPlanDir, readPlanFile, writePlanFile } from './helpers/plan-dir.ts';

// A(2) and B(2) sit in Ana S2; C(2) sits in Ana S3. Cap 4 for everyone, six sprints.
const world = (capacity: CapacityRow[] = []) => buildModel({
  tickets: [{ key: 'A', sp: 2 }, { key: 'B', sp: 2 }, { key: 'C', sp: 2 }],
  schedule: [{ key: 'A', owner: 'Ana', sprint: 2 }, { key: 'B', owner: 'Ana', sprint: 2 }, { key: 'C', owner: 'Ana', sprint: 3 }],
  config: { first_sprint: 1, end_sprint: 6, caps: { default: 4 } },
  capacity,
});
const row = (sprint: number, sp: number): CapacityRow => ({ person: 'Ana', sprint, sp });

test('capacityFor: min(row, config) when a row exists, else the config value', () => {
  const cfg = { caps: { default: 4 } };
  assert.equal(capacityFor('Ana', 3, [row(3, 1)], cfg), 1);
  assert.equal(capacityFor('Ana', 3, [row(3, 9)], cfg), 4);
  assert.equal(capacityFor('Ana', 4, [row(3, 1)], cfg), 4);
  assert.equal(capacityFor('Ben', 3, [row(3, 1)], cfg), 4);
  assert.equal(capacityFor('Ana', 3, [], cfg), 4);
});

test('a row below the config lowers that sprint only, in whatif and --relieve', () => {
  assert.equal(whatif(world(), { key: 'A', sprint: 3 }).ok, true);
  const r = whatif(world([row(3, 3)]), { key: 'A', sprint: 3, }, { noSuggest: true });
  assert.equal(r.ok, false); assert.deepEqual(r.reasons.map((x) => x.code), ['CAPACITY']);
  assert.equal((r.load.Ana as Record<number, { cap: number }>)[3]?.cap, 3);
  assert.equal(whatif(world([row(3, 3)]), { key: 'A', sprint: 4 }).ok, true);
  assert.equal(relieve(world(), { person: 'Ana', sprint: 2 }).status, 'none_needed');
  const rel = relieve(world([row(2, 2)]), { person: 'Ana', sprint: 2 });
  assert.equal(rel.status, 'relief'); assert.equal(rel.cap, 2);
});

test('--find and --relieve respect a row below the config', () => {
  const f = findSlots(world([row(3, 3), row(4, 1)]), 'A');
  const at = (s: number) => f.slots.find((x) => x.owner === 'Ana' && x.sprint === s);
  assert.equal(at(3), undefined); assert.equal(at(4), undefined); assert.ok(at(5));
  const rel = relieve(world([row(2, 2), row(3, 2), row(4, 1)]), { person: 'Ana', sprint: 2 });
  assert.equal(rel.status, 'relief'); assert.ok(rel.moves.every((m) => m.to.sprint >= 5));
});

test('a row above the config never lets whatif accept what verify rejects, and prints the advisory line', () => {
  const m = world([row(3, 99)]);
  const r = whatif(m, { key: 'A', sprint: 3 }, { noSuggest: true });
  assert.equal(r.ok, true); // 2 + 2 = 4 fits the config value of 4
  assert.deepEqual(r.notes, ['capacity row for Ana in S3 is above the config value; the solver and verify use 4']);
  assert.match(renderWhatif(r), /Note: capacity row for Ana in S3 is above the config value; the solver and verify use 4\.$/);
  const big = buildModel({ ...{ tickets: [{ key: 'A', sp: 3 }, { key: 'B', sp: 3 }], schedule: [{ key: 'A', owner: 'Ana', sprint: 2 }, { key: 'B', owner: 'Ana', sprint: 3 }], config: { first_sprint: 1, end_sprint: 6, caps: { default: 4 } }, capacity: [row(3, 99)] } });
  const o = whatif(big, { key: 'A', sprint: 3 }, { noSuggest: true });
  assert.equal(o.ok, false); assert.deepEqual(o.reasons.map((x) => x.code), ['CAPACITY']);
});

test('a repair whatif suggests with rows never overfills a cell the rows lower', () => {
  const rows = [row(3, 2), row(4, 2)], m = world(rows);
  const r = proposeMove(m, { key: 'A', sprint: 3 });
  assert.ok(r.ok);
  const after = applyMoves(m.sched, r.moves), load = new Map<string, number>();
  for (const [k, p] of after) load.set(`${p.owner}\t${p.sprint}`, (load.get(`${p.owner}\t${p.sprint}`) ?? 0) + ((m.tickets.get(k)?.sp as number) ?? 0));
  for (const [c, l] of load) { const [o, sp] = c.split('\t') as [string, string]; assert.ok(l <= capacityFor(o, Number(sp), rows, m.config), c); }
});

test('no rows: whatif and relieve results equal the same model without the field', () => {
  const a = world(), b = buildModel({ tickets: [...a.tickets.values()], schedule: [...a.sched].map(([key, p]) => ({ key, owner: p.owner ?? null, sprint: p.sprint ?? null })), config: a.config });
  assert.deepEqual(whatif(a, { key: 'A', sprint: 3 }), whatif(b, { key: 'A', sprint: 3 }));
  assert.deepEqual(relieve(a, { person: 'Ana', sprint: 2 }), relieve(b, { person: 'Ana', sprint: 2 }));
  assert.equal(whatif(a, { key: 'A', sprint: 3 }).notes, undefined);
});

test('verify ignores capacity rows; capOf keeps its result; lib/verify.ts imports nothing from lib/capacity.ts', () => {
  assert.deepEqual(verifyPlan(world([row(2, 1)])), verifyPlan(world()));
  assert.equal(capOf({ caps: { default: 4, Ana: 7 } }, 'Ana'), 7); assert.equal(capOf({}, 'Ana'), 140);
  assert.equal(/capacity/.test(fs.readFileSync(path.join(import.meta.dirname, '../lib/verify.ts'), 'utf8').split('\n').filter((l) => /^\s*import /.test(l)).join('\n')), false);
});

test('modelFromDb reads capacity.jsonl through the index (CLI)', async () => {
  const { fixture, run, jl, state } = await import('./helpers/cli-fixture.ts');
  state.FIX = await fixture();
  const d = state.FIX;
  const dir = path.join(d, '.plangraph');
  const tk = readPlanFile(dir, 'schedule.jsonl').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { key: string; owner: string; sprint: number })[0];
  assert.ok(tk);
  writePlanFile(dir, 'capacity.jsonl', jl([{ person: tk.owner, sprint: tk.sprint, sp: 0 }]));
  adoptPlanDir(dir);
  assert.equal((await run(d, ['build'])).code, 0);
  const r = await run(d, ['whatif', '--relieve', tk.owner, '--sprint', String(tk.sprint), '--json']);
  assert.match(r.out.join('\n'), /"cap":0/);
});
