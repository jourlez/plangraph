# Engineering contract for project-brain modules

Goal: the best planning memory for AI coding agents. Hard rules, in priority order:

1. **Correctness is provable.** Every feature ships with tests that could fail: property tests against an independent oracle, golden outputs, mutation-sensitive assertions. Say what a test does NOT cover in a comment at the top of the test file.
2. **Tokens are a budget.** Every answer a command prints is read by a model. Default output is the smallest useful answer (target: one line for a yes/no, under 250 tokens for anything, under 60 for the common case). No prose, no decoration, stable ordering, stable field names. Bounded output: an explicit limit plus a `... N more` marker. Every answer that depends on data states its freshness when it could be stale. Estimate tokens as `ceil(chars / 4)`.
3. **No network or model calls** anywhere except `lib/jira.mjs`. Never write, log or echo secrets (Jira token). Tokens only from the process environment or an OS keychain helper.
4. **Pure core.** Library modules are ES modules in `lib/*.mjs` that take plain data (the model from `lib/model.mjs`, see `buildModel`) and return plain data or strings. No SQLite, no `process.exit`, no `console.log` inside library functions (return strings or objects; the CLI prints). This keeps them testable and lets the CLI drop SQLite later.
5. **No runtime dependencies** (Node built-ins only; Python solver only uses OR-Tools). Dev-only, exact-pinned, never shipped: `typescript`, `@types/node`, `@biomejs/biome` (`npm run typecheck`, `npm run lint`). Node >= 24.2. Tests use `node:test` + `node:assert/strict`, files named `test/<module>.test.mjs`, runnable with `node --test test/*.test.mjs`. Fixtures come from `test/fixtures/gen.mjs` (`genPlan`, `rng`). Never use real people, tickets or company data; names are invented.
6. **Determinism.** Same input gives byte-identical output. Sort with plain `<` comparison (not localeCompare). Seeded RNG only (`rng` from the fixtures file; copy the tiny function into lib if the module needs randomness).
7. **Merge-friendly data.** Text files are JSONL, one record per line, sorted by primary key, canonical key order, `\n` endings, trailing newline.

