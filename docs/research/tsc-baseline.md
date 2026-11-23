# tsc baseline (Task 18)

Measured 2026-11-22 on branch base 94965d8 with `typescript@7.0.2` (native compiler, `tsc -v` = `Version 7.0.2`), `@types/node@24.19.2`, Node 24.18.0.
Command: `npx --no-install tsc --noEmit -p .` with the committed `tsconfig.json` (`checkJs`, `noEmit`, `strict: false`, `noImplicitAny: false`).
Checked files: `lib/**/*.mjs`, `src/**/*.mjs`, `scripts/*.mjs`, `test/*.mjs` (and `evals/*.mjs`, pulled in by test imports).
Not checked: `bin/brain`, `bin/brain-merge` and the other extensionless entry points (tsc and Biome only read known extensions); both are thin shims over `src/`.

## Non-strict baseline: 469 errors

| Area | Errors |
|---|---|
| lib/ | 64 |
| src/ | 44 |
| scripts/ | 3 |
| test/ | 358 |

By error code: 169 TS2339 (property does not exist), 168 TS2353 (object literal names an unknown property), 57 TS2322, 43 TS2345, 6 TS2741, 4 TS2740, 3 TS2769, 3 TS2739, 3 TS2538, 2 each TS2561 TS2556 TS2365 TS2363 TS2362 TS2349, 1 TS2731.
Most of them are option and context objects whose type tsc infers from a default or a first use (`{}` or a narrower shape), so every later field access or call site with more fields is an error.

By file:

| File | Errors |
|---|---|
| test/cli-core.test.ts | 95 |
| test/integrations-detect.test.ts | 52 |
| test/openitems.test.ts | 27 |
| test/jira.test.ts | 27 |
| test/commands.test.ts | 23 |
| lib/jira.ts | 23 |
| test/merge.test.ts | 18 |
| test/superpowers-ingest.test.ts | 16 |
| test/driver.test.ts | 16 |
| src/db.ts | 14 |
| lib/openitems.ts | 13 |
| test/fsafe.test.ts | 12 |
| test/store.test.ts | 11 |
| test/openwolf-readthrough.test.ts | 9 |
| test/whatif.test.ts | 8 |
| test/schema.test.ts | 8 |
| test/security.test.ts | 7 |
| src/commands/integrations.ts | 7 |
| src/commands/audit.ts | 6 |
| lib/jsonl.ts | 6 |
| lib/integrations/superpowers.ts | 6 |
| test/platform.test.ts | 5 |
| test/jsonl-read.test.ts | 5 |
| src/commands/plan.ts | 5 |
| lib/integrations/openwolf.ts | 5 |
| test/verify.test.ts | 4 |
| test/sanitize.test.ts | 4 |
| test/floor.test.ts | 3 |
| test/driver-wiring.test.ts | 3 |
| src/context.ts | 3 |
| src/commands/openitems.ts | 3 |
| src/cli.ts | 3 |
| scripts/mutate.ts | 3 |
| lib/store.ts | 3 |
| test/solver.test.ts | 2 |
| test/contract.test.ts | 2 |
| src/commands/shared.ts | 2 |
| lib/integrations/detect.ts | 2 |
| lib/forecast.ts | 2 |
| lib/driver.ts | 2 |
| test/hook.test.ts | 1 |
| src/errors.ts | 1 |
| lib/model.ts | 1 |
| lib/fsafe.ts | 1 |

## Strict probe (same files, `strict: true`): 3988 errors

lib/ 1287, src/ 453, test/ 2053, evals/ 191, scripts/ 4. Mostly TS7006 (1168 outside test/, implicit any parameter) and TS2339.
The four library files staged first under strict (`lib/sanitize.ts`, `lib/gitsafe.ts`, `lib/fsafe.ts`, `lib/schema.ts`) had 66 between them.

Strict, outside test/, by file:

| File | Errors |
|---|---|
| lib/forecast.ts | 185 |
| lib/integrations/superpowers.ts | 179 |
| lib/jira.ts | 144 |
| evals/gen.ts | 129 |
| lib/store.ts | 102 |
| lib/stale.ts | 102 |
| lib/whatif.ts | 93 |
| lib/openitems.ts | 92 |
| lib/integrations/openwolf.ts | 90 |
| src/db.ts | 70 |
| src/commands/queries.ts | 68 |
| evals/run.ts | 53 |
| src/commands/plan.ts | 50 |
| src/commands/integrations.ts | 49 |
| lib/integrations/detect.ts | 46 |
| src/commands/audit.ts | 43 |
| lib/report.ts | 40 |
| src/commands/shared.ts | 38 |
| lib/merge.ts | 35 |
| lib/render.ts | 30 |
| lib/jsonl.ts | 28 |
| src/commands/openitems.ts | 27 |
| lib/schema.ts | 27 |
| src/context.ts | 23 |
| src/commands/analysis.ts | 23 |
| lib/verify.ts | 23 |
| lib/model.ts | 23 |
| src/cli.ts | 22 |
| lib/fsafe.ts | 21 |
| lib/gitsafe.ts | 13 |
| src/commands/explain.ts | 12 |
| src/errors.ts | 11 |
| lib/driver.ts | 9 |
| evals/schema.ts | 9 |
| src/commands/report.ts | 6 |
| src/args.ts | 6 |
| lib/sanitize.ts | 5 |
| scripts/mutate.ts | 4 |
| src/registry.ts | 3 |
| src/floor.mjs | 2 |

