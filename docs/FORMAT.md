# Plan data format, merging, locks and schema evolution

Implemented in `lib/store.ts`, `lib/merge.ts`, `bin/plangraph-merge`. Text files are the source of truth; SQLite is a rebuildable index.

## 1. Canonical form (`canonLine`, `canonFile`)

- One JSON object per line, `\n`, trailing newline, no spaces. Empty file = zero bytes.
- Records sorted by primary key with plain `<` (code units, so `T-10` < `T-2`). Ties by line text. An identical line twice collapses to one.
- Per-file fixed key order; unknown fields are kept and appended in sorted order; nested object keys are sorted; arrays keep order except declared set fields (`refs.plans`: sorted, deduped).
- Idempotent: `canon(parse(canon(x))) === canon(x)`. Numbers go through `JSON.stringify` (`1.0` becomes `1`; integers beyond 2^53 lose precision on the first parse only).
- Serialization is manual, so a `__proto__` field is preserved and cannot pollute anything.
- Unknown-field rule: a record field that is not one of the file's known fields is kept, never interpreted. `plangraph build` stores the unknown fields of each record as canonical JSON (keys sorted, no whitespace) in a nullable `extra` column of the index table (`ticket`, `schedule`, `edge`, `evidence`, `finding`, `meta`, `learning`, `ref`; NULL when there are none) and `plangraph export` merges them back. Round trip (tested on a fixture with optional fields absent, explicit nulls and numbers in text columns): build then export reproduces a canonical file of the exported tables byte for byte, with one exception: a schedule row without `version` comes back with `"version":"current"` (the default `plangraph build` applies). The rules that make it hold: a known field that is absent is stored as NULL and stays absent on export; an explicit `null` in a known field and a number in a known text column (kept in the column as its JSON text, e.g. `"123"`, for queries) are also stored in `extra`, which wins on export; a boolean, object or array in a known text column is a data error (`file:line: "field" must be a string or a number`, exit 2). Known columns are a fixed list taken from the index schema in `bin/plangraph`; no SQL identifier is ever taken from a record key (a key such as `summary) VALUES(1,2);--` is just an unknown field). A field literally named `extra` is an ordinary unknown field. Only the tables in `FILES` are exported; `learnings.jsonl` and `refs.jsonl` are never rewritten from the index, so their `extra` exists in the index only. `format_version` is NOT bumped: the change is additive (older files load unchanged, and files with unknown fields now build instead of failing).

| file | primary key | note |
|---|---|---|
| tickets | `key` | |
| edges | `consumer`+`producer` | |
| schedule | `version`+`key` | `version` defaults to `current` (on read, and by `plangraph build` before the insert, so every query sees the row; `plangraph export` then writes `"version":"current"`) |
| findings | `key`+`kind`+`text` | an edit is delete + add |
| meta | `k` | |
| learnings | `id` | |
| refs | `key` | `plans` is a set |
| open-items | `key`+`kind` | |
| evidence | content hash of (key, source, verdict, resolution, needs) | no natural key: the file is a SET, sorted by key, source, hash |
| people | `id` | graph file (section 6) |
| sprints | `n` | graph file; `n` is a whole number, 0 and negatives allowed like `schedule.sprint` |
| epics | `id` | graph file |
| repos | `id` | graph file; `langs`, `frameworks`, `entry`, `owners` and `paths` are sets |
| capacity | `person`+`sprint` | graph file; a data file, not a node type |
| xrefs | `type`+`id`+`sys`+`xid` | graph file; one node may have many references |
| links | hash of the whole canonical record | graph file; a SET: an edit is a delete plus an add |
| any other `*.jsonl` | hash of the whole canonical record | set semantics: never loses a line |

Defaults for missing optional fields are applied on read (`readRecords`, `withDefaults`), never written, so they cause no churn (the one exception is the schedule `version`, see the table).

## 2. Format version

`<plan dir>/format.json`: `{"format_version":N,"min_reader":M}`. This tool writes `FORMAT_VERSION = 1`. A directory without the file reads as format 0 and is accepted for now.

Reader rules (`checkFormat(dir, {version}, {mode})`):
- Unknown fields are ignored and preserved (including in `format.json`). Missing optional fields get defaults.
- Directory newer than the tool: hard error `TOO_NEW` ("upgrade the plangraph tool"). In `mode:'read'` it is allowed when `min_reader <= tool version` (additive changes only); writing to a newer directory is never allowed.

