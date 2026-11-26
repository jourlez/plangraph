# Audit A: 1.0 plan vs real code

Plan: `docs/superpowers/plans/2026-11-26-plangraph-1.0.md`. Checked against the code on main (0.5.0). Counts: 3 BLOCKER, 10 MAJOR, 11 MINOR.

## Blast radius of Tasks 4, 4B, 4C (measured)

Pattern: `tickets|edges|schedule|people|sprints|epics|refs|capacity|repos|links|xrefs|evidence|findings|learnings|open-items .jsonl`, `canonFile`, `readRecords`, `SCHEMAS`, `canonText`, `readJsonl`.
- Tests: 84 of 207 `test/*.test.ts` files (909 lines) use the old layout directly. Fixtures are written inline (for example `test/golden.test.ts:44`), not from `test/fixtures`.
- Goldens: 41 of 137 `test/golden/*.txt` embed a JSONL file name, a `"fresh":{"fp":...}` fingerprint or the card `@hash`. That hash is computed over the JSONL bytes and file names (`src/commands/queries.ts:375-382`, `src/db.ts:201-211`).
- lib: 13 files (store, schema, model, jsonl, capacity, openitems, stale, graph/files, integrity, views, repo, touches, catalog).
- src: `src/db.ts` (index columns come from `SCHEMAS[file].order`, `src/db.ts:99`), `src/merge-main.ts` and 11 command files. There are about 60 direct file-read sites and 22 `writeState` sites.
- Other: `bin/plangraph-solve` (Python `--jsonl-dir`, `:284-290`); `scripts/baseline.ts`, `scripts/solver-measure.ts`; 45 `evals/cases/*.json` plus `evals/gen.ts` and `evals/families.ts`; 5 `skills/*/SKILL.md`; about 15 `docs/*.md`; `seed/learnings.seed.jsonl`; the mutation pins (`test/golden/mutation-kills/store.json` and others, 47 `lib/store.ts` refs) and `scripts/mutate/trust-roots.json`.

## BLOCKER

**B1. Task 4B cannot keep its own test: "byte-identical to the frozen goldens; the goldens do not change".**
- Evidence: 41 goldens hash the file bytes and names. Integrity output names `tickets.jsonl` (`lib/graph/integrity.ts:61`). Task 4B Step 3 deletes the old readers, but its Step 1 test builds "through the old fixtures". After 4A, nothing reads format 1.
- Fix: decompose the move.
  - (a) 4B-0: add a `Store` interface (`readKind` / `writeKind`) and route the 60 read sites, the 22 `writeState` sites, the 5 `readRecords` sites and the `src/db.ts` DEFS through it, still on JSONL. Goldens stay unchanged.
  - (b) 4B-1: add `test/helpers/plan-dir.ts` (`writePlanDir(dir, GenPlan, extras)`) and convert the 84 tests to it mechanically, still on JSONL.
  - (c) 4B-2: normalize fingerprints and file names in `test/golden.test.ts:79`. The controller re-baselines once.
  - (d) 4B-3: add the entity-file backend behind the interface. The mapping test compares the two live backends.
  - (e) 4B-4: switch kinds one group at a time.
  - (f) 4B-5: delete the JSONL backend, the merge driver and `--heal` (with `hooks/hooks.json` in the same commit), and fold 4A's migration removal in here.
  - Keep the index table shapes identical, so the views and the solver stay untouched until 4C.

**B2. The solver refuses any index that changes a table or view. The plan touches it only in 4C, as "version check only".**
- Evidence: `bin/plangraph-solve:181-230`. `schema_kind` returns None for any table outside `INDEX_TABLES`. `GRAPH_VIEWS` must equal the view SQL byte for byte. `content_digest` hashes a fixed table list that must match `src/db.ts:219`.
- These tasks add tables or change views: Task 4 (`source_file`), 4C (`requirement`, `decision`, `team`, `event` and both views), Task 5 (`identity`) and Task 7 (`module`). Each one makes `plangraph-solve` print "run plangraph build" on every index.
- "v1 part SQL byte-equal" is meaningless: each view is one SQL string. The `src/db.ts schemaKind` current/prev/older logic (`:369`) also needs a new generation.
- Fix: put `bin/plangraph-solve`, `test/solver*.test.ts` and `test/plangraph-solve-input.test.ts` in the file list of Tasks 4, 4C, 5 and 7. Or better: keep non-solver tables in a second database file or an allowlisted "advisory" set that the solver ignores, and decide this in Task 4.

**B3. The Task 4B mapping table drops data and contradicts the relation grammar.**
- Dropped data:
  - `capacity.jsonl` has `review_h` (`lib/store.ts:62`). The mapping keeps only `{S<n>: sp}`.
  - `xrefs.jsonl` has `src` and `seen`. `Xref` keeps only `sys`, `xid` and `note`.
  - Some `refs.jsonl` rows are keyed `sp:<slug>`: plan and epic rows, not tickets (`lib/graph/views.ts`, the g_nodes `ref ... instr(key,'/')=0`). "Fields of the ticket" leaves them homeless.
  - Some `links.jsonl` / `xrefs.jsonl` rows have a source type with no node file (`plantask`, `openitem`, `plan`, `doc`, `x-*`, per `lib/graph/files.ts:16`). They have no "source node" to live in.
