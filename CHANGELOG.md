# Changelog

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
  as `brain ready KEY` (lib/ready.mjs readyScope over readySet). Changed: `brain ready` with no argument now says `ready needs a KEY, or
  --person NAME and/or --sprint N` (it said `expected 1 argument, got 0`), and readySet also returns `verdict` (the tickets whose verdict is
  not READY) and takes an optional `{ keys }`.
- Optional read-only MCP adapter, off by default: `mcp/brain-mcp.mjs` (stdio, hand-written JSON-RPC, no dependencies) with three tools,
  `ready`, `whatif` (dry run only) and `ticket`, whose text is byte for byte the CLI's. The plugin does not start it (no `mcpServers`,
  no `.mcp.json`; the default install still shows `MCP servers (0)`); docs/MCP.md shows how to opt in and when it is worth it (only if
  your evals show it is no worse than the CLI). `node test/bench-mcp.mjs` measures its token cost. Connecting and listing tools was
  verified with Claude Code 2.1.329. Later, in a live 2.1.329 session: Claude Code deferred the tool definitions and loaded them through
  `ToolSearch` (the model's first step selected the three tools), then made 3 correct calls in 5 turns for $0.046 (reported); the size of
  the deferred entry and other clients are not verified (docs/MCP.md).

Packaging:

- Plugin icon `.claude-plugin/icon.png` (1024x1024 PNG), generated deterministically by `scripts/make-icon.mjs` (no dependencies; its
  self-check measures that the highlighted path stays visible at 32 and 64 px); `plugin.json` sets `icon`. The validator's `ICON_MISSING`
  warning is gone.
- `engines.claude-code` is `>=2.1.329` in `plugin.json`: the plugin was installed and run on 2.1.329; the newest published, 2.1.330, was not tested.
- `repository` and `homepage` in `plugin.json`, and `repository`, `homepage` and `bugs` in `package.json` (still `private`), all pointing at
  the one GitHub repository. README installs with `/plugin marketplace add jourlez/OpenBrain`; `.github/CODEOWNERS` names the owner;
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

Status, stated plainly: it works locally. The test suite runs with `node --test $(ls test/*.test.mjs | grep -v solver)` (the solver suite, which needs Python and downloads packages, is run separately), plus `test/smoke.sh` and `test/validate-plugin.mjs`. It has not been installed in a live Claude Code session by its author, and it has no remote repository yet.

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
- (Resolved) the manifests are now also checked by `claude plugin validate .` on Claude Code 2.1.329, via `test/claude-validate.test.mjs`.
