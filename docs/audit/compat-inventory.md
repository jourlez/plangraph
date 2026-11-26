# Compatibility inventory for pre-launch versions (task 5, step 1)

Scope: every path whose only purpose is reading, converting or staying compatible with a plan directory written by plangraph 0.1 to 0.5, or with the old command names. Built by grep and Read on branch `t5` (base 11e2043). Line numbers are of that tree and are hints: re-verify before each removal commit. No code was changed and no test was run.

Legend for "Covered by": T = test, G = golden (`test/golden/*.txt`), K = mutation-kill golden (`test/golden/mutation-kills/*.json`, keyed by case name), P = pin (`scripts/mutate.ts`, `scripts/mutate/*.json`), R = trust root (`scripts/mutate/trust-roots.json`). The pin files are controller-owned: each commit below lists the pin and trust-root edits as a request to the controller, not an implementer edit.

## 1. Command group: `migrate-names` (commit A)

| # | Path (file:line) | What it does | Covered by |
|---|---|---|---|
| 1 | `src/commands/migrate-names.ts:1-58` (command table entry at :57) | the `migrate-names [--apply]` command; real fs/git adapters | T `test/migrate-names.test.ts`, `test/trust-kills-migrate-names.test.ts`, `test/security-sec2.test.ts:142-154` (M3); G `test/golden/migrate-names.txt`; K `cli.json` keys `migrate-names --bogus` (:1991), `migrate-names (too many)` (:1999) |
| 2 | `lib/migrate-names.ts:1-189` | pure planner: old config dir, `.brain` dir, `.brainrc`, driver names, `.gitattributes` and `.gitignore` rewrite | T same as 1; R `scripts/mutate/trust-roots.json:23`; P any `lib/migrate-names.ts` entries in `scripts/mutate.ts` (grep found none by name, controller to confirm) |
| 3 | `src/commands/index.ts:10,16` | import and `migrateNames` entry in `GROUPS` | T `test/contract.test.ts` registry/explain checks; `test/golden.test.ts:136` |
| 4 | `test/golden.test.ts:136` | golden case `migrate-names` | G `test/golden/migrate-names.txt` |
| 5 | `test/golden/explain.txt:9,10` | `explain` lists `migrate-names` and `migrate-names --apply` in the writes lines | G itself; T `test/contract.test.ts:314` (regex names `migrate-names --apply`) |
| 6 | `test/hostile-fuzz.test.ts:126`, `test/json-envelope.test.ts:62` | per-command argument tables with a `migrate-names` entry | T themselves |
| 7 | `src/jira-tenant.ts:53` | doc comment: "`plangraph migrate-names` copies it" (code reads only the new folder; the comment is the only compat part) | none (comment) |
| 8 | `test/state-paths.test.ts:7-8` and `test/env-names.test.ts` (whole file) | assert old env vars and old config folder are ignored. These guard the absence of a fallback, not a bridge. Decision for the controller: keep as regression guards or delete with the rename history. Listed, not proposed for removal by default | T |
| 9 | `scripts/baseline.ts:464-480` probe `migrate-names` and `:84` `namesOldNames` | baseline probe that runs the command (also covered in group B) | T `test/baseline.test.ts:70-76`, `:180` |
| 10 | `README.md:389` | command table row | T `test/golden/*` none; `test/team-docs.test.ts` only checks other needles |
| 11 | `CHANGELOG.md:41,46,50-53` | history | do not edit (history; controller-owned) |

## 2. Baseline mapping and rename tooling (commit B)

