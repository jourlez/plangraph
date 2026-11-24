# TypeScript migration of plangraph: design

Date: 2026-11-23. Status: approved by the owner in conversation, to be executed after the Wednesday token reset.
Plan: `docs/superpowers/plans/2026-11-23-typescript-migration.md`.

## 1. Purpose

Move the whole plugin from JavaScript (`.mjs` with JSDoc types) to TypeScript, native ESM, on the newest toolchain, and adopt the quality pipeline the owner uses on their other TypeScript projects. Behavior does not change. The owner will not run any command themselves: Claude Code drives everything, so the result has to be self-explanatory and self-checking.

This supersedes the conclusion of `docs/research/language-platform.md` section 0 item 3 ("JSDoc plus `tsc --checkJs` is the best fit"). That research assumed TypeScript would need a build step. On Node 24 it does not (section 3), so the reason against TypeScript no longer holds.

## 2. Non-goals

- No change to any command, output, exit code, data format, or error text, except the file-name changes in section 7.
- No build step, no `dist/`, no bundler, no npm publish. The plugin ships as source through git.
- No runtime dependency. Zero runtime dependencies stays true.
- No Vitest, tsdown, publint, attw or size-limit: they belong to npm-published libraries. The plugin keeps `node:test`.
- No Biome formatter. Formatting 32,000 lines would move every line the mutation tests are keyed to.
- No restructuring of the Jira code (module split, tracker-provider interface, neutral tenant alias). That is a separate spec, `docs/superpowers/specs/2026-11-23-tracker-provider-design.md`, executed after this migration so the two never mix.
- No rename of anything the owner did not ask for. The only renames are `.mjs` to `.ts` (and the one exception in section 4).

## 3. Platform facts this design relies on (verified 2026-11-23)

- Node 24.18.0 runs `.ts` files directly by stripping types (`process.features.typescript` is `"strip"`), with no flag and no warning on stderr.
- It rejects TypeScript-only syntax that needs code generation (for example `enum`). `erasableSyntaxOnly` already is `true` in `tsconfig.json`, so `tsc` catches it first.
- Stripping is refused for files under a `node_modules` directory. The plugin is installed at `~/.claude/plugins/cache/.../plangraph/<version>/`, which has no `node_modules` segment. A test must pin this (section 8).
- Imports of `.ts` files must name the `.ts` extension. `allowImportingTsExtensions` makes `tsc` accept that.
- TypeScript 7.0.2 (native compiler) and Biome 2.6.8 are already devDependencies. `@types/node` is 24.19.2.
- Each load strips the file again. Startup cost is therefore a risk for the `SessionStart` hook, which runs `brain card` on every session (timeout 10 s). Section 8 sets a budget.

Measured on this machine on 2026-11-23 (Node 24.18.0, macOS, median of 30 runs of `node bin/brain card --if-present` on a real brain directory):

| Variant | Median | Notes |
|---|---|---|
| Current `.mjs` | 135 ms | baseline |
| All `.ts`, no cache | 187 ms | +51 ms: over the 40 ms budget the first draft allowed |
| All `.ts`, `module.enableCompileCache()` | 141 ms | +6 ms warm; the first (cold) run costs about 211 ms |

So the compile cache is part of the design, not a fallback: `bin/brain` calls `enableCompileCache()` before loading the CLI. The budget is warm median at most 15 ms over the pre-migration median. The same experiment confirmed that a crude all-`.ts` copy runs with exit 0 and empty stderr, and that `stripTypeScriptTypes` from `node:module` returns plain JavaScript unchanged but prints an `ExperimentalWarning`, so any test that calls it runs in a child process with `--no-warnings`.

Other verified facts: the latest `lefthook` is 2.2.2 and `knip` is 6.48.0 (both pinned exactly); in Biome 2.6.8 `noVar` and `noDoubleEquals` live under `suspicious`, `useConst`, `useImportType` and `useExportType` under `style`, `noUnusedImports` and `noUnusedVariables` under `correctness`; `biome lint --write` is the fix flag.

