# Engineering contract for plangraph modules

Goal: the best planning memory for AI coding agents. Hard rules, in priority order:

1. **Correctness is provable.** Every feature ships with tests that could fail: property tests against an independent oracle, golden outputs, mutation-sensitive assertions. Say what a test does NOT cover in a comment at the top of the test file.
2. **Tokens are a budget.** Every answer a command prints is read by a model. Default output is the smallest useful answer (target: one line for a yes/no, under 250 tokens for anything, under 60 for the common case). No prose, no decoration, stable ordering, stable field names. Bounded output: an explicit limit plus a `... N more` marker. Every answer that depends on data states its freshness when it could be stale. Estimate tokens as `ceil(chars / 4)`.
3. **No network or model calls** anywhere except `lib/jira.ts`. Never write, log or echo secrets (Jira token). Tokens only from the process environment or an OS keychain helper.
4. **Pure core.** Library modules are ES modules in `lib/*.ts` that take plain data (the model from `lib/model.ts`, see `buildModel`) and return plain data or strings. No SQLite, no `process.exit`, no `console.log` inside library functions (return strings or objects; the CLI prints). This keeps them testable and lets the CLI drop SQLite later.
5. **No runtime dependencies** (Node built-ins only; Python solver only uses OR-Tools). Dev-only, exact-pinned, never shipped: `typescript`, `@types/node`, `@biomejs/biome` (`npm run typecheck`, `npm run lint`). Node >= 24.2. Tests use `node:test` + `node:assert/strict`, files named `test/<module>.test.ts`, runnable with `npm test`. Fixtures come from `test/fixtures/gen.ts` (`genPlan`, `rng`). Never use real people, tickets or company data; names are invented.
6. **Determinism.** Same input gives byte-identical output. Sort with plain `<` comparison (not localeCompare). Seeded RNG only (`rng` from the fixtures file; copy the tiny function into lib if the module needs randomness).
7. **Merge-friendly data.** Text files are JSONL, one record per line, sorted by primary key, canonical key order, `\n` endings, trailing newline.