| # | Path (file:line) | What it does | Covered by |
|---|---|---|---|
| 12 | `scripts/baseline.ts:60-86` | `NAME_MAP`, `mapOldNames`, `OLD_NAMES`, `namesOldNames`, `oldNameHits`: map a pre-0.3.0 capture to new names | T `test/baseline.test.ts:9,60-62,180` |
| 13 | `scripts/baseline.ts:47-48` | `normalizeOutput(..., { oldNames })` option | T `test/baseline.test.ts` (normalize cases) |
| 14 | `scripts/baseline.ts:520-521` | capture refuses a stray old name | T `test/baseline.test.ts:180` |
| 15 | `scripts/baseline.ts:535-536` | `compareDirs` maps side `a` (`.baseline/pre-030`) | T `test/baseline.test.ts` compare cases |
| 16 | `scripts/baseline.ts:20` | imports `RULES` from `rename-check.ts` | T `test/baseline.test.ts` |
| 17 | `scripts/rename-check.ts:1-116` | command-word rules and the old-tree vs new-tree check | T `test/rename-check.test.ts`; `test/no-old-names.test.ts:18` (EXEMPT) |
| 18 | `test/no-old-names.test.ts:17-18,26,49` | scan for old names; the EXEMPT list names `lib/migrate-names.ts`, `test/migrate-names.test.ts`, `test/trust-kills-migrate-names.test.ts`, `scripts/baseline.ts`, `scripts/rename-check.ts` and `test/fixtures/release-*`. The scan stays (it guards new code); the EXEMPT entries shrink to what remains | T itself |
| 19 | `test/naming.test.ts:23-25` | previous name allowed only in CHANGELOG; keeps working after removal (allowed set unchanged) | T itself |
| 20 | `scripts/repin.ts:28-29` and `test/repin.test.ts` | generic re-pin tool with `--subst old=new`; written for the rename but general. Proposed: keep (controller tool, not compat code); flag only | T `test/repin.test.ts` |
| 21 | `scripts/ts-migrate.ts`, `test/ts-migrate.test.ts` | `.mjs` to `.ts` rename tool: not plan-directory compat. Out of scope, listed so nobody sweeps it by name | T |

Baseline matrix items tied to the old format (also group B, because the matrix lives in `scripts/baseline.ts`, controller-owned):

| # | Path | Note |
|---|---|---|
| 22 | `scripts/baseline.ts:28,115,131,163-166` | `legacy` fixture (a plan dir with `format.json` deleted) and the `['migrate','--write']` EXTRA entry. After commit C the `legacy` fixture must either be removed or retargeted to the new refusal (`unsupported pre-1.0 directory`, exit 2). Retarget is preferable: it covers the refusal path that must stay |
| 23 | `scripts/baseline.ts:9` | header comment mentions the legacy repository |

## 3. Migration, old-reader checks, 0-to-1 (commit C)

