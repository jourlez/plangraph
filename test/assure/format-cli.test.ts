// Exhaustive small-scope check, full bounds ((h) build/export round trip and data errors). Run with `npm run assure` (ASSURE_LEVEL=quick runs the reduced bounds).
// What it proves and what it does NOT cover: see the header of ./format.assure.ts.
import test from 'node:test';
import { level } from './enum.ts';
import { assureBuildExport } from './format.assure.ts';

test('(h) build/export round trip and data errors (exhaustive within the stated bounds)', { timeout: 15 * 60 * 1000 }, async (t) => {
  const counts = await assureBuildExport(level());
  t.diagnostic(`${level()} ${JSON.stringify(counts)}`);
});