A mechanical rewrite must not touch test fixtures: `test/fixtures/**` and `test/golden/**` contain `.mjs` as plain data (fake plan paths inside fixture plan documents). Rewriting them changes the fingerprints the goldens record and breaks them. The rewrite therefore resolves each import specifier against the importing file and renames only references whose target is a file being migrated.

## 4. Target layout

Same directories, same file names, extension `.ts`:

| Directory | Files | Becomes |
|---|---|---|
| `lib/`, `lib/integrations/` | 21 + 3 | `.ts` |
| `src/`, `src/commands/` | 9 + 10 | `.ts`, except `src/floor.mjs` |
| `mcp/` | 1 | `.ts` |
| `scripts/` | 6 | `.ts` |
| `evals/` | 13 | `.ts` |
| `test/` (incl. `assure/`, `helpers/`) | 150 | `.ts` |

Exceptions, kept as plain JavaScript on purpose:

1. `src/floor.mjs` becomes `src/floor.js`. It is the Node-version guard that `bin/brain` imports before anything else, so it must parse on a Node too old to strip types. `src/floor.js` is plain syntax only, with a comment saying why, and a test that fails if it ever contains a type annotation. This is the only `.js` file in the plugin.
2. `bin/brain` and `bin/brain-merge` keep no extension and their shebang. `bin/brain` imports `../src/floor.js`, then `../src/cli.ts`.
3. `bin/brain-solve` and `solver/` are Python and do not change.

## 5. Typing rules