### Expand / migrate / contract (many repos, one shared tool; how a future format version ships)

Repos upgrade at different times, so a change ships in three releases, never one:
1. Expand: tool N+1 reads and writes both shapes (new optional field, or new file alongside the old). `format_version` stays; `min_reader` stays. Old tools keep working (unknown fields preserved).
2. Migrate: once every repo runs N+1, a migration `N to N+1` rewrites data to the new shape. Raise `min_reader` only if old tools would misread the new shape; that turns old tools into a clear "upgrade" error instead of silent damage.
3. Contract: a later release drops the old-shape reading code. The tool then refuses a directory still on the old format with a clear message.
Rules: never reuse or repurpose a field; never remove a migration; renames are expand (write both) then contract; every migration is idempotent and tested with crash injection.

## 3. Locks (`withLock`)

Used by `withLock`. The lock file is created exclusively and holds `{pid, token}`. A lock is stolen only when its owner pid is dead (`process.kill(pid, 0)` fails with `ESRCH`; `EPERM` means alive) AND the file is older than `staleMs` (default 30 s); content that does not parse counts as stale by age alone. Release removes the file only if the token is still the caller's. If the lock cannot be taken after `retries`, the error says `locked`.

- The lock path is only examined with `lstat` / `O_NOFOLLOW`: a symlink there (dangling or not) is an error, `lock path is a symlink`, never followed. The "file vanished, try again" path counts against `retries`; a successful steal retries without consuming one (it is progress), so only an adversary that keeps re-creating stale locks could extend the loop.
- Stealing is serialized by a short-lived guard file `<lock>.steal` and done as a rename to `<lock>.stale-<pid>-<hex>`, a re-read that must still describe the dead owner (inode, pid, token), and only then a remove. A live owner's file that was moved by mistake is put back with a no-clobber link and never deleted by this code, but the put-back is best-effort: if another process created the lock path in the meantime the link fails, the moved file stays behind as `<lock>.stale-*` (a leaked orphan) and an overlap is possible. That needs something to swap the lock file between the guard's re-check and the rename (a hand deletion, or a process running an older unguarded version). A guard left by a crashed stealer is removed once it is older than `staleMs` and its pid is dead; clearing it is itself not atomic (lstat, then remove), so a crashed holder plus a tight race can briefly let two stealers run. The optional `onStealDecision` callback is test-only.
- Known limit, recycled pids: liveness is `kill(pid, 0)`. If a dead owner's pid has been reused by an unrelated live process, the lock (and, the same way, a stale steal guard) is never stolen and callers see `locked` until someone removes the lock file by hand.

## 4. Merge driver (`mergeJsonl`, `bin/plangraph-merge`, `installMergeDriver`, `doctorMergeDriver`)

`mergeJsonl({base, ours, theirs}, keyFn|schema, opts)` merges by primary key: only one side changed: take it; both same: take it; one side deleted and the other unchanged: delete; deleted vs edited: conflict; added differently on both sides: conflict; both edited differently: field-level 3-way (a field changed on one side only, or to the same value, merges; same field changed to different values: conflict). Set fields (`refs.plans`) merge elementwise. Evidence, `links.jsonl` and unknown files are sets (union minus removals). The graph node files (section 6) merge by key exactly like the v1 files; a clean field-level merge keeps each field valid, not the rules that tie two fields together (two branches that edit `start` and `end` of one sprint apart can leave `start` after `end`; `plangraph build` reports it). A new duplicate primary key is a conflict. Output is canonical. Returns `{text, conflicts:[{key,detail,ours,theirs}]}`; with conflicts `text` carries `<<<<<<< ours / ======= / >>>>>>> theirs` blocks at the record's sorted position, which `readJsonl` refuses (so nobody builds from a conflicted file).

`bin/plangraph-merge %O %A %B %P`: key function chosen from the basename of `%P`; result written atomically to `%A`; exit 0 clean, 1 conflicts (keys and reasons on stderr), 2 unreadable input (`%A` untouched). Works for `git merge`, `rebase` and `cherry-pick`. A clean merge of `schedule.jsonl` or `edges.jsonl` prints one line on stderr (`... merged cleanly, but a text merge can still break a handoff or capacity rule: run \`plangraph build\` then \`plangraph check\``): field-level merging keeps each record valid, not the plan's rules (edge T-2 needs T-1, base both Ana S2, ours moves T-2 to Ben S3, theirs moves both to S3: clean, yet a HANDOFF violation).

