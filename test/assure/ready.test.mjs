// Exhaustive small-scope check, full bounds ((f) can start today == ready oracle). Run with `npm run assure` (ASSURE_LEVEL=quick runs the reduced bounds).
// What it proves and what it does NOT cover: see the header of ./ready.assure.mjs.
import test from 'node:test';
import { level } from './enum.mjs';
import { assureReady } from './ready.assure.mjs';

test('(f) can start today == ready oracle (exhaustive within the stated bounds)', { timeout: 15 * 60 * 1000 }, async (t) => {
  const counts = await assureReady(level());
  t.diagnostic(`${level()} ${JSON.stringify(counts)}`);
});
