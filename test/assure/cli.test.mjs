// Exhaustive small-scope check, full bounds ((b) CLI check and verify agree). Run with `npm run assure` (ASSURE_LEVEL=quick runs the reduced bounds).
// What it proves and what it does NOT cover: see the header of ./cli.assure.mjs.
import test from 'node:test';
import { level } from './enum.mjs';
import { assureCli } from './cli.assure.mjs';

test('(b) CLI check and verify agree (exhaustive within the stated bounds)', { timeout: 15 * 60 * 1000 }, async (t) => {
  const counts = await assureCli(level());
  t.diagnostic(`${level()} ${JSON.stringify(counts)}`);
});
