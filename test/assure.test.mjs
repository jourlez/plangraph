// The exhaustive small-scope suite (test/assure/) at its REDUCED bounds, so it runs on every default `node --test test/*.test.mjs` run.
// Same oracles and properties as `npm run assure` (full bounds, minutes); each property file's header states what it proves and what it
// does NOT cover. Exhaustive within the stated bounds, not a proof beyond them. Instance counts are printed as test diagnostics.
import test from 'node:test';
import { assureVerify } from './assure/verify.assure.mjs';
import { assureWhatif } from './assure/whatif.assure.mjs';
import { assureMerge } from './assure/merge.assure.mjs';
import { assureStale } from './assure/stale.assure.mjs';
import { assureReady } from './assure/ready.assure.mjs';
import { assureForecast } from './assure/forecast.assure.mjs';
import { assurePure, assureBuildExport } from './assure/format.assure.mjs';
import { assureCli } from './assure/cli.assure.mjs';

/** @type {Array<[string, () => unknown]>} */
const props = [
  ['(a) verifyPlan == oracle', () => assureVerify('quick')],
  ['(b) CLI check and verify agree', () => assureCli('quick')],
  ['(c) whatif verdicts and repairs', () => assureWhatif('quick')],
  ['(d) three-way merge', () => assureMerge('quick')],
  ['(e) stale closure', () => assureStale('quick')],
  ['(f) can start today', () => assureReady('quick')],
  ['(g) forecast refusal gates', () => assureForecast('quick')],
  ['(h) canonical round trip', () => assurePure('quick')],
  ['(h) build/export round trip', () => assureBuildExport('quick')],
];
for (const [name, fn] of props) test(`assure quick: ${name}`, async (t) => { t.diagnostic(JSON.stringify(await fn())); });
