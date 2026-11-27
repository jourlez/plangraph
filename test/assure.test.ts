// The exhaustive small-scope suite (test/assure/) at its REDUCED bounds, so it runs on every default `npm test` run.
// Same oracles and properties as `npm run assure` (full bounds, minutes); each property file's header states what it proves and what it
// does NOT cover. Exhaustive within the stated bounds, not a proof beyond them. Instance counts are printed as test diagnostics.
import test from 'node:test';
import { assureVerify } from './assure/verify.assure.ts';
import { assureWhatif } from './assure/whatif.assure.ts';
import { assureStale } from './assure/stale.assure.ts';
import { assureReady, assureReadyBulk } from './assure/ready.assure.ts';
import { assureForecast } from './assure/forecast.assure.ts';
import { assurePure, assureBuildExport } from './assure/format.assure.ts';
import { assureCli } from './assure/cli.assure.ts';
import { assureRelieve } from './assure/relieve.assure.ts';

const props: Array<[string, () => unknown]> = [
  ['(a) verifyPlan == oracle', () => assureVerify('quick')],
  ['(b) CLI check and verify agree', () => assureCli('quick')],
  ['(c) whatif verdicts and repairs', () => assureWhatif('quick')],
  ['(e) stale closure', () => assureStale('quick')],
  ['(f) can start today', () => assureReady('quick')],
  ['(f) bulk ready', () => assureReadyBulk('quick')],
  ['(g) forecast refusal gates', () => assureForecast('quick')],
  ['(h) canonical round trip', () => assurePure('quick')],
  ['(h) build/export round trip', () => assureBuildExport('quick')],
  ['(i) relieve minimal moves', () => assureRelieve('quick')],
];
for (const [name, fn] of props) test(`assure quick: ${name}`, async (t) => { t.diagnostic(JSON.stringify(await fn())); });
