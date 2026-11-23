# TypeScript Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every `.mjs` file of the plugin to native-ESM TypeScript, add the owner's quality pipeline, and prove the plugin's behavior is byte-identical.

**Architecture:** Node 24 strips types at load time, so there is no build step and no `dist/`; the entry point turns on Node's compile cache to keep startup within budget. A differential harness records the pre-migration behavior (CLI matrix, hook, merge driver, MCP session, library probes) and compares after every task. Migration goes layer by layer with the full suite green per commit, then strict flags, then release 0.2.0.

**Tech Stack:** Node 24.18, TypeScript 7.0.2 (`tsc --noEmit`), Biome 2.6.8 (lint only), `node:test`, Lefthook 2.2.2, knip 6.48.0. No runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-11-23-typescript-migration-design.md`. Read its section 3 (measured facts) before starting; this plan relies on them.

## Global Constraints

- Node floor stays `>=24.2` (`NODE_FLOOR` in `src/floor`, `package.json` engines, README, CHANGELOG, `docs/CONTRACT.md`, `test/floor.test.*` agree; change none of them).
- Zero runtime dependencies. New packages are devDependencies, installed with `npm install -D -E`: `lefthook@2.2.2`, `knip@6.48.0`.
- No `enum`, `namespace`, parameter properties, or `import x = require` (`erasableSyntaxOnly`). Type-only imports use `import type`.
- Imports name the real extension (`./x.ts`). The only `.js` file in the plugin is `src/floor.js` (plain syntax, no type annotations); `workflows/audit.workflow.js` is an existing Workflow-tool script and is not touched.
- No `any` to silence an error. Use `unknown` plus a narrowing function. Each unavoidable assertion has a one-line reason comment.
- Never regenerate a golden file and never run with `UPDATE_GOLDEN=1`. A golden diff is a possible behavior change: stop and investigate. The only allowed golden edit is the exact-path name rewrite done by `scripts/ts-migrate` (Task 3).
- The rewrite never touches `test/fixtures/**` or `test/golden/**` except for exact repo paths of migrated files (spec section 3, last paragraph).
- No company name, Jira host, cloud id or personal path in any file (`test/public-clean.test.*` enforces it).
- Commit subjects are short imperative lines. No co-author trailer and no AI attribution of any kind (the owner's global rule). Commit on the current branch; do not push before Task 15.
- Commands run from the repository root.
- **The Gate** (end of every task from Task 4 on): `npm run bulletproof:check` passes, and after `node scripts/baseline.ts capture --out .baseline/now`, the command `node scripts/baseline.ts compare --a .baseline/pre --b .baseline/now` prints `differing: 0`. (After Task 10 the script is `scripts/baseline.ts`; the command line is the same.) Before Task 2 creates `bulletproof:check`, the Gate is `npm test` plus the compare.

## Parallel execution (ruling R11, owner asked for speed)

After Task 4 the work runs in parallel waves; Tasks 5 to 11 and 13 touch disjoint files, so they run at the same time in separate git worktrees (one branch each, created from the integration branch after the mass rename) and the controller merges them.

1. **Mass rename (controller step "4b", between Task 4 and the wave).** One commit runs `scripts/ts-migrate` over every remaining `.mjs` file (except `src/floor`), widens `tsconfig.json`, `tsconfig.strict.json`, the typecheck scope globs and the mutation file lists by exact path, and passes the Gate. Types are still comments at that point, so behavior cannot change.
2. **In Tasks 5 to 11, ignore every step that renames files with `scripts/ts-migrate` or commits a rename**: it has already happened. Start at the first step that writes a test or converts code. Where a task says "Run the Gate", the per-branch gate is: the task's own test files with `node --test`, plus `npx tsc --noEmit -p tsconfig.json` with no new errors in the task's files. The controller runs the full Gate (`npm run bulletproof:check` plus the baseline compare) once after merging each wave.
3. **Shared files.** Parallel tasks must not edit the same file. Negative-type fixtures are therefore one file per layer in `test/types-fixtures/<layer>-bad.ts`; its first line is `// expect: TS2322,TS2345` (the exact error codes it must produce); `test/types.test.ts` (Task 4) discovers every `*-bad.ts` fixture and compares codes, so a layer task only adds a fixture file and never edits the runner. `lib/model` is typed in Task 4 so every later layer can import `Ticket`, `Edge`, `ScheduleRow` and `Model` from it. The `bench` subcommand of `scripts/baseline` is added in Task 4. Add your files to the strict include list of `tsconfig.strict.json` only by reporting them; the controller edits that list at merge.
4. **No full suite inside a parallel task.** Several full suites at once make the load-sensitive timing tests fail. Run focused tests only; the controller serializes the full suite.
5. Reviews run per branch, concurrently, on the committed diff of that branch.

## Review Focus

Inputs and conditions no single task's tests would otherwise cover, most likely first:

1. A tool that enumerates source files by extension (`scripts/ci-tests`, `scripts/mutate-all`, `scripts/typecheck`, the walkers in `test/public-clean` and `test/packaging`) silently finds nothing after the rename and reports green. Expected: each finds at least as many files as before. Pinned in Task 3 (`test/enumerators.test.ts`).
2. The plugin installed under a path with a space or a non-ASCII character. Expected: `brain doctor` and `brain card` run. Pinned in Task 3.
3. Any warning on stderr from Node when it loads the `.ts` entry, which would break `--if-present` silence and the `SessionStart` hook output. Expected: stderr is empty for `brain card --if-present` and `brain doctor`. Pinned in Task 3.
4. Node older than the floor invoking `bin/brain`. Expected: exit 3 with the floor message (exit 0 and silent with `--if-present`), because the guard is plain JavaScript. Pinned in Task 3.
5. Running `brain` from a working directory that holds a `package.json` with `"type": "commonjs"` or a stray `tsconfig.json`. Expected: no change, because Node picks the module type from the plugin's own `package.json`. Pinned in Task 3.
6. A compile-cache directory that is unwritable or on a read-only file system. Expected: `brain` still runs with empty stderr and the same output. Pinned in Task 8.

---

### Task 0: Rename the plugin to plangraph

**Files:** every tracked file that names the plugin, marketplace, repository or skills: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `package.json`, `package-lock.json`, `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md` (a new entry only; old entries stay as written), `docs/**`, `skills/**`, `briefs/**`, `workflows/**`, `evals/**`, `test/**`, `bin/*` messages, `src/**` and `lib/**` user-facing strings, `.github/**`. Create `test/naming.test.ts`.

**Interfaces:**
- New names: plugin `plangraph`, marketplace `plangraph-marketplace`, repository `jourlez/plangraph`, install string `/plugin install plangraph@plangraph-marketplace`, skill prefix `plangraph:` (for example `plangraph:brain-onboard`). The command you type stays `brain`. The rename replaces the previous name `open-brain` everywhere.
- Names that MUST NOT change (users' data lives there): the config directory `~/.config/project-brain/`, the cache directory `~/.cache/project-brain`, the keychain service `project-brain-jira` (and `project-brain-jira:<host>`), the git merge driver name `brain-jsonl`, and every environment variable name. `test/state-paths.test.ts` pins the first two; extend the naming test to pin the other two.

- [ ] **Step 1: Inventory.** Run `git grep -n -i "open-brain"` and classify each hit: identifier to rename, user-facing prose to rename, historical CHANGELOG text to keep. Write the classification into the report.
- [ ] **Step 2: Write the failing test** `test/naming.test.ts`: `plugin.json`, `marketplace.json` and `package.json` all carry the name `plangraph` (marketplace entry `plangraph`, marketplace name `plangraph-marketplace`); `git grep -l "open-brain"` over tracked files returns only `CHANGELOG.md`; the README install line contains `plangraph@plangraph-marketplace`; `configDir({ HOME: '/h' })` ends with `.config/project-brain`; the keychain service constant is `project-brain-jira`; the merge driver name is `brain-jsonl`. Run it. Expected: FAIL.
- [ ] **Step 3: Apply the rename** to every classified hit. Do not rename the local directory. Regenerate the `docs/MCP.md` token table (the shorter name changes the byte counts) with the repository's own tool (`node test/bench-mcp.ts`, check its options) and confirm `node test/bench-mcp.ts --check` passes.
- [ ] **Step 4: Run** `node --test test/naming.test.ts test/packaging.test.ts test/state-paths.test.ts`, then the full suite (`npm test`). Expected: PASS, 0 failures. No golden is regenerated; a golden that mentions the old name is edited by exact-string replacement and the diff reviewed.
- [ ] **Step 5: Commit** `rename the plugin to plangraph`. Do not rename the GitHub repository and do not push (the controller does both at release).

### Task 1: Differential baseline harness

**Files:**
- Create: `scripts/baseline.ts`, `test/baseline.test.ts`
- Modify: `.gitignore` (add `.baseline/`)

**Interfaces:**
- Produces (exports of `scripts/baseline.ts`; CLI `capture --out DIR [--data DIR]` and `compare --a DIR --b DIR`, where `compare` prints `same: N` and `differing: M` plus one line per differing id):
  - `type MatrixEntry = { id: string; args: string[]; fixture: 'plan' | 'empty' | 'legacy' }`
  - `const MATRIX: MatrixEntry[]`, built from `brain explain --json` so a new command cannot be missed: every command plain, with `-v` and with `--json` where accepted, plus at least one error path per command (bad argument, missing index).
  - `const PROBES: Array<{ id: string; run: () => unknown | Promise<unknown> }>`: fixed calls of exported library functions with canned inputs (verify, whatif, merge, stale, forecast, the Jira `normalizeIssue`, `getCredentialsFor` with injected `env` and `exec`, `pullSnapshot` over a stub `fetchImpl`). Results are stored as stable JSON.
  - `runHook(root: string): { code: number; out: string; err: string }`, running the command of `hooks/hooks.json` in a fixture; `runMergeDriver(root: string): { code: number; merged: string }` on three fixed files; `runMcpSession(root: string): string[]`, a scripted stdio session (`initialize`, `tools/list`, one `tools/call` for `ready`) returning the JSON-RPC responses one per entry.
  - `normalizeOutput(text: string): string` replaces every `\.(mjs|ts|js)\b` with `.EXT` and every absolute temp or repository path with `<ROOT>`.
  - `captureAll(opts: { root: string; outDir: string; dataDir?: string }): { count: number }`; `dataDir`, when given, is copied to a temporary directory first and never modified.
  - `compareDirs(a: string, b: string): { same: number; differing: string[] }` comparing normalized content.
- Consumes: `test/helpers/cli-fixture.ts` to build the `plan`, `empty` and `legacy` fixture repositories.

- [ ] **Step 1: Write the failing test** in `test/baseline.test.ts`: `captures twice and compares equal` (assert `compareDirs(a, b).differing` deep-equals `[]` and `count` is at least 200); `normalizeOutput maps .mjs, .ts and .js to .EXT`; `compareDirs lists the id of a changed file`; `the matrix covers every command that brain explain lists`; `the MCP session returns an initialize result and a non-empty tools list`; `the merge driver result is stable across two runs`.
- [ ] **Step 2: Run** `node --test test/baseline.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `scripts/baseline.ts` per the interface. Fix `HOME`, `TZ=UTC`, `LC_ALL=C` in every child environment for determinism.
- [ ] **Step 4: Run** the test file. Expected: PASS.
- [ ] **Step 5: Capture the pre-migration baseline** on the clean tree: `node scripts/baseline.ts capture --out .baseline/pre`. If the owner supplies a real brain directory, also `capture --out .baseline/pre-real --data <that directory>`. Record `git rev-parse HEAD` and the per-directory source file counts (`git ls-files '*.mjs'` grouped by directory) in the commit body; Task 3 needs those counts.
- [ ] **Step 6: Commit**

```bash
git add scripts/baseline.ts test/baseline.test.ts .gitignore
git commit -m "add differential baseline harness"
```

### Task 2: Dev tooling

**Files:**
- Create: `.node-version` (content `24`), `.npmrc`, `.editorconfig`, `lefthook.yml`, `knip.json`, `scripts/related-tests.ts`, `test/related-tests.test.ts`
- Modify: `package.json`, `biome.json`, `.github/workflows/ci.yml`

**Interfaces:**
- Produces `relatedTests(staged: string[], allTests: string[], readFile: (path: string) => string): string[]` in `scripts/related-tests.ts` (and a CLI that reads staged files from argv): returns the test files that import (by resolved path) any staged source file, plus `test/golden.test.*` and `test/cli-core.test.*`, sorted, deduplicated; a staged test file maps to itself.
- Produces npm scripts: `lint:check` (`biome lint .`), `lint:fix` (`biome lint --write .`), `typecheck` (unchanged), `test` (unchanged), `test:related` (`node scripts/related-tests.ts`), `bulletproof` (`npm run lint:fix && npm run typecheck && npm run test`), `bulletproof:check` (`npm run lint:check && npm run typecheck && npm run test`), `knip` (`knip`), `prepare` (`lefthook install`).

- [ ] **Step 1: Write the failing test** `test/related-tests.test.ts`: a staged `lib/store.ts` returns the tests whose source imports `../lib/store.mjs` plus the two smoke files; a staged `test/x.test.mjs` returns itself plus the two smoke files; a staged `README.md` returns only the two smoke files; the result is sorted and has no duplicates.
- [ ] **Step 2: Run** `node --test test/related-tests.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `relatedTests`** by parsing `import ... from '<relative>'` and dynamic `import('<relative>')` specifiers and resolving them against the importing file; no regex on whole file paths without resolution.
- [ ] **Step 4: Add the tooling files.** `.npmrc`: `engine-strict=true`, `save-exact=true`, `package-lock=true`. `.editorconfig`: UTF-8, LF, 2-space indent, final newline, trim trailing whitespace except in `.md`. `lefthook.yml`: a parallel `pre-commit` with three commands: Biome (`npx @biomejs/biome check --no-errors-on-unmatched {staged_files}`, glob `*.{ts,js,mjs,json}`), `npm run typecheck`, and `node scripts/related-tests.ts {staged_files}` piped to `node --test`. `knip.json` entries: `bin/brain`, `bin/brain-merge`, `src/cli.ts`, `mcp/brain-mcp.ts`, `scripts/*.mjs`, `evals/*.mjs`, `test/**/*.test.mjs`, `test/**/*.assure.mjs`. Install `lefthook@2.2.2` and `knip@6.48.0` with `npm install -D -E`.
- [ ] **Step 5: Tighten Biome** in `biome.json` (formatter stays off): under `linter.rules` set `correctness.noUnusedVariables` and `correctness.noUnusedImports` to `error`; `style.useConst`, `style.useImportType`, `style.useExportType` to `error`; `suspicious.noVar` and `suspicious.noDoubleEquals` to `error` (these group names are verified for Biome 2.6.8). Run `npx @biomejs/biome lint .` and fix every finding in `lib/`, `src/`, `mcp/`, `scripts/` and `evals/` without changing behavior. For `test/**`, fix what is mechanical; a rule with more than 30 test findings is set to `warn` in the existing test override, with a one-line reason in the commit body.
- [ ] **Step 6: CI.** In `.github/workflows/ci.yml` use `npm ci`, add `npm audit --audit-level=high` before the tests and `npm run bulletproof:check` as its own step. Keep the coverage floors (99 lines, 95 branches, 98 functions) and the job split.
- [ ] **Step 7: Run** `npm run bulletproof:check`, `npm test` and the baseline compare. Run `npm run knip`; record its findings in the commit body and fix none yet (Task 12 does). Expected: all PASS, `differing: 0`.
- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "add quality pipeline and related-tests hook"
```

### Task 3: Migration mechanics and platform tests

**Files:**
- Create: `scripts/ts-migrate.ts`, `test/ts-migrate.test.ts`, `test/enumerators.test.ts`, `test/install-path.test.ts`
- Modify: `src/floor.mjs` (renamed to `src/floor.js`), `bin/brain`, `tsconfig.json`, `test/floor.test.ts`, every importer of `src/floor.mjs`

**Interfaces:**
- Produces `scripts/ts-migrate.ts` (CLI `node scripts/ts-migrate.ts <file>...`):
  - `migrate(files: string[], opts: { root: string; dryRun?: boolean }): { renamed: string[]; rewritten: string[] }`: `git mv` each `.mjs` to `.ts`; then (1) in every tracked code file rewrite each relative import specifier and dynamic import whose resolved target is a renamed file, and (2) in every tracked text file except `test/fixtures/**` (code, configuration such as `package.json`, `knip.json`, `tsconfig.json`, `lefthook.yml`, `.github/**`, `hooks/hooks.json`, `.claude-plugin/*.json`, documentation, and `test/golden/**`) rewrite every exact repo-relative path of a renamed file, including path string literals inside code such as `'test/solver.test.ts'` (`lib/store.ts` becomes `lib/store.ts`). Never rewrite by basename alone, and never touch `test/fixtures/**`.
  - `RESULT` is deterministic and idempotent: a second call renames and rewrites nothing.
- Consumes: the per-directory file counts recorded in Task 1's commit body.

- [ ] **Step 1: Write the failing tests.**
  - `test/ts-migrate.test.ts`: in a temp git repository with `a.mjs` importing `./b.mjs`, `docs.md` mentioning `lib/b.mjs` (and a repo path `lib/b.mjs` existing), `test/fixtures/x.md` mentioning `lib/b.mjs`, `test/golden/g.txt` mentioning `lib/b.mjs` and `other/b.mjs`, a `cfg.json` and a `run.js` containing the string literal `'lib/b.mjs'`, and an untouched `c.mjs`: after `migrate(['lib/b.mjs'])` expect `lib/b.ts` to exist, `a.mjs` to import `./lib/b.ts`-equivalent resolved path, `docs.md`, `g.txt`, `cfg.json` and the literal in `run.js` to say `lib/b.ts`, `g.txt` to still say `other/b.mjs`, `test/fixtures/x.md` unchanged, `c.mjs` unchanged; a second `migrate` returns empty arrays.
  - `test/enumerators.test.ts`: for each of `scripts/ci-tests`, `scripts/mutate-all`, `scripts/typecheck` and the file walkers in `test/public-clean` and `test/packaging`, assert the number of source files found is at least the count recorded in the test as constants (the Task 1 commit-body counts), whatever the extension.
  - `test/install-path.test.ts`: copy the plugin (no `node_modules`, no `.git`) to `<tmpdir>/with space é/plangraph/0.0.0`; from a working directory holding a `package.json` with `"type": "commonjs"`, run `node <copy>/bin/brain doctor` and `node <copy>/bin/brain card --if-present`; assert exit 0 and empty stderr. Add a case that runs the entry with `--import` of a stub that sets `process.versions.node` to `22.0.0` and expects exit 3 with the floor message, and exit 0 with empty output under `--if-present`.
  - Extend `test/floor.test.ts`: run `node --no-warnings -e` in a child that imports `stripTypeScriptTypes` from `node:module` and exits 0 only if the output for `src/floor.js` equals its source (no annotations).
- [ ] **Step 2: Run** the four test files. Expected: FAIL.
- [ ] **Step 3: Implement `migrate`** in `scripts/ts-migrate.ts` (parse specifiers with a small tokenizer for `from '...'`, `import('...')` and `export ... from '...'`; resolve with `path.resolve(dirname(file), spec)`). Make each enumerator in the Review Focus list extension-agnostic (accept `.mjs`, `.ts`, and `.js` for `src/floor.js` only).
- [ ] **Step 4: Rename the guard.** The migrate script is not used for it (its target is `.js`). Run `git mv src/floor.mjs src/floor.js`, update every importer with `git grep -l "floor.mjs"` and a targeted replace of `floor.mjs` with `floor.js`, and add a top-of-file comment: this file stays plain JavaScript so a Node too old to strip types can still read it.
- [ ] **Step 4b: Make the test runner see `.ts` tests.** Change the npm `test` script to `node --test "test/*.test.{mjs,ts}"` (quoted, so Node expands the glob), and make `scripts/ci-tests` and the CI commands list `.test.ts` files too. A `.test.ts` file added later must run in `npm test`, in the CI `unit` job and in the `portable` group; add a test in `test/enumerators.test.ts` that creates a throwaway `test/zz-probe.test.ts` in a temp copy and asserts `scripts/ci-tests coverage` lists it.
- [ ] **Step 5: Transitional `tsconfig.json`.** Add `allowImportingTsExtensions: true`; widen `include` to `**/*.ts`, `**/*.mjs` and `src/floor.js`; add `exclude: ["test/types-fixtures"]`; keep `allowJs` and `checkJs`. Run `npm run typecheck`; the ratchet baseline must not rise.
- [ ] **Step 6: Run the Gate.** Expected: PASS, `differing: 0`.
- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "add migration script, plain-JS floor guard, platform tests"
```

### Task 4: Pilot layer, Jira boundary

**Files:**
- Migrate (via `scripts/ts-migrate.ts`): `lib/model.ts` (only the interfaces and the typing of `Ticket`, `Edge`, `ScheduleRow`, `Model`; Task 6 types the rest of the core libraries), `lib/jira.ts`, `src/jira-tenant.ts`, `test/jira.test.ts`, `test/jira-tenants.test.ts`, `test/jira-project-config.test.ts`, `test/doctor-jira.test.ts`, `test/mutation-kills-jira.test.ts`, `test/mutation-kills-jira-edges.test.ts`, `test/jira-slim.test.ts`
- Create: `docs/superpowers/typing-conventions.md`, `test/types.test.ts`, `test/types-fixtures/tsconfig.json`, `test/types-fixtures/jira-bad.ts`
- Modify: `src/commands/audit.ts`, `src/commands/plan.ts` (imports only)

**Interfaces:**
- Produces, exported from `lib/jira.ts` and `src/jira-tenant.ts` with exactly these names:
  - `type AuthMode = 'scoped' | 'site-token' | 'datacenter'`; `const AUTH_MODES: { readonly SCOPED: 'scoped'; readonly SITE_TOKEN: 'site-token'; readonly DATACENTER: 'datacenter' }` (replaces the repeated literals)
  - `interface JiraCredentials { readonly email: string; source: string; readonly token: string }` (the token stays non-enumerable at runtime)
  - `interface SiteEntry { email_env?: string; token_env?: string; op_ref?: string; keychain?: string }`
  - `interface ProjectEntry { auth?: { mode: AuthMode }; base_url?: string; cloud_id?: string; jql?: string; sprint_field?: string }`
  - `interface JiraSettings extends ProjectEntry { userTenant?: boolean }`
  - `interface LoadedRegistry { file: string; exists: boolean; reg: Record<string, SiteEntry>; projects: Record<string, ProjectEntry>; problems: string[] }`
  - `interface TenantResolution { jira: JiraSettings; tenant: string; mode: AuthMode; registry: LoadedRegistry; entry: SiteEntry | null; pinned: boolean; allowGeneric: boolean }`
  - `resolveTenant(committed: JiraSettings | undefined, root: string, env: Record<string, string | undefined>): TenantResolution`
  - `type Exec = (file: string, args: string[]) => Promise<string>` and `getCredentialsFor(host: string, opts: { env?: Record<string, string | undefined>; exec?: Exec; platform?: string; registry?: Record<string, SiteEntry>; allowGeneric?: boolean }): Promise<JiraCredentials>`
  - `class JiraError extends Error { readonly code: JiraErrorCode; status?: number; resetAt?: number }` with `type JiraErrorCode`, a string-literal union of every code the file throws.
- Produces the negative-type suite: `test/types.test.ts` discovers every `test/types-fixtures/*-bad.ts`, runs `tsc --noEmit -p test/types-fixtures/tsconfig.json` once as a child process, and asserts that each fixture file produces exactly the error codes named on its first line (`// expect: TS2322,TS2345`) and no others. A later task adds one fixture file and never edits the runner.
- Produces in `scripts/baseline.ts`: the subcommand `bench --runs N`, which prints the warm median in milliseconds of `node bin/brain card --if-present` on the `plan` fixture (used by Tasks 8 and 12).
- Produces in `lib/model.ts`: `interface Ticket`, `interface Edge`, `interface ScheduleRow`, `interface Model`, with field names exactly the column names in `docs/FORMAT.md`.
- Consumes: Task 3's `migrate`.

- [ ] **Step 1: Run the migration script** on the files above (`node scripts/ts-migrate.ts <files>`), then `npm test`. Expected: PASS (types are still comments; this proves the rename alone is safe). Commit separately: `rename the Jira layer to .ts`.
- [ ] **Step 2: Write the failing negative-type test.** `test/types-fixtures/jira-bad.ts` contains four deliberate misuses: assigning a number to `JiraCredentials.token` (expect TS2322), passing an unknown string where `AuthMode` is required (TS2345), reading `resolveTenant(...).allowGeneric` as a string (TS2322), and calling `getCredentialsFor` without a host (TS2554). `test/types.test.ts` asserts those four codes, in that file, and no others. Run `node --test test/types.test.ts`. Expected: FAIL (the types do not exist yet).
- [ ] **Step 3: Convert** `lib/jira.ts` and `src/jira-tenant.ts` to real annotations: each JSDoc `@typedef`, `@param` and `@returns` becomes a declaration; add the interfaces above; type the `fetchImpl`, `sleep`, `now` and `random` injection points; parse JSON at the edge as `unknown` and narrow with the existing validators (`parseSiteRegistry`, `normalizeIssue`). Replace repeated mode strings with `AUTH_MODES`. Behavior stays identical.
- [ ] **Step 4: Convert** the seven Jira tests: inline types replace JSDoc; every assertion and expected value stays.
- [ ] **Step 5: Write `docs/superpowers/typing-conventions.md`** (one page): how JSDoc maps to TypeScript here (typedef to `interface`/`type`, `@param {X} a` to `a: X`, callbacks to function types), the `unknown`-at-the-edge rule, where assertions are allowed and how to comment them, the `Record<string, string | undefined>` shape for `env`, and how to add a negative-type fixture. Later tasks follow this page and do not restate it.
- [ ] **Step 5b: Add the `bench` subcommand** to `scripts/baseline.ts` with a test (`bench prints a positive number of milliseconds and runs N times`), and type `lib/model.ts` with the four interfaces above (a fixture `model-bad.ts` expects TS2741 for a `Ticket` without `key` and TS2741 for a `Model` without `edges`).
- [ ] **Step 6: Run** `node --test test/types.test.ts` (expected PASS) and the Gate (expected PASS, `differing: 0`).
- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "type the Jira boundary, add typing conventions and negative-type tests"
```

### Task 5: Leaf libraries

**Files:** migrate and type `lib/clock.ts`, `lib/jsonl.ts`, `lib/sanitize.ts`, `lib/fsafe.ts`, `lib/gitsafe.ts`, `lib/schema.ts`, `lib/steer.ts`, `lib/frozen.ts`, `lib/driver.ts`, and the tests that import only these (find each with `git grep -l "lib/<stem>" test/`; migrate every file once). Add `test/types-fixtures/leaf-bad.ts`.

**Interfaces:**
- Consumes: Task 4's conventions page, `Exec`, and the negative-type suite.
- Produces: typed exports with the same names and runtime signatures as today. Where a function returns a shape built from JSON (`lib/jsonl`, `lib/schema`), the return type is an explicit interface exported next to it, never `any`. `lib/gitsafe` and `lib/fsafe` expose their validated values through distinct named types (`SafeRef`, `SafePath`, both `string & { readonly __brand: never }` brands applied only inside the validators) so unvalidated strings cannot reach them.

- [ ] **Step 1: Run** the migrate script on the listed files, then `npm test`. Commit `rename leaf libraries to .ts`.
- [ ] **Step 2: Write the failing negative-type fixture** `leaf-bad.ts`: pass a plain `string` where a `SafeRef` is required (TS2345) and a plain `string` where a `SafePath` is required (TS2345); add the fixture with its `// expect:` first line. Expected: FAIL.
- [ ] **Step 3: Convert the library files.** `lib/sanitize` and `lib/fsafe` are security code: every regular expression, limit constant and error message stays byte-identical; the diff of those two files shows annotation changes only. Review that diff line by line before committing.
- [ ] **Step 4: Convert the matching tests.**
- [ ] **Step 5: Run the Gate.** Expected: PASS, `differing: 0`.
- [ ] **Step 6: Commit** `type the leaf libraries`.

### Task 6: Core libraries, part A (model and decisions)

**Files:** type `lib/store.ts` (`lib/model` was typed in Task 4; import its interfaces), `lib/verify.ts`, `lib/whatif.ts`, `lib/ready.ts`, `lib/merge.ts`, and the tests that import only these or earlier migrated files (including `test/assure/*` oracles for verify, whatif, merge, ready). Add `test/types-fixtures/core-a-bad.ts`.

**Interfaces:**
- Consumes `Ticket`, `Edge`, `ScheduleRow`, `Model` from `lib/model.ts` (Task 4); no module redefines them. In `lib/verify.ts`: `type Violation` and `type Verdict` as discriminated unions on a `kind` or `code` field that already exists at runtime.
- Consumes: Task 5's typed leaf libraries.

- [ ] **Step 1: Run** the migrate script on the listed files, then `npm test`. Commit `rename core libraries A to .ts`.
- [ ] **Step 2: Write the failing negative-type fixture** `core-a-bad.ts`: a `Ticket` without `key` (TS2741), a `Model` built without `edges` (TS2741), a `switch` over `Verdict` that omits a member and assigns the remainder to `never` (TS2322). Add the fixture file with its `// expect:` line (the runner discovers it). Expected: FAIL.
- [ ] **Step 3: Convert in dependency order** (`store`, `verify`, `whatif`, `ready`, `merge`). After each file run `npm run typecheck` and that file's tests. The exhaustive oracles in `test/assure/` must pass unchanged.
- [ ] **Step 4: Convert the matching tests and oracles.**
- [ ] **Step 5: Run the Gate.** Expected: PASS, `differing: 0`.
- [ ] **Step 6: Commit** `type the core libraries, part A`.

### Task 7: Core libraries, part B (analysis and rendering)

**Files:** migrate and type `lib/stale.ts`, `lib/forecast.ts`, `lib/openitems.ts`, `lib/render.ts`, `lib/report.ts`, `lib/integrations/detect.ts`, `lib/integrations/openwolf.ts`, `lib/integrations/superpowers.ts`, and the tests that import them. Add `test/types-fixtures/core-b-bad.ts`.

**Interfaces:**
- Consumes: Task 6's `Ticket`, `Edge`, `Model`.
- Produces: `interface StaleResult { stale: Array<{ key: string; reasons: StaleReason[]; via?: string }>; clean: number; ref: string }` and `type StaleReason = 'plan' | 'files' | 'jira' | 'links' | 'rules' | 'full' | 'producer_changed'` in `lib/stale.ts` (the reason list is the existing `REASONS` constant); `interface ForecastResult` in `lib/forecast.ts` with the fields the code returns today.

- [ ] **Step 1: Run** the migrate script, then `npm test`. Commit `rename core libraries B to .ts`.
- [ ] **Step 2: Write the failing negative-type fixture** `core-b-bad.ts`: a reason string outside `StaleReason` (TS2322) and a `StaleResult` missing `ref` (TS2741). Add the fixture with its `// expect:` first line. Expected: FAIL.
- [ ] **Step 3: Convert** `stale`, `forecast`, `openitems`, `render`, `report`, then `integrations/*`. `lib/render` produces text that goldens pin: its output must not change; run `test/golden.test.*` after the file.
- [ ] **Step 4: Convert the matching tests.**
- [ ] **Step 5: Run the Gate.** Expected: PASS, `differing: 0`.
- [ ] **Step 6: Commit** `type the core libraries, part B`.

### Task 8: CLI core, commands and compile cache

**Files:** migrate and type `src/args.ts`, `src/context.ts`, `src/db.ts`, `src/errors.ts`, `src/registry.ts`, `src/mcp.ts`, `src/cli.ts`, `src/commands/*.mjs` (10 files), and the tests that import them. Modify `bin/brain`. Add `test/types-fixtures/cli-bad.ts` and `test/compile-cache.test.ts`.

**Interfaces:**
- Produces: `interface Ctx` in `src/context.ts` listing exactly the members the commands use today (`root`, `dir`, `env`, `io`, `now`, `config()`, `db()`, `git`); `type Command` and `type CommandMap` in `src/registry.ts`; handlers typed `(ctx: Ctx, args: Args) => Promise<number | void>` as they behave today.
- Produces in `bin/brain`: after the floor check passes, `(await import('node:module')).enableCompileCache?.()` runs before `import('../src/cli.ts')`. It uses Node's default cache directory.
- Consumes: Tasks 4 to 7.

- [ ] **Step 1: Run** the migrate script, then `npm test`. Commit `rename the CLI to .ts`.
- [ ] **Step 2: Write the failing tests.** `cli-bad.ts`: a `CommandMap` entry without `run` (TS2741). `test/compile-cache.test.ts`: run `node bin/brain card --if-present` three times in a fixture with `NODE_COMPILE_CACHE` pointing at an unwritable directory (mode 0500) and assert exit 0, identical stdout across runs, and empty stderr each time (Review Focus 6). Expected: FAIL for the type fixture; the cache test fails until the entry is changed.
- [ ] **Step 3: Convert** `src/errors`, `src/args`, `src/context`, `src/db`, `src/registry`, then the commands, then `src/cli` and `src/mcp`. `src/db` wraps `node:sqlite`: type statement results as `unknown[]` at the call and narrow with the existing row decoders.
- [ ] **Step 4: Edit `bin/brain`** to call `enableCompileCache` as specified and to import `../src/cli.ts` (the migrate script already rewrote the path; verify). Confirm `bin/brain-merge` references no migrated file.
- [ ] **Step 5: Convert the matching tests.**
- [ ] **Step 6: Measure.** Run `node scripts/baseline.ts bench --runs 30` (added in Task 4) now and on the Task 1 commit in a temporary worktree. The difference must be at most 15 ms. Put both numbers in the commit body.
- [ ] **Step 7: Run the Gate.** Expected: PASS, `differing: 0`. If `.baseline/pre-real` exists, also capture and compare against it.
- [ ] **Step 8: Commit** `type the CLI, enable the compile cache`.

### Task 9: MCP server, manifests and docs

**Files:** migrate and type `mcp/brain-mcp.ts`; modify `.claude-plugin/plugin.json`, `hooks/hooks.json`, `.mcp.json` if present, `README.md`, `CONTRIBUTING.md`, `docs/*.md`, `skills/*/SKILL.md`, `briefs/*`, `workflows/*` (exact-path references only, done by the migrate script).

**Interfaces:** consumes the typed `Ctx` and registry; produces no new names.

- [ ] **Step 1: Run** the migrate script on `mcp/brain-mcp.ts`; review `git diff --stat` for unexpected files.
- [ ] **Step 2: Write the failing test** `test/manifest-paths.test.ts`: every path named in `.claude-plugin/plugin.json`, `hooks/hooks.json` and the MCP configuration exists on disk.
- [ ] **Step 3: Convert** `mcp/brain-mcp.ts`; the tool list and JSON-RPC behavior stay identical (the MCP session in the baseline and `docs/MCP.md` are the contract).
- [ ] **Step 4: Search for stale names:** `git grep -n "\.mjs"` must list only `scripts/`, `evals/` and `test/` files not yet migrated, fixture data, and historical `CHANGELOG.md` entries. Fix anything else.
- [ ] **Step 5: Run the Gate.** Expected: PASS, `differing: 0` (this includes the MCP session).
- [ ] **Step 6: Commit** `migrate the MCP server and path references`.

### Task 10: Scripts and evals

**Files:** migrate and type `scripts/ci-tests.ts`, `scripts/make-icon.ts`, `scripts/mutate-all.ts`, `scripts/mutate-pool.ts`, `scripts/mutate.ts`, `scripts/typecheck.ts`, `scripts/baseline.ts`, `scripts/related-tests.ts`, `scripts/ts-migrate.ts`, and the 13 files in `evals/`. Update `scripts/typecheck-baseline.json` keys, the `scripts/mutate*` file lists, `test/golden/mutation-kills/`, `equivalent.json`, `.github/workflows/mutation.yml`, `.github/workflows/ci.yml` and `package.json` scripts for the new names.

**Interfaces:**
- Consumes: the extension-agnostic enumerators from Task 3.
- Produces: the same CLI for each script. `parseTsc(text: string): Map<string, number>` stays exported from `scripts/typecheck.ts`.

- [ ] **Step 1: Run** the migrate script on the listed files, then `npm test`. Commit `rename scripts and evals to .ts`.
- [ ] **Step 2: Rebuild the mutation baselines** with the repository's own tool (`npm run mutate:smoke`) and review the diff of `equivalent.json` and `test/golden/mutation-kills/`: only line numbers and file names may differ. Any other difference stops the task.
- [ ] **Step 3: Convert** scripts and evals to real annotations; the existing `parseTsc` test must pass unchanged.
- [ ] **Step 4: Run the Gate and `npm run mutate:smoke`.** Expected: PASS, and every previously killed mutant is still killed.
- [ ] **Step 5: Commit** `type scripts and evals`.

### Task 11: Tests, helpers and oracles

**Files:** migrate and type every remaining `.mjs` under `test/`: `test/helpers/*` (4), `test/fixtures/*` (1 code file), `test/assure/*`, and all remaining `test/*.mjs` and `test/*.test.mjs`. Batch with `git ls-files 'test/*.mjs' | sort`: first half, then second half.

**Interfaces:** `test/helpers/cli-fixture.ts` exports `interface Fixture { root: string; run(args: string[], opts?: RunOpts): RunResult }`, `interface RunOpts { env?: Record<string, string>; cwd?: string }`, `interface RunResult { code: number; out: string; err: string }`.

- [ ] **Step 1: Convert the helpers first** (`test/helpers/*`, `test/assure/oracle`, `test/assure/enum`), run `npm test`, commit `type the test helpers`.
- [ ] **Step 2: Migrate and type the first half** of the remaining tests, run the Gate, commit `type tests, first half`.
- [ ] **Step 3: Migrate and type the second half**, run the Gate, commit `type tests, second half`.
- [ ] **Step 4: Verify** `git ls-files '*.mjs'` prints nothing, and `git ls-files '*.js'` prints only `src/floor.js` and `workflows/audit.workflow.js`.

### Task 12: Strict flags, ratchet to zero, knip

**Files:** modify `tsconfig.json`; delete `tsconfig.strict.json`; modify `scripts/typecheck.ts`, `scripts/typecheck-baseline.json` (delete), `knip.json`, `docs/research/tsc-baseline.md`.

**Interfaces:** produces the final compiler options of spec section 5. `npm run typecheck` runs one `tsc --noEmit` and exits non-zero on any error; the baseline file is removed.

- [ ] **Step 1: Write the failing check** `test/tsconfig.test.ts`: the parsed `tsconfig.json` has `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`, `erasableSyntaxOnly` and `allowImportingTsExtensions` all `true`, and `allowJs` and `checkJs` absent or `false`.
- [ ] **Step 2: Turn the flags on** and run `npx tsc --noEmit`. Fix every error at its cause, in this order of preference: a narrower type, a narrowing function, a guarded check, and only then a commented assertion. If a fix would change runtime behavior, stop and report the case instead of fixing it.
- [ ] **Step 3: Remove `allowJs` and `checkJs`**; keep `src/floor.js` outside `tsc`. Delete the ratchet machinery and `tsconfig.strict.json`; reduce `scripts/typecheck.ts` to a thin wrapper around `tsc --noEmit`; update `docs/research/tsc-baseline.md` to say the ratchet ended at zero.
- [ ] **Step 4: Run `npm run knip`** and remove every unused export and dependency it reports, except intentional semantic aliases, each listed in `knip.json` with a reason.
- [ ] **Step 5: Re-measure startup** with `node scripts/baseline.ts bench --runs 30` against the Task 1 worktree; the difference must still be at most 15 ms. Record both numbers in the commit body.
- [ ] **Step 6: Run the Gate.** Expected: PASS, `differing: 0`.
- [ ] **Step 7: Commit** `enable strict TypeScript, end the ratchet, clear dead code`.

### Task 13: Governance and packaging (from the owner's modernization playbook)

**Files:**
- Create: `CODE_OF_CONDUCT.md`, `.github/ISSUE_TEMPLATE/bug_report.md`, `.github/ISSUE_TEMPLATE/feature_request.md`, `.github/pull_request_template.md`, `test/governance.test.ts`
- Modify: `package.json`, `.github/dependabot.yml`, `CONTRIBUTING.md`, `SECURITY.md`, `README.md`, `.github/workflows/ci.yml`

**Interfaces:** none produced. Consumes the scripts from Task 2.

- [ ] **Step 1: Write the failing test** `test/governance.test.ts`: the files above exist; `package.json` has `"private": true` (the plugin is distributed through git and must never be published to npm by accident), `"type": "module"`, `engines.node` equal to `>=24.2`, a `packageManager` field of the form `npm@<semver>`, `license` `MIT`; `.github/dependabot.yml` has a weekly schedule for both `npm` and `github-actions` with the dev and production dependencies in separate groups; `CONTRIBUTING.md` names `bulletproof`, `bulletproof:check`, `knip` and `test:related`; the README has sections Requirements, Installation, Quick Start, Development (with a scripts table), Contributing, Security, Changelog and License. Run it. Expected: FAIL.
- [ ] **Step 2: Write the files and edits.** `CODE_OF_CONDUCT.md`: the Contributor Covenant 2.1 text with the repository's security reporting route as the contact (no email address; `test/packaging.test.*` forbids one in `SECURITY.md`, apply the same rule). Issue and pull request templates: short, with a checklist that names `npm run bulletproof:check`. `package.json`: add `private`, `packageManager` (the `npm --version` of the machine at execution time), keep everything else. `dependabot.yml`: weekly, grouped dev and prod. CI: add a Node matrix of the floor major (`24`) and keep the existing jobs.
- [ ] **Step 3: Run** `node --test test/governance.test.ts` and the Gate. Expected: PASS, `differing: 0`.
- [ ] **Step 4: Commit** `add governance files, issue templates, packaging fields`.

### Task 14: Audit against the owner's playbook

**Files:** modify `CHANGELOG.md`; create `KNOWN_ISSUES.md` only if something cannot be fixed.

**Interfaces:** none.

- [ ] **Step 1: Run the checks from the audit playbook that apply:** dependencies (`npm audit --audit-level=high`, `npm ls --all`, no new runtime dependency); static analysis (`npm run knip`, `npm run lint:check`, `npm run typecheck`); security-sensitive code review of `lib/jira.ts`, `src/jira-tenant.ts`, `lib/sanitize.ts`, `lib/fsafe.ts`, `lib/gitsafe.ts` (no secret in errors or logs, no `Math.random` for security values, HTTPS only, timeouts present, no `==`); test quality (coverage floors 99 / 95 / 98 met under `--experimental-test-coverage`); and the private-data scan (`test/public-clean.test.ts` passes, and `git grep -i "atlassian\\.net"` shows only the `acme`-style example hosts already in the tests).
- [ ] **Step 2: Fix every finding** at its cause. A fix that changes behavior needs the owner's approval first: stop and ask.
- [ ] **Step 3: Write the CHANGELOG entry** `## 0.2.0`: the TypeScript migration with no behavior change, new tooling and scripts, file-name changes, the startup numbers.
- [ ] **Step 4: Run the Gate and `npm audit --audit-level=high`.** Expected: PASS.
- [ ] **Step 5: Commit** `audit pass for 0.2.0`.

### Task 15: Release 0.2.0

**Files:** modify `package.json`, `package-lock.json`, `.claude-plugin/plugin.json`, `src/mcp.ts` (`SERVER_VERSION`), `test/golden/mutation-kills/src-core.json` (version string only), `README.md`, `CONTRIBUTING.md`.

**Interfaces:** none.

- [ ] **Step 1: Final differential.** `node scripts/baseline.ts capture --out .baseline/final` (and `--data` for the real directory if it exists), then `compare --a .baseline/pre --b .baseline/final`. Expected: `differing: 0`. Any difference stops the release.
- [ ] **Step 2: Bump the version** to `0.2.0` in the four places. Update README and CONTRIBUTING for the new scripts (`bulletproof`, `bulletproof:check`, `knip`, `test:related`) and the rule "`.ts` runs directly on Node 24, no build".
- [ ] **Step 3: Run the Gate and `npm run smoke`.** Expected: PASS.
- [ ] **Step 4: Commit** `release 0.2.0`.
- [ ] **Step 5: Publish.** The owner has authorized the rename and the release. First rename the repository: `gh repo rename plangraph -R jourlez/open-brain --yes`, then `git remote set-url origin https://github.com/jourlez/plangraph.git` (GitHub redirects the old URL). Then `git fetch origin`, `C=$(git commit-tree 'HEAD^{tree}' -p origin/main -m "release 0.2.0: TypeScript, quality pipeline")`, `git push origin "${C}:refs/heads/main"`. Never push the private history and never force.
- [ ] **Step 6: Update the installed plugin:** `claude plugin marketplace update plangraph-marketplace`, then `claude plugin update plangraph@plangraph-marketplace` (the `claude` binary is inside the editor extension directory if it is not on the path). Tell the owner to restart Claude Code, then run `brain doctor --fix` to repoint the merge driver at the new install, and `brain doctor` to confirm the `jira:` lines.