Exhaustive small-scope suite: `npm run assure` (minutes; `test/assure/`) checks verify, check/verify CLI agreement, whatif/proposeMove, whatif --relieve, merge, stale, ready (single and bulk), forecast gates and the canonical round trip against clean-room oracles on EVERY instance up to small bounds (each file's header states them; a reduced variant runs in every `npm test` run as `test/assure.test.ts`). It is exhaustive within those bounds, not a proof beyond them.

CI (`.github/workflows/ci.yml`) runs parallel jobs so that no job is long: `unit` (ubuntu; every test file but the slow no-coverage group,
with the coverage floors), `slow` (ubuntu with uv; smoke, then the solver, evals and icon tests, which reach no `lib/` or `src/` code the
coverage group does not), `static` (typecheck, lint, plugin layout), `macos` (every test but the solver one, in shards, plus smoke),
`mutation` and `gitleaks`. `node scripts/ci-tests.ts coverage|nocoverage|portable` prints each group; `test/ci-tests.test.ts` pins the
split, and a file joins the no-coverage group only after measuring that the coverage group alone keeps the same coverage.

Mutation testing: `npm run mutate` runs the hand-written mutants of known past defects (`--list` prints them; all must be killed; they run
in parallel on min(cores, 4) workers, `--jobs N` overrides; the required CI `mutation` job runs it on every push). `npm run mutate:all`
(`scripts/mutate-all.ts`, long run) generates every mutant of `lib/`, `lib/integrations/`, `src/` and `mcp/` (relational, arithmetic,
logical, boolean, condition negation, return value, string literal, off-by-one, guard and throw removal; never comments, JSDoc, regex
literals or import specifiers), applies each to a temporary copy of the repository, syntax-checks it and runs the test files mapped to
that file (tier 1: direct importers that run in under 10 s; tier 2, only for tier-1 survivors: slower importers and tests reaching it
transitively or through `bin/brain`). A failing
test or a timeout kills a mutant (timeouts are counted in their own column); a mutant that does not parse is left out. The score is
(killed + timeout) / (mutants - invalid - reviewed equivalents). Equivalent mutants are listed, each with a one-line reason, in
`scripts/mutate/equivalent.json`; keep that list tiny and re-justify an entry when its line changes (a stale entry fails a full run).
Results are resumable from `$TMPDIR/brain-mutate-all/`; `--files`, `--limit N --seed S`, `--shard N/M`, `--jobs J`, `--max-tier 1`.
`npm run mutate:smoke` (40 seeded mutants of core modules with fast tests: verify, whatif, merge, gitsafe, fsafe, forecast, report; tier 1) runs weekly and on demand as the informational `mutation`
workflow (not on every push): it reports survivors in the job summary and never fails the run. A surviving mutant is answered with a behavior test that
kills it (`test/mutation-kills-*.test.ts`; their JSON goldens are in `test/golden/mutation-kills/`, rewritten with `UPDATE_GOLDEN=1`
after an intended output change and reviewed as a diff), or with an equivalence entry, never with a test of the mutant's text.


Ownership: each worker edits ONLY the files assigned to it (new files under `lib/`, `test/`, and where stated `bin/brain-solve`, docs). Do NOT edit `bin/brain`, `hooks/`, `skills/`, `README.md`, `lib/model.ts`, `lib/jsonl.ts`, `test/smoke.sh`, `test/fixtures/gen.ts`; the integrator wires modules into the CLI. If you need a change in one of those, describe it in your final report.

Model shape (`lib/model.ts`): `{ tickets: Map<key,row>, edges: [{consumer,producer,kind,note}], prods: Map<consumer,[producer]>, cons: Map<producer,[consumer]>, sched: Map<key,{owner,sprint}> (current schedule), config, findings, evidence, learnings, refs }`. `config.caps[person] ?? config.caps.default` is capacity in story points per person per sprint (`capOf`). `ticket.sp` is story points. A link "consumer needs producer". **Strict handoff rule:** `sprint[consumer] >= sprint[producer] + (owner[consumer] !== owner[producer] ? 1 : 0)`: another person's output must land in an earlier sprint; the same person may share the sprint.

**Frozen history** (stated once, in `lib/frozen.ts`; `bin/brain-solve` mirrors it and `test/frozen.test.ts` compares the two on a grid; verify, `whatif` (STARTED and the tickets a
repair may move), `proposeMove` and `--relieve` all read this one predicate. In `brain whatif`, a closed ticket, a ticket below
`frozen_before_sprint` or one frozen by the caller is a hard `STARTED` stop; `In Progress` always warns (`STARTED`, warn: someone
started it, whatever `frozen_statuses` says; `brain init` writes `["Done"]`), and so does any status listed in `frozen_statuses` (a
stop under `--strict`); only a listed status is frozen for verify, the solver, repairs and relief). CLOSED: an
`sp:` task with `impl_status` done, or a ticket whose `jira_status` is `Done` or in `closed_statuses`. FROZEN (keeps its slot): closed, or
`jira_status` in `frozen_statuses` (only what config lists), or `--freeze` / `opts.frozen`, or a current sprint below `frozen_before_sprint`.
A constraint exists only where at least one side is FREE: a link whose producer is closed is satisfied wherever the producer sits (a
finished producer cannot be late); a link between two frozen tickets is a fixed fact, never a violation and never a constraint; every other
link obeys the strict handoff rule. A person-sprint cell's capacity binds only its free load, which must fit in `max(0, cap - frozen load)`:
a cell of frozen tickets only is never over capacity, and no free story point joins a cell whose frozen load already reaches cap (a 0-SP
ticket may). `brain verify`/`check`, `brain whatif` (and `--relieve`), `brain ready` and the solver all apply this rule, and the solver never
moves a frozen ticket or delays a consumer because of a closed producer's slot. `brain verify FILE` checks the file against the frozen
tickets of the current schedule (`FROZEN_MOVED KEY was O Sn, now ...` for each one it moves or drops), and `brain schedule-load FILE NAME`
refuses such a file (exit 4, `refusing to load: the schedule moves N frozen ticket(s) (KEYS); a frozen ticket keeps its slot`, nothing
written; there is no override flag: unfreeze the ticket in the data first).

Final report format from each worker: what you built (files), exact test command and its result, what the tests do not cover, public API (function signatures), and CLI wiring the integrator must add (command name, flags, one example output with its estimated token count).

## CLI contract (bin/brain)

`bin/brain` is a thin entry point: it checks the Node floor, then hands the arguments to `src/cli.ts`, which looks the command up in the
registry (`src/registry.ts`, a `Map` of frozen specs from `src/commands/*.ts`), parses the options strictly (`src/args.ts`), runs the
command with a context (`src/context.ts`) and prints the bounded output. Commands take `(ctx, args)`, write through `ctx.io`, and return
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

`brain check` and the CI gate: `check` exits 1 on any strict-rule violation, person-sprint over cap, loop, or **unplaced ticket** (a ticket with no valid
schedule row; an `sp:` task is exempt until someone places it). Its one line adds ` | unplaced N (brain verify lists them)` only when N > 0, and
`--json` data is `{ tickets, links, violations, overCap, loopFree, lastSprint, unplaced }` (`tickets` counts the placed ones, as the line does). N is
`brain verify`'s own UNPLACED count (check calls `verifyPlan`, the function behind the card's violation count), so `verify` exiting 1 on UNPLACED
and `check` saying all is well can no longer both happen.

