# Plan data layout (format 2)

The plan is a directory of small text files in the repository (`.plangraph/` by default, or the `dir` of `.plangraphrc`). The text files are the source of truth. The SQLite index, the observation cache and the solver input are derived, git-ignored and rebuilt by `plangraph build`. Implemented in `lib/store2/`, `lib/planstore.ts` (the one door every read and write goes through), `lib/store.ts` (format stamp, canonical text of a row, locks) and `src/db.ts` (index). Spec: `docs/superpowers/specs/2026-11-26-plangraph-1.0-design.md`, section 4.0.

## 1. Directory tree

```
.plangraph/
  format.json                   {"format_version":2,"min_reader":2,"storage":"entity"}
  config.json                   constraints (caps, stage order, ...); one file, not an entity
  meta.jsonl                    key/value rows; the one plan file that stays a single JSONL file
  nodes/<kind>/<h2>/<slug>~<h12>.pg      one file per node: ticket, person, sprint, epic, repo, openitem, ext
  events/<yyyy-mm>/<actor>.<bh8>.<dd>.jsonl   append-only task events, one writer per file
  runs/<kind>/<yyyy-mm>/<h8>.jsonl      sealed audit output: evidence, findings, learnings
  schedules/<version>.jsonl     immutable schedule versions
  schedules/CURRENT             one line: the current version name
  .gitignore                    cache/  plangraph.sqlite*  .txn/
  cache/                        git-ignored: observations, solver-input/
  plangraph.sqlite              git-ignored: the index (and its journal files)
  .txn/                         git-ignored: staging of an interrupted write
```

`init` writes `format.json`, `config.json`, the ignore lines and no `.gitattributes`. No merge driver exists and none is needed (section 9).

## 2. Node files (`.pg`)

Path: `nodes/<kind>/<h2>/<slug>~<h12>.pg`. `h12` is the first 12 hex of the sha256 of the exact id, `h2` its first two characters (256 directories), `slug` the id lower-cased with every character outside `[a-z0-9._-]` replaced by `_`, at most 60 characters. Two ids that differ only in case get different names, so a case-insensitive file system cannot merge them. The slug is for people; it is never parsed back.

Content: line 1 is `id <json string>`; then one line per field, `<name> <json value>`, sorted by name. A collection field (`links`, `xrefs`, `acceptance`, `members`, `owns`, `affects`, `capacity`) repeats its name once per element, elements sorted by their canonical JSON. Rules, all checked by `plangraph check`:

- LF line ends, one trailing newline, no blank line, no comma or brace at a line end, each line at most 8 KiB, no NUL.
- Field names match `[A-Za-z_][A-Za-z0-9_-]*` and are never `__proto__`. A name outside that grammar is refused when written.
- Values are canonical JSON: object keys sorted at every level, no spaces, `1.0` written `1`.
- Unknown fields are kept and sorted with the rest, never interpreted. A newer tool's field survives an older tool's edit.
- Reserved fields: `schema_version`, `src`, `fp`, `derivation` (`extracted`, `inferred`, `human`), `valid_to`, `superseded_by`, `links` (`{rel, to, attrs?, until?}`), `xrefs` (`{sys, xid, src?, seen?, note?}`).
- A node file is at most 256 KiB.
- Idempotent: formatting a parsed file gives the same bytes. `plangraph fmt` rewrites every non-canonical file; a hand edit is allowed and checked.

### Where each kind lives