| # | Path (file:line) | What it does | Covered by |
|---|---|---|---|
| 24 | `lib/store.ts:43` `V1_FILES` | frozen file list iterated only by the 0-to-1 migration. Check other users before deleting (it may also feed the index list) | T `test/store.test.ts`; K `store.json` |
| 25 | `lib/store.ts:243-312` `MigrationOp`, `Migration`, `migrations`, `chain`, `MIGRATE_MAX`, `readDataFile`, `planSteps`, `MigrationPlan`, `planMigration`, `runMigration` (incl. `.migrate.lock`) | the whole migration framework and the single 0 to 1 step | T `test/store.test.ts:97-165` (legacyDir, migration 0->1, crash injection, abort, chained 1->2), `test/mutation-kills-store.test.ts:95-108,261-279`, `test/security-final.test.ts:334-393` (I9, five tests), `test/graph-files.test.ts:487-500`; K `store.json` keys `migrate-*`, `perm-migrate`, `migrate-cap`, `migrate-none`, `migrate-raced`; P `scripts/mutate.ts` and `scripts/mutate/equivalent.json` entries for these lines (controller) |
| 26 | `lib/store.ts:11` `MIN_FORMAT` and `:239` NEEDS_MIGRATION throw in `checkFormat`; `:12` `'NEEDS_MIGRATION'`, `'NO_PATH'` codes | old-reader floor. **Replace, do not delete**: the check becomes the `unsupported pre-1.0 directory: recreate it with plangraph takeover` refusal, exit 2 (see section 6) | T `test/store.test.ts:109-112`; K `store.json` lines 203-214, 425-436; P `scripts/mutate/equivalent.json:1264-1265` (`MIN_FORMAT` in `checkFormat`) |
| 27 | `lib/store.ts:207-212` `FormatInfo.legacy` and the missing-file branch returning `{format_version:0, legacy:true}` | v0 "no format.json" reading | T `test/store.test.ts`, `test/security.test.ts:265` (dangling symlink "not legacy"); K `store.json` 203-204 |
| 28 | `src/commands/plan.ts:251-256` `migrate` and `:430` registry entry | `plangraph migrate [--write]` | T `test/golden.test.ts:135`; G `migrate.txt`, `migrate-write.txt`, `migrate-json.txt`; T `test/smoke.sh:93`, `test/integrations-detect.test.ts:369`, `test/hostile-fuzz.test.ts:121`, `test/json-envelope.test.ts:58`, `test/mutation-kills-cli.test.ts:50`, `test/mutation-kills-cli-more.test.ts:15-20`; K `cli.json` 1663-1676 (`migrate --bogus`, `migrate (too many)`), 2139-2148 (`migrate`, `migrate --write`), `cli-more.json` 290-348 (`legacy export`, `legacy ticket T-1`, `legacy migrate`, `legacy doctor`, `legacy card`, `newer migrate --write`) |
| 29 | `src/commands/plan.ts:290` | `doctor` prints `(legacy: run plangraph migrate --write)` and counts it as a problem | T `test/plan-branches.test.ts:165-176`; G `test/golden/err-noplangraph-doctor.txt:4`; K `cli-more.json:314-317` |
| 30 | `src/cli.ts:75,86` | `FORMAT_HINTS` NEEDS_MIGRATION hint and the soft-mode note | T `test/commands.test.ts:349-352`, `test/security.test.ts:287-290`, `test/cli-core.test.ts:87` (exit code of `NEEDS_MIGRATION`); K `cli-more.json:290-304,321-327` |
| 31 | `src/registry.ts:33` | comment on the soft guard mentioning NEEDS_MIGRATION | none (comment) |
| 32 | `src/commands/queries.ts:403-411` | first-use card line `plan data found ... run plangraph migrate --write (format vN) then plangraph build` | T `test/first-use.test.ts:27,41-44` (`LEGACY`) |
| 33 | `src/commands/plan.ts:242` | `init` writes `format.json` for a missing file: **stays** (new directories still stamped) | n/a |
| 34 | `src/db.ts:19-25,71,145,204,364,436-446` and `bin/plangraph-solve:180,203` | accepts an index built by 0.3.0 (8 v1 tables, no view) or 0.4.0 (no `obs` table) as an "older" schema: opens stale, query-only; `V1_TABLE_COUNT`, `V1_TABLES`, `PREV_TABLES`, `older`/`prev` kinds, a v1-only fingerprint rule | T `test/graph-views.test.ts:286-296,306-392,423-428`, `test/plangraph-solve-input.test.ts:75,89-92,131`, `test/cli-core.test.ts:465-475` (legacy-built index is stale); K none by name; P `src/db.ts` entries (controller). The index is a rebuildable cache, so removal is safe in behavior terms: a bad or old index just rebuilds. The fingerprint rule at `src/db.ts:204` and `src/commands/shared.ts:31`, `src/commands/queries.ts:377` ("keeps its 0.3.0 digest") exists only so a v1-only directory keeps the 0.3.0 digest. Judgment call: confirm with the controller whether task 9 (incremental index) replaces this anyway; if so, defer it there |
| 35 | `lib/stale.ts:186` | "legacy row" (audit row without `fp_prods`) treated as stale | T `test/stale.test.ts:254-260`, `test/mutation-kills-stale.test.ts:47-54`; K `stale.json`. Borderline: rows are pre-0.2 data. Confirm with the controller whether this is "format" compat or a live safe-direction rule; default: keep |
| 36 | `test/cli-core.test.ts:36-69,386-399,465-475` `legacyBuild` | frozen copy of the pre-lib `bin/plangraph` build used as a differential oracle. It checks the index builder against the original implementation, not a directory reader. Borderline: removal is possible once the schema is covered by direct tests. Default: keep, decide in step 2 | T itself |
| 37 | `test/jira.test.ts:520-538` `legacyAdf` | oracle copy of the pre-lib ADF flattener. Same class as 36. Default: keep | T itself |
| 38 | `lib/jira/snapshot.ts:1`, `src/commands/shared.ts:120-127` (`toLegacyMap`, legacy JSON map snapshot input) and "legacy string-form sprint values" in `test/jira.test.ts:472,667-670,749`, `test/trust-kills-jira-snapshot.test.ts:65-80,373-386,402-410`, `test/mutation-kills-jira.test.ts:141` | Jira snapshot input forms. The legacy sprint string is a real Jira Server wire format, not a plangraph directory; the legacy map is an input format from the pre-lib CLI. **Not proposed for removal**: not plan-directory compat; flag for the controller only |
| 39 | `test/superpowers-ingest.test.ts:258-264`, `test/build-extra.test.ts:76` | "legacy tickets.jsonl without impl_status round-trips": additive optional field, which is future-compatible reading. **Keep** |

