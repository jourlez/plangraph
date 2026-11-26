import test from 'node:test';
import assert from 'node:assert/strict';
import { listSchedule } from '../lib/heuristic.ts';

test('chain across owners costs one sprint per hop and the bound is tight', () => {
  const r = listSchedule([
    { key: 'A', owner: 'x', sp: 1, deps: [] }, { key: 'B', owner: 'y', sp: 1, deps: ['A'] }, { key: 'C', owner: 'x', sp: 1, deps: ['B'] },
  ], { cap: 10 });
  assert.deepEqual([...r.sprint], [['A', 1], ['B', 2], ['C', 3]]);
  assert.equal(r.end, 3); assert.equal(r.lowerBound, 3); assert.equal(r.label, 'upper bound');
});

test('same owner chain stays in one sprint when capacity allows', () => {
  const r = listSchedule([{ key: 'A', owner: 'x', sp: 2, deps: [] }, { key: 'B', owner: 'x', sp: 2, deps: ['A'] }], { cap: 4 });
  assert.equal(r.end, 1);
});

test('capacity pushes items to later sprints and the capacity bound counts', () => {
  const r = listSchedule([{ key: 'A', owner: 'x', sp: 3, deps: [] }, { key: 'B', owner: 'x', sp: 3, deps: [] }, { key: 'C', owner: 'x', sp: 3, deps: [] }], { cap: 4 });
  assert.equal(r.end, 3); assert.equal(r.lowerBound, 3);
});

test('an oversized item goes alone into a sprint', () => {
  const r = listSchedule([{ key: 'A', owner: 'x', sp: 9, deps: [] }], { cap: 4 });
  assert.equal(r.sprint.get('A'), 1);
});

test('cycles and unknown producers are reported, not placed', () => {
  const r = listSchedule([{ key: 'A', owner: 'x', sp: 1, deps: ['B'] }, { key: 'B', owner: 'x', sp: 1, deps: ['A'] }, { key: 'C', owner: 'x', sp: 1, deps: ['Z'] }, { key: 'D', owner: 'x', sp: 1, deps: [] }], { cap: 9 });
  assert.deepEqual(r.unplaced, ['A', 'B', 'C']); assert.equal(r.sprint.get('D'), 1);
});

test('the end is never below the lower bound and respects the first sprint', () => {
  const r = listSchedule([{ key: 'A', owner: 'x', sp: 1, deps: [] }, { key: 'B', owner: 'y', sp: 1, deps: ['A'] }], { first: 5, cap: { default: 3 } });
  assert.equal(r.sprint.get('B'), 6); assert.ok(r.end >= r.lowerBound);
});