| kind (old file) | home |
|---|---|
| ticket (`tickets`) | `nodes/ticket/`: only tickets that are in the plan (scheduled, or named by a link, a plan or an open item). Jira history for every other issue stays in `cache/` observations and is never committed |
| edge (`edges`) | `links` lines with `rel` `needs` on the consumer ticket: `links {"rel":"needs","to":"<producer>","attrs":{"kind":"...","note":"..."}}` |
| ref (`refs`) | fields `plans`, `files`, `fp_files`, `jira_updated`, `audited_at` (and any other column) on the ticket; a ref keyed `sp:<slug>` (a plan epic) lives on `nodes/epic/` |
| person, sprint, epic, repo | `nodes/person/`, `nodes/sprint/`, `nodes/epic/`, `nodes/repo/` |
| requirement, decision, team | `nodes/requirement/`, `nodes/decision/`, `nodes/team/` (canonical text names `requirements`, `decisions`, `teams`) |
| capacity | repeated `capacity {"sprint":3,"sp":5,"review_h":2}` lines on the person |
| link, xref | `links` and `xrefs` lines of the source node; a source type with no node directory (plantask, plan, doc, openitem, `x-*`) lives in `nodes/ext/` keyed by its `pg:` URI |
| open item (`open-items`) | `nodes/openitem/`, id `<key>|<kind>`; closing is an edit of the `status` field |
| schedule | `schedules/<version>.jsonl` plus `schedules/CURRENT` |
| evidence, findings, learnings | sealed run files under `runs/` |
| meta, config, format | `meta.jsonl`, `config.json`, `format.json`: single files |

Every column of every old row is kept. The old file names survive only as names of a kind's canonical text in messages (`tickets.jsonl:3: "sp" must not be negative`), in the index sources and in the solver input.

### Volatile fields

`jira_status`, `jira_updated` and `audited_at` change often and belong to the tracker. They are written only by explicit commands (`refs-update` writes `audited_at` and `jira_updated`; a later release adds the tracker fetch), never by `card` or a hook. `jira-import` and `units` write no plan data: `jira-import --out` writes a snapshot file you name, and `units` writes its units directory, so no tracker history ever becomes a committed node.

### Fields of the existing kinds

Defaults for missing optional fields are applied on read, never written. A numeric string for `sp` or `sprint` (`"5"`) is rejected by the validators; use a JSON number. A schedule `sprint` is a whole number; a ticket `sp` is not negative and may be fractional.

- ticket: `key`, `summary`, `epic`, `sp`, `jira_status`, `v2_owner`, `v2_sprint`, `verdict`, `verdict_source`, `first_verdict`, `impl_status` (`todo`, `in_progress`, `done`, `blocked`; implementation progress taken only from a superpowers ledger, never from checkboxes, and a different thing from `jira_status`).
- Keys `sp:<plan-slug>` (one epic per plan) and `sp:<plan-slug>/<task-id>` are superpowers tasks. Jira keys never contain `:`. An `sp:` ticket is placed only when someone assigns it; `plangraph verify` does not report `UNPLACED` for one without a placement.
- Edge kinds: `plan_need` (default), `sp_needs` (a superpowers task needs another), any other word you use.
- Finding kinds: free words; the ingest uses `sp_constraint`, `sp_review_focus`, `sp_ruling`, `sp_parked`, `sp_deferred`.
- people: `id`, `name`, `active`. sprints: `n` (a whole number, 0 and negatives allowed), `name`, `start`, `end` (`YYYY-MM-DD`, `start <= end`), `state`. epics: `id`, `name`. repos: `id`, `name`, `role` (`service lib app infra docs monorepo`), `langs`, `pm`, `runtime`, `frameworks`, `cmds` (`{build,test,lint}`: script names, never bodies), `entry`, `deploy`, `owners`, `paths` (`[{glob, sub}]`), `src` (`scan manual catalog`), `fp`, `scanned_at`, `scanner`.
- capacity: `sprint`, `sp` (non-negative) required; `review_h` (non-negative, carried and never read).
- requirement: `text`, `kind` (`ears gherkin free`), `status` (`proposed accepted dropped`), `source` (a repo-relative path with an optional `#anchor`, or an external reference `<sys>:<xid>` such as `confluence:12345`; never a URL, `..` or an absolute path: `BAD_SCHEMA`), repeated `acceptance` lines, `priority`. decision: `title`, `status` (`proposed accepted deprecated superseded rejected`), `date` (`YYYY-MM-DD`), repeated `affects` lines (repo paths or globs), `source`, `derivation`. team: `name`, repeated `members` and `owns` lines. Ids are local (`R-<hex>`, `D-<hex>`, `TEAM-<hex>`).
- Open grammars: node types are `ticket person sprint epic plantask openitem plan doc repo requirement decision team` plus `x-<sys>.<kind>`; hand-authored relations are `relates_to`, `depends_on`, `touches`, `satisfies` (ticket to requirement; trace), `affects`, `supersedes`, `member_of`, `alias_of` (information only), plus `x-<sys>/<rel>`; none of the new relations is read by a blocker, capacity, solver or verify rule, so an existing plan gives the same verdicts; derived relations (`needs assigned_to scheduled_in belongs_to implements held_by part_of specified_by tracked_by owned_by`) come from the plan and are refused as hand-authored links (`LINK_DERIVED_REL`). A sprint is written `S<n>`, an open item `<key>|<kind>`, a plan task `<plan>#<task>`. Ids are at most 200 characters with no control, bidirectional or line-break character.
- xrefs: `sys` is `<name>`, `<name>:<alias>` or `<name>:<owner>/<repo>`; `xid` is `[A-Za-z0-9._:/#@ -]{1,200}` with no `..`, no URL and nothing shaped like an email address. No URL, host, account id or email is committed.