Install: `.gitattributes` gets `<dir>/*.jsonl merge=plangraph-jsonl` (versioned, commit it) and `git config merge.plangraph-jsonl.driver '<path>/plangraph-merge %O %A %B %P'`. `.git/config` is NOT versioned, so every clone needs it: `plangraph init` and `plangraph doctor --fix` call `installMergeDriver`, and `plangraph doctor` calls `doctorMergeDriver` (checks attribute line, config, and that the executable exists). Use the absolute path of the installed plugin's `bin/plangraph-merge` (git runs it outside the plugin PATH, e.g. from a terminal or CI); a plugin update that moves the directory shows up in doctor as "executable not found". Without the driver git falls back to line merge, which conflicts on adjacent edits but never corrupts the canonical form (still valid JSONL, `plangraph build` rejects conflict markers).

## 5. Behavior notes (cleanup of earlier hardening)

- Reading: a numeric string for `sp` or `sprint` (`"5"`) is now rejected by the schema validators; SQLite used to coerce it silently. Fix the source data (use a JSON number).
- Reading: a schedule `sprint` must be a whole number (`2.5` is rejected: `schedule.jsonl:N: "sprint" must be a whole number`) and a ticket `sp` must not be negative (`tickets.jsonl:N: "sp" must not be negative`); `sp` may be fractional. `plangraph whatif` refuses an index built before this rule that still holds either (exit 2, data error).
- Reading: `readJsonl` / `readRecords` error messages name the file by base name only, never a path.
- Reading: more than 1000 bad lines stops the scan, so exactly 1000 errors reads `... and 990 more` and over 1000 reads `... and at least 990 more` (both tested).
- Reading stdin: `readStreamCapped`'s `timeoutMs` is an idle bound for non-blocking fds only; a blocking stdin cannot be interrupted, so a caller that needs a hard bound must read in a child process.
- Writing (`lib/fsafe.ts`): a target that is a symlink is refused with code `SYMLINK`. This includes the repo `.gitignore` written by `plangraph init`: the CLI wiring must catch it and print a clear message (to do when init is wired to `writeAtomicSafe`). A dangling symlink anywhere in a confined path is refused with code `OUTSIDE_REPO` (`path contains a dangling symlink`). `resolveBrainDir` returns the lexical path; confinement is enforced only when callers pass `{ root }` to `writeAtomicSafe`.

## 6. Additive fields and kinds from the superpowers ingest (no format bump)

`plangraph sp-ingest` (see `docs/INTEGRATIONS.md`, "Ingesting superpowers plans") adds one optional field and new record kinds. All of it is additive: `FORMAT_VERSION` and `min_reader` stay at 1, older tools keep and ignore the field (unknown fields are preserved), and no migration exists or is needed.

