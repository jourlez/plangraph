// Exhaustive small-scope check, full bounds ((g) forecast refusal gates). Run with `npm run assure` (ASSURE_LEVEL=quick runs the reduced bounds).
// What it proves and what it does NOT cover: see the header of ./forecast.assure.ts.
import test from 'node:test';
import { level } from './enum.ts';
import { assureForecast } from './forecast.assure.ts';

test('(g) forecast refusal gates (exhaustive within the stated bounds)', { timeout: 15 * 60 * 1000 }, async (t) => {
  const counts = await assureForecast(level());
  t.diagnostic(`${level()} ${JSON.stringify(counts)}`);
});