- `tsconfig.json` ends with: `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, `allowImportingTsExtensions`, `noEmit`, `skipLibCheck`, `module` and `moduleResolution` `nodenext`, `target` `es2024`. `allowJs` and `checkJs` are on only during the migration and removed at the end.
- JSDoc types become real annotations. The existing `@typedef` blocks become `type` and `interface` declarations next to the code. No `any` is introduced to silence an error. An `unknown` plus a narrowing function is preferred; each unavoidable assertion carries a one-line reason.
- Type-only imports use `import type`. No `enum`, `namespace`, parameter properties, or `import x = require`.
- The type-check ratchet (`scripts/typecheck`, `scripts/typecheck-baseline.json`) stays during the migration and ends at an empty baseline for every file, strict.
- Data crossing a trust boundary (JSONL rows, config, Jira responses, CLI arguments) is typed as `unknown` at the edge and narrowed by the existing validators, whose behavior does not change.

## 6. Tooling and quality pipeline

Adopted from the owner's playbooks for their other TypeScript projects (`1-BULLETPROOF.md`, `2-MODERNIZE.md`, `3-AUDIT.md`), adapted to a git-distributed plugin. The owner holds the originals; Task 11 of the plan lists the checks taken from them:

- `package.json` scripts `lint:fix`, `lint:check`, `typecheck`, `test`, `bulletproof` (fix, typecheck, test) and `bulletproof:check` (CI form, no writes).
- `lefthook.yml` pre-commit, in parallel: Biome check on staged files, `typecheck`, and the tests related to the staged files (`scripts/related-tests`, which maps staged source files to the test files that import them, plus two smoke files). The full suite takes minutes, so it runs in CI and in `bulletproof`, not on every commit; the playbook's "include the full test command" is adapted for that reason.
- `.node-version`, `.npmrc` (`engine-strict=true`, `save-exact=true`, `package-lock=true`), `.editorconfig`.
- `knip` for dead code, run in the audit and in CI.
- Biome: linter rules tightened per the playbook (`noUnusedVariables`, `noUnusedImports`, `useConst`, `noVar`, `useImportType`, `useExportType`, `noDoubleEquals` as errors). Formatter stays off (superseded on 2026-11-24 by decision D1 of `docs/superpowers/specs/2026-11-24-zero-gaps-design.md`: the formatter is adopted in 0.3.0).
- CI: `npm ci`, `npm audit --audit-level=high`, `bulletproof:check`, the existing coverage floors (99 lines, 95 branches, 98 functions), the mutation workflow unchanged in intent.
- The audit playbook (`3-AUDIT.md`) is run once at the end as a checklist: dependencies, static analysis, security-sensitive code (the Jira credential path above all), test quality, configuration, branding and private-data scan.
- Not adopted: Conventional Commits with issue-tracker ids, because the plugin has no such tracker. Commit subjects stay short and imperative.

## 7. What may change in output

Only these, and nothing else:

- File names in error messages, stack traces, `brain explain`, `brain doctor` and docs end in `.ts` instead of `.mjs`.
- `.claude-plugin/plugin.json`, `hooks/hooks.json`, MCP launch paths, `package.json` scripts and docs name the new files.
- The version becomes 0.2.0 (the toolchain and file layout change; the CLI contract does not).

## 8. Safety net (the proof that behavior is unchanged)

1. **Differential baseline.** Before any source change, a harness records three kinds of observations and compares them byte for byte after every task: (a) a matrix of CLI commands (every command, with and without `-v` and `--json`, success and error paths) against the repo fixtures and, optionally, a real brain directory, storing stdout, stderr and exit code; (b) the hook command from `hooks/hooks.json` and the merge driver `bin/brain-merge` on fixed inputs; (c) library probes: fixed calls of exported functions (verify, whatif, merge, stale, forecast, the Jira normalizer, credential resolution with injected `env` and `exec`, `pullSnapshot` over a stub `fetch`) whose JSON results are stored. It also records a scripted MCP stdio session (`initialize`, `tools/list`, one `tools/call`). The only accepted differences are the file-name changes in section 7, normalized by the harness and listed in its report. Not covered, and said so: the Python solver (unchanged, has its own tests) and live network calls.
2. **Goldens are frozen.** No task regenerates a golden file or runs with `UPDATE_GOLDEN=1`. A golden diff is investigated as a possible behavior change. Normalized file-name differences are the only exception and are applied by a script, not by regeneration.
3. **The 1417-test suite** passes after every task, not only at the end. The mutation baselines (`scripts/mutate*`, `equivalent.json`, `test/golden/mutation-kills/`) are rebuilt for renamed files by a script and reviewed.
4. **Install-path test.** A test copies the plugin into a temporary directory shaped like the real install path (no `node_modules` segment) and runs `brain doctor` and `brain card` from it with the real `node`.
5. **Startup budget.** The warm median of `brain card --if-present` is at most 15 ms over the pre-migration median on the same machine, with the compile cache on (section 3). The plan's measuring script prints both numbers.
6. **Private-data guard.** The existing `test/public-clean.test.ts` (renamed with the rest) passes before every publish.

## 9. Order of work

Each step is its own commit with the full suite green:

1. Baseline harness (before anything changes).
2. Dev tooling, no source changes.
3. Migration mechanics: the rename-and-rewrite script, the `.ts` transition config, `src/floor.js`, the install-path and enumerator tests.
4. Pilot layer: `lib/jira`, `src/jira-tenant`, and their tests, plus the negative-type test suite. This fixes the conventions for typing the rest.
5. Leaf libraries, then core libraries (two commits), then the CLI (with the compile cache), then `mcp/`, `scripts/`, `evals/`, then `test/`.
6. Hardening: strict flags for everything, `allowJs` off, empty ratchet baseline, knip clean, startup budget.
7. Audit against the owner's playbook.
8. Release 0.2.0: final differential run, docs, publish as one commit on the public `main`, update the installed plugin.

Publishing follows the existing rule: the private history stays local; the public `main` receives one commit whose tree equals the working tree (`git commit-tree HEAD^{tree} -p origin/main`).

## 10. Risks

| Risk | Mitigation |
|---|---|
| A conversion mistake changes behavior in code the tests do not reach | Differential baseline on real data, strict types, `unknown` at trust boundaries |
| Tests are converted too, so they are not an independent oracle | Differential baseline and frozen goldens; old tests keep running against migrated code until their own turn |
| Startup slower on every session start | Compile cache in the entry point, budget in section 8, measured +6 ms |
| Stripping refused in some install location | Install-path test; no `node_modules` segment in marketplace paths |
| `floor` guard unreadable on old Node | It stays plain JavaScript, with a test |
| Mutation baselines keyed to line numbers drift | They are rebuilt per renamed file by script and reviewed |
| Public repository leaks private data | `public-clean` test, and no company, host or id appears in any new document |
