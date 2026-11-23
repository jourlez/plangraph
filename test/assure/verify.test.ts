// Exhaustive small-scope check, full bounds ((a) verifyPlan == oracle). Run with `npm run assure` (ASSURE_LEVEL=quick runs the reduced bounds).
// What it proves and what it does NOT cover: see the header of ./verify.assure.ts.
import test from 'node:test';
import { level } from './enum.ts';
import { assureVerify } from './verify.assure.ts';

test('(a) verifyPlan == oracle (exhaustive within the stated bounds)', { timeout: 15 * 60 * 1000 }, async (t) => {
  const counts = await assureVerify(level());
  t.diagnostic(`${level()} ${JSON.stringify(counts)}`);
});
