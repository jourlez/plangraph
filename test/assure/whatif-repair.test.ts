// Exhaustive small-scope check, full bounds ((c) proposeMove repairs, suggestions, brute-force minimality). Run with `npm run assure` (ASSURE_LEVEL=quick runs the reduced bounds).
// What it proves and what it does NOT cover: see the header of ./whatif.assure.ts.
import test from 'node:test';
import { level } from './enum.ts';
import { assureWhatif } from './whatif.assure.ts';

test('(c) proposeMove repairs, suggestions, brute-force minimality (exhaustive within the stated bounds)', { timeout: 15 * 60 * 1000 }, async (t) => {
  const counts = await assureWhatif(level(), ['repair']);
  t.diagnostic(`${level()} ${JSON.stringify(counts)}`);
});
