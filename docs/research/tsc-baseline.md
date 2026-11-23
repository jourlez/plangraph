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
| test/cli-core.test.mjs | 95 |
| test/integrations-detect.test.mjs | 52 |
| test/openitems.test.mjs | 27 |
| test/jira.test.mjs | 27 |
| test/commands.test.mjs | 23 |
| lib/jira.mjs | 23 |
| test/merge.test.mjs | 18 |
| test/superpowers-ingest.test.mjs | 16 |
| test/driver.test.mjs | 16 |
| src/db.mjs | 14 |
| lib/openitems.mjs | 13 |
| test/fsafe.test.mjs | 12 |
| test/store.test.mjs | 11 |
| test/openwolf-readthrough.test.mjs | 9 |
| test/whatif.test.mjs | 8 |
| test/schema.test.mjs | 8 |
| test/security.test.mjs | 7 |
| src/commands/integrations.mjs | 7 |
| src/commands/audit.mjs | 6 |
| lib/jsonl.mjs | 6 |
| lib/integrations/superpowers.mjs | 6 |
| test/platform.test.mjs | 5 |
| test/jsonl-read.test.mjs | 5 |
| src/commands/plan.mjs | 5 |
| lib/integrations/openwolf.mjs | 5 |
| test/verify.test.mjs | 4 |
| test/sanitize.test.mjs | 4 |
| test/floor.test.mjs | 3 |
| test/driver-wiring.test.mjs | 3 |
| src/context.mjs | 3 |
| src/commands/openitems.mjs | 3 |
| src/cli.mjs | 3 |
| scripts/mutate.mjs | 3 |
| lib/store.mjs | 3 |
| test/solver.test.mjs | 2 |
| test/contract.test.mjs | 2 |
| src/commands/shared.mjs | 2 |
| lib/integrations/detect.mjs | 2 |
| lib/forecast.mjs | 2 |
| lib/driver.mjs | 2 |
| test/hook.test.mjs | 1 |
| src/errors.mjs | 1 |
| lib/model.mjs | 1 |
| lib/fsafe.mjs | 1 |

## Strict probe (same files, `strict: true`): 3988 errors

lib/ 1287, src/ 453, test/ 2053, evals/ 191, scripts/ 4. Mostly TS7006 (1168 outside test/, implicit any parameter) and TS2339.
The four library files staged first under strict (`lib/sanitize.mjs`, `lib/gitsafe.mjs`, `lib/fsafe.mjs`, `lib/schema.mjs`) had 66 between them.

Strict, outside test/, by file:

| File | Errors |
|---|---|
| lib/forecast.mjs | 185 |
| lib/integrations/superpowers.mjs | 179 |
| lib/jira.mjs | 144 |
| evals/gen.mjs | 129 |
| lib/store.mjs | 102 |
| lib/stale.mjs | 102 |
| lib/whatif.mjs | 93 |
| lib/openitems.mjs | 92 |
| lib/integrations/openwolf.mjs | 90 |
| src/db.mjs | 70 |
| src/commands/queries.mjs | 68 |
| evals/run.mjs | 53 |
| src/commands/plan.mjs | 50 |
| src/commands/integrations.mjs | 49 |
| lib/integrations/detect.mjs | 46 |
| src/commands/audit.mjs | 43 |
| lib/report.mjs | 40 |
| src/commands/shared.mjs | 38 |
| lib/merge.mjs | 35 |
| lib/render.mjs | 30 |
| lib/jsonl.mjs | 28 |
| src/commands/openitems.mjs | 27 |
| lib/schema.mjs | 27 |
| src/context.mjs | 23 |
| src/commands/analysis.mjs | 23 |
| lib/verify.mjs | 23 |
| lib/model.mjs | 23 |
| src/cli.mjs | 22 |
| lib/fsafe.mjs | 21 |
| lib/gitsafe.mjs | 13 |
| src/commands/explain.mjs | 12 |
| src/errors.mjs | 11 |
| lib/driver.mjs | 9 |
| evals/schema.mjs | 9 |
| src/commands/report.mjs | 6 |
| src/args.mjs | 6 |
| lib/sanitize.mjs | 5 |
| scripts/mutate.mjs | 4 |
| src/registry.mjs | 3 |
| src/floor.mjs | 2 |

## After Task 18

| Run | Config | Scope counted | Errors |
|---|---|---|---|
| non-strict | `tsconfig.json` | every checked file | 469 -> 0 |
| strict | `tsconfig.strict.json` | `lib/sanitize.mjs`, `lib/gitsafe.mjs`, `lib/fsafe.mjs`, `lib/schema.mjs`, `src/**/*.mjs`, `scripts/typecheck.mjs` | 519 -> 0 (at the base commit: 66 in the four lib files, 453 in src/; the script is new) |

`npm run typecheck` (`scripts/typecheck.mjs`) runs both and fails when any per-file count rises above `scripts/typecheck-baseline.json`
(all zero, so any new error fails). The strict run also type-checks the lib files that src imports; those are counted only by the
non-strict run until they join the strict include list (next candidates by strict error count: verify, merge, render, model, store).

How the errors were fixed: JSDoc `@param`/`@returns`/`@type`/`@typedef` comments and parenthesized `/** @type {T} */ (expr)` casts,
`catch (/** @type {any} */ e)` where the code reads `e.code`, and typed case tables in tests. Three changes touch code, each provably
behavior-preserving: boolean subtraction written as `Number(a) - Number(b)` (lib/openitems.mjs, twice; the same ToNumber coercion),
`typeof r === 'number' &&` before `Number.isSafeInteger(r)` (src/cli.mjs; isSafeInteger is false for every non-number anyway), and
`io: io` with a cast (src/context.mjs). No runtime bug was found: the research note's "forecast.mjs 17 and 38 pass string | number"
was a tuple-inference artifact (`lines()` always yields `[string, number]`), and the compact.mjs option fields it named are gone.
`bin/brain` and the other extensionless entry points are not checked (tsc and Biome read only known extensions); they are thin shims.

## Biome baseline (`@biomejs/biome@2.6.8`, before Task 18 fixes)

`biome lint` with the recommended preset and `useTemplate` off, on lib, src, scripts, test, evals: 2 errors, 93 warnings, 7 infos
(35 useOptionalChain, 31 noUnusedFunctionParameters, 11 noAssignInExpressions, 7 noTemplateCurlyInString, 6 noUselessEscapeInRegex,
4 noUnusedVariables, 2 noCommaOperator, 1 each noMisleadingCharacterClass, useConst, noUnusedImports, noPrecisionLoss, noAdjacentSpacesInRegex).
Fixed: the unused variables and import, useConst, the adjacent-spaces regex (` {2}`). Turned off, with reasons, in `biome.json`:
useOptionalChain (its fix is not equivalent when the left side is a falsy non-nullish value), noAssignInExpressions and noCommaOperator
(the deliberate dense style), noUselessEscapeInRegex (`\/` inside a class is harmless), noUnusedFunctionParameters (positional stub and
callback signatures), noControlCharactersInRegex (sanitizer patterns match control characters on purpose); per file: noMisleadingCharacterClass
in lib/sanitize.mjs (the class strips single code points on purpose), noPrecisionLoss in test/jira.test.mjs (`1e400` tests Infinity),
noTemplateCurlyInString in test/ and evals/ (literal `${CLAUDE_PLUGIN_ROOT}` and shell text). The formatter is disabled: no file was reformatted.