## 3. Batch files

- Events: `events/<yyyy-mm>/<actor>.<bh8>.<dd>.jsonl`, where `bh8` is the first 8 hex of the sha256 of the branch name at write time and `dd` the day. One writer per file, so two branches never append to one file. A line is one JSON object with `at`, `seq`, `task`, `to`, `by`, and `force: true` when a flow command was run with `--force`. `at` is exactly `yyyy-mm-ddThh:mm:ssZ`; a row with any other `at` is not an event and `check` reports it. `at` is the maximum of the wall clock (to the second) and the latest `at` already read that is at most 24 hours ahead of the wall clock, with a per-file `seq`, so a clone with a fast clock cannot outrank events it has seen, and one wrong clock cannot pin every later event to its month. In a file named for an actor, `by` is that actor: a row by someone else is not an event. A task held by one actor (`claimed`, `in_progress`, `in_review`) is not moved by another actor unless the event carries `force`. Readers sort by `(at, seq, actor, bh8)` and drop exact duplicates.
- Runs: `runs/<kind>/<yyyy-mm>/<h8>.jsonl`, `h8` the content hash, lines sorted. Identical runs are one file.
- Schedules: `schedules/<version>.jsonl` with `version = v<n>-<h8 of content>`, immutable. `schedules/CURRENT` holds one version name; two branches that both change it conflict there, on purpose.
- `plangraph compact` merges sealed months into one content-hashed file per month and kind. It refuses unless `CI=true` or `--ci`, so two clones cannot race; events later than a compacted month land in a fresh file.
- Every line of a batch file is one JSON object of at most 1 MiB.

## 4. Violation codes (`plangraph check`)

`check` prints one line per violation, `error: CODE path:line: fix`, and exits 1 on any error. `NOT_CANONICAL` and `UNSORTED_BATCH` are warnings. Readers never throw on a damaged file: they skip it, and the card prints `store: N problem files (run plangraph check)`.

| code | meaning |
|---|---|
| `ID_MISMATCH` | the file name's hash differs from the id inside, or the file is in the wrong directory |
| `DUPLICATE_ID` | two files hold one id |
| `CASE_COLLISION` | two names are equal ignoring case |
| `NOT_CANONICAL` | the bytes differ from the canonical form: run `plangraph fmt` |
| `DANGLING_LINK` | a link names a node that does not exist |
| `BAD_SCHEMA` | a reserved field has a wrong shape (`derivation`, `status`, `links`, `xrefs`, ...) |
| `CONFLICT_MARKERS` | `<<<<<<<`, `=======` or `>>>>>>>` in the file: run `plangraph resolve` |
| `BAD_LINE` | a line that is not `<name> <json>` (node) or not one JSON object (batch), a NUL, or a line over its limit |
| `UNSORTED_BATCH` | lines out of order in an event or run file |
| `SYMLINK` | the file is a symlink: never read, never followed |
| `OVERSIZE` | a node file over 256 KiB |
| `MISSING_CURRENT` | `schedules/CURRENT` absent or naming a version that does not exist |

