# Known issues

Open problems that are known and not fixed yet, with the reason and the recommended resolution. Security reports go through the channel in SECURITY.md, not here.

Each entry lists the problem, why it is not fixed now, the recommended resolution, the risk and the affected files. "Deferred" entries came out of the security audit of the TypeScript migration and wait for an owner decision. The pre-existing product bugs and test gaps reported during the migration were fixed in 0.2.1 (see CHANGELOG.md).

## Deferred: owner decision needed

### The `uv run` fallbacks of the solver launcher still read a `uv.toml` from the working directory

- Problem: since 0.2.1 the two uv preparation calls of `bin/brain-solve-run` (`uv sync --locked --script`, `uv python find --script`) run from the plugin's `bin` directory, so a `uv.toml` (or `pyproject.toml` `[tool.uv]`) in the user's repository is not read on the normal path. The fallbacks taken when that preparation fails (an older uv without `sync --script`, or `BRAIN_SOLVE_LAUNCH=uv-run`) `exec uv run` in the user's directory, because the solver must run there (its arguments may be relative paths), and uv then reads the repository's config.
- Why not fixed now (ruling for 0.2.1): `--no-config` (or `UV_NO_CONFIG=1`) also drops the user's own uv config, such as a private index or corporate mirror set in `~/.config/uv/uv.toml`, and `uv run --directory` would change the solver's working directory. Moving the main path out of the repository closes the case without either cost; the fallbacks are left as they are.
- Recommended resolution: drop the `uv run` fallbacks once the minimum supported uv has `sync --script` (then every uv call runs from `bin`), or pass `--no-config` on the fallbacks only, with a note on setting a mirror through `UV_INDEX_URL` or `UV_DEFAULT_INDEX`.
- Risk: low. It needs an older uv (or a failing preparation) and `--locked` with the hashes in `bin/brain-solve.lock` should refuse substituted artifacts.
- Affected files: `bin/brain-solve-run`.

### `card --heal` wires the merge driver in any repository with a committed brain directory

- Problem: the SessionStart hook runs `brain card --if-present --heal`. In any repository that has a committed brain directory, heal writes `.gitattributes`, `merge.brain-jsonl.*` in `.git/config` and the shim in the user data directory, even if the user never ran `brain init` there.
- Why not fixed now: changing it changes the hook's behavior for existing users (a clone would no longer get a working merge driver on its own). That is the owner's call.
- Recommended resolution: heal only repositories that were initialised once by `brain init` or `brain doctor --fix`, recorded by a marker in the user data directory; otherwise the card nudges the user to run `brain doctor --fix`.
- Risk: low. The shim and target are the plugin's own files, and git runs only the shim the user's own data directory holds; the concern is writing config the user did not ask for.
- Affected files: `src/commands/queries.ts` (`healMergeDriver`), `hooks/hooks.json`.

### Redaction misses case-changed and partial tokens

- Problem: secret redaction in error and log output covers each registered secret as is, JSON-escaped, base64 and base64url (whole, and inside a longer blob at any byte offset), hex (both cases) and percent-encoded (as `encodeURIComponent` writes it, lower-case, and every byte escaped). It does not cover a case-changed copy, a partial token or other transforms.
- Why not fixed now (ruling for 0.2.1): no server is known to echo those forms, and matching them (case-folding or partial matches) risks redacting ordinary data.
- Recommended resolution: none for now; revisit if a server is found to echo a transformed token.
- Risk: informational.
- Affected files: `lib/jira.ts` (redaction).

### `bin/brain` and `bin/brain-merge` are not linted or typechecked

- Problem: the two entry points have no file extension, so Biome and tsc skip them. `bin/brain` now holds the floor check and the private compile-cache setup.
- Why not fixed now: neither tool supports extensionless files, and `bin/brain` must stay plain JavaScript that parses on an old Node (no type annotations), so it cannot become a `.ts` file.
- Recommended resolution: keep both files small; the behavior is covered by tests that run them as processes (`test/floor.test.ts`, `test/compile-cache.test.ts`, `test/install-path.test.ts`, the merge-driver tests).
- Risk: informational.
- Affected files: `bin/brain`, `bin/brain-merge`.

### Mutation kills that still depend on a clock or a timeout

- Problem: since 0.2.3 every mutant that `npm run mutate` (the required CI job) pins is killed by a failing assertion. The audit for 0.2.3 recorded, for each pinned mutant, which tests fail and how long the run takes. It also ran `mutate-all` on `lib/store.ts`. Three kinds of clock dependence remain. (1) `scripts/mutate-all.ts` (local, informational in CI) still counts a run past its per-mutant timeout as killed, by design. Only `lib/store.ts` was audited for those: its 4 timeouts were endless lock loops, and `test/lock-bound.test.ts` now kills them on an attempt count. The other files were not audited, because a full run takes hours. (2) The wall-clock checks stay in the suite as tests: the `timing:` and `scaling` tests, and the `budget()` bounds in `test/helpers/perf.ts`. They can still fail on a badly overloaded machine, but no pinned mutant relies on them any more. (3) The deterministic work count (`builtinWork` in `test/helpers/perf.ts`) only sees the listed Array and String built-ins. A quadratic hand-written loop is caught only by the wall-clock `scaling` check.
- Why not fixed now: a hang can only be told apart from slow progress with a bound, and auditing every library file under `mutate-all` takes hours of machine time. The remaining wall-clock tests check real elapsed time, which no work count replaces.
- Recommended resolution: when `mutate-all` reports a `timeout` for a file, add a test that bounds the loop by a count (see `test/lock-bound.test.ts`). When a new size-axis check is added, pair it with a `workScaling` check.
- Risk: informational (test tooling only; no runtime effect).
- Affected files: `scripts/mutate-all.ts`, `test/helpers/perf.ts`, the `timing:` tests in `test/hook.test.ts`, `test/driver-wiring.test.ts` and `test/gitsafe.test.ts`.
