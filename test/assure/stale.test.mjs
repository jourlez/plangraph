// Exhaustive small-scope check, full bounds ((e) stale closure == graph closure). Run with `npm run assure` (ASSURE_LEVEL=quick runs the reduced bounds).
// What it proves and what it does NOT cover: see the header of ./stale.assure.mjs.
import test from 'node:test';
import { level } from './enum.mjs';
import { assureStale } from './stale.assure.mjs';

test('(e) stale closure == graph closure (exhaustive within the stated bounds)', { timeout: 15 * 60 * 1000 }, async (t) => {
  const counts = await assureStale(level());
  t.diagnostic(`${level()} ${JSON.stringify(counts)}`);
});
