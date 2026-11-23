// Exhaustive small-scope check, full bounds ((i) whatif --relieve == clean-room brute force). Run with `npm run assure` (ASSURE_LEVEL=quick runs the reduced bounds).
// What it proves and what it does NOT cover: see the header of ./relieve.assure.mjs.
import test from 'node:test';
import { level } from './enum.mjs';
import { assureRelieve } from './relieve.assure.mjs';

test('(i) relieve: minimal valid moves == brute force (exhaustive within the stated bounds)', { timeout: 15 * 60 * 1000 }, (t) => {
  const counts = assureRelieve(level());
  t.diagnostic(`${level()} ${JSON.stringify(counts)}`);
});
