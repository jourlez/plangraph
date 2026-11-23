// Exhaustive small-scope check, full bounds ((c) whatif verdicts == move-rule oracle). Run with `npm run assure` (ASSURE_LEVEL=quick runs the reduced bounds).
// What it proves and what it does NOT cover: see the header of ./whatif.assure.mjs.
import test from 'node:test';
import { level } from './enum.mjs';
import { assureWhatif } from './whatif.assure.mjs';

test('(c) whatif verdicts == move-rule oracle (exhaustive within the stated bounds)', { timeout: 15 * 60 * 1000 }, async (t) => {
  const counts = await assureWhatif(level(), ['verdict']);
  t.diagnostic(`${level()} ${JSON.stringify(counts)}`);
});
