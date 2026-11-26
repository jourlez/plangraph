# Changelog

Entries below `[Unreleased]` are history: they name the tool and its files as they were called at the time (`brain`, `bin/brain`, `.brain/`, `BRAIN_*`) and are kept as written.

## [Unreleased]

## 0.3.0 - 2026-11-25

### Breaking
The whole tool is renamed to plangraph. Every name changes at once and nothing falls back to an old name; `plangraph migrate-names` is the one explicit bridge.
- Command and files: `brain` is `plangraph` (`bin/plangraph`, `bin/plangraph-merge`, `bin/plangraph-solve`, `bin/plangraph-solve-run`, `mcp/plangraph-mcp.ts`); the `package.json` bin keys are `plangraph` and `plangraph-merge`. Every hint, `try:` line, error and usage line says `plangraph`; the error code `NO_BRAIN` is `NO_PLANGRAPH` in the JSON envelope.
- Skills: `plangraph:brain` is `plangraph:plangraph`; `brain-audit`, `brain-autopilot`, `brain-init`, `brain-onboard`, `brain-plan` and `brain-report` are `plangraph:audit`, `:autopilot`, `:init`, `:onboard`, `:plan` and `:report`. `plangraph:whatif` is unchanged. Re-point any CLAUDE.md line or permission rule that names `Bash(brain` to `Bash(plangraph`.
- State: the 30 `BRAIN_*` variables are `PLANGRAPH_*` and the old names are ignored; `~/.config/project-brain` and `~/.cache/project-brain` are `~/.config/plangraph` and `~/.cache/plangraph`; the default plan directory is `.plangraph/`, the repository config is `.plangraphrc`, the index is `plangraph.sqlite`; the merge driver is `plangraph-jsonl`; the eval schema ids are `plangraph-eval-case/2`, `plangraph-eval-p/1` and `plangraph-real-eval/1`. The config key `brain_rules_version` keeps its name until the format-2 migration (an old reader of a renamed key would silently default it).
- New command `plangraph migrate-names`: dry run by default, `--apply` performs the changes, never run by a hook, `card` or any other command. It copies (never moves) `jira-sites.json` and `autopilot.json` to the new config folder with mode 0600, refuses symlinks and never overwrites; renames `.brainrc` and the default `.brain/` (a directory named by the rc file keeps its path); rewrites the `.gitattributes` and `.gitignore` lines; points `merge.plangraph-jsonl.*` at the stable shim and unsets `merge.brain-jsonl.*`. It refuses a repository with uncommitted changes to tracked files, and prints one line when there is nothing left to do.
- Manual step, the keychain: `migrate-names` never reads or writes the credential store (writing the secret would put it on a process argument list). Save the Jira token again under the service `plangraph-jira` (the dry run and `--apply` print the macOS command), then delete the old `project-brain-jira` entry.
- Merge driver: every contributor updates before the repository's `.gitattributes` line changes. An unwired teammate (still on the old name, or without `plangraph-merge` installed) text-merges the JSONL files instead of using the driver.
- Tooling: `scripts/rename-check.ts` holds the command-word rules and proves that the goldens, eval cases and fixtures equal the old ones with the rules applied (the deliberate differences are listed with their reason); `scripts/baseline.ts` maps the old names on the old side of a compare only; `test/no-old-names.test.ts` fails on any old name outside the migration, its tests, the baseline tools and history.

