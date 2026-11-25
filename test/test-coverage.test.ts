// scripts/test-coverage.ts: the coverage run's arguments (floors, includes, reporters) and its argument handling. The run itself is the CI unit job.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coverageArgs, main } from '../scripts/test-coverage.ts';

test('coverageArgs sets the floors, the three include globs and both reporters, then the files', () => {
  const a = coverageArgs(['test/a.test.ts', 'test/b.test.ts']);
  assert.deepEqual(a.slice(-2), ['test/a.test.ts', 'test/b.test.ts']);
  for (const f of ['--test-coverage-lines=99', '--test-coverage-branches=95', '--test-coverage-functions=98', '--test-coverage-include=lib/**', '--test-coverage-include=src/**', '--test-coverage-include=mcp/**', '--test-reporter=spec', '--test-reporter=lcov', '--test-reporter-destination=coverage/lcov.info']) assert.ok(a.includes(f), f);
});

test('main refuses an unknown group or argument with exit 2', async () => {
  assert.equal(await main(['--group', 'bogus']), 2);
  assert.equal(await main(['--nope']), 2);
  assert.equal(await main(['--group']), 2);
});