Backstage names are a mapping for catalog import and export, not extra relations:

| plangraph relation | Backstage relation |
|---|---|
| `member_of` | `memberOf` |
| `part_of` | `partOf` |
| `owned_by` | `ownedBy` |
| `depends_on` | `dependsOn` |

A `satisfies` link to a requirement that does not exist is `DANGLING_LINK` (node check) and `LINK_MISSING_NODE` (graph check).

Graph rules checked on the plan (`LINK_MISSING_NODE`, `UNDATED_SPRINT`, `XREF_BAD_ID`, ...) are printed by `check` and `build` as before.

## 5. Cache and index (derived, git-ignored)

- `cache/<sys>.jsonl`: observations from `plangraph import` (generic, jira, sp, github), mode 0600. Row: `sys`, `xid`, `type`, `fields` (at most 40 scalars), `links` (extension relations only), `fp`, `seen`. Advisory: never read as plan data. `plangraph sync --plan` joins observations to the plan and prints drift (`DRIFT_ASSIGNEE`, `DRIFT_SPRINT`, `DRIFT_DONE`, `DRIFT_LINK`, `XREF_STALE`, `XREF_ORPHAN`) with a tracker push list.
- `cache/solver-input/`: v1-shaped canonical JSONL (`tickets`, `edges`, `schedule` of the current version, `open-items`, `sprints`) and a copy of `config.json`, written by `plangraph build` and `export`, mode 0600. `bin/plangraph-solve --jsonl-dir <plan dir>` reads it (docs/SOLVER.md). The bytes depend only on the plan's rows, so the same logical plan gives the same solver input digest.
- `plangraph.sqlite` and its `-journal`, `-wal`, `-shm` files: the index. Built incrementally: per source file `(size, mtime)` is compared with the `source_file` table, only files that differ are re-hashed and re-read, deleted files are seen from the directory walk, and it works in and out of git. Open items are read from the store, not the index, and are not in the source fingerprint.
- Advisory index tables, never read by the solver and not in its content digest (listed in `ADVISORY_TABLES` in `src/db.ts` and `bin/plangraph-solve`, kept equal by `test/solver-contract.test.ts`): `source_file`; `requirement`, `decision`, `team` (the node kinds); `event` (from `events/`); `module` (from `cache/git.jsonl`, rows of `ingest git`, checked by its own validator; the file is not an observation cache); `identity` (from `cache/identities.json`). They are rebuilt on every build that changes any source. The index file is mode 0600 because it embeds identity refs.
- `.txn/`: the staging area of a multi-file write. An interrupted write rolls forward or back on the next call to any command.

## 6. `format.json`

`{"format_version":N,"min_reader":M,"storage":"entity"}`. This tool writes `FORMAT_VERSION = 2`. Unknown fields are ignored and preserved.

`checkFormat(dir, {version}, {mode})` rules:

- A directory with `format_version` below 2, or with no `format.json` but old-layout files (`tickets.jsonl`, `edges.jsonl`, `schedule.jsonl`, `learnings.jsonl`, `open-items.jsonl`, ...) beside it, is refused everywhere (exit 2): `unsupported pre-1.0 directory: recreate it with plangraph takeover`. `plangraph doctor` prints the same line. An empty directory with no stamp is accepted (a fresh start).
- A directory newer than the tool is a hard error `TOO_NEW` (`upgrade the plangraph tool`). In `mode:'read'` it is allowed when `min_reader <= tool version` (additive changes only); writing to a newer directory is never allowed.

