# Known issues

Open problems that are known and not fixed yet, with the reason and the recommended resolution. Security reports go through the channel in SECURITY.md, not here.

Each entry has six fields: the problem, why it is not fixed now, the recommended resolution, the risk, the affected files (with line numbers where they are known) and the target release. "Deferred" entries came out of the security audit of the TypeScript migration and wait for an owner decision. The pre-existing product bugs and test gaps reported during the migration were fixed in 0.2.1 (see CHANGELOG.md).

## Deferred: owner decision needed

### The `uv run` fallbacks of the solver launcher still read a `uv.toml` from the working directory

- Problem: since 0.2.1 the two uv preparation calls of `bin/brain-solve-run` (`uv sync --locked --script`, `uv python find --script`) run from the plugin's `bin` directory, so a `uv.toml` (or `pyproject.toml` `[tool.uv]`) in the user's repository is not read on the normal path. The fallbacks taken when that preparation fails (an older uv without `sync --script`, or `BRAIN_SOLVE_LAUNCH=uv-run`) `exec uv run` in the user's directory, because the solver must run there (its arguments may be relative paths), and uv then reads the repository's config. The interpreter choice is fixed in 0.2.4: uv also picked the interpreter of those `uv run` calls from a `.venv` (every uv version) or `.python-version` (uv 0.4.30) committed in the working directory, which ran a repository-chosen executable; both fallbacks now pass an absolute `--python` found from `bin` (`test/solver.test.ts`). Only the `uv.toml` residue stays open, for 0.3.0.
- Why not fixed now (ruling for 0.2.1): `--no-config` (or `UV_NO_CONFIG=1`) also drops the user's own uv config, such as a private index or corporate mirror set in `~/.config/uv/uv.toml`, and `uv run --directory` would change the solver's working directory. Moving the main path out of the repository closes the case without either cost; the fallbacks are left as they are.
- Recommended resolution: drop the `uv run` fallbacks once the minimum supported uv has `sync --script` (then every uv call runs from `bin`), or pass `--no-config` on the fallbacks only, with a note on setting a mirror through `UV_INDEX_URL` or `UV_DEFAULT_INDEX`.
- Risk: low for the `uv.toml` residue. It needs an older uv (or a failing preparation); a hostile `uv.toml` can redirect the package index, and `--locked` with the hashes in `bin/brain-solve.lock` should refuse substituted artifacts. It cannot choose the interpreter since 0.2.4.
- Affected files: `bin/brain-solve-run`.
- Target release: 0.3.0

### `card --heal` wires the merge driver in any repository with a committed brain directory

- Problem: the SessionStart hook runs `brain card --if-present --heal`. In any repository that has a committed brain directory, heal writes `.gitattributes`, `merge.brain-jsonl.*` in `.git/config` and the shim in the user data directory, even if the user never ran `brain init` there.
- Why not fixed now: changing it changes the hook's behavior for existing users (a clone would no longer get a working merge driver on its own). That is the owner's call.
- Recommended resolution: heal only repositories that were initialised once by `brain init` or `brain doctor --fix`, recorded by a marker in the user data directory; otherwise the card nudges the user to run `brain doctor --fix`.
- Risk: low. The shim and target are the plugin's own files, and git runs only the shim the user's own data directory holds; the concern is writing config the user did not ask for.
- Affected files: `src/commands/queries.ts` (`healMergeDriver`), `hooks/hooks.json`.
- Target release: 0.3.0

### Redaction misses case-changed and partial tokens

- Problem: secret redaction in error and log output covers each registered secret as is, JSON-escaped, base64 and base64url (whole, and inside a longer blob at any byte offset), hex (both cases) and percent-encoded (as `encodeURIComponent` writes it, lower-case, and every byte escaped). It does not cover a case-changed copy, a partial token or other transforms.
- Why not fixed now (ruling for 0.2.1): no server is known to echo those forms, and matching them (case-folding or partial matches) risks redacting ordinary data.
- Recommended resolution: none for now; revisit if a server is found to echo a transformed token.
- Risk: informational.
- Affected files: `lib/jira.ts` (redaction).
- Target release: 0.3.0

### `bin/brain` and `bin/brain-merge` are not linted or typechecked

- Problem: the two entry points have no file extension, so Biome and tsc skip them. `bin/brain` now holds the floor check and the private compile-cache setup.
- Why not fixed now: neither tool supports extensionless files, and `bin/brain` must stay plain JavaScript that parses on an old Node (no type annotations), so it cannot become a `.ts` file.
- Recommended resolution: keep both files small; the behavior is covered by tests that run them as processes (`test/floor.test.ts`, `test/compile-cache.test.ts`, `test/install-path.test.ts`, the merge-driver tests).
- Risk: informational.
- Affected files: `bin/brain`, `bin/brain-merge`.
- Target release: 0.3.0

### Mutation kills that still depend on a clock or a timeout

