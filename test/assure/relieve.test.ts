// Exhaustive small-scope check, full bounds ((i) whatif --relieve == clean-room brute force). Run with `npm run assure` (ASSURE_LEVEL=quick runs the reduced bounds).
// What it proves and what it does NOT cover: see the header of ./relieve.assure.ts.
import test from 'node:test';
import { level } from './enum.ts';
import { assureRelieve } from './relieve.assure.ts';

test('(i) relieve: minimal valid moves == brute force (exhaustive within the stated bounds)', { timeout: 15 * 60 * 1000 }, (t) => {
  const counts = assureRelieve(level());
  t.diagnostic(`${level()} ${JSON.stringify(counts)}`);
});
