import { test } from 'node:test';
import assert from 'node:assert/strict';
import { belowFloor, FLOOR } from '../scripts/coverage-floor.ts';

const rec = (file: string, lf: number, lh: number, brf: number, brh: number): string =>
  `TN:\nSF:${file}\nFNF:0\nFNH:0\nDA:1,1\nLF:${lf}\nLH:${lh}\nBRF:${brf}\nBRH:${brh}\nend_of_record\n`;

test('belowFloor lists a file under the floor with its numbers and keeps one above it out', () => {
  const lcov = rec('lib/a.ts', 100, 95, 20, 18) + rec('lib/b.ts', 100, 80, 20, 19) + rec('lib/c.ts', 100, 95, 20, 10);
  const r = belowFloor(lcov, FLOOR, ['lib/a.ts', 'lib/b.ts', 'lib/c.ts']);
  assert.deepEqual(r, [
    { file: 'lib/b.ts', lines: 80, branches: 95 },
    { file: 'lib/c.ts', lines: 95, branches: 50 },
  ]);
});

test('a file exactly on the floor passes and one just under fails', () => {
  const lcov = rec('lib/a.ts', 100, 90, 20, 17) + rec('lib/b.ts', 100, 89, 20, 17) + rec('lib/c.ts', 100, 90, 20, 16);
  assert.deepEqual(belowFloor(lcov, FLOOR, ['lib/a.ts', 'lib/b.ts', 'lib/c.ts']).map((x) => x.file), ['lib/b.ts', 'lib/c.ts']);
});

test('a file with no branches counts as 100 branch coverage', () => {
  assert.deepEqual(belowFloor(rec('lib/a.ts', 10, 10, 0, 0), FLOOR, ['lib/a.ts']), []);
});

test('a source file absent from the report is listed at 0 and 0', () => {
  assert.deepEqual(belowFloor(rec('lib/a.ts', 10, 10, 0, 0), FLOOR, ['lib/a.ts', 'lib/unloaded.ts']), [{ file: 'lib/unloaded.ts', lines: 0, branches: 0 }]);
});

test('absolute report paths match the repo-relative file list', () => {
  const lcov = rec('/repo/lib/a.ts', 10, 1, 0, 0);
  assert.deepEqual(belowFloor(lcov, FLOOR, ['lib/a.ts'], '/repo').map((x) => x.file), ['lib/a.ts']);
});

test('a report file outside the list is ignored', () => {
  assert.deepEqual(belowFloor(rec('lib/x.ts', 10, 0, 0, 0), FLOOR, ['lib/a.ts']).map((x) => x.file), ['lib/a.ts']);
});