## 4. Frozen 0.3.0 comparison fixtures (commit C, last step, or its own commit C2)

| # | Path | Consumers (file:line) |
|---|---|---|
| 40 | `test/fixtures/release-0.3.0/**` (the cut tree: `TREE`, `bin`, `lib`, `src`, `mcp`, `seed`, `solver`, `package.json`) | `test/mixed-version.test.ts:16,44-146` (whole file), `test/graph-files.test.ts:21,448-500`, `test/graph-views.test.ts:20,286-392`, `test/plangraph-solve-input.test.ts:21,89-92`, `test/blockers-one-more.test.ts:19,46-110` |
| 41 | `scripts/freeze-release.ts` (whole file) and `knip.json:17-18` (`test/fixtures/release-*/**`) | tool that cuts such a tree, and the knip ignore for it. Delete the tool only if no later release will be frozen; the controller decides (a 1.0 freeze for 1.x mixed-version tests would reuse it) |
| 42 | `test/no-old-names.test.ts:26,49`; `test/golden.test.ts:5`; `test/blockers-one.test.ts:3` | comment and EXEMPT rule for `release-*` fixtures |

Tests that compare against the frozen tree and nothing else are deleted whole: `test/mixed-version.test.ts`, `test/blockers-one-more.test.ts`. Mixed files lose only the frozen cases: `test/graph-files.test.ts:448-500` (the "unchanged against frozen 0.3.0" block incl. the 0-to-1 plan comparison), `test/graph-views.test.ts:286-392` (frozen fingerprint and older-schema block, together with row 34), `test/plangraph-solve-input.test.ts:89-92`. `test/mixed-version.test.ts` also exercises the 0.3.0 merge driver; the driver tests are task 11, but the file's reason to exist is the frozen tree, so it goes here.

Note for the controller on `test/graph-files.test.ts:186,213,398` and `docs/FORMAT.md:112`: parser tolerance for "a file an older merge driver rewrote" and the duplicate-node message "a merge by an older plangraph". These serve the merge driver and are task 11.

## 5. Docs, CI and config (commit D)

| # | Path (file:line) | Content | Covered by |
|---|---|---|---|
| 43 | `README.md:256-268` | "Legacy data without `format.json`" section and the doctor/migrate transcript | T `test/team-docs.test.ts`, `test/docs-scripts.test.ts` (check which transcripts are executed) |
| 44 | `README.md:306` | "`plangraph migrate` upgrades an older one" (keep the `min_reader` half) | none |
| 45 | `README.md:388,389` | table rows `migrate`, `migrate-names` | none |
| 46 | `README.md:632,634` | troubleshooting rows for "older format" and `data format 0 is older than 1` | none |
| 47 | `docs/FORMAT.md:38,42-45,47-53,57-60` | "No file = legacy v0", NEEDS_MIGRATION rule, migration framework, expand/migrate/contract policy and the lock text used only by `runMigration`. Keep the stamp, `min_reader`, TOO_NEW and the expand/contract policy for future versions; rewrite the rest | none |
| 48 | `docs/FORMAT.md:94,111-112` | graph-file additive notes and the "older `plangraph-merge` (0.3.0)" sentence (the latter is task 11) | none |
| 49 | `docs/CONTRACT.md:195,218-222` | index built by 0.3.0 is a known older schema; "run `plangraph build` once after upgrading from 0.3.0" | none |
| 50 | `docs/SOLVER.md:303` | "index with exactly the eight tables of 0.3.0" | none |
| 51 | `docs/TEAM.md:50` | "upgrade 0.3.0 clients / older reader of a newer data format" paragraph | T `test/team-docs.test.ts:20` (needles `'0.5.0'`, `'v0.3.0'`, `'.gitattributes'`, `'conflict'`: update the needle list in the same commit) |
| 52 | `docs/TEAM.md:54-57` | "From v0.3.0 on, releases are annotated tags": install instructions, not compat. Keep, but the example tag `v0.3.0` is stale | T `test/team-docs.test.ts:20` |
| 53 | `docs/ADOPT.md:26` | "existing plan data in an older format: run `plangraph migrate --write`" | none |
| 54 | `docs/REUSE.md:32` | "`lib/store` format version and `migrate` ... Keep" | none |
| 55 | `CHANGELOG.md:28,31,41,46-53` | history of the above | do not edit; controller-owned |
| 56 | `.github/workflows/ci.yml:184` | comment "the floor of 0.3.0". Cosmetic: the matrix value (`24.15.0`) stays | none |
| 57 | `test/golden/init.txt:50`, `evals/fixtures/{S,M,L}/format.json`, `evals/gen.ts:72`, `evals/gen-real.ts:84`, `test/assure/{cli,format,ready}.assure.ts` | write `{"format_version":1,"min_reader":1}`. These are the current stamp and **stay** until task 10 changes the version; listed only because grep finds `min_reader` there | n/a |
| 58 | `package.json`, `lefthook.yml`, `scripts/check-package.ts`, `scripts/ci-tests.ts`, `scripts/mutate-all.ts` | no compat script entry found (the hits are the `.mjs` to `.ts` migration comments). `knip.json` needs entries for removed files only if knip reports them in step 3 | none |