Session hook: `brain card --if-present` (with or without `--heal`) prints nothing and exits 0 whenever anything fails: a too-old Node, a bad
`.plangraphrc`, a refused brain directory (`PLANGRAPH_DIR` or `--dir` absolute or escaping), a missing or corrupt index, a bad option, or any
thrown error. On success it prints the card (a last `STALE:` line when the index is stale). With no index but brain data present (the brain
directory resolves inside the repository and holds `tickets.jsonl` or `config.json`) it prints ONE fixed first-use line instead, still exit 0:
`brain: plan data found in <dir> but no index: run brain build`, or, when `format.json` is older than the tool's (a missing file is format 0),
`brain: plan data found in <dir> but no index: run brain migrate --write (format v<N>) then brain build` (`<dir>` is the brain directory relative
to the repository, one sanitized line; nothing from the data files is in it). The line is decided from `lstat` and sizes only, with no git process;
the hook never writes, migrates or builds. It stays silent (exit 0) for no brain, a brain directory with no data file, a newer format, and every
refusal above plus a symlink, FIFO, directory, unreadable or over-cap data file, `config.json` or `format.json`, a bad `format.json`, and anything
at the index path. A manual `brain card` is unchanged (`error: no index`, exit 2). Only `card` has
this guarantee: other commands given `--if-present` still report errors (it only suppresses their STALE warning).

Errors print `error: <what>` on stderr, optionally `hint: <what to do>` (prose), and always a last line `try: <exact command>`
(the error table in `src/errors.ts`: a hint that names a `brain ...` command becomes the try line; otherwise `brain init` when there is no
brain directory, `brain build` for a missing index, `brain doctor` for environment and internal errors, else `brain explain <the command that failed>`). A mistyped command gets
`did you mean <name>?` (edit distance at most 2); the command list itself is `brain explain`. A line never carries a newline or a forged
`<untrusted>` tag from the data, and untrusted text never reaches the try line. Commands print through `ctx.io.out(line)`, which takes
exactly one line: a line break of any kind (LF, CR, VT, FF, NEL, U+2028, U+2029) is a programmer error that fails the tests
(`PLANGRAPH_STRICT_OUT=1`, set under `node --test`) and becomes a space in production; intended multi-line output (a fence block) goes
through `ctx.io.outBlock(lines)`. `test/hostile-fuzz.test.ts` runs every registered command over a plan whose every free-text field
carries a line injection.