- `tickets.impl_status` (optional string): `todo`, `in_progress`, `done` or `blocked`. It is implementation progress taken ONLY from a superpowers SDD ledger, never from plan checkboxes, and is a different thing from `jira_status` (which the ingest never touches). The validator rejects any other value with `"impl_status" must be one of todo, in_progress, done, blocked`. It is the last known field in the tickets order (after `first_verdict`). Absent means "never ingested with a ledger". The SQLite `ticket` table has an `impl_status TEXT` column; `plangraph export` omits the field when it is null, so a tickets.jsonl that never had it exports byte-for-byte as before.
- Ticket keys `sp:<plan-slug>` (one epic per plan) and `sp:<plan-slug>/<task-id>`. Jira keys never contain `:`, so they cannot collide. Caps: the slug (plan file name without `.md`) is at most 48 characters and contains no `..`; a task id is at most 24 characters (`[A-Za-z0-9]+(\.[A-Za-z0-9]+)*`), so an `sp:` key is at most 76 characters. A longer slug or id is a loud failure (exit 2, nothing written); the error names the task by its position and line, never by echoing the id. Commands that take a key argument (`sp-link`, `open-items --findings`) accept keys of up to 120 characters from `[A-Za-z0-9._:/-]`, starting with a letter or digit, with no `..`.
- Key namespace rule: a key starting with `sp:` denotes a superpowers implementation task (or its plan epic). Such a ticket is placed only when someone assigns it (`sp-ingest --owner NAME --sprint N`, or a schedule row added by hand). `plangraph verify` does not report `UNPLACED` for an `sp:` ticket without a placement; an `sp:` ticket that has a placement is verified like any other (handoff, capacity, cycles). `OK plan valid (N tickets)` counts every ticket, placed or not. `plangraph check` ignores unscheduled tickets as before. `plangraph ready KEY` for an `sp:` key reads progress from `impl_status`, not from `jira_status`: it prints `ALREADY DONE KEY` (exit 0) when the task's own `impl_status` is `done`; an `sp:` producer counts as done when its `impl_status` is `done`, and otherwise the reason reads `waits for <producer> (impl_status <status or todo>[, planned S<n> <owner>])`. The plan fragment is printed only for a producer that has a placement. `plangraph ticket` and `plangraph ready` omit any fragment that has no value (no `Snull`, `null` or empty owner).
- Edge kind `sp_needs`: consumer task needs producer task, from an explicit `Task M` in its Consumes text or an exact backticked name that exactly one earlier task Produces. Note = the names, else `Task M`.
- Finding kinds: `sp_constraint` and `sp_review_focus` (plan Global Constraints and Review Focus bullets, keyed on the epic; not learnings), `sp_ruling`, `sp_parked`, `sp_deferred` (ledger rulings, parked findings and deferred minors, keyed on the task or the epic).
- Ownership: records whose key is `sp:<slug>` or starts with `sp:<slug>/` belong to that plan's ingest. A re-ingest replaces that plan's tickets, refs, `sp_needs` edges and plan-kind findings; ledger-kind findings are kept and added to (they must survive the ledger being deleted) and are dropped only with their task. Schedule rows are never changed or removed (`--owner NAME --sprint N` only adds rows for tasks that have none). Every other record is passed through unchanged.
- Unknown ticket fields are now safe (`plangraph build` keeps them, see the unknown-field rule in section 1). The ingest still writes none (no `alias`, `kind`, `title_fp`, `impl_range`) because it has no need to.

## 7. Graph files (0.4.0, no format bump)

Seven optional files next to the v1 files: `people.jsonl`, `sprints.jsonl`, `epics.jsonl`, `repos.jsonl`, `capacity.jsonl`, `links.jsonl`, `xrefs.jsonl`. A directory without them is a valid directory and behaves exactly as under 0.3.0 (index fingerprint, card line and every answer are unchanged); a present file adds its bytes to the card digest. `FORMAT_VERSION` and `min_reader` stay 1. Nodes are keyed per file and no file stores a `type` field; there is no `plantasks.jsonl` (plan tasks are derived from `refs.plans`, `<plan>#<task>`, never parsed). One reader, `parseGraphFile(name, text)` in `lib/graph/files.ts`, checks every graph file; a data error is `<file>:<line>: "<field>" must be ...` (never the value) or starts with a code: `LINK_UNKNOWN_REL`, `LINK_DERIVED_REL`, `DUPLICATE_NODE`, `XREF_BAD_ID`.

| file | row (all fields optional unless marked) |
|---|---|
| `people.jsonl` | `id` (required), `name`, `active` (boolean) |
| `sprints.jsonl` | `n` (required), `name`, `start`, `end` (`YYYY-MM-DD`, real dates, `start <= end`), `state` |
| `epics.jsonl` | `id` (required), `name` |
| `repos.jsonl` | `id` (required), `name`, `role` (`service lib app infra docs monorepo`), `langs`, `pm`, `runtime`, `frameworks`, `cmds` (`{build,test,lint}`: script names, never bodies), `entry`, `deploy`, `owners`, `paths` (`[{glob, sub}]`), `src` (`scan manual catalog`), `fp`, `scanned_at`, `scanner` |
| `capacity.jsonl` | `person`, `sprint`, `sp` (non-negative) required; `review_h` (non-negative, carried and never read) |
| `links.jsonl` | `from`, `from_type`, `rel`, `to`, `to_type` required; `attrs` (object) |
| `xrefs.jsonl` | `type`, `id`, `sys`, `xid` required; `src`, `seen` (`YYYY-MM-DD`), `note` |