## 6. Must NOT be removed (serves future versions)

- `format.json` itself: `FORMAT_FILE`, `FORMAT_VERSION`, `readFormat`, `writeFormat`, `checkFormat` and `FormatError`, `lib/store.ts:207-241`, and `init` writing the stamp (`src/commands/plan.ts:242`).
- The refusal path: `TOO_NEW` ("newer than this tool supports: upgrade the plangraph plugin"), `mode:'read'` honoring `min_reader <= tool version`, and unknown fields in `format.json` kept on write. Covered by `test/store.test.ts:109-124`, `test/golden/err-newer-format.txt`, `cli-more.json` keys `newer *`, `store.json` min_reader cases. The NEEDS_MIGRATION branch is the one piece of `checkFormat` that is replaced (row 26) by the `unsupported pre-1.0 directory` refusal, exit 2, same soft/strict guard behavior in `src/cli.ts:86`.
- `FormatInfo.min_reader` and the `1 <= min_reader <= format_version` validation (`lib/store.ts:224-225`).
- The `FormatError` to exit code mapping and the `relDir` message cleaning (`src/cli.ts:131`).
- `docs/FORMAT.md` policy text for expand, migrate and contract, and for TOO_NEW: they describe how future versions evolve.
- The `format.json` stamp in fixtures and goldens (row 57) until task 10 bumps it.
- `lib/store.ts` locks (`withLock`, `:125-135`): used outside migration too; only the `.migrate.lock` call site goes.

## 7. Belongs to task 11, not task 5

- Merge driver: `lib/driver.ts`, `lib/merge.ts`, `src/merge-entry.js`, `src/merge-main.ts`, `bin/plangraph-merge`, `installMergeDriver` and `doctorMergeDriver` (`lib/store.ts:319-398`), `wireMergeDriver` (`src/commands/plan.ts:245`, `doctor` at `:291-300`), `SIDE_WRITES` (`src/registry.ts:25`), `healMergeDriver` and the grandfathering note "wired before 0.3.0" (`src/commands/queries.ts:339-346`), `plan.ts:297`.
- `--heal` (`card --if-present --heal` in `hooks/hooks.json`), the `heal-marker`, `driver*`, `merge*`, `mutation-kills-driver/merge`, `trust-kills-driver` tests (`test/trust-kills-driver.test.ts:50,56` mention 0.3.0 only as a version string).
- `explain` text for `card --heal` and `.gitattributes, merge shim` (`test/golden/explain.txt:10`; the `migrate-names --apply` half of that line goes in commit A; the line is edited twice, so expect a golden conflict between the two commits).
- The JSONL backend and `lib/jsonl.ts` read paths; `.gitattributes` writes in `init`.
- Parser tolerance for files an older merge driver rewrote, and "a merge by an older plangraph" DUPLICATE_NODE wording (`test/graph-files.test.ts:186,213,398`; `docs/FORMAT.md:112`).

## 8. Proposed removal commits (step 2, one area each; subject `remove compatibility code for pre-launch versions: <area>`)