## After Task 18

| Run | Config | Scope counted | Errors |
|---|---|---|---|
| non-strict | `tsconfig.json` | every checked file | 469 -> 0 |
| strict | `tsconfig.strict.json` | `lib/sanitize.ts`, `lib/gitsafe.ts`, `lib/fsafe.ts`, `lib/schema.ts`, `src/**/*.mjs`, `scripts/typecheck.ts` | 519 -> 0 (at the base commit: 66 in the four lib files, 453 in src/; the script is new) |

At the time, `npm run typecheck` (`scripts/typecheck.ts`) ran both and failed when any per-file count rose above a committed baseline
(all zero, so any new error failed). The strict run also type-checks the lib files that src imports; those are counted only by the
non-strict run until they join the strict include list (next candidates by strict error count: verify, merge, render, model, store).

How the errors were fixed: JSDoc `@param`/`@returns`/`@type`/`@typedef` comments and parenthesized `/** @type {T} */ (expr)` casts,
`catch (/** @type {any} */ e)` where the code reads `e.code`, and typed case tables in tests. Three changes touch code, each provably
behavior-preserving: boolean subtraction written as `Number(a) - Number(b)` (lib/openitems.ts, twice; the same ToNumber coercion),
`typeof r === 'number' &&` before `Number.isSafeInteger(r)` (src/cli.ts; isSafeInteger is false for every non-number anyway), and
`io: io` with a cast (src/context.ts). No runtime bug was found: the research note's "forecast.mjs 17 and 38 pass string | number"
was a tuple-inference artifact (`lines()` always yields `[string, number]`), and the compact.mjs option fields it named are gone.
`bin/brain` and the other extensionless entry points are not checked (tsc and Biome read only known extensions); they are thin shims.

## End of the ratchet (TypeScript migration, Task 12)

The ratchet ended at zero: every per-file count reached 0 under the final strict flags, so the baseline file
(`scripts/typecheck-baseline.json`), the strict-scope config (`tsconfig.strict.json`) and the counting logic were removed.
`npm run typecheck` is now a thin wrapper that runs `tsc --noEmit -p tsconfig.json` (every `.ts` file except `test/types-fixtures`, which only `test/types.test.ts` checks, plus `src/floor.js`: `allowJs` and `checkJs` stay on so the plain-JavaScript Node-version guard is type-checked through JSDoc; `strict`, `noImplicitAny`,
`exactOptionalPropertyTypes`) and `tsc --noEmit -p tsconfig.prod.json` (`lib`, `src`, `mcp`, adding `noUncheckedIndexedAccess`),
prints every error, and exits 1 on any error (2 when tsc cannot run).

## Biome baseline (`@biomejs/biome@2.6.8`, before Task 18 fixes)

`biome lint` with the recommended preset and `useTemplate` off, on lib, src, scripts, test, evals: 2 errors, 93 warnings, 7 infos
(35 useOptionalChain, 31 noUnusedFunctionParameters, 11 noAssignInExpressions, 7 noTemplateCurlyInString, 6 noUselessEscapeInRegex,
4 noUnusedVariables, 2 noCommaOperator, 1 each noMisleadingCharacterClass, useConst, noUnusedImports, noPrecisionLoss, noAdjacentSpacesInRegex).
Fixed: the unused variables and import, useConst, the adjacent-spaces regex (` {2}`). Turned off, with reasons, in `biome.json`:
useOptionalChain (its fix is not equivalent when the left side is a falsy non-nullish value), noAssignInExpressions and noCommaOperator
(the deliberate dense style), noUselessEscapeInRegex (`\/` inside a class is harmless), noUnusedFunctionParameters (positional stub and
callback signatures), noControlCharactersInRegex (sanitizer patterns match control characters on purpose); per file: noMisleadingCharacterClass
in lib/sanitize.ts (the class strips single code points on purpose), noPrecisionLoss in test/jira.test.ts (`1e400` tests Infinity),
noTemplateCurlyInString in test/ and evals/ (literal `${CLAUDE_PLUGIN_ROOT}` and shell text). The formatter is disabled: no file was reformatted.