- Every row may carry `schema_version` (a whole number of at least 1, the version of that row's own shape) and any field a newer tool wrote: unknown fields are kept and written back appended in sorted order, never interpreted. A row of a newer shape is read, never refused.
- Open grammars. Node types are `ticket person sprint epic plantask openitem plan doc repo` plus extension types `x-<sys>.<kind>` (`[a-z][a-z0-9-]{0,23}` each part). Hand-authored relations in `links.jsonl` are `relates_to`, `depends_on`, `touches`, plus extension relations `x-<sys>/<rel>`. Derived relations (`needs assigned_to scheduled_in belongs_to implements held_by part_of specified_by tracked_by owned_by`) are never stored: a row with one is `LINK_DERIVED_REL` naming the file that holds the fact; any other relation is `LINK_UNKNOWN_REL`. An extension type, relation or xref `sys` is accepted and counted (`GraphFiles.ext`), never an error, and no blocker, capacity, solver or verify rule reads it (`REL_SEMANTICS`).
- Endpoints are typed: a sprint is written `S<n>`, an open item `<key>|<kind>`, a plan task `<plan>#<task>`; ids are unique per type, not across types.
- Id rule: at most 200 characters, no C0 or C1 control, bidirectional or line-break character. A row already in a file that breaks it is a warning (`GraphFiles.warnings`); a command that writes a new row refuses it (`idProblem`).
- xrefs: `sys` is `<name>`, `<name>:<alias>` or `<name>:<owner>/<repo>` (lower-case name; known names are `jira github gitlab bitbucket linear confluence ci local sp`, any other well-formed name is accepted as an extension); `xid` is `[A-Za-z0-9._:/#@ -]{1,200}` with no `..`, no URL and nothing shaped like an email address. No URL, host, account id or email is committed (decision D24).
- `plangraph graph-materialize` (0.5.0, decision D23; no format bump) appends one bare row to `people.jsonl`, `sprints.jsonl` and `epics.jsonl` for each person, sprint and epic that `schedule.jsonl` and `tickets.jsonl` name and the file lacks. It never edits an existing row, writes no v1 file, leaves out a name outside the id rule with a warning, and is idempotent (a second run writes nothing).
- Duplicates: two rows with one key and different content are `DUPLICATE_NODE` naming the file and the key (an identical row twice is one row). An older `plangraph-merge` (0.3.0) merges these files as sets of whole records, so a two-sided edit of one row leaves two rows with that key; the 0.4.0 driver merges them into one by key. Upgrade every team member before anyone commits graph files.

### Observation cache (0.5.0, uncommitted, no format bump)

`plangraph import --sys S FILE...` writes `<dir>/cache/<S>.jsonl` (`S` is `generic`, `jira` or `sp`; the directory is git-ignored through a `cache/` line in the plan directory `.gitignore`, the files are mode 0600). Row: `sys`, `xid`, `type`, `fields` (a map of at most 40 scalars, keys `[a-z][a-z0-9_]{0,31}`, strings at most 200 characters), `links` (extension relations `x-<sys>/<rel>` only), `fp` (16 hex digits of the content), `seen` (`YYYY-MM-DD`). Key `sys`+`xid`. No URL, no account id, no email (decision D24): the Jira provider stores a display name and a `jira:<alias>` system. The index loads every cache file into the table `obs` (same columns); a cache file adds bytes to the source fingerprint only when it exists. `obs` is read by no rule and no solver, and `export` never writes it. A `generic` batch is `{"schema":"plangraph-ext-batch@1","sys":"x-<name>","observations":[{"xid","type":"x-<name>.<kind>","fields","links"}]}`.

### Drift report (0.5.0, read-only)

`plangraph sync --plan` joins `obs` to the plan: an observation of type `ticket` belongs to a plan ticket when its `sys`+`xid` equals an `xrefs.jsonl` row of that ticket, or, for `jira:<alias>` and `sp`, when `xid` is the ticket key. The plan is the authority for the planned owner, sprint and `needs`; the observation for status, real assignee and real sprint. Findings (one line each, sorted by code then key): `DRIFT_ASSIGNEE` (schedule owner and observed `assignee` differ, case-insensitive), `DRIFT_SPRINT` (the `current` sprint number and the last id of observed `sprint` differ), `DRIFT_DONE` (the observed `status` is closed, `Done` or `config.closed_statuses`, and the plan ticket is not done by `jira_status` or `impl_status`, or the reverse), `DRIFT_LINK` (an observed `x-<sys>/blocks` link `A blocks B` with no plan edge `B needs A`), `XREF_STALE` (`seen` older than `config.graph.stale_days`, default 14), `XREF_ORPHAN` (an xref whose `sys`+`xid` the cache lacks while the cache holds rows of that system). Observed text is printed in an `<untrusted src="<sys>">` fence. The push list names the tracker id, field and planned value for `DRIFT_ASSIGNEE` and `DRIFT_SPRINT` of `jira` systems; plangraph never applies it.
