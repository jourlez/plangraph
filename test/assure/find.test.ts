// Exhaustive small-scope check, full bounds ((j) whatif --find == clean-room brute force). Run with `npm run assure` (ASSURE_LEVEL=quick runs the reduced bounds).
// What it proves and what it does NOT cover: see the header of ./find.assure.ts.
import test from 'node:test';
import { level } from './enum.ts';
import { assureFind } from './find.assure.ts';

test('(j) whatif --find: valid slots, ranking and counts == brute force (exhaustive within the stated bounds)', { timeout: 15 * 60 * 1000 }, (t) => {
  const counts = assureFind(level());
  t.diagnostic(`${level()} ${JSON.stringify(counts)}`);
});
