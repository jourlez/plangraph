# Git-native stores for a team project graph (research date 2026-11-26)

Tag key: [verified: URL] = read in a fetched primary page this session. [claimed/unverified] = general knowledge or secondary/search-snippet only. Vendor posts (DoltHub) are self-reported.

## 1. beads (steveyegge/beads, now gastownhall/beads)
- Current storage is Dolt, not JSONL+SQLite. README: Dolt is the backend; embedded mode (default) in `.beads/embeddeddolt/`, single writer; server mode (`bd init --server`) in `.beads/dolt/`, multi-writer. [verified: https://github.com/steveyegge/beads]
- `.beads/issues.jsonl` is "an export for viewers and interchange, not the source of truth or a backup". Sync uses `bd dolt push/pull` against `refs/dolt/data` on the git remote. [verified: https://github.com/steveyegge/beads]
- Hash ids (`bd-a1b2`, hierarchical `bd-a3f8.1`) exist "to prevent merge collisions in multi-agent/multi-branch workflows". [verified: same]
- History: classic design was SQLite cache (gitignored) + committed JSONL + a `bd merge` driver set up by `bd init`. [claimed/unverified: search snippet of mirrors/pkg.go.dev]
- Early Feb 2026 Yegge moved beads and Gastown exclusively to Dolt; it "scaled another order of magnitude"; this added friction for solo users who liked SQLite+git with no external server. Beads Classic was restored ~Apr 2026 (~120 commits). [verified: https://www.dolthub.com/blog/2026-04-02-restoring-beads-classic/] This is a DoltHub post, so it is biased toward Dolt.
- Stated JSONL costs: "merge conflicts, no concurrent access, no query capability" (community answer, 2026-02-27). `sync-branch` was removed in v0.53.0 in favor of Dolt-native sync. [verified: https://github.com/gastownhall/beads/discussions/2164] Not an official maintainer postmortem.
- Maintainer's own caveats: HTTP backend "experimental", advice to pin exact version, schema-skew guard blocks old binaries on migrated DBs. [verified: https://github.com/steveyegge/beads]
- Lesson for us: the most-used agent-oriented tracker abandoned committed JSONL + merge driver at scale and chose a real versioned DB. But its scale target (many concurrent agents, Gas Town) is far above a team's shared graph. A Rust port (beads_rust) stays on SQLite + auto-flushed JSONL, never touching git itself. [claimed/unverified: docs.rs snippet]
- Not found: a primary-source list of concrete JSONL merge bugs in beads. Do not assume them.

## 2. git-bug
- Data model: each edit session is an OperationPack (JSON array in a blob) under a tree `/ops`; commits chain; exposed as `refs/<namespace>/<id>`. State is compiled by replaying ops. Op id = hash of data; entity id = hash of first op. [verified: https://raw.githubusercontent.com/git-bug/git-bug/master/doc/design/data-model.md]
- Ordering: Lamport clocks stored in tree entry names; wall clock display-only; ties broken by lexicographic OperationPack id (arbitrary but unbiased). Diverged histories become merge commits, so merges never conflict by construction. [verified: same]
- Cost: no hand-editable files; reading needs git-bug tooling (Go). No visible diff in PRs (data lives in refs, not in the tree). Web UI labeled WIP; ~10.9k stars, 112 open issues. [verified: https://github.com/git-bug/git-bug] Scale benchmarks not published (only "milliseconds" claim).
- Refs are not shown or reviewable in GitHub PRs and do not travel with a normal `git push` of a branch. [claimed/unverified, standard git behavior]

## 3. Dolt / DoltHub / DoltLite
- Cell-wise data merge; schema changes to different tables/columns merge without conflict. Conflict and constraint details are on other pages. [verified: https://www.dolthub.com/docs/concepts/dolt/git/merge]
- Dolt is Go; normally a server process. A Go-only embedded `database/sql` driver runs in-process with no server (Jan 2026 post). [claimed/unverified: search snippet of https://www.dolthub.com/blog/2026-01-23-golang-sql-drivers; fetch redirected, not read]. No Node binding found. [claimed/unverified]
- DoltLite: SQLite fork with prolly-tree storage in one file, branches/merge/diff/push/pull; Beta Aug 2026 at v0.50.0; format stable for 57 releases; passes 99.46% of SQLite TCL tests, 4,809 known divergences; no WAL sidecar; file-backed reads match SQLite, batched writes 10% slower, autocommit writes 3.1x slower. Bindings listed: C, Python, Ruby, Swift, Android, WASM; no Node mentioned. [verified: http://www.dolthub.com/blog/2026-08-31-doltlite-beta/] Merge semantics of DoltLite not documented in that post. An earlier July post called it alpha, with chunks uncompressed, stop-the-world GC, multi-process with one writer lock. [verified: http://www.dolthub.com/blog/2026-07-08-dolt-doltlite-storage-comp/]
- Fit: it cannot be `node:sqlite` (stock). A native fork or WASM would be a new hard dependency. A binary prolly-tree file in git is not reviewable in a PR; sync is via `refs/dolt/data` or a remote, not via ordinary branch diffs. Strong merge semantics, wrong distribution shape for "files in git that PRs review".

## 4. TerminusDB
- Apache-2.0 (copyright Gettier, 2026); v12.0.7, 12.1 RC; 6,918 commits; run via Docker/source on `localhost:6363` with admin password, i.e. a server. [verified: https://github.com/terminusdb/terminusdb]
- Immutable delta layers, branch/merge/time-travel, WOQL Datalog. [claimed/unverified: Wikipedia/doc snippets]
- Fit: needs a server. Disqualified by the "no server" constraint.

## 5. SQLite committed as binary
- Text view possible: `diff.<name>.textconv` + `binary=true` running `sqlite3 .dump`; slow on big DBs because it dumps everything each time; some people commit the `.dump` as source and treat the binary as generated. [claimed/unverified: https://simonwillison.net/2023/Nov/1/tracking-sqlite-database-changes-in-git/ via search snippets]
- Merge: git cannot merge two divergent binary files; any concurrent edit is a whole-file conflict. Page reorder makes every commit a different blob, so repo history grows (poor delta compression). [claimed/unverified, general knowledge]
- textconv is local config, so GitHub's PR diff shows "binary file changed". [claimed/unverified]
- Verdict: fine as a rebuildable cache (current design). Unfit as the shared source of truth.
- Variant: committed `.dump` SQL text. Stable ordering is feasible but INSERT-per-row merge needs a driver anyway.

## 6. One file per entity (YAML/JSON/MD front matter)
- Backstage: entities are descriptor files; names unique per kind/namespace; page does not describe duplicate-name handling or git ingestion. [verified: https://backstage.io/docs/features/software-catalog/descriptor-format]
- Merge behavior: two branches editing different entities touch different files, so git's built-in 3-way merge, GitHub web merge and PR UI all work with no driver. Same-entity edits conflict only on overlapping lines; if each field is on its own line, concurrent edits to different fields merge cleanly. [claimed/unverified, git's line-based merge semantics]
- Failure modes: filename collisions on create (same id twice yields add/add conflict, which is a good signal); ids must be globally unique without coordination (use random/hash ids, not sequence numbers); renames; large directories (100k files: slow `git status` on some filesystems, big checkouts, slow GitHub tree views, ~1 inode per row). [claimed/unverified]
- Mitigation: shard by kind and id prefix (`tickets/ab/abcd.md`). Task events as entity files are heavy; better as a per-day or per-ticket append file, see 7.
- Readability: best of all options in PRs (one entity per file path, per-field lines). Agent ergonomics: write one small file, no read-modify-write of a big file.

## 7. Event-sourced append-only logs
- Pattern (git-bug is the reference). Append-only files merge cleanly under git only if each writer appends to a *different* file; two branches appending to the same file's tail conflict at the textual level (both add lines at the same position). [claimed/unverified, general git behavior]
- Remedy: one file per event or per (ticket, actor, day); or `merge=union` for pure append logs (union merges in either order, may duplicate; ordering must come from an explicit Lamport/HLC field, not file order). `merge=union` is a built-in strategy, needs no config, but whether GitHub's web merge honors it was not verified. [claimed/unverified]
- Derived state is rebuilt into SQLite (already done). Compaction/snapshots needed eventually; replay of 100k events is cheap in SQLite (seconds). [claimed/unverified]
- Fits the "agents append" requirement best; state-of-ticket fields (status, owner) should be derived from last-writer-by-clock events, which also gives a real audit trail (the "task events" you already have).

## 8. Plain JSONL + custom merge driver (current design): pitfalls
- A custom driver is defined in local git config, not in the repo, so each clone must install it; GitHub web merges don't run it per an unofficial answer. [claimed/unverified: https://kiwix.lema.org/stackoverflow.com_en_all_2023-11/questions/65309426/how-to-enable-custom-merge-driver-gitattributes-in-github]
- GitLab: "Custom merge drivers are not supported on GitLab.com or GitLab Dedicated" (self-managed admins only). Also "invoked only in the case of a non-trivial merge conflict", so not a reliable guard. [verified: https://docs.gitlab.com/user/project/repository/files/git_attributes]
- Bitbucket Cloud: feature request open for per-repo merge drivers. [claimed/unverified: https://jira.atlassian.com/browse/BCLOUD-20234]
- Consequence: on any hosted PR merge, git falls back to text 3-way merge on the sorted file. Adjacent inserts in a sorted file conflict or silently interleave. Duplicate merge keys can be introduced (two branches add the same key at different positions: git merges cleanly, giving a duplicate). That is the worst failure: clean text merge, invalid data. [claimed/unverified, derived from git semantics]
- Other: one large file per kind means every PR touching it grows conflict surface; line-per-row diffs of long JSON lines are hard to read (whole-line replacement, no per-field diff); canonical formatting must be enforced or whitespace/key-order churn causes false conflicts; CI cannot run the driver either, so you need a post-merge validator (dup keys, sortedness, referential integrity). [claimed/unverified]
- git rerere/rebase/cherry-pick/stash do run drivers locally if installed, but only when configured. [claimed/unverified]

## 9. git notes / refs
- Notes ref `refs/notes/commits` default; strategies `manual` (default), `ours`, `theirs`, `union`, `cat_sort_uniq`. [verified: https://git-scm.com/docs/git-notes]
- Notes attach to object ids (commits), not to entities; refs/notes are not pushed or fetched by default, need explicit refspecs. [claimed/unverified for push default; the docs page does not say it]
- Not visible in PRs, not in the working tree, rewritten on rebase unless copied; web UIs largely ignore them. [claimed/unverified]
- Verdict: wrong tool for a graph keyed by entity ids. Reject. (git-bug shows refs-based storage works, but at a cost in visibility.)

## Comparison against the requirements
| Option | Web-UI merge safe | Concurrent edits | PR review | 100k rows | Agent writes | Offline | Server |
|---|---|---|---|---|---|---|---|
| Current JSONL+driver | no (falls back to text) | good locally with driver | poor | OK, file grows | read-modify-write file | yes | no |
| File per entity (sharded) | yes | good | best | OK with sharding | easy | yes | no |
| Event files + derived SQLite | yes (distinct files) | best | good | good | easiest (append new file) | yes | no |
| SQLite binary | no | whole-file conflict | none | fine | easy | yes | no |
| Dolt/DoltLite | n/a (own sync) | best (cell-level) | none | good | SQL | yes | embedded Go/ new fork; Dolt server |
| git-bug | yes (refs) | good (CRDT-ish) | none in PR | unpublished | via tool | yes | no |
| TerminusDB | n/a | good | none | n/a | API | n/a | yes |
| git notes | no | weak | none | n/a | poor | yes | no |

## Ranked recommendation
1. Hybrid: sharded one-file-per-entity for entity kinds (ticket, person, sprint, repo, requirement, decision), plus per-event append files for task events and link changes (one file per event or per actor/day, with Lamport/HLC clock + random id), with SQLite as a rebuildable, gitignored index. Merges with stock git everywhere (CLI, GitHub, GitLab.com, Bitbucket, CI), no driver required, readable PR diffs, trivial agent writes. Keep a validator (CI + pre-commit) for duplicate ids, dangling refs, schema.
2. Keep JSONL but make it driver-optional: one record per file or per-shard JSONL with canonical format and `merge=union`, plus validator. Lower migration cost than 1, but retains duplicate-key and ordering risk.
3. DoltLite (embedded) if you later need real cell-level merge and SQL as the source of truth. Revisit only once Node bindings exist and PR review is solved. Rejected today: no Node binding found, binary store, sync outside normal branch flow.
4. git-bug-style refs store: strong merge model, poor visibility. 5. SQLite binary, TerminusDB (server), git notes: reject.

## Three biggest risks of the current JSONL design
1. Merge driver is local config: every hosted merge (GitHub/GitLab.com/Bitbucket web UI), CI merge queue, fresh clone and agent sandbox without installation gets stock text merge on sorted files. Result is conflicts or, worse, clean merges with duplicate keys.
2. Silent data corruption on clean text merges: duplicate merge keys, broken sort order and dangling links pass git without conflict; nothing checks until read. Need a mandatory validator, which the driver cannot supply.
3. Poor review and growth: one big file per kind with long single-line records gives unreadable PR diffs (no per-field view), a hot-spot file every ticket edit touches (conflict surface grows with team and agent count), and whole-file read-modify-write for each agent append. Beads' own migration away from this model at scale is the closest industry signal. [verified: https://www.dolthub.com/blog/2026-04-02-restoring-beads-classic/ for the move; reasons for it are only partly sourced]

## Gaps
No primary sources found for: Dolt embedded driver details (fetch redirected), DoltLite merge semantics, beads' concrete JSONL bug reports, GitHub's official statement on merge drivers, performance of 100k-file repos. Treat those rows as unverified.