### Security
- The solver launcher never runs a repository-chosen interpreter or reads a repository `uv.toml`: absolute `--python` from `bin/`, `--no-config` with the user's own config passed back, relative `XDG_CONFIG_HOME` and non-absolute `PATH` entries ignored; the venv and its `bin/` must be owned by you and not group or world writable, and are rebuilt under `umask 077` otherwise.
- A group- or world-writable `CLAUDE_PLUGIN_DATA` no longer stops the solver or the merge shim: they print one line and use `~/.cache/plangraph` (created 0700); the other directory is never changed.
- Merge-driver healing needs consent (`plangraph.heal` in the clone's own git config; clones wired before this release are grandfathered); only a version value counts, `never` declines. Without consent the hook writes nothing and prints one line that names the plan directory only if it is a plain short name.
- Credentials: the tracker provider seam (`Ctx.tracker()`) binds every networked call to a minted, frozen `Trust` checked at run time (not only by type); a neutral tenant alias (`"tenant": "work"`) keeps the company host out of the repository and needs your approval in a terminal outside Claude Code (`plangraph doctor --fix --alias`); the user registry `jira-sites.json` must be owned by you and not group or world writable.
- Redaction covers case-changed forms of registered API tokens and any 16-character piece of them (limits are listed in `SECURITY.md`).
- The solver never reports OPTIMAL it has not verified: every hinted OPTIMAL is recomputed, checked against the independent verifier and re-proved without the hint (OR-Tools 9.15.6755 can report a false OPTIMAL under a hint, upstream issue 5582).
- Hook output and `migrate-names` never print repository-controlled text unless it is a plain safe name; the card steer line falls back to `.plangraph`.

### Changed
- Node 24.15 is the floor (was 24.2): Node 24.2 to 24.14 print ExperimentalWarning lines on every command. Below the floor the SessionStart hook exits 0 and prints one line (`plangraph: needs Node >= 24.15, found <v>; install Node 24`); every other command exits 3 with one line. `package.json` engines say `>=24.15`.
- Merge-driver healing needs consent: a SessionStart hook repairs the driver only where `plangraph.heal` in the clone's own git config holds a version (written by `init` and `doctor --fix`; clones wired before this release are grandfathered). Otherwise it writes nothing and prints one line.
- A group- or world-writable `CLAUDE_PLUGIN_DATA` is no longer an error: the solver launcher and the merge shim print one line and use `~/.cache/plangraph` (created 0700); the other directory is never changed.
- The solver fallbacks pass `--no-config` (the user's own `uv.toml` is passed back with `--config-file`); a relative `XDG_CONFIG_HOME` is ignored.
- Redaction also covers case-changed forms of registered API tokens and any 16-character piece of them.
- CI: lean job set (unit, slow, static, macos, compat, floor, mutation, secrets, release-dry-run), shellcheck and actionlint, package contents check, `claude plugin validate --strict`.
- Skills that write to Jira or change state carry `disable-model-invocation: true`: `autopilot`, `onboard` and `plan` (with `audit` and `init`, which already did), because they write Jira, plan data or the schedule; read-only query skills stay invocable by the model.

### Added
- `docs/TEAM.md`: the path for a second teammate (project-scope install, `plangraph doctor --fix` once per clone and why, per-person Jira credentials, what to commit, upgrading together, pinning a release by tag, resolving merge conflicts), checked by `test/team-docs.test.ts`.
- README: a "Which Node, how to get it" box (nvm, fnm, `.node-version`; Node 24.15 or newer) and "Windows is not supported" at the top of Requirements.
- `CONTRIBUTING.md`: how CI works, commit style, identity and secrets, pull request flow. `SECURITY.md`: one line on response (best effort, single maintainer, private reporting).
- `.github/dependabot.yml`: `dependencies` and `ci` labels, and an ignore of `@types/node` major updates.
- Per-file coverage floor (90 percent lines, 85 percent branches) over `lib`, `src` and `mcp`; `lib/jira.ts` is split into ten modules under `lib/jira/` with frozen exports; `scripts/repin.ts` re-pins mutation pins across text edits; `test/known-issues.test.ts` fails a release version that lists a known issue.

### Fixed
- `npm run mutate` prints the failing test's output when its baseline is red; the full mutation generator creates a git repository in each copy, mutates `src/entry.js` and `src/merge-entry.js`, and reports timeouts apart from kills.
- Timing tests run on their own, serially, as size-ratio checks with no wall-clock bounds and no kill timers; the `slow` CI job runs them.
- An eval budget split lost a cent through float rounding (a 3.50 cap became 3.49).

## 0.2.4

Security hotfix.
- Security: the solver's `uv run` fallback no longer executes a `.venv` or `.python-version` interpreter committed in the working directory. The fallback (an older uv without `sync --script`, or `BRAIN_SOLVE_LAUNCH=uv-run`) runs in your directory, where uv picked its interpreter from a committed `.venv` (every uv version, also with `--no-config`) or `.python-version` (uv 0.4.30), so a repository could run its own executable as you. Both `uv run` fallbacks of `bin/brain-solve-run` now pass an absolute `--python` found by `uv python find` run from the plugin's `bin` directory (`UV_PYTHON`, when set, is the request). The normal uv path is unchanged.
- Migration: when uv finds no Python 3.10-3.14, the fallback now exits 3 with the one line `brain-solve: no Python 3.10-3.14 found by uv; run: uv python install 3.14`. Before 0.2.4, `uv run` could download a Python on its own in that case; run that command once. The launcher never installs a Python itself.
- Tests: `test/solver.test.ts` runs the fallback with the real uv in a working directory holding a hostile `.venv/bin/python` and a `.python-version` naming `./evil/python3` and asserts neither runs (a uv 0.4.30 leg runs when `BRAIN_TEST_UV_0430` names that binary); `test/solver-launcher.test.ts` pins the `--python` argument and the exit 3 with a fake uv.
- `KNOWN_ISSUES.md`: the interpreter case is closed; the `uv.toml` residue of the fallback stays open for 0.3.0.

## 0.2.3

Test fixes only; no behavior change of the plugin.
- Mutation: the CI `mutation` job failed on Linux. It reported a survivor in `lib/store.ts`: the deliberately quadratic, output-identical line scan of `doctorMergeDriver`, which `scripts/mutate.ts` pins. Only a wall-clock n-vs-4n ratio killed it, and on a fast runner the ratio stayed under the limit. The same held for the other two pinned quadratic mutants (`lib/gitsafe.ts` `nextIndex`, `lib/render.ts` verdict count).
- Tests: new `workScaling` and `builtinWork` in `test/helpers/perf.ts` count the elements that common Array and String built-ins touch, n vs 4n, with no clock. The real code stays near 4x and each quadratic mutant gives about 16x, the same on every machine. Each of the three mutants now fails a `work:` test in `test/driver-wiring.test.ts`, `test/hook.test.ts` and `test/gitsafe.test.ts`. The wall-clock timing tests stay.
- Tests: `test/lock-bound.test.ts` counts lock attempts through a spy on `fs.openSync`, so an endless `acquireLock` retry loop fails at once instead of waiting for the mutation runner's timeout. The four such mutants in `lib/store.ts` are now pinned in `scripts/mutate.ts`.
- `KNOWN_ISSUES.md` lists the clock dependence that remains (`mutate-all` timeouts in files not yet audited, the wall-clock tests themselves).

## 0.2.2

CI fixes only; no behavior change of the plugin.
- CI: the `unit` and `macos` jobs now install the locked dev tools (`npm ci --ignore-scripts --no-fund`), because `test/types.test.ts` runs `tsc` from `node_modules`.
- Tests: the baseline normalizer (`scripts/baseline.ts`, a development harness) now also drops the per-run directory under the host temp directory. On Linux that directory is `/tmp`, which left `<ROOT>/<run-dir>/...` behind. `test/baseline.test.ts` runs its assertions under the host temp directory and a mocked `/tmp`.
- Tests: the solver-launcher probes run with a PATH that is one directory of symlinks to the tools the fallback needs, so uv stays hidden even when it shares a directory with them. Their uv check takes any non-zero `command -v` status with no output as hidden. On Ubuntu, `sh` is dash, which exits 127 rather than 1 for a missing command.

## 0.2.1

Fixed (the open items parked by the 0.2.0 migration; these are intended behavior changes):
- `brain forecast`: a PRIOR-ONLY forecast downgraded from 10 to 19 sprints (a mean shift or missing actuals) printed `NaN-NaN%`. It now prints the leave-one-sprint-out range like every PRIOR-ONLY result (`docs/FORECAST.md`), and a view without a range prints the point probability.
- `brain simulate`: a schedule row whose ticket does not exist had no size; it still counted for the planned and simulated end sprint. Such rows are now left out, with one `warning: simulate skips N schedule row(s) with no ticket: ...` line on stderr (exit 0).
- `brain sp-link`: a `refs.jsonl` record whose `plans` holds a non-object entry was accepted and written back. It is now a data error naming the line (exit 2, nothing written). A non-array `plans` was already refused by the reader.
- `open-items.jsonl`: a non-string `owner` printed as `owner [object Object]` in `brain ready`. Reading the file now refuses it as a data error naming the line (exit 2).
- Jira: an empty tenant (no `cloud_id` in scoped mode, no usable `base_url` otherwise) is refused before any credential helper (`op`, `security`, `secret-tool`) runs, with a message that names the missing field and points to `docs/JIRA.md`. A user `projects` entry with only `base_url` (scoped by default) now says to add `"auth": {"mode": "site-token"}` instead of a bad-host error. An empty committed `base_url` (as `brain init` writes it) counts as unset, so scoped mode reaches the gateway instead of failing with `base URL rejected: empty`.
- Solver launcher: the uv preparation calls run from the plugin's `bin` directory, so a `uv.toml` in the repository you run from is not read; user-level uv config and `UV_*` variables still apply. The `uv run` fallbacks for an older uv are unchanged (`KNOWN_ISSUES.md`).
- Redaction: a registered secret is also redacted inside a longer base64 or base64url blob at any byte offset, in hex, and lower-case or fully percent-encoded.
- Tooling: the nine stale mutation equivalents are re-pinned or deleted (their mutant is gone or now killed), entry 195 covers only its reviewed line, `test/equivalents.test.ts` allows no stale, duplicate-line or repeated entry, and `test/build-extra.test.ts` pins the INSERT template and checks every table spec at runtime.

## 0.2.0

Changed: the plugin is now native-ESM TypeScript (Node 24 runs the `.ts` files directly, no build step). Behavior is unchanged: a differential baseline of 373 command, hook, merge-driver, MCP and library probes is identical before and after, on synthetic and on a real brain directory. Startup time is the same (about 133 ms either way). Strictness flags: `strict`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, and `noUncheckedIndexedAccess` for `lib`, `src` and `mcp`. Tooling: TypeScript 7.0.2 (`tsc --noEmit`), Biome 2.6.8 (lint), knip 6.48.0, lefthook 2.2.2, `node:test`. Still zero runtime dependencies. The mutation-equivalents list was rebuilt (97 entries re-pinned; a recorded line may now differ only by a type annotation). Known open items are in `KNOWN_ISSUES.md`.

Renamed: the plugin, the marketplace and the repository are now `plangraph` (`/plugin install plangraph@plangraph-marketplace`; skills are `plangraph:brain`, `plangraph:brain-onboard` and so on). The command stays `brain`. The per-user state keeps its names (`~/.config/project-brain/`, `~/.cache/project-brain`, the keychain service `project-brain-jira`, the merge driver `brain-jsonl`, every environment variable), so nothing needs to be moved.

Security (from an adversarial audit; see `SECURITY.md` trust boundaries):
- A committed config can no longer redirect the generic Jira credentials. A user `projects` entry that names `base_url`, `cloud_id` or `auth` now decides the whole tenant; committed tenant fields are dropped. An unknown or malformed `auth.mode` fails with `bad_config` before any credential helper runs.
- Data Center: generic credentials are used only when `BRAIN_JIRA_DC_HOSTS` lists exactly one host and it is the tenant. With several hosts each needs a per-host binding.
- Files written by `jira-pull`, `jira-import`, `jira-text` and `units --out` are mode 0600.
- The Node compile cache lives in a private per-user directory (`<data>/compile-cache`, mode 0700, refused when not owned by the user or writable by others). It no longer uses the shared temp directory.
- The solver launcher runs Python in isolated mode (`-I`), so files in the current directory cannot shadow `ortools`, `venv` or `pip`.
- `release.yml` grants the permissions that `ci.yml` asks for. Tests no longer write into the real home directory.

## 0.1.4

Fixed: 0.1.3 changed two per-user state locations during the rename, which hid existing Jira bindings (`~/.config/project-brain/jira-sites.json`)
and moved the data and cache directory. Both are back to `project-brain` (`~/.config/project-brain/`, `~/.cache/project-brain`), and
`test/state-paths.test.ts` pins the names so a rename cannot change them silently. Anyone on 0.1.3 should update.

## 0.1.3

Renamed: the plugin, the marketplace and the repository are now `open-brain` (`/plugin install open-brain@open-brain-marketplace`; skills are
`open-brain:brain`, `open-brain:brain-onboard` and so on). The Jira credential and cache locations keep their names
(`~/.config/project-brain/`, the keychain service `project-brain-jira`, `~/.cache/project-brain`), so existing bindings and the solver
environment keep working. Added: the `brain-autopilot` skill (`docs/AUTOPILOT.md`). Changed: one function, `resolveTenant`, now decides
whether the generic Jira credentials may be used, for both `brain jira-pull` and `brain doctor`. No change to any command output.

## 0.1.2

Added: the Jira tenant (site, cloud id, JQL) can live in the user-level `jira-sites.json` under `projects`, keyed by repository path, so
nothing about a company has to be committed. A site chosen there is trusted and may use the generic `JIRA_*` credentials; this restores
the pre-0.1.1 behaviour for users who keep the tenant at user level. Credentials for a site that only a committed config names stay bound.

## 0.1.1

Added: Jira credentials are bound per tenant (cloud id, site or Data Center host) through a user-level registry
`~/.config/project-brain/jira-sites.json` that holds names and references only, with per-site env and keychain conventions. Generic
`JIRA_*` credentials are no longer sent to an unpinned site-token host. `brain doctor` prints a `jira:` line (tenant, credential binding,
no secret) and the one connector check to make before any connector call. The `brain` skill follows those lines.

## Unreleased

The commands moved from one 835-line `bin/brain` into `src/commands/` behind a registry; `bin/brain` is now a thin entry point. The
successful output of the commands is unchanged (frozen by the golden tests), with these exceptions: the error paths below (messages,
`error:`/`hint:` lines and exit codes), `findings --json` and `rules --json` now print the JSON envelope (they printed nothing before),
and the new limits and refusals listed under Changed.

Added:

- Relieve: `brain whatif --relieve NAME --sprint N [--earlier] [--owner-change]` (read-only, `--json` too) lists the smallest valid set of
  single-ticket moves of that cell's tickets that brings the person's load to cap or under without any new violation (each set checked
  with verifyPlan), with the exact `brain whatif` dry-run command of each move in an order where each passes alone, or `NO RELIEF` with
  the reasons; a documented search budget is reported when hit. Changed: `brain whatif` with no argument now says `whatif needs a KEY, or
  --relieve NAME --sprint N` (it said `expected 1 argument, got 0`).
- Bulk ready: `brain ready --person NAME --sprint N` (either filter alone or both, no KEY) answers which of those tickets may start now in
  one call: counts first, the ready keys (capped, `-v` more), each not-ready reason with example keys, `--json` with every list. Same rules
  as `brain ready KEY` (lib/ready.ts readyScope over readySet). Changed: `brain ready` with no argument now says `ready needs a KEY, or
  --person NAME and/or --sprint N` (it said `expected 1 argument, got 0`), and readySet also returns `verdict` (the tickets whose verdict is
  not READY) and takes an optional `{ keys }`.
- Optional read-only MCP adapter, off by default: `mcp/brain-mcp.ts` (stdio, hand-written JSON-RPC, no dependencies) with three tools,
  `ready`, `whatif` (dry run only) and `ticket`, whose text is byte for byte the CLI's. The plugin does not start it (no `mcpServers`,
  no `.mcp.json`; the default install still shows `MCP servers (0)`); docs/MCP.md shows how to opt in and when it is worth it (only if
  your evals show it is no worse than the CLI). `node test/bench-mcp.ts` measures its token cost. Connecting and listing tools was
  verified with Claude Code 2.1.329. Later, in a live 2.1.329 session: Claude Code deferred the tool definitions and loaded them through
  `ToolSearch` (the model's first step selected the three tools), then made 3 correct calls in 5 turns for $0.046 (reported); the size of
  the deferred entry and other clients are not verified (docs/MCP.md).

Packaging:

- Plugin icon `.claude-plugin/icon.png` (1024x1024 PNG), generated deterministically by `scripts/make-icon.ts` (no dependencies; its
  self-check measures that the highlighted path stays visible at 32 and 64 px); `plugin.json` sets `icon`. The validator's `ICON_MISSING`
  warning is gone.
- `engines.claude-code` is `>=2.1.329` in `plugin.json`: the plugin was installed and run on 2.1.329; the newest published, 2.1.330, was not tested.
- `repository` and `homepage` in `plugin.json`, and `repository`, `homepage` and `bugs` in `package.json` (still `private`), all pointing at
  the one GitHub repository. README installs with `/plugin marketplace add jourlez/open-brain`; `.github/CODEOWNERS` names the owner;
  SECURITY.md uses GitHub private vulnerability reporting (it must be enabled in the repository settings); CONTRIBUTING.md uses issues and pull requests.

Changed:

- `brain jira-import` accepts a slimmed connector response: a field the response leaves out keeps the snapshot value (it was blanked),
  a present field replaces it. docs/JIRA.md documents the recommended `responseFields` call (UNVERIFIED) against the measured
  baseline of about 15,000 characters for one ticket with 22 links.
- `brain rules --repo` takes `--topic WORD` (case-insensitive substring filter, bounded) and `--all` (adds dated cerebrum sections, counts
  line first, still capped and fenced); `brain doctor` adds `info: OpenWolf STATUS.md mentions an older brain line: run /handoff` when
  OpenWolf is active or rules-only and the STATUS brain line differs from `brain card --line` (never a failure, never a write).
- `brain integrations` and `brain doctor` decide a plugin's enabled-ness per exact `name@marketplace` key: a key enabled in settings that
  is not the installed key is reported as `enabled but not installed` instead of making the installed one `enabled` (the installed key
  then stays `installed` unless a layer enables that exact key). Per key, the most specific settings layer decides.
- superpowers ledger layouts, verified against the release sources: 6.2.0/6.3.0 marker-less per-plan workspaces are found (when their
  identity line names the plan), `Final: Ruling:` lines become rulings, `brain integrations` prints the layout of the installed version
  (`not verified` outside 6.1.1 to 7.0.2), and `sp-ingest` without a ledger says whether previous `impl_status` values were kept.
- The session card's last line is a steer instead of a pointer: `plan questions: use brain (ticket, ready, whatif, blockers, sprint,
  person); do not read .brain/*.jsonl` (the brain directory as configured). Card on the benchmark plan: 449 -> 533 bytes, 113 -> 134 est
  tok. `brain init` now also PRINTS a 3-line snippet with the same steer for the repo's own CLAUDE.md (until a CLAUDE.md carries it;
  brain never writes CLAUDE.md), and `brain doctor` adds one `info:` line when a CLAUDE.md exists without it (never a failure).
- `SOURCE_DATE_EPOCH` is honored as the clock for every printed or stored date (`closed_at`, `imported_at`, `fetched_at`); unset or
  invalid values fall back to the wall clock. The golden tests pin it, so they no longer fail after 00:00 UTC.

- Node 24.2 is the floor (`import.meta.main`); `package.json` engines say `>=24.2`. An older Node exits 3 with one line (was 2), or
  stays silent with exit 0 under `--if-present` as before.
- A brain directory that is absolute or escapes the repository (`--dir`, `BRAIN_DIR` or `.brainrc`) is refused with exit 4. Use a
  relative directory inside the repository.
- Exit codes follow docs/CONTRACT.md: an unknown command exits 2 (was 1); usage and data errors exit 2 (were often 1, or a raw error
  such as `Provided value cannot be bound to SQLite parameter 1.` or `ENOENT`); missing Jira credentials exit 3 (was 1); a refused write
  exits 4; an unexpected crash exits 5 (was 1).
- Error lines start with `error:` and may carry a `hint:` line.
- Agent-facing contract (breaking for scripts that parse output): every error ends with `try: <exact command>`; a hint that was a
  command became that line; an internal error prints `error: internal error: ...` (was `brain: internal error: ...`); an unknown
  command no longer lists every command, it suggests the nearest one (`did you mean ticket?`) and points at the new `brain explain`.
  `--json` is envelope v2 (`ok`, `exit`, `fresh {fp, built}`, `next` at the top level; structured `data` for sprint, ready, whatif,
  verify and explain; `{lines}` elsewhere). `ticket KEY` is one line by default (`-v` shows needs, findings and evidence). The card is
  cache-stable: `brain <fp> | ...` identity instead of `built Xh ago`, no `stale ?` line, no command menu (`ask: brain explain`),
  STALE only from the fingerprint check and printed last.
- Options are parsed strictly: an unknown option, a value on a flag or a bad number is a usage error (exit 2) instead of being ignored;
  `findings --json` and `rules --json` no longer take `--json` as the kind or topic.
- STALE now means the text files changed since the last build (a content fingerprint), not that a file is newer; `brain export` leaves
  the index current.
- `brain build` keeps the temporary file of another build that is still running; only leftovers (older than 10 minutes or of a dead
  process) are removed.
- A corrupt or non-SQLite index is a data error with the `brain build` hint.
- `brain card --if-present` (the session hook, with or without `--heal`) prints nothing and exits 0 on any failure: a bad `.brainrc`, a
  refused brain directory (so a global `BRAIN_DIR` that is absolute does not make the hook noisy), a corrupt index, a bad option, or any
  thrown error.
- A refused write target (a symlink, not a regular file, or outside the repository) exits 4 for every writing command, nothing written:
  `card --write` (was 5), `sp-ingest`, `sp-link`, `learn --from-wolf` (were 2) and `init` with a symlinked `format.json` (was 5 when
  dangling, silently skipped otherwise).
- `brain export` refuses a stale index (the text was edited after the last build) with exit 2 and the `brain build` hint, instead of
  overwriting those edits. An index built by the old `bin/brain` has no fingerprint and counts as stale: run `brain build` once.
  `schedule-load` or `whatif --write` followed by `export` still works.
- `open-items` checks the data format strictly (a directory needing migration is an error, not a note) whenever it writes:
  `--write`, `--close`, `--reopen` or `--register`.
- Jira 400 error details (`errorMessages`) are reduced to one sanitized line (no newline, no angle brackets, at most 200 characters).
- New limits, each a usage or data error (exit 2) when exceeded:
  - `neighbors` depth: a whole number from 0 to 50;
  - `simulate`: `--runs` 1 to 100000, `--sigma` 0 to 5 (a leading digit is required: `0.5`, not `.5`), `--limit` 0 to 100000,
    `--seed` an integer;
  - `units`: `--size` 1 to 1000, `--tokens-per-unit` 0 to 100000000 (plain digits: no exponent);
  - `schedule-load`: the archive name is 1 to 200 characters and not `current`; every row must be `{item, owner, sprint}` with string
    item and owner and a whole sprint number;
  - `open-items`: one action per run (only one of `--close`, `--reopen`, `--register`);
  - Node 24.2 or newer (see above).
- Untrusted text is fenced in every output that shows it (Task 12). `ticket`, `findings KIND`, `ready`, `open-items`, `bundle`, the
  `units` files and `jira-text` files print summaries, finding and open-item texts, evidence, plan sections and Jira text only inside
  `<untrusted>` fences, one record per line; the ticket summary moved from the first line of `ticket` and `bundle` into the fence, and
  `ready` names an open item by its kind with the texts in the fence. Short fields (status, verdict, owner, kind) are one sanitized
  line each, also in `card`, which carries no free text. Outputs are bounded so the 40-line limit never cuts a fence: `ticket` shows 12
  findings and 12 evidence rows (100 with `-v`), `findings KIND` 30 (2000), `ready` 20 reasons and 10 texts (200 and 100); `bundle`
  takes at most 100 keys (exit 2 beyond; use `units`), and per ticket caps the summary (300 chars), findings (50 of 500 chars), plan
  sections (20000 chars), file names (50) and Jira text (32000 chars, read capped at 1 MiB).
- `brain doctor` exits 1 with `tracked index: ...` when git tracks the brain index (`brain.sqlite`).
- `brain card` says `STALE:` in its own first line when the content fingerprint no longer matches (also in hook mode, where the stderr
  warning stays silent), not only when a source file is newer.
- `format.json` is read capped (64 KiB), regular files only; a symlinked (even dangling), non-regular, too large or invalid one is a
  data error (exit 2) whose message names only `format.json`, never its path or content.
- Format notes and errors name the brain directory relative to the repository (`note: .brain: data format 0 ...`), not by absolute path.
- `brain verify` (and the violation count of `card --line`) reports `BEFORE_FIRST <key> sprint N before the first sprint M` for a free
  ticket placed before `config.first_sprint` (the solver's rule; frozen tickets by `frozen_statuses`, `frozen_before_sprint` or a freeze
  list keep their slot), and a `first_sprint` that is not a whole number within +-1000000 is one `CONFIG first_sprint` violation.

## 0.1.0

Status, stated plainly: it works locally. The test suite runs with `node --test $(ls test/*.test.mjs | grep -v solver)` (the solver suite, which needs Python and downloads packages, is run separately), plus `test/smoke.sh` and `test/validate-plugin.ts`. It has not been installed in a live Claude Code session by its author, and it has no remote repository yet.

What exists:

- The `brain` command (tickets, links, sprints, readiness, stale detection, what-if moves, schedule check, open items, forecast, Jira snapshot, audit preparation, superpowers plan ingest, companion-tool detection), the `brain-merge` git merge driver, and `brain-solve-run` (OR-Tools solver run through `uv` or a pip virtual environment).
- A session-start hook that prints a short card when the project has a brain, and seven skills: `brain`, `brain-init`, `brain-audit`, `brain-onboard`, `brain-plan`, `brain-report`, `whatif`.
- Data is plain text (JSONL) in git; the SQLite index is a rebuilt cache.

Changed since the first build:

- Node 24 is the floor (the first build said 22.13; raised to 24.2 since, see Unreleased).
- Records keep fields the tool does not know: `brain build` stores them in an `extra` column and `brain export` writes them back.
- Tickets may carry an optional `impl_status` (`todo`, `in_progress`, `done`, `blocked`), taken only from a superpowers ledger.
- Untrusted text is sanitized and fenced; state writes are atomic and refuse symlinks; git runs without a shell.
- The solver dependencies are pinned and locked, and docs/SOLVER.md says what the first run downloads.
- Jira: a read-only bulk client plus `brain jira-import` for results the Atlassian connector saved to disk.

Removed, and why (see the module audit in docs/REUSE.md):

- Claims (`brain claim`, git-based ticket claiming): no use in the real plan graph, two real bugs found in it, and Jira assignee is the system of record.
- Hash ids (`newId`): only claims used them.
- Compaction (`brain compact`, `restore`): git history already keeps old versions, and the measured saving was small.
- Command execution from config (`config.checks`): a project config could make the tool run commands. A check can run anywhere and its findings can be loaded with `brain open-items --findings FILE`.

Data format:

- `format_version` is 1 (`min_reader` 1). Older files without `format.json` load as version 0 and `brain migrate` upgrades them.
- The `extra` handling and `impl_status` are additive: `format_version` was not bumped, and files that never had these fields export byte for byte as before.

Unverified:

- Install and hook behavior inside a live Claude Code session.
- Claude Code releases newer than 2.1.329 (the declared minimum): the newest published when the minimum was set, 2.1.330, was not tested.
- (Resolved) the manifests are now also checked by `claude plugin validate .` on Claude Code 2.1.329, via `test/claude-validate.test.ts`.