- Contradiction: storing `needs` as a stored link breaks `DERIVED_RELATIONS` (`lib/graph/files.ts:26`). Today a links row with a derived relation is a data error. `lib/graph/files.ts` is not in Task 4B's file list.
- Fix: extend `Node`/`Xref`, give plan, epic and plantask refs their own kind directory, define a home for links from file-less types, and add `lib/graph/files.ts` to 4B.

## MAJOR

**M1. Task 4: removing the merge driver is much larger than listed.**
- The plan lists "driver files, .gitattributes, `card --heal`". The real scope also covers:
  - code: `lib/driver.ts`, `lib/merge.ts`, `src/merge-entry.js`, `src/merge-main.ts`, `bin/plangraph-merge`, `installMergeDriver` / `doctorMergeDriver` (`lib/store.ts:319-398`), `doctor --fix` (`src/commands/plan.ts`), `SIDE_WRITES` (`src/registry.ts:25`), `explain`;
  - config: `package.json` bin, `knip.json`, `tsconfig*.json`, `src/floor.js`;
  - tests and goldens: about 30 tests (`driver*`, `merge*`, `heal-marker`, `contract.test.ts:286-316`) and 4 `doctor*` goldens.
- `hooks/hooks.json` calls `card --if-present --heal`. Removing `--heal` in Task 4 breaks the SessionStart hook until Task 19.
- Fix: list these files, and change `hooks/hooks.json` in the same commit.

**M2. Tasks 5, 13, 15 and 19: the registry cannot express per-subcommand `writes`/`guard`.**
- `src/registry.ts:12,47-63`: one `CommandSpec` per name. `NAME` allows no space. `guard(values)` sees options, not positionals.
- The repo's precedent is a separate writer command (`graph` vs `graph-materialize`, `src/commands/graph.ts:5`). "`flow` ... writers `claim`, `progress`, `done` declared `writes: 'text'`" is not implementable as written. Neither are `identity map`, `docs build` and `hooks install`.
- Fix: either name the writers as separate commands (`flow-claim`, ...), or extend the registry with a `sub` map and update `explain` and `contract.test.ts`.

**M3. Wave conflicts.**
- Wave 2 runs 7 and 9 in parallel. Task 7 creates `src/commands/ingest.ts` and Task 9 modifies it.
- Wave 4 runs 16 in parallel with 15. Task 16 modifies `src/commands/docs.ts`, which 15 creates, and consumes `GENERATORS` (`rtm`).
- Task 19 creates three commands but does not list `src/commands/index.ts`.
- Tasks 5, 6, 7, 9 and 11 all edit `SHAPES` in `test/json-envelope.test.ts` and `test/hostile-fuzz.test.ts` in parallel.
- Fix: run 7 before 9, and 15 before 16. Add `index.ts` to 19. The controller owns the SHAPES edits.

**M4. Task 2: semantics and file list.**
- Applying `SPRINT_CLOSED` to every schedule row flags all done work in past sprints. whatif checks only the move target (`lib/whatif.ts:153-154`).
- `BLOCKED` as an error flags every ticket that waits on an open item, which is the normal state.
- Python `verify` (`bin/plangraph-solve:545`) is cross-checked against `verifyPlan` (`test/solver-trust.test.ts:99`) and does not know either code.
- The card line prints the `verifyPlan` count (`src/commands/queries.ts:382`), so the card goldens change.
- `HARD` is duplicated in `src/commands/plan.ts:34`.
- Fix: exempt done, frozen and past-sprint rows. Add the solver, `plan.ts`, the card goldens and the verify mutation pins to the file list.

**M5. Task 4/13: `appendEvent` uses a session "once per process".**
- Each CLI call is a new process, so each `flow claim` creates a new `events/<yyyy-mm>/<random>.jsonl`. File names are random, which breaks Task 21's "re-run byte-equal".
- `seq` is used in the sort but not defined in `appendEvent` or `TaskEvent`.
- Fix: a session id derived from the branch and the day, or `by` plus the day. Define `seq`.

**M6. Task 4: the merge-safety claim is overstated.**
- With one field and one array element per line, git conflicts on adjacent-line edits (for example `sp` / `summary`).
- Two branches that each append a link to the same node always conflict: both touch the previous last element's comma.
- The listed merge tests cover only benign cases.
- Fix: add adjacent-field and concurrent-link-append tests, and document the expected conflicts, or use a trailing-element layout.

**M7. Tasks 4A, 4 and 4B require edits to controller-owned files.**
- Global Constraints line 26 forbids implementers to edit `test/golden/mutation-kills/*.json` and `scripts/mutate.ts` pins.
- 4A must delete pins for `migrate-names`, and `trust-roots.json` lists `lib/driver.ts`, `src/merge-entry.js` and `lib/migrate-names.ts`. 4 and 4B invalidate `store.json`.
- Fix: schedule the controller's pin edits inside these tasks.