### Expand, migrate, contract (how a future format version ships)

Repos upgrade at different times, so a change ships in three releases, never one:
1. Expand: tool N+1 reads and writes both shapes (a new optional field, or a new file beside the old). `format_version` and `min_reader` stay. Old tools keep working because unknown fields are preserved.
2. Migrate: once every repo runs N+1, a migration `N to N+1` rewrites data to the new shape. Raise `min_reader` only if old tools would misread the new shape; that turns old tools into a clear "upgrade" error instead of silent damage.
3. Contract: a later release drops the old-shape reading code and refuses a directory still on the old format with a clear message (as format 2 does for format 1).
Rules: never reuse or repurpose a field; renames are expand (write both) then contract; every migration is idempotent and tested with crash injection.

## 7. Locks (`withLock`)

The store lock file is created exclusively and holds `{pid, token}`. A lock is stolen only when its owner pid is dead (`process.kill(pid, 0)` fails with `ESRCH`; `EPERM` means alive) AND the file is older than `staleMs` (default 30 s); content that does not parse counts as stale by age alone. Release removes the file only if the token is still the caller's.

- The lock path is examined only with `lstat` and `O_NOFOLLOW`: a symlink there (dangling or not) is an error, never followed.
- Stealing is serialized by a short-lived guard file `<lock>.steal` and done as a rename to `<lock>.stale-<pid>-<hex>`, a re-read that must still describe the dead owner, and only then a remove. A live owner's file moved by mistake is put back with a no-clobber link and never deleted by this code.
- Known limit, recycled pids: liveness is `kill(pid, 0)`. If a dead owner's pid has been reused by an unrelated live process, the lock is never stolen and callers see `locked` until someone removes the lock file by hand.

## 8. Reading and writing rules

- Writes go through validating commands and a staged transaction (`withTxn`): files are staged under `.txn/`, journaled, then renamed into place. Two agents in one clone serialize on the store lock.
- A target that is a symlink, or a directory that leaves the repository, is refused with exit 4 and `nothing was written`; every target is checked before the first write.
- Reading: error messages name the file by base name only, never a path. More than 1000 bad lines stops the scan (`... and at least 990 more`).
- Canonical text of a row (what `readText` gives and the solver input holds): one JSON object per line, `\n`, trailing newline, no spaces, records sorted by primary key with plain `<` (so `T-10` sorts before `T-2`), per-kind fixed key order, unknown fields appended sorted, set fields (`refs.plans`) sorted and de-duplicated. `canon(parse(canon(x))) === canon(x)`. Serialization is manual, so a `__proto__` field cannot pollute anything.

## 9. Merge behavior, stated honestly, and `resolve`

Stock git does every merge: no driver, no attribute, so the GitHub and GitLab merge buttons, CI merge queues, fresh clones and agent sandboxes behave the same as a terminal.

- Two branches editing different nodes touch different files: clean.
- Two branches editing non-adjacent fields of one node: clean. Editing adjacent fields (adjacent lines), or inserting two links at the same sorted position: a text conflict in that one file. Two branches creating the same id: an add/add conflict, which is the right signal.
- Two branches changing `schedules/CURRENT` conflict there by design.
- Events from two branches land in different files (different `bh8`) and merge clean.
- A conflict never takes the tool down: the file is skipped (`CONFLICT_MARKERS`), the other files load, and `check` and the card say so.
- `plangraph resolve` finds files with conflict markers. When every conflicting hunk consists only of lines of collection fields it resolves by union and sorts; a hunk that touches a scalar field is left in place and reported with the file and field, for a person to settle. Run `plangraph check` afterwards.
- A clean merge can still break a hand-off or a capacity rule (two people placing work in one sprint): `plangraph check` and `plangraph verify` are the guard, in CI and before a commit.
