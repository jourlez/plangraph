# Known issues

Open problems that are known and not fixed yet, with the reason and the recommended resolution. Security reports go through the channel in SECURITY.md, not here.

Each entry lists the problem, why it is not fixed now, the recommended resolution, the risk and the affected files. "Deferred" entries came out of the security audit of the TypeScript migration and wait for an owner decision. "Pre-existing" entries were found before or during the migration and were reported, not introduced, by it.

## Deferred: owner decision needed

### uv reads a `uv.toml` from the working directory

- Problem: on the uv path, `bin/brain-solve-run` runs `uv sync --locked --script`, `uv python find --script` and `uv run --script` from the user's working directory. uv reads a `uv.toml` (or `pyproject.toml` `[tool.uv]`) found there even with `--script`, so a repository can point uv at another package index. The audit's probe logged an attacker index URL being used.
- Why not fixed now: the fix (`--no-config` on every uv call, or `UV_NO_CONFIG=1`) also ignores legitimate user configuration, such as a corporate mirror set in the user's own `uv.toml`. That trade-off is the owner's call.
- Recommended resolution: pass `--no-config` (or set `UV_NO_CONFIG=1`) for the uv calls, and document how a user who needs a mirror sets it through environment variables (`UV_INDEX_URL`, `UV_DEFAULT_INDEX`), which `--no-config` keeps.
- Risk: medium-low. `--locked` with the hashes in `bin/brain-solve.lock` should refuse substituted artifacts, so a hostile index can mostly cause failures or leak which packages are fetched; artifact substitution under `--locked` was not tested.
- Affected files: `bin/brain-solve-run`.

### `card --heal` wires the merge driver in any repository with a committed brain directory

- Problem: the SessionStart hook runs `brain card --if-present --heal`. In any repository that has a committed brain directory, heal writes `.gitattributes`, `merge.brain-jsonl.*` in `.git/config` and the shim in the user data directory, even if the user never ran `brain init` there.
- Why not fixed now: changing it changes the hook's behavior for existing users (a clone would no longer get a working merge driver on its own). That is the owner's call.
- Recommended resolution: heal only repositories that were initialised once by `brain init` or `brain doctor --fix`, recorded by a marker in the user data directory; otherwise the card nudges the user to run `brain doctor --fix`.
- Risk: low. The shim and target are the plugin's own files, and git runs only the shim the user's own data directory holds; the concern is writing config the user did not ask for.
- Affected files: `src/commands/queries.ts` (`healMergeDriver`), `hooks/hooks.json`.

### Redaction misses some token forms

- Problem: secret redaction in error and log output matches the token forms servers echo. It does not cover misaligned base64, hex, case-changed or partial tokens.
- Why not fixed now: no server is known to echo those forms; widening the patterns risks redacting ordinary data.
- Recommended resolution: none for now; revisit if a server is found to echo a transformed token.
- Risk: informational.
- Affected files: `lib/jira.ts` (redaction).

### `bin/brain` and `bin/brain-merge` are not linted or typechecked

- Problem: the two entry points have no file extension, so Biome and tsc skip them. `bin/brain` now holds the floor check and the private compile-cache setup.
- Why not fixed now: neither tool supports extensionless files, and `bin/brain` must stay plain JavaScript that parses on an old Node (no type annotations), so it cannot become a `.ts` file.
- Recommended resolution: keep both files small; the behavior is covered by tests that run them as processes (`test/floor.test.ts`, `test/compile-cache.test.ts`, `test/install-path.test.ts`, the merge-driver tests).
- Risk: informational.
- Affected files: `bin/brain`, `bin/brain-merge`.

## Pre-existing product bugs

### `forecast` prints `NaN-NaN%` for a downgraded PRIOR-ONLY forecast with 10 or more sprints

- Problem: when a forecast with 10 or more sprints of history is downgraded to PRIOR-ONLY, the range line prints `NaN-NaN%` instead of a range.
- Why not fixed now: it is a product bug, outside the migration and the security fixes; fixing it changes forecast output.
- Recommended resolution: compute the range from the prior in the downgraded branch (or print no range for PRIOR-ONLY), and add a regression test with n >= 10 downgraded records.
- Risk: low (wrong text in an informational output; no data is written).
- Affected files: `lib/forecast.ts`.

### `simulate` yields NaN for a schedule row whose ticket does not exist

- Problem: a schedule row naming a ticket that is not in the ticket table gives an undefined size, and the Monte Carlo totals become NaN.
- Why not fixed now: a product bug outside the migration and the security fixes.
- Recommended resolution: skip such rows with a one-line warning (or refuse with exit 2), with a regression test.
- Risk: low (wrong numbers in an informational output).
- Affected files: `src/commands/analysis.ts`.

### `sp-link` throws a TypeError for a non-array `plans` in refs

- Problem: `refs.jsonl` is read without its validator in `sp-link`; a record whose `plans` is not an array makes `.some` throw a TypeError. `spErrors` reports it as an error line with exit 2, but the message is not a clear data error.
- Why not fixed now: a product bug outside the migration and the security fixes.
- Recommended resolution: validate `plans` (array of objects) when reading refs for `sp-link` and report `refs.jsonl:<line>: "plans" must be a list` as a data error.
- Risk: low.
- Affected files: `src/commands/integrations.ts`.

### open-items `owner` is not validated

- Problem: the `open-items.jsonl` validator makes `key` and `kind` strings; the other fields, `owner` included, are unchecked when read.
- Why not fixed now: a product bug outside the migration and the security fixes.
- Recommended resolution: validate `owner` as a string (or absent) in the open-items reader, with a test for a non-string owner.
- Risk: low.
- Affected files: `src/commands/shared.ts`.

## Pre-existing test and tooling gaps

### Nine mutation equivalents were already stale before the migration

- Problem: entries 30, 44, 45, 46, 157, 158, 164, 185 and 226 of `scripts/mutate/equivalent.json` no longer match the code they describe. A full mutation run prints 9 `STALE EQUIVALENT` lines and exits 1.
- Why not fixed now: each entry needs a fresh review against the current code (re-justify, move or delete), which is separate from the migration.
- Recommended resolution: review the nine entries one by one; delete those whose mutant no longer exists, update the line of those that moved, and re-run the full mutation suite.
- Risk: low (a tooling gate fails loudly; no behavior is affected).
- Affected files: `scripts/mutate/equivalent.json`.

### Equivalent entry 195 covers two occurrences but justifies one

- Problem: entry 195 in `scripts/mutate/equivalent.json` (`lib/store.ts`, `return false;` to `return true;`) matches two occurrences of `return false;`, but its reviewed reason (retrying after a live owner is put back meets the same live lock) justifies only one of them.
- Why not fixed now: needs a mutation review of the second occurrence.
- Recommended resolution: make the entry match only the justified occurrence, and either kill the other mutant with a test or add a separately reviewed entry.
- Risk: low (a mutant may survive unnoticed).
- Affected files: `scripts/mutate/equivalent.json`, `lib/store.ts`.

### The build-extra template scan misses interpolation mutations

- Problem: the source scan in `test/build-extra.test.ts` (INSERT column lists come from constants) checks the shape of the SQL template literals, but a mutation of an interpolation inside an INSERT template still passes.
- Why not fixed now: a test-strength gap found by mutation, separate from the migration.
- Recommended resolution: assert the exact interpolations allowed in each INSERT template (table name, verb, constant column list and placeholders), or check the generated SQL for each table at runtime.
- Risk: low.
- Affected files: `test/build-extra.test.ts`, `src/db.ts` (`insertSql`).