- Problem: since 0.2.3 every mutant that `npm run mutate` (the required CI job) pins is killed by a failing assertion. The audit for 0.2.3 recorded, for each pinned mutant, which tests fail and how long the run takes. It also ran `mutate-all` on `lib/store.ts`. Three kinds of clock dependence remain. (1) `scripts/mutate-all.ts` (local, informational in CI) still counts a run past its per-mutant timeout as killed, by design. Only `lib/store.ts` was audited for those: its 4 timeouts were endless lock loops, and `test/lock-bound.test.ts` now kills them on an attempt count. The other files were not audited, because a full run takes hours. (2) The wall-clock checks stay in the suite as tests: the `timing:` and `scaling` tests, and the `budget()` bounds in `test/helpers/perf.ts`. They can still fail on a badly overloaded machine, but no pinned mutant relies on them any more. (3) The deterministic work count (`builtinWork` in `test/helpers/perf.ts`) only sees the listed Array and String built-ins. A quadratic hand-written loop is caught only by the wall-clock `scaling` check.
- Why not fixed now: a hang can only be told apart from slow progress with a bound, and auditing every library file under `mutate-all` takes hours of machine time. The remaining wall-clock tests check real elapsed time, which no work count replaces.
- Recommended resolution: when `mutate-all` reports a `timeout` for a file, add a test that bounds the loop by a count (see `test/lock-bound.test.ts`). When a new size-axis check is added, pair it with a `workScaling` check.
- Risk: informational (test tooling only; no runtime effect).
- Affected files: `scripts/mutate-all.ts`, `test/helpers/perf.ts`, the `timing:` tests in `test/hook.test.ts`, `test/driver-wiring.test.ts` and `test/gitsafe.test.ts`.
- Target release: 0.3.0

## Open for 0.3.0 (work in progress)

These entries record the open items of the 0.3.0 plan so the record is complete while the work is open. Each is removed by the commit that closes it, and the list is empty at release.

### `BRAIN_SOLVE_SCRIPT` with a failed preparation installs OR-Tools through an unhashed `uv run --with`

- Problem: when `BRAIN_SOLVE_SCRIPT` overrides the solver script and the uv preparation fails, `bin/brain-solve-run` falls back to `uv run --with "$PIN" python "$SCRIPT"`, which resolves OR-Tools without the hashes of `bin/brain-solve.lock`.
- Why not fixed now: the override exists for tests and mutation checks; the fix belongs with the rest of the launcher work (the uv residue above).
- Recommended resolution: refuse the override fallback, or install from the hashed lock.
- Risk: low (the override is an environment variable the user sets).
- Affected files: `bin/brain-solve-run:38-39`.
- Target release: 0.3.0

### Shell scripts have no shellcheck

- Problem: `bin/brain`, `bin/brain-merge`, `bin/brain-solve-run` and `test/smoke.sh` are not checked by a shell linter locally or in CI.
- Why not fixed now: no script runs shellcheck yet.
- Recommended resolution: `npm run lint:sh` over the shell scripts, enforced in the `static` job.
- Risk: informational.
- Affected files: `bin/brain-solve-run`, `test/smoke.sh`, `.github/workflows/ci.yml`.
- Target release: 0.3.0

### The Node floor and the supported Python range are not tested at their edges

- Problem: no job runs a real Node below the floor, so the SessionStart hook's refusal on Node 18 and 20.0 to 20.9 (where an extensionless entry under `"type": "module"` is likely refused before any code runs) is unproven. The exact floor is not tested in CI either, and on Node 24.2.0 (the current floor, `src/floor.js:7`) every command prints two runtime warnings (measured). Python 3.10, the solver's floor, is never tested.
- Why not fixed now: the floor rises to 24.15 with the launcher work, and the matching CI legs come with the CI task.
- Recommended resolution: raise `NODE_FLOOR` to 24.15, print one line from the hook below it, and add a floor job (Node 18, 20.9.0, 24.14.0), a compat job (24.15.0) and a solver leg on Python 3.10.
- Risk: low.
- Affected files: `src/floor.js:7`, `hooks/hooks.json`, `.github/workflows/ci.yml`.
- Target release: 0.3.0

### Six command files are below 90 percent branch coverage, and `mcp/brain-mcp.ts` is below the floors

- Problem: branch coverage per file is below 90 in six `src/commands` files (lowest `plan.ts`, 80.71); `mcp/brain-mcp.ts` measures 88.89 lines, 66.67 branches and 50.00 functions. Since 0.3.0-dev `mcp/**` is inside the coverage run (`scripts/test-coverage.ts`), the global floors still hold.
- Why not fixed now: no per-file floor exists yet.
- Recommended resolution: tests that assert results for those files, then a per-file floor over `coverage/lcov.info`.
- Risk: informational.
- Affected files: `src/commands/*.ts`, `mcp/brain-mcp.ts`, `scripts/test-coverage.ts`.
- Target release: 0.3.0

### Timing tests are flaky under parallel load

- Problem: eight test files use `test/helpers/perf.ts`; under heavy parallel load a wall-clock check can fail. Since 0.2.3 no pinned mutation kill relies on a clock (work counts, `test/lock-bound.test.ts`); the residue is item (2) of the mutation entry above.
- Why not fixed now: each check needs a ratio form measured in the same process.
- Recommended resolution: ratio checks in `-timing.test.ts` files that honor `BRAIN_PERF_FACTOR`, run apart from the parallel suite.
- Risk: informational (test tooling only).
- Affected files: `test/helpers/perf.ts`, the `timing:` tests.
- Target release: 0.3.0

### `npm run mutate` does not say which test failed when its baseline is red

- Problem: `npm run mutate` failed once under load with `baseline is red: refusing to mutate` and printed no test name, so the flake could not be diagnosed.
- Why not fixed now: the runner change is part of the mutation task.
- Recommended resolution: print the failing test file and its `not ok` block, then exit 2 as now; report timeouts apart from kills.
- Risk: informational (test tooling only).
- Affected files: `scripts/mutate.ts:120`, `scripts/mutate-all.ts`.
- Target release: 0.3.0

### `claude plugin validate --strict` is skipped in CI

- Problem: the `static` job runs `claude plugin validate . --strict` only when the `claude` CLI is installed, and runners do not have it, so the step prints a notice and skips.
- Why not fixed now: the CLI is not available on the runners.
- Recommended resolution: install the CLI in the job, or replace the step with a layout check that does not need it.
- Risk: informational (`npm run validate:plugin` still checks the layout).
- Affected files: `.github/workflows/ci.yml:83-86`.
- Target release: 0.3.0