`brain explain [COMMAND] [--json]` describes the CLI from the registry (summary, options, argument count, `writes` class plus the merge-driver wiring a command always does (`init`) or a flag adds (`doctor --fix`, `card --heal`: git config, `.gitattributes`, the merge shim), exit codes),
bounded (the full list under 400 estimated tokens). `--json` on any command prints exactly one v2 envelope on stdout
`{"v":2,"cmd","ok","exit","data","fresh","next"}`, also when the command printed nothing (`data` is `{ "lines": [] }`) and when it failed
(the error lines stay on stderr; `cmd` is null for an unknown command; `test/json-envelope.test.ts` runs every registered command): `data` is structured for `sprint`, `ready` (one ticket or the bulk form), `whatif` (dry run, also `--relieve`), `verify` and
`explain`, and `{ "lines": [...] }` for the others (card and bundle included: their prepared text, line by line); `fresh` is `{ "fp", "built" }` (first 8 hex of the source fingerprint of the text
now and of the text the index was built from; they differ when the index is stale) or null when the command read no index; `next` holds
0 to 3 exact follow-up commands, built only from shell-safe values.

Bulk ready (`brain ready --person NAME --sprint N`, either filter alone or both, never with a KEY): the scope is every ticket placed with
that owner (resolved like `whatif --to`: exact, else a unique case-insensitive match, else a unique first name; anything else is a usage
error that never echoes the name) and/or in that sprint. Each ticket of the scope is exactly one of ready, done or not ready, by
`lib/ready.ts` `readyScope` over the shared `readySet` (no second implementation; `test/assure/ready.assure.ts` checks it against a
clean-room oracle on every small instance). Text: one count line first (`<owner> S<n>: ready R of T, done D, not ready N (waiting on
producers a, open items b, verdict not READY c)`; the groups overlap: a not-ready ticket counts under each of its reasons, and each one is
under at least one), then the ready keys (25, `-v` 500, then `+N more`), one line per reason with 5 example keys (`-v` 50), with `-v` the
done keys, and the freshness note. Exit 0 when at least one ticket may start, 1 when none may (also `no placed tickets`). `--json` data:
`person`, `sprint`, `total`, `counts`, and the lists `ready`, `done`, `notReady`, `waiting`, `openItems` (`{key, kinds}`), `verdict`
(`{key, verdict}`), each capped at 2000 (the counts are never capped). A KEY together with a filter, or neither, is a usage error.