**M8. The "baseline compare `differing: 0`" gates in 4B, 23 and 25 are impossible.**
- `scripts/baseline.ts` captures merge-driver, legacy-repo and `oldNames` probes (`:9,47`), and its input is generated in format 1 (`genModel`, `:261`).
- Fix: re-capture a 1.0 baseline after 4B and compare later waves against it.

**M9. Task 10: a per-task `Assignee` "becomes a schedule row".**
- A schedule row needs a sprint. Ingest seeds rows only with an owner and a sprint (`lib/integrations/superpowers.ts:566`), and `docs/FORMAT.md:89` says schedule rows are never changed.
- A changed assignee on re-ingest is undefined.
- Fix: write `assigned_to` without a slot, or require `--sprint`, and specify what happens on re-ingest.

**M10. Task 7.**
- `CACHE_FILES` rows all go through one `obsProblem` path into the `obs` table (`src/db.ts:297-299`). Module rows do not fit `OBS_COLUMNS`.
- `makeGit` is a synchronous `execFileSync` with a 30 s timeout (`lib/gitsafe.ts:14-15`), not streaming. 20k commits with `--numstat` exceed it.
- Fix: keep `cache/git.jsonl` out of `CACHE_FILES`, give it its own loader, and add a streaming spawn helper to `lib/gitsafe.ts` (a mutation trust root).

## MINOR

- **m1. Global Constraints:** `fenceBlock` and `fencedList` live in `src/commands/shared.ts:47-50`, not `lib/sanitize.ts`. New `lib/` modules importing them invert the layering. Move them.
- **m2. Tasks 3, 4B, 17:** `genPlan` is in `test/fixtures/gen.ts:15`, not `test/helpers`. It has no repos, people or requirements, so "genPlan with 60 repos" needs an extension.
- **m3. Missing test files:**
  - Task 7: `test/obs.test.ts`.
  - Task 11: `test/sync-command.test.ts`; the real file is `import-sync-branches.test.ts`.
  - Task 19: `test/hooks.test.ts`; the real file is `hook.test.ts`.
  - Task 19: `test/session-hook*.test.ts`; none exist.
  - Task 10: `test/sp-ingest*.test.ts`; the real files are `superpowers-ingest*.test.ts` and `sp-ingest-solver.test.ts`.
- **m4. Signatures and anchors:**
  - `touchesFor` returns `TouchResult {verdict, touches}`.
  - `parseCatalogInfo(text, people): CatalogSeed`.
  - `repoScan` is `scanRepo`.
  - provider `normalize` is a method of `GraphProvider`.
  - `buildIndex(ctx, {file, now})`, not `(root, db)`.
  - `parsePlan` is at `:196`; `sp-link` is at `:161`.
- **m5. Task 3:**
  - `neighbors` refuses depths above 50 and does not clamp; 21 is valid (`src/commands/queries.ts:79-83`).
  - The 0.3.0-equivalence tests are deleted by 4A one wave later.
  - "Spy on the constructor" of the ESM function `modelSource` needs an injection seam.
- **m6. Task 1:** `--test-shard` splits by index (`ci.yml:173`). Rebalancing needs `scripts/ci-tests.ts` shard lists, `test/workflows.test.ts:115-122` and `test/ci-tests.test.ts`.
- **m7. Task 2:** `IntegrityViolation.line` already exists (`lib/graph/integrity.ts:14,61`). JSONL line numbers become moot after 4B.
- **m8. Task 19:** the new matcher drops `fork` from the current `startup|resume|clear|compact|fork`.
- **m9. Task 11:**
  - `sync` is `writes: 'none'` (`src/commands/sync.ts:56`), so `--fetch` needs an option-level `writes`.
  - `x-confluence.page` needs a provider in `PROVIDERS` (`lib/graph/provider.ts:162`); none is listed.
- **m10. Task 5:** a 0600 `cache/identities.json` copied into an `identity` table puts account refs in `plangraph.sqlite`. Check the index file mode.
- **m11. Naming:**
  - `hook` and `hooks` are two commands one letter apart.
  - `lib/context.ts`, `src/context.ts` (Ctx) and `src/commands/context.ts`.
  - The relation class `identity` already exists (`REL_SEMANTICS` `tracked_by`).
  - `skills/docs` has trigger words (`Docs`, `Confluence`) that overlap other installed docs skills.
  - `ingest` joins `sp-ingest`, `import` and `jira-import`.
  - Task 18: `.mcp.json` default-on contradicts `mcp/plangraph-mcp.ts:2` ("NOT started by the plugin"). The `2026-07-28` `server/discover`/`ttlMs`/`cacheScope` features are unverified.
  - No hard collision: `export`, `check` and `graph` exist, but the new names are subcommands.

Verified as stated: `makeGit`, `writeAtomicSafe`, `readCapped`, `canonFile`, `readRecords`, `oneLine`, `CARD_BUDGET`, `SCHEMAS`, `migrations`, `ctx.now()`, `ctx.db()`, `blockersOf`, `readySet`.
