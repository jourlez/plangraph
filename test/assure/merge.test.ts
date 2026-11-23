// Exhaustive small-scope check, full bounds ((d) three-way merge). Run with `npm run assure` (ASSURE_LEVEL=quick runs the reduced bounds).
// What it proves and what it does NOT cover: see the header of ./merge.assure.ts.
import test from 'node:test';
import { level } from './enum.ts';
import { assureMerge } from './merge.assure.ts';

test('(d) three-way merge (exhaustive within the stated bounds)', { timeout: 15 * 60 * 1000 }, async (t) => {
  const counts = await assureMerge(level());
  t.diagnostic(`${level()} ${JSON.stringify(counts)}`);
});