Relieve (`brain whatif --relieve NAME --sprint N [--earlier] [--owner-change]`, read-only, never with a KEY; `--to`, `--apply-plan` and
`--write` are usage errors; `--slip` is implied and `--strict` has no effect: frozen tickets never move): `lib/whatif.ts` `relieve`.
The name resolves like `whatif --to`. Move space: only the tickets of that cell move, each once, to one slot: the same owner in a later
sprint; with `--earlier` an earlier one; with `--owner-change` another person (an owner or a caps person) in sprint N or later (earlier too
with both flags); every sprint in first_sprint..end_sprint. Frozen tickets stay (the one predicate of `lib/frozen.ts`: closed statuses,
an `sp:` task with impl_status done, frozen_statuses as config lists them, N below frozen_before_sprint). Frozen history: only the free load of the cell must fit in max(0, cap -
frozen load), so a cell over cap by frozen tickets alone needs no relief (`OK: ... over capacity (L/C) only by frozen tickets, which are
history: nothing to relieve`). A set is valid when, applied together, the free load left fits, every link with a moved ticket at either end
(other end a placed ticket) satisfies the strict handoff rule unless its producer is closed, and every cell that gained
load ends at or under its owner's cap; the chosen set is checked again with verifyPlan (every violation after must have been there
before; an internal error otherwise). Choice: fewest moves, then least total |to sprint - N|, then fewest owner changes, then key order
(moves sorted by key, compared by key, owner, sprint). Search: subsets by size, depth-first assignment with a bound; budget 1,000,000
steps, each subset step and slot try (`RELIEVE_BUDGET`; `nodes` in --json is what was spent); when it is hit the header says `search budget ... hit: not proven minimal` or `no relief found within the
search budget ...; not proven impossible`. Text: `RELIEF: <owner> S<n> L/C -> A/C with k moves (slip s, o owner changes)`, one line per
move with its exact `brain whatif` dry-run command (or `no shell-safe command` when a key or name is not shell-safe), in an order where
each passes `brain whatif` alone on the plan so far (else a note that the moves only work together and that brain cannot apply moves
together, since `whatif --apply-plan` applies one move with its own repair; the safe path is a hand-edited schedule checked with `brain
verify FILE` and loaded with `brain schedule-load`), then the dry-run note; `NO RELIEF`
lists the reasons (FROZEN, NO_SLOT, LINKS, FULL, then NOT_ENOUGH, NO_ROOM (`the targets have room for X of Y SP`: the target cells
together have less room than the excess) or CONFLICT) with 5 example keys (`-v` 50) and the flags to try (never `--earlier` when N is
first_sprint); `OK:
... nothing to relieve` when the load is within cap. Exit 0 for relief or nothing to relieve, 1 for no relief. `--json` data: `relieve`
`{person, sprint}`, `status` (`relief`, `no_relief`, `none_needed`), loads, `slip`, `ownerChanges`, `order`, `searchComplete`, `budget`, `nodes`,
`allowed`, `moves` (with `command`), `reasons`; `next` holds the move commands, or the relieve command with a wider flag.
`test/assure/relieve.assure.ts` checks it against a clean-room brute force on every small instance (minimality, validity, order).

