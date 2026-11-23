// Exhaustive small-scope check, full bounds ((h) canonical serialization round trip). Run with `npm run assure` (ASSURE_LEVEL=quick runs the reduced bounds).
// What it proves and what it does NOT cover: see the header of ./format.assure.ts.
import test from 'node:test';
import { level } from './enum.ts';
import { assurePure } from './format.assure.ts';

test('(h) canonical serialization round trip (exhaustive within the stated bounds)', { timeout: 15 * 60 * 1000 }, async (t) => {
  const counts = await assurePure(level());
  t.diagnostic(`${level()} ${JSON.stringify(counts)}`);
});
