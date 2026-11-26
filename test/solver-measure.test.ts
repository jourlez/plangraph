import test from 'node:test';
import assert from 'node:assert/strict';
import { dominanceWeights, keepVariant, neighborhoodWins } from '../lib/solver-measure.ts';
import type { Run } from '../lib/solver-measure.ts';

test('dominanceWeights: each weight beats the whole range of the later stages', () => {
  assert.deepEqual(dominanceWeights([5, 9, 3]), [40, 4, 1]);
  assert.deepEqual(dominanceWeights([]), []);
  assert.throws(() => dominanceWeights([1, 1.5, 1]), RangeError);
  assert.throws(() => dominanceWeights(new Array(12).fill(1e6)), RangeError);
});

const r = (seed: number, wallS: number, objectives = [3, 10], verified = true): Run => ({ seed, wallS, objectives, verified });

test('keepVariant keeps only same-result faster variants', () => {
  assert.equal(keepVariant([r(1, 10), r(2, 12)], [r(1, 4), r(2, 5)]).keep, true);
  assert.equal(keepVariant([r(1, 10)], [r(1, 11)]).keep, false);
  assert.match(keepVariant([r(1, 10)], [r(1, 4, [3, 11])]).reason, /objectives differ/);
  assert.match(keepVariant([r(1, 10)], [r(1, 4, [3, 10], false)]).reason, /verify/);
  assert.match(keepVariant([r(1, 10)], [r(2, 4)]).reason, /missing/);
  assert.equal(keepVariant([], []).keep, false);
});

test('neighborhoodWins needs a strict majority of seeds', () => {
  assert.equal(neighborhoodWins([1, 1, 1, 2, 2], [2, 2, 2, 1, 1]), true);
  assert.equal(neighborhoodWins([1, 1, 2, 2, 2], [2, 2, 1, 1, 1]), false);
  assert.equal(neighborhoodWins([], []), false);
});