Find (`brain whatif KEY --find [--earlier] [--owner-change] [--strict]`, read-only; `--to`, `--sprint`, `--relieve`, `--apply-plan` and
`--write` are usage errors; `--slip` is implied): `lib/whatif.ts` `findSlots`. Slot space (relieve's for one ticket): the same owner in
every later sprint; with `--earlier` an earlier one; with `--owner-change` every other person (an owner or a caps person) in the current
sprint or later (earlier too with both); sprints first_sprint..end_sprint; at most `FIND_MAX` (5000) slots are tried. A slot is valid when
`whatif` says OK (a STARTED warning keeps it, marked; `--strict` makes it a stop) and, applied to a copy, verifyPlan finds nothing it did not
already find (an internal error otherwise). Ranked by |to sprint - current sprint|, the same owner first, the least load on the target cell,
owner name, sprint. Text: `FIND KEY (O Sn): V valid slots of T tried (space); best: S5 Ana (no change), ...`, the best 5 (`-v` 20) with
slip, load and the exact `brain whatif` dry-run command, then the dry-run note; none valid: the reason counts and the flags to try; a key
whatif stops with STARTED: `no slot: KEY keeps its slot (STARTED: ...)`. Exit 0 when a slot is valid, 1 otherwise. `--json` data: `key`,
`status` (`found`, `none`, `frozen`, `unknown`), `from`, `tried`, `valid`, `allowed`, `searchComplete`, `slots` (up to 200, with `command`),
`reasons` ({code: count}); `next` holds the best three commands. `test/assure/find.assure.ts` checks it against a clean-room brute force.

Session card (`brain card`, the SessionStart hook): a pure function of the data, byte-identical across runs (no clock, no age, no
modification time): `brain <fp> | N tickets, M links, S<first>-S<last>, P people`, verdicts, over-cap, findings, the steer
line `plan questions: use brain (ticket, ready, whatif, blockers, sprint, person); do not read <brain dir>/*.jsonl` (lib/steer.ts; the
directory as the repo configures it, default `.plangraph`), and a last `STALE: index older than text, run \`brain build\`` line only when the fingerprint check fails.

Brain directory: `--dir`, else a non-empty `PLANGRAPH_DIR`, else `{"dir": "..."}` in `.plangraphrc` at the repository root, else `.plangraph`. It must be
a relative path inside the repository: an absolute or escaping directory is refused with exit 4 (`brain directory is outside the repository`), and so is a name with whitespace, a control character or any of `* ? [ ] \ ! # "` (`brain directory name has a character that is not allowed`; the merge driver is only wired for names made of `A-Z a-z 0-9 . _ / -`), except under
`brain card --if-present`, which stays silent with exit 0.

Staleness: the index stores a source fingerprint (sha256 of the eight text files it is built from). When the text no longer matches,
index-reading commands still answer, and print `STALE: the text files changed since the index was built; run \`brain build\`` on stderr
(once), unless `--if-present` is given. `brain export` rewrites the text from the index and records the new fingerprint, so the next query
is not stale; it refuses a stale index (exit 2, hint `brain build`), because writing it would overwrite the edited text. `schedule-load`
and `whatif --write` change only the index, so export after them goes ahead. `brain forecast` also warns when `open-items.jsonl` is newer than the index; the card uses the fingerprint only (no modification times).

Index integrity: the fingerprint covers the text only, so `brain build` also stores a content digest (sha256 over every row of every
table of `plangraph.sqlite`, `index_meta` included except the digest row, in a canonical order: primary key, then every column) in `index_meta`
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

SQLite sidecars: SQLite replays a hot rollback journal (`plangraph.sqlite-journal`) into the database on the first read-write open, whatever
database it came from, and a read-only open of a database with a hot journal fails. A planted or committed journal holding every page of a
forged index (digest recomputed as above) would otherwise become the index on the next `schedule-load` or `whatif --write`, and block every
read until removed by hand. Brain never uses WAL, builds with `journal_mode=OFF` (no journal at all for the temp file), and its own writes
(journal mode DELETE) remove their journal on commit, so no sidecar is ever legitimately beside the index when a command starts (tested:
build, reads, `whatif --write`, `schedule-load` and `export` leave none). So: every index open (reads, writes, the hook's card) refuses a
`plangraph.sqlite-journal`, `-wal` or `-shm` beside the index before SQLite sees the file: exit 2, `error: the index has a SQLite journal file
beside it (plangraph.sqlite-journal); it is never replayed`, `try: brain build` (the hook prints nothing, exit 0). `brain build` removes a
regular sidecar of the index and of its own temp name right before the rename (it belongs to a prior or foreign index and is never
replayed), and refuses a symlinked or non-file sidecar (exit 4, `refusing to build the index: plangraph.sqlite-wal is a symlink; remove it by
hand, then run ...`), following and removing nothing. `brain init` writes `*.sqlite`, `*.sqlite-journal`, `*.sqlite-wal` and
`*.sqlite-shm` to the brain directory's `.gitignore` (appending only the missing lines to an existing one), and `brain doctor` warns about a
sidecar beside the index, a git-tracked sidecar, and a `.gitignore` without the sidecar lines (warnings, exit code unchanged). Consequences:
a crash in the middle of `schedule-load` or `whatif --write` leaves a real hot journal; it is refused like a planted one, and `brain build`
rebuilds from the text, so index-only changes not yet exported are lost (export after every index write, as above). A reader that starts
while another process is inside an index write sees that writer's journal and is refused (exit 2) for that moment.

`brain report [--out DIR] [--jira SNAPSHOT --as-of YYYY-MM-DD]` writes `report.md` and `report.html` (default: the brain directory; `--out` must be an existing directory inside the repository) atomically, after checking both targets (a symlink or non-file target: exit 4, nothing written). Same inputs give the same bytes: no clock, sorted order, no randomness. Sections: sprint load against cap, can start today (the same set `brain ready` accepts: one shared function, `lib/ready.ts`, checked against the CLI and an independent brute-force oracle; a ticket whose own status is closed (`Done` or a `closed_statuses` entry; an `sp:` task with `impl_status` done) is `DONE` for `brain ready`, exit 1, and never listed), blocked by an open item, per person, critical chain, stale count, forecast state tag. Each section carries a source label: `computed`, `from jira snapshot dated X` (X is the `--as-of` you gave; the file's own age is not read), `from history n=N`, or `not computed`. All free text is sanitized and escaped; the HTML has no script, handler or external resource. The stale count and forecast state are computed when possible and shown as `not computed` when git or history is unavailable. Publishing and sharing are not done by the command (see the brain-report skill). Race left: a target swapped for a symlink between the pre-check and the rename is replaced by the rename, not followed.

## Symlink and swap races

What is closed (tests: `test/toctou-race.test.ts`, each race forced at an exact point by an injected `fsImpl` that swaps the file right
after the check, asserting the outside file is never read or written):

- Reading a brain data file (the eight index sources, `config.json`, `format.json`, `.gitattributes`, `open-items.jsonl`, migration inputs,
  the `card --line` hash inputs, and the OpenWolf files read by `rules --repo` and `doctor`: `.wolf/cerebrum.md`, `.wolf/STATUS.md`,
  `.wolf/anatomy-index.json`) goes through `readDataCapped`: `lstat` (a symlink is refused), then `open` with `O_NOFOLLOW` (a symlink
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
- The index: a `plangraph.sqlite` that is a symlink is refused on open (exit 2, `brain build`); so is one that is not a regular file (a FIFO,
  a directory, a device: exit 2, `error: the index is not a regular file`, `try: brain build`; the session hook prints nothing, exit 0),
  because SQLite opens without `O_NONBLOCK` and a FIFO with no writer would block every index command and the hook until its 10 s kill.
  Before SQLite sees the path, brain `lstat`s it, opens it itself with `O_RDONLY|O_NONBLOCK|O_NOFOLLOW` (never blocks, never follows), requires
  the `fstat` of that descriptor to be a regular file with the `lstat`'s device and inode, and closes it (tested with `mkfifo`; skipped where
  there is none). Residual: SQLite then opens the index again BY PATH, so a FIFO or another file swapped in between that check and SQLite's
  own open is not detected (Node's SQLite binding cannot take a descriptor); a local attacker able to do that can replace the index directly.
  The sidecar files beside it are only `lstat`ed, never opened (see "SQLite sidecars" above); `brain build` creates its temp file itself with
  `O_CREAT|O_EXCL|O_NOFOLLOW` before SQLite opens it. A regular file already at that predictable name with this process's pid (or a dead
  pid, or older than 10 minutes) is a leftover of a crashed build and is removed first (only that name is unlinked: a hard link to an
  outside file loses the link, the file is untouched); a symlink or any other non-file there, and a file that appears at the name after
  that clean-up, are refused (exit 4, nothing removed). It checks its identity again before the rename. It keeps that descriptor open
  until the rename is done, so the temp file's inode cannot be freed and its number cannot be handed to a file created at that path meanwhile: the identity check is a guarantee even against a
  delete-then-create (tested; before this, on ext4 a file planted that way after SQLite closed the temp file became the index). The write
  path above holds its temp file's descriptor the same way. The SQLite library bundled with Node also refuses to open a symlinked database or journal
  (observed, not relied on).

What remains (needs `openat`/`O_BENEATH`-style APIs Node does not expose): every open is by path, so an INTERMEDIATE directory component (for
example `.plangraph` itself, or a directory above it inside the repository) swapped for a symlink between the realpath walk and the open is not
detected for reads, and for writes it is detected only when it is the target's own parent directory (the device and inode check; no
descriptor of that directory is held, so a directory deleted and recreated on the same filesystem can get its inode number back). To use
it, a local attacker needs write access to a directory on that path inside your repository and to win a race of a few system calls while a
brain command runs; with that access they can usually edit the data files directly anyway. On Windows there is no `O_NOFOLLOW`: the device
and inode comparisons are the guard there (not tested on Windows), and creating symlinks needs a privilege. The data directory of the
merge-driver shim is covered by its own trust model (docs/INTEGRATIONS.md); `bin/brain-merge` reads the files git hands it.