Exhaustive small-scope suite: `npm run assure` (minutes; `test/assure/`) checks verify, check/verify CLI agreement, whatif/proposeMove, merge, stale, ready, forecast gates and the canonical round trip against clean-room oracles on EVERY instance up to small bounds (each file's header states them; a reduced variant runs in every `node --test test/*.test.mjs` run as `test/assure.test.mjs`). It is exhaustive within those bounds, not a proof beyond them.

Ownership: each worker edits ONLY the files assigned to it (new files under `lib/`, `test/`, and where stated `bin/brain-solve`, docs). Do NOT edit `bin/brain`, `hooks/`, `skills/`, `README.md`, `lib/model.mjs`, `lib/jsonl.mjs`, `test/smoke.sh`, `test/fixtures/gen.mjs`; the integrator wires modules into the CLI. If you need a change in one of those, describe it in your final report.

Model shape (`lib/model.mjs`): `{ tickets: Map<key,row>, edges: [{consumer,producer,kind,note}], prods: Map<consumer,[producer]>, cons: Map<producer,[consumer]>, sched: Map<key,{owner,sprint}> (current schedule), config, findings, evidence, learnings, refs }`. `config.caps[person] ?? config.caps.default` is capacity in story points per person per sprint (`capOf`). `ticket.sp` is story points. A link "consumer needs producer". **Strict handoff rule:** `sprint[consumer] >= sprint[producer] + (owner[consumer] !== owner[producer] ? 1 : 0)`: another person's output must land in an earlier sprint; the same person may share the sprint.

Final report format from each worker: what you built (files), exact test command and its result, what the tests do not cover, public API (function signatures), and CLI wiring the integrator must add (command name, flags, one example output with its estimated token count).

## CLI contract (bin/brain)

`bin/brain` is a thin entry point: it checks the Node floor, then hands the arguments to `src/cli.mjs`, which looks the command up in the
registry (`src/registry.mjs`, a `Map` of frozen specs from `src/commands/*.mjs`), parses the options strictly (`src/args.mjs`), runs the
command with a context (`src/context.mjs`) and prints the bounded output. Commands take `(ctx, args)`, write through `ctx.io`, and return
an exit code; nothing under `src/` calls `process.exit` or `console.log`.

Exit codes:

| code | meaning |
|---|---|
| 0 | ok |
| 1 | a negative verdict: `check`, `verify`, `ready`, `whatif`, `doctor` found a problem |
| 2 | usage or data error: unknown command or option, missing or bad argument, unreadable or invalid input file, no index, corrupt index, `export` over a stale index, data format too new or needing migration for a writing command |
| 3 | environment missing: Node older than 24.2 (with `--if-present`, any command: silent exit 0 instead), Jira credentials or configuration missing or rejected |
| 4 | refused: a brain directory outside the repository (absolute, or escaping it through `..` or a symlink), a write target that is a symlink, not a regular file or outside the repository (nothing is written), a whatif write that would add violations |
| 5 | unexpected internal error (`error: internal error: ...`) |

Clock: every date the commands print or store (`closed_at` of `open-items --close`, `imported_at` of `jira-import`, `fetched_at` of
`jira-pull`) comes from `ctx.now()`. `SOURCE_DATE_EPOCH` (whole seconds since the epoch, digits only; anything else is ignored) makes
that clock fixed, so a run is reproducible: the same value gives the same bytes and card fingerprint. Lock, temp-file and timeout code
keeps the real clock. The golden tests force their own value whatever the parent environment says.

Session hook: `brain card --if-present` (with or without `--heal`) prints nothing and exits 0 whenever anything fails: a too-old Node, a bad
`.brainrc`, a refused brain directory (`BRAIN_DIR` or `--dir` absolute or escaping), a missing or corrupt index, a bad option, or any
thrown error. On success it prints the card (nothing when there is no index; a last `STALE:` line when the index is stale). Only `card` has
this guarantee: other commands given `--if-present` still report errors (it only suppresses their STALE warning).

Errors print `error: <what>` on stderr, optionally `hint: <what to do>` (prose), and always a last line `try: <exact command>`
(the error table in `src/errors.mjs`: a hint that names a `brain ...` command becomes the try line; otherwise `brain init` when there is no
brain directory, `brain build` for a missing index, `brain doctor` for environment and internal errors, else `brain explain <the command that failed>`). A mistyped command gets
`did you mean <name>?` (edit distance at most 2); the command list itself is `brain explain`. A line never carries a newline or a forged
`<untrusted>` tag from the data, and untrusted text never reaches the try line. Commands print through `ctx.io.out(line)`, which takes
exactly one line: a line break of any kind (LF, CR, VT, FF, NEL, U+2028, U+2029) is a programmer error that fails the tests
(`BRAIN_STRICT_OUT=1`, set under `node --test`) and becomes a space in production; intended multi-line output (a fence block) goes
through `ctx.io.outBlock(lines)`. `test/hostile-fuzz.test.mjs` runs every registered command over a plan whose every free-text field
carries a line injection.

`brain explain [COMMAND] [--json]` describes the CLI from the registry (summary, options, argument count, `writes` class plus the merge-driver wiring a command always does (`init`) or a flag adds (`doctor --fix`, `card --heal`: git config, `.gitattributes`, the merge shim), exit codes),
bounded (the full list under 400 estimated tokens). `--json` on any command prints exactly one v2 envelope on stdout
`{"v":2,"cmd","ok","exit","data","fresh","next"}`, also when the command printed nothing (`data` is `{ "lines": [] }`) and when it failed
(the error lines stay on stderr; `cmd` is null for an unknown command; `test/json-envelope.test.mjs` runs every registered command): `data` is structured for `sprint`, `ready`, `whatif` (dry run), `verify` and
`explain`, and `{ "lines": [...] }` for the others (card and bundle included: their prepared text, line by line); `fresh` is `{ "fp", "built" }` (first 8 hex of the source fingerprint of the text
now and of the text the index was built from; they differ when the index is stale) or null when the command read no index; `next` holds
0 to 3 exact follow-up commands, built only from shell-safe values.

Session card (`brain card`, the SessionStart hook): a pure function of the data, byte-identical across runs (no clock, no age, no
modification time): `brain <fp> | N tickets, M links, S<first>-S<last>, P people`, verdicts, over-cap, findings, the steer
line `plan questions: use brain (ticket, ready, whatif, blockers, sprint, person); do not read <brain dir>/*.jsonl` (lib/steer.mjs; the
directory as the repo configures it, default `.brain`), and a last `STALE: index older than text, run \`brain build\`` line only when the fingerprint check fails.

Brain directory: `--dir`, else a non-empty `BRAIN_DIR`, else `{"dir": "..."}` in `.brainrc` at the repository root, else `.brain`. It must be
a relative path inside the repository: an absolute or escaping directory is refused with exit 4 (`brain directory is outside the repository`), and so is a name with whitespace, a control character or any of `* ? [ ] \ ! # "` (`brain directory name has a character that is not allowed`; the merge driver is only wired for names made of `A-Z a-z 0-9 . _ / -`), except under
`brain card --if-present`, which stays silent with exit 0.

Staleness: the index stores a source fingerprint (sha256 of the eight text files it is built from). When the text no longer matches,
index-reading commands still answer, and print `STALE: the text files changed since the index was built; run \`brain build\`` on stderr
(once), unless `--if-present` is given. `brain export` rewrites the text from the index and records the new fingerprint, so the next query
is not stale; it refuses a stale index (exit 2, hint `brain build`), because writing it would overwrite the edited text. `schedule-load`
and `whatif --write` change only the index, so export after them goes ahead. `brain forecast` also warns when `open-items.jsonl` is newer than the index; the card uses the fingerprint only (no modification times).

Index integrity: the fingerprint covers the text only, so `brain build` also stores a content digest (sha256 over every row of every
table of `brain.sqlite`, `index_meta` included except the digest row, in a canonical order: primary key, then every column) in `index_meta`
under `content_digest`. Every index open (every index-reading command, `whatif --write`, `schedule-load`, `export`, and the session hook's
card) recomputes it. A mismatch, meaning a row was inserted, deleted or changed inside the sqlite file outside brain, is refused: exit 2,
`error: the index content does not match its integrity digest (it was edited outside brain)`, `try: brain build`; the hook prints nothing
(exit 0), so a tampered index is never served. An index without a digest (built by an older version) is treated as stale (the STALE line,
query-only, `export` refused), and `whatif --write` / `schedule-load` refuse it (exit 2, `brain build`). Those two commands and export's
fingerprint stamp re-stamp the digest inside their transaction. Cost: a full digest on every open, never sampled, streamed in 64 KiB batches;
measured on the dev machine (Apple silicon, other load present) at 1,400 tickets (7.5k rows) open 6 ms, digest 5 ms; at 100,000 tickets
(533k rows, 39 MB index) open 0.43 to 0.50 s, digest 0.40 to 0.50 s (build 1.8 to 3.3 s). Stated budget: under 1 s at 100,000 tickets; a
test bounds the 1,400-ticket digest. Limit: the digest is unkeyed, so it detects direct edits and accidental tools, not a forger who edits
rows and then recomputes the digest the same way; the text files in git remain the source of truth, and `brain build` rebuilds from them.

`brain report [--out DIR] [--jira SNAPSHOT --as-of YYYY-MM-DD]` writes `report.md` and `report.html` (default: the brain directory; `--out` must be an existing directory inside the repository) atomically, after checking both targets (a symlink or non-file target: exit 4, nothing written). Same inputs give the same bytes: no clock, sorted order, no randomness. Sections: sprint load against cap, can start today (the same set `brain ready` accepts: one shared function, `lib/ready.mjs`, checked against the CLI and an independent brute-force oracle; a ticket whose own status is closed (`Done` or a `closed_statuses` entry; an `sp:` task with `impl_status` done) is `DONE` for `brain ready`, exit 1, and never listed), blocked by an open item, per person, critical chain, stale count, forecast state tag. Each section carries a source label: `computed`, `from jira snapshot dated X` (X is the `--as-of` you gave; the file's own age is not read), `from history n=N`, or `not computed`. All free text is sanitized and escaped; the HTML has no script, handler or external resource. The stale count and forecast state are computed when possible and shown as `not computed` when git or history is unavailable. Publishing and sharing are not done by the command (see the brain-report skill). Race left: a target swapped for a symlink between the pre-check and the rename is replaced by the rename, not followed.

## Symlink and swap races

What is closed (tests: `test/toctou-race.test.mjs`, each race forced at an exact point by an injected `fsImpl` that swaps the file right
after the check, asserting the outside file is never read or written):

- Reading a brain data file (the eight index sources, `config.json`, `format.json`, `.gitattributes`, `open-items.jsonl`, migration inputs,
  the `card --line` hash inputs) goes through `readDataCapped`: `lstat` (a symlink is refused), then `open` with `O_NOFOLLOW` (a symlink
  swapped in after the `lstat` fails the open, refused as a symlink), then the `fstat` of the opened descriptor must have the `lstat`'s device,
  inode and change time (ctime), else it is refused before one byte is read. What each part catches:
  - device and inode, a guarantee: any replacement that existed while the original did. That covers a hard link to an outside file (its
    inode is the outside file's, which is live) and a copy written beside the original and renamed over it.
  - change time, a heuristic: a file created only after the original was DELETED. Its inode number can be the original's: ext4 and overlayfs
    (the Linux CI runner, Docker) hand a freed number to the very next file created, so device and inode match (measured: 2000 of 2000
    delete-then-create swaps on ext4/overlayfs; 0 on APFS and tmpfs, which do not reuse a number at once). Its ctime is new, and no
    unprivileged process can set a ctime, so the swap is still refused, unless the new file is created within the filesystem's timestamp
    granularity of the original's last change (a kernel tick, at most 10 ms, on Linux kernels with coarse timestamps; nanoseconds on APFS).
    Measured on ext4/overlayfs and APFS: the ctime differed in every one of those swaps. Brain never changes a data file in place (every
    write is a rename), so a ctime change in that window always means a swap. What such a file can contain is only what its creator could
    write, so the case left open is equivalent to that person editing the file, which needs the same directory access.
  Files a person names on the command line (`--jira`, `--keys-file`, input JSON) still follow symlinks, as before.
- Writing (`writeAtomicSafe`: every state file, `.gitattributes`, `format.json`, `CARD.md`, reports, the driver files): after the
  realpath confinement check the target directory is `stat`ed once and its device and inode are compared again after the temp file is created
  and right before the rename (a directory swapped for a symlink to elsewhere is refused); the temp file is created with
  `O_CREAT|O_EXCL|O_NOFOLLOW` (a planted file or symlink at its name is never written through); right before the rename the destination is
  `lstat`ed again (a symlink is refused) and the temp path must still be the descriptor written (`lstat` against `fstat`); after the rename
  the destination must be that same file. `rename(2)` replaces a symlink at the destination itself, so a swap in the last instant before the
  rename is replaced, not followed (tested).
- The index: a `brain.sqlite` that is a symlink is refused on open (exit 2, `brain build`); `brain build` creates its temp file itself with
  `O_CREAT|O_EXCL|O_NOFOLLOW` before SQLite opens it, refuses (exit 4, nothing removed) a file or symlink already at that predictable name,
  and checks its identity again before the rename. It keeps that descriptor open until the rename is done, so the temp file's inode cannot be
  freed and its number cannot be handed to a file created at that path meanwhile: the identity check is a guarantee even against a
  delete-then-create (tested; before this, on ext4 a file planted that way after SQLite closed the temp file became the index). The write
  path above holds its temp file's descriptor the same way. The SQLite library bundled with Node also refuses to open a symlinked database or journal
  (observed, not relied on).

What remains (needs `openat`/`O_BENEATH`-style APIs Node does not expose): every open is by path, so an INTERMEDIATE directory component (for
example `.brain` itself, or a directory above it inside the repository) swapped for a symlink between the realpath walk and the open is not
detected for reads, and for writes it is detected only when it is the target's own parent directory (the device and inode check; no
descriptor of that directory is held, so a directory deleted and recreated on the same filesystem can get its inode number back). To use
it, a local attacker needs write access to a directory on that path inside your repository and to win a race of a few system calls while a
brain command runs; with that access they can usually edit the data files directly anyway. On Windows there is no `O_NOFOLLOW`: the device
and inode comparisons are the guard there (not tested on Windows), and creating symlinks needs a privilege. The data directory of the
merge-driver shim is covered by its own trust model (docs/INTEGRATIONS.md); `bin/brain-merge` reads the files git hands it.