1. **command**: rows 1-11. Delete `src/commands/migrate-names.ts`, `lib/migrate-names.ts`, the `GROUPS` entry, tests `test/migrate-names.test.ts` and `test/trust-kills-migrate-names.test.ts`, `test/security-sec2.test.ts` M3 case, `test/golden/migrate-names.txt`, the `golden.test.ts:136` case, the fuzz and envelope entries, the `explain` golden half-line, the `cli.json` keys, the README row and the `src/jira-tenant.ts:53` comment. Controller: drop `lib/migrate-names.ts` from `trust-roots.json:23`, drop any pins, regenerate `cli.json` and `explain.txt`. The baseline `migrate-names` probe (row 9) must leave in commit 2, but its test (`test/baseline.test.ts:70-76`) runs the command: do rows 9 and 12-19 first or together to keep every commit green. Practical order: commit 2 before commit 1, or fold row 9 into commit 1.
2. **baseline mapping**: rows 9, 12-19, 22-23 and the `scripts/rename-check.ts` file with its test; shrink the `no-old-names` EXEMPT list. Retarget the `legacy` matrix fixture to the new refusal instead of deleting it, so the baseline still covers the refusal path (this needs commit 3's behavior; if ordered before it, only drop the `['migrate','--write']` EXTRA entry now and retarget in commit 3). Controller: edit `scripts/baseline.ts` probes (controller-owned).
3. **migration and old-reader checks**: rows 24-32 and 34-35 decision. Add the `unsupported pre-1.0 directory` refusal in place of NEEDS_MIGRATION, remove `migrate` command, `V1_FILES`, the migration framework, `.migrate.lock`, `FormatInfo.legacy`, first-use migrate line, doctor legacy line. Delete `test/store.test.ts:97-165` migration cases (keep the format gate cases, retarget the legacy-dir one to the refusal), `test/security-final.test.ts:334-393`, the `mutation-kills-store` migrate cases, `test/first-use.test.ts` legacy case (retarget), the migrate goldens (`migrate*.txt`), and update `err-noplangraph-doctor.txt`, `cli-more.json`, `cli.json`, `store.json`. Controller: pins in `scripts/mutate.ts` and `equivalent.json:1264-1265` for `lib/store.ts`.
4. **frozen fixtures and older-index schema**: rows 34 (if confirmed), 40-42. Delete `test/fixtures/release-0.3.0`, `test/mixed-version.test.ts`, `test/blockers-one-more.test.ts`, the frozen blocks in `graph-files`, `graph-views`, `plangraph-solve-input` tests, the `knip.json:17-18` ignore and, by decision, `scripts/freeze-release.ts`. Run after commit 3 because `graph-files.test.ts:487` compares migration plans.
5. **docs**: rows 43-54, 56. Rewrite `docs/FORMAT.md` section 2, drop README sections and rows, update the `docs/TEAM.md` paragraph and the needle list in `test/team-docs.test.ts:20` in the same commit.

After the five commits: full test suite once, `npm run knip`, then the controller refreshes pins, `trust-roots.json`, `store.json`, `cli.json`, `cli-more.json`, `explain.txt` and the baseline.

## 9. Risks and open points for the controller

1. **The stamp**: all 0.1 to 0.5 directories that have a `format.json` carry `format_version: 1`, the same value 1.0 writes today. Refusing "a directory without the new stamp" only catches v0 (no file) until task 10 gives the entity layout a new `format_version`. Until then the refusal in commit 3 distinguishes nothing for 0.4/0.5 directories. Confirm what "the new stamp" is (suggest `format_version: 2` set at task 10, and the refusal checks `< 2` from then; task 5 ships the code path with the v0 case only).
2. Pin churn: `lib/store.ts` and `src/db.ts` carry many pins and equivalents; commit 3 and the older-index decision move line numbers across the file.
3. `scripts/baseline.ts` `legacy` fixture is used for 2 x every command in the matrix; retarget instead of deleting, or the refusal path loses its only cross-command coverage.
4. The `explain.txt` golden line 10 and `cli.json` are touched by commits 1, 3 and (later) task 11: regenerate once per commit, do not hand-merge.
5. Row 34 (older index) and row 35 (legacy stale rows) are judgment calls; defaults: row 34 remove with the frozen fixtures if task 9 does not already supersede it; row 35 keep.
