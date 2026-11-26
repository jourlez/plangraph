# Graph v2 amendment: the integration substrate (binding amendment)

This document amends `2026-11-24-graph-model-v2.md` (the graph plan) and its spec `../specs/2026-11-23-graph-model-v2-design.md`. Where they disagree, this one wins. It was written from two read-only reviews on 2026-11-25: a design review of the graph plan against the owner's vision, and a survey of the field (graphify, Beads, Graphiti, basic-memory, Backlog.md, Taskmaster, the Atlassian MCP server, the MCP specification revision 2026-07-28). Claims about other projects came from their public pages and were not all verified; none of the design depends on one.

## 1. Purpose and position

The graph is the core of plangraph: tickets, people, sprints, epics, plans, specs and plan tasks as typed nodes, with relations that rules can act on (what blocks what, who is overloaded, what a move breaks) and external identities that let other tools contribute nodes and facts.

Position, so the scope stays honest: plangraph is a git-native, offline, deterministic planning layer for teams that use Claude Code with a tracker. It is not a code knowledge graph (graphify models source code and documents; the two complement each other and plangraph links to code through a reference, it does not reimplement parsing) and not a general agent memory (Graphiti, the memory server). What it has that those lack: executable rules (readiness, capacity, solver, what-if), people and capacity, deterministic merge of plain text in git, read-only tracker ingest, and answers in a few tokens. What it must add to be clearly the best planning graph: a stable external identity scheme, adapters for other plugins and MCP servers, provenance and staleness on every imported fact, hardened handling of imported text, and a graph surface for MCP clients.

## 2. Release map (replaces the old split)

| Release | Content | Format |
|---|---|---|
| 0.3.0 | the revised zero-gaps plan (rename, security, team docs) | 1 |
| 0.4.0 | expand: the graph plan's Tasks 1 to 7 plus the substrate: open type and relation grammar, node URI, `xrefs.jsonl`, derived `plan`/`doc` nodes | 1 (tolerant readers) |
| 0.5.0 | read-side integration: provider seam, `import`, observation cache, drift report, whatif gate and slot reasons, MCP `graph` tool and resource templates, `graph materialize` instead of a content-free migration (D23) | 1 |
| 0.6.0 (follow-up, owner decides after 0.5.0) | write side and the section 3.13 candidates: `sync --write` for plan-side edits, push lists, GitHub and CI providers, claim and lease protocol, review-capacity forecasting, conflict-aware scheduling, drift verdicts, Beads and OpenSpec bridges, tasks extension, subscriptions, graph.json and HTML export | 1 |
| 1.0.0 | contract: format 2 (drop `v2_owner`, `v2_sprint`, `first_verdict`) | 2 |

Every file shape and grammar the later releases need ships in 0.4.0, so no later release changes the format and 0.3.0 and 0.4.0 tools never reject a directory only because it holds a newer additive row.

## 3. Design

### 3.1 Node identity

- Storage is unchanged: raw ids are unique per type; a node is `(type, id)`.
- External form (command arguments, `--json`, MCP): `pg:<type>/<pct(id)>`, with percent-encoding of `%`, `/`, `#`, `|`, `?`, space, controls and non-ASCII (UTF-8). Decoding is single pass; a decoded value that does not re-encode to the input is refused (no double encoding). Examples: `pg:ticket/ABC-123`, `pg:person/Ana%20Silva`, `pg:sprint/S3`, `pg:plantask/docs%2Fp.md%23Task%203`. The scheme name `pg` stays (a short stable prefix, not a product name in a path).
- Id rules for new rows: at most 200 characters, no C0 or C1 controls, bidirectional or line-break characters. Old values outside the rules are a warning, never an error.
- Type grammar: core `ticket person sprint epic plantask openitem plan doc repo` plus extension types `x-<sys>.<kind>` (`[a-z][a-z0-9-]{0,23}` each part). `plan` and `doc` ids are repo paths and are derived from `refs.plans[].plan` and `refs.files`; derived relations `part_of` (plantask to plan) and `specified_by` (plan to doc). An extension type is opaque: reachable only through `relates_to` and extension relations, never read by blockers, capacity, the solver or verify.
- Relation grammar: core relations plus extension relations `x-<sys>/<rel>` with informational semantics. An unknown non-`x-` relation stays `LINK_UNKNOWN_REL`; an unknown `x-` type or relation is accepted and counted (`doctor`: `ext ignored N`).
- `REL_SEMANTICS` (frozen): `needs: order`, `assigned_to: load`, `scheduled_in: slot`, `held_by: gate`, `belongs_to: group`, `implements|part_of|specified_by: trace`, `tracked_by: identity`, `relates_to|x-*: info`. Only order, load, slot and gate relations are read by blockers, capacity, the solver and verify.

### 3.2 External references: `xrefs.jsonl`

Committed, keyed file. Key `type+id+sys+xid`. One node may have many references. Row: `{type, id, sys, xid, src?, seen?, note?}`.

- `sys` grammar: `jira:<alias>` (the tenant alias of the tracker work, so no host is committed), `github:<owner>/<repo>`, `linear:<alias>`, `confluence:<alias>`, `sp`, `ci:<alias>`, `x-<name>`.
- `xid` is validated per system (Jira key, `sprint/<int>`, `pull/<n>`, `issue/<n>`); generic rule `[A-Za-z0-9._:/#@ -]{1,200}`, no `..`.
- No URLs and no account ids or emails are stored. Links render at output time from `sys` and `xid`. People hold at most a display name and a `jira:<alias>` reference (decision D24).
- Provenance: `src` (`import:jira`, `hand`) and `seen` (`YYYY-MM-DD`, from `ctx.now`).
- Implicit references are never stored (no fact twice): a ticket key matching the key rule is implicitly `jira:<default alias>`; an `sp:` ticket is implicitly linked to its plan task through `refs.plans`.
- Derived relation `tracked_by` from xrefs. Integrity: `XREF_DUPLICATE` (one `sys`+`xid` on two nodes of a type, error), `XREF_MISSING_NODE` (as `LINK_MISSING_NODE`), `XREF_BAD_ID` (parse error), warning `DOUBLE_PLACED_WORK` (an `sp:` ticket and the Jira ticket it tracks are both placed: capacity would count the work twice).

### 3.3 Provider interface (pure; no I/O in `lib/`)

```ts
interface Observation { sys: string; xid: string; type: NodeType; fields: Readonly<Record<string, string|number|boolean|null>>; links: ReadonlyArray<{ rel: string; sys: string; xid: string }>; fp: string }
interface ProviderBatch { observations: Observation[]; warnings: string[]; dropped: number }
interface GraphProvider { readonly sys: string; readonly schema: 1; validXid(xid: string): boolean; normalize(input: unknown, opts: { tenant: string; now: string; prev: ReadonlyMap<string, Observation> | null }): ProviderBatch }
const PROVIDERS: Readonly<Record<string, GraphProvider>>   // frozen, null-prototype, Object.hasOwn lookup
```

- Built-in providers (nothing loads dynamically): `jira` (snapshot to observations: assignee display name, status, sprint ids and dates, blocks links), `sp` (plan, task, checkbox counts, ledger status), `generic` (strict `plangraph-ext-batch@1` JSON for any other plugin or MCP server). `github` and `ci` follow in 0.6.0.
- Data arrives as files: an agent saves another MCP server's JSON output and runs `plangraph import --sys <S> FILE...` (the `jira-import` pattern). `jira-pull` stays the only networked fetcher. Observations are written to the uncommitted cache `<dir>/cache/<sys>.jsonl` (git-ignored, mode 0600); the index gets an `obs` table; the source fingerprint includes the cache only when it exists, so a directory without a cache keeps its fingerprint.
- Observations never write `edges`, `schedule` or `tickets`. A provider only proposes; only an explicit write (0.6.0 `sync --write`) turns a proposal into a fact.

### 3.4 Sync and ownership

| Field | Authority |
|---|---|
| summary, status, real assignee, real sprint | tracker (observation) |
| planned owner, sprint, `needs` | plangraph files |
| task progress | the superpowers ledger status; checkboxes are advisory only |

Read-only drift report `plangraph sync --plan` (0.5.0), one bounded line per finding: `DRIFT_ASSIGNEE`, `DRIFT_SPRINT`, `DRIFT_DONE`, `DRIFT_LINK`, `XREF_STALE` (`seen` older than `config.graph.stale_days`, default 14), `XREF_ORPHAN`. Staleness shows in verdicts ("blocked by X, data 9 days old"). Tracker writes stay outside plangraph: it prints a push list the agent applies through the Atlassian connector after the user approves.

### 3.5 Trust

All imported strings pass `oneLine` and a length cap; committed data holds ids, enums, numbers and a summary of at most 200 characters; external text never reaches the card and is printed fenced as `<untrusted src="<sys>">`; extension relations are informational by grammar; agent-supplied JSON is hostile input (8 MiB per file, 50,000 observations); imported links never become blocker or capacity facts without an explicit write.

### 3.6 Superpowers mapping

Plan file to `plan` node (derived); the `**Spec:**` line to a `doc` node with `specified_by` (derived from the epic's `refs.files` entry that `sp-ingest` writes); `### Task N` to a plantask plus the `sp:slug/N` ticket as today; `sp-link ABC-123 PLAN --tasks N` gives `implements`, and `sp-link --track` adds the `tracked_by` xref from `sp:slug/N` to `ABC-123` (this removes the double placement of one work item). Step checkboxes are not nodes (token cost); the `sp` observation carries `checked k/n` as an advisory.

### 3.7 Reassignment respecting the graph (whatif)

whatif keeps its constraint engine for order, load and slot and adds (0.5.0): a gate (an open `held_by` or a verdict other than READY on the moved ticket gives `BLOCKED`, a warning, a stop under `--strict`); a slot (a target sprint whose state is `closed`, or whose end is before the as-of date, gives `SPRINT_CLOSED`); load reads `capacityFor`. One bounded line (at most 40 estimated tokens) from a depth-2 `reach` over trace and identity relations: `touches: plan docs/p.md#3, epic E-1, jira ABC-123 (assignee Ben: push list)`. Group and info relations are never read.

### 3.8 MCP surface (0.5.0)

A `graph` tool; `resources/templates/list` with `plangraph://node/{type}/{id}` and `plangraph://graph/{type}/{id}{?rel,depth}`; `resources/read` returns the same text as the command; `resources/list` stays empty (bounded); no subscriptions (0.6.0). Results carry `structuredContent` plus a text mirror, and `resource_link` entries for detail instead of bodies. Tool and resource definitions stay under the token bound (`tools/list` at most 2,600 bytes). A non-grammar URI is an `isError` with a fixed message. Tool annotations stay honest (read-only hints).

### 3.9 Format fit

0.4.0 ships the schemas, merge keys and tolerant grammars for every v2 file (`xrefs.jsonl` included): a file must be merged by key by every tool from the first release that may see it, or the duplicate problem the graph plan calls G2 returns. The observation cache is uncommitted and needs no format change. The content-free 1-to-2 migration of the old Task 8 is replaced by `plangraph graph materialize` (decision D23): it appends node rows, is idempotent, writes no v1 file and bumps no version; format 2 arrives only with the 1.0.0 contract step.

### 3.10 Repositories as nodes, and many repositories per tracker project

Both shapes are first class: one Jira project may span many repositories, and one repository may serve several Jira projects. The link is many to many on both sides; a repository is never part of a ticket's identity.

- Node type `repo` joins the core types. Id: a stable slug chosen in the plan (`repo:<slug>`), never derived from content, so a rename or move of the repository changes only its reference. External reference through xrefs: `github:owner/repo`, `gitlab:group/project`, `bitbucket:ws/repo`, `local:<path>` (not committed when it is a home path).
- Row (file `repos.jsonl`, keyed by `id`, added to the 0.4.0 file set with the other v2 files): `{id, name, role (service|lib|app|infra|docs|monorepo), langs (top 3 by extension count), pm, runtime, frameworks (allowlist match only), cmds {build,test,lint} (script NAMES, never bodies), entry (at most 3 paths), deploy (docker|lambda|k8s|none), owners, paths (monorepo sub-units: [{glob, sub}]), src (scan|manual|catalog), fp, scanned_at, scanner}`. Every field is an enum, a short token or a path: no free text, no README summary. A monorepo is one node with optional `paths` sub-units addressed as `repo:<slug>#<sub>`; no node per package by default.
- Relations: `part_of` (sub-unit to repo, repo to system), `depends_on` (repo to repo, from manifest package names matched to other repos' published names; low confidence for runtime coupling, informational), `owned_by` (repo to person, from CODEOWNERS), `touches` (ticket to repo, with `conf` and `why`, hand-authored or from the heuristic below), `tracked_in` (repo to tracker project alias, optional). `depends_on`, `owned_by` and `touches` are trace or info relations: never read by blockers, capacity, the solver or verify.
- `plangraph repo scan <path|--all> [--check]` (deterministic, no LLM, no network): reads only allowlisted files (manifests, tool-version files, CODEOWNERS, Dockerfile, CI workflow names) from git blobs when possible, caps file size (256 KB), never runs a script or package manager or any subprocess except `git`, never follows a symlink out of the repository. Output is canonical (sorted keys and arrays, no timestamps inside the fingerprinted data). `fp` is the SHA-256 of the sorted `(path, blob sha)` pairs of the files read; `--check` recomputes it and exits non-zero on drift. Hand-written fields (`role`, `part_of`, `owners` edits) survive a rescan; scanned fields are overwritten and tagged `src:scan`. Scanned text is untrusted data, never instructions: only allowlisted tokens reach a node.
- "Which repositories does this ticket touch" (read-side, 0.5.0): a ranked list with `conf` and `why`, never a bare answer. High: an explicit `touches` link or label, or a linked PR or branch in that repository. Medium: a Jira component mapped to the repository through its node, or two or more sibling tickets of the same epic that touched it. Low: keyword or path overlap, or dependency closure (flagged "possible", never counted as touched). Ties or nothing above low give `unknown, ask`.
- Federation: the graph lives in one plan repository that stores the repo nodes (central, reviewed, lowest token cost); each repository's own `catalog-info.yaml` is an optional seed only, treated as untrusted input (Backstage keeps ownership distributed and the catalog central; Nx derives one project graph from per-project config).
- Ordering: 0.4.0: `repo` type, `repos.jsonl` schema and merge key, `part_of`, `owned_by`, `depends_on`, manual `touches`, offline `repo scan` and `--check`. 0.5.0: GitHub provider linking (key in branch name or PR title), the `touches` heuristic, monorepo `paths`, catalog seed. Later: Dockerfile and CI deploy parsing, cross-repo dependency edges from package names, similar-ticket history, SBOM as an artifact.
- Tests that can fail: hostile manifest and CODEOWNERS text never reaches a node or any output; a scan runs no subprocess but `git` (planted `postinstall`, Makefile); two scans on different paths and platforms are byte-identical; changing a script or dependency fails `--check`, changing only a README does not; CODEOWNERS last match wins, no negation, unresolvable owners dropped, oversized file refused; one alias with three repositories and one repository with two aliases produce no collision; no signal gives `unknown`, ties return both, closure never exceeds "possible"; a monorepo ticket naming `packages/web/**` resolves to the sub-unit; a repository rename keeps ids and `touches` edges; two branches each adding a different repo node merge cleanly with canonical array order; a `touches` or `depends_on` to a deleted repo id is reported by verify.


### 3.11 What the model sees (LLM-facing representation; evidence from a 2026-11-25 survey, partly unverified)

The graph is the source of truth and the relational index; it is not what goes into the model's context. Evidence read or summarized: format choice moves accuracy little and differences are mostly inside confidence intervals, while token cost differs a lot (compact tabular text saves roughly a third on mixed data and more on flat data against pretty JSON); every format scores under 50 percent when the model must count, filter or aggregate in its head; models are poor at multi-step graph computation (ordering, cycles, shortest paths) and good at asking a deterministic engine; GraphRAG-style systems win on multi-hop and temporal questions and lose on single-hop lookups, and most of their cost is extracting a graph from prose, which plangraph does not do because its rows are authored. Weak spots, stated plainly: no source studies planning graphs consumed by agents; most format numbers are the format authors' own benchmark; vendor memory benchmarks are disputed.

Rules that follow (binding for 0.4.0 and 0.5.0 output design):
1. Default answer = a verdict line plus at most three supporting rows, for example `READY` or `BLOCKED by ABC-12 (in_progress, S4)`. Counting, summing, filtering, sorting, ordering, cycles and capacity are computed by the engine (SQL views, `blockersOf`, the solver) and never left to the model.
2. Row output is a flat table: header line, declared row count, sorted stable columns, one fact per row (CSV-like or TOON-like text). Nested JSON only inside `structuredContent` with an `outputSchema`; the text mirror stays compact.
3. A raw subgraph is an explicit drill-down (`graph KEY --rel --depth`, with caps and a `truncated N` line); "everything" returns a file path or a named SQL view, never a dump into context.
4. Per-node cards and per-sprint digests are precomputed into the index keyed by the source fingerprint (cache, derived, never committed).
5. Tool and schema text stays small, deterministic in order and stable between releases so prompt caching hits; tiered tool sets stay available.
6. Imported text never appears in the default answer (section 3.5).

Benchmark (new Task 7B, run once in the 0.4.0 audit and kept as `evals/graph-format`): about 100 to 200 held-out questions over a fixed synthetic plan (point lookup, 1-hop, 2-3 hop transitive blockers, aggregation such as load per person and count by status, filter, what-if, cycle and ordering) with ground truth from SQL and the solver. Arms: flat table; edge list; nested JSON; TOON-like; verdict plus rows (the planned default); an agent calling the CLI or MCP tools; optionally an agent writing SQL against the index. Fixed model set (at least three), fixed temperature, fixed tokenizer; report accuracy with Wilson intervals, input and output tokens, tool-call count and latency; adversarial cases (stale rows, ties). The format of the default answer is chosen from this result, not from the survey. Expected, not assumed: the verdict arm wins on aggregation and ordering; the format arms differ little elsewhere.


### 3.12 Retrieval: no embeddings in the core (survey of 2026-11-25, partly unverified)

"RAG is dead" is a headline that bundles several things: long context (degrades with length and cost, not a replacement at scale), agentic search with grep and file reads (shipped, matches retrieval on conversational and document questions, evidence is single-group preprints), memory layers (stored as files, so retrieval again), and learned or parametric memory (research only, no shipped product, weak at exact recall). The chunk, embed, top-k pipeline as the default is demoted; retrieval as a concept stays. For plangraph, whose data is authored typed rows with ids and links, similarity search is the wrong tool. Rulings: (1) no embeddings or vector index in 0.4.0 to 0.6.0; (2) rows stay one per line with stable keys so any agent can grep the JSONL; (3) MCP and CLI answers are terse and inline (results returned inline beat file pointers in the one controlled study); (4) an optional SQLite FTS5 search over free-text fields (title, summary) may be added behind a flag in 0.6.0, off by default, only if agents are measured missing rows they should find; (5) memory-layer interop is a documented read-only export, not a memory store; (6) revisit when a continual-learning model ships or independent per-query cost benchmarks exist. Added after reading the owner-supplied links (six of ten readable): (7) retrieve small, return the parent: a match on a ticket row returns its epic, sprint and dependency neighbours through graph edges (deterministic hierarchical return, no chunking); (8) a hard per-answer token budget test (moderate beats aggressive search in the one coding-agent retrieval benchmark cited; more context degrades answers), part of Task 7B; (9) a `dump everything` mode is allowed only when the whole graph fits a small cap, measured before it ships; (10) task-state memory (writable, authored rows, audited by git) stays separate from world facts and from derived LLM summaries, which are regenerable and never authoritative. After reading the five pages that were blocked earlier (fetched with a headless browser; one still only a free preview): (11) deterministic first: documented order is typed query, then grep over rows, then optional FTS, with semantic search only as a last resort; (12) a capped answer carries a `truncated N, narrow with --rel or --depth` line so the agent drills down instead of asking for more; (13) retrieval is evaluated separately from the answer: a golden-query set checks that the right row ids come back (precision, recall, MRR) and every answer names its row ids as provenance, part of Task 7B; (14) any derived lesson or summary carries its source row ids and a content hash and is invalidated when a source row changes (memory rot and silent overwrite are the documented failure); (15) policy-aware row visibility is not built; revisit only if multi-tenant use appears.


### 3.13 Market and obsolescence rulings (four surveys of 2026-11-25; sources partly unverified, none of the rulings depends on one)

Validated by the market: git-native agent-readable task graphs with typed dependencies, a `ready` query and atomic claims (Beads, Backlog.md, Taskmaster); MCP as the access layer; specs and plans as markdown in the repository. Crowded, do not build: plain task boards, per-agent worktree launchers, the spec-to-tasks-to-implement workflow, a generic Jira or Linear MCP wrapper (Beads already syncs both ways with Jira, Linear and GitHub). Genuine gaps no surveyed tool fills: a typed graph spanning people, sprints, epics, repos, specs and tickets; deterministic readiness verdicts with explanations; a solver with a safe reassignment what-if; capacity that models review hours; multi-repo planning; spec to code to ticket staleness checks.

Rulings:
1. MCP conformance (0.5.0 Task 12 grows): follow the 2026-07-28 revision while still answering older clients: per-request version and client info, optional `server/discover`, `ttlMs` and `cacheScope` on list and read results, deterministic tool order, `structuredContent` plus `outputSchema` plus a compact text mirror, `resource_link` for detail, tasks extension for long solver runs (0.6.0), no use of the deprecated roots, sampling or logging. Keep `initialize` only for clients that still send it. Tool count stays at 2 to 5 coarse tools, each with a `concise|detailed` response mode, results capped (about 4,000 characters by default), instructions inside the first 4,096 characters.
2. CLI first, a skill that teaches it, one small MCP second. Skills with side effects carry `disable-model-invocation: true`; read-only query skills stay model-invocable. The plugin manifest declares `engines`, `network.hosts` and `userConfig` (secrets marked sensitive); `claude plugin validate --strict` stays in CI; state lives in `${CLAUDE_PLUGIN_DATA}`.
3. Hooks are an extension point, not only a banner: later releases may inject a plan slice on `SubagentStart` and enforce readiness on `PreToolUse` (0.6.0 candidates, not 0.4.0 or 0.5.0).
4. Capacity unit: story points stop predicting delivery when agents write code; 0.6.0 designs review hours, rework rate and per-agent merge rate as capacity inputs. 0.4.0 `capacity.jsonl` keeps story points and may add optional `review_h`.
5. Format versioning and pinning stay mandatory (the format guard and `min_reader`): another tool changed its store architecture twice in a year and clients on different versions could not share it.
6. Do not assume plans live in the repository or that the tool coordinates agents: Claude Code agent-team tasks live in the user's home folder per session. The 0.6.0 claim and lease protocol (atomic claim, stale-claim detection, file or scope mutex) lives in the plan files and is compatible with those tasks.
7. 0.6.0 candidates in value order: review-capacity-aware forecasting and verdicts; conflict-aware parallel scheduling with a file or scope mutex in the solver and what-if; spec to code to ticket drift verdicts; import and export bridges to Beads, Backlog.md and OpenSpec and the Atlassian MCP rather than competing with them; the claim and lease protocol. Probabilistic forecasting stays optional (weak 2026 evidence).
8. Untrusted imported text (tickets, issues, PR titles) is never placed in a tool argument or shell command unchecked and never reaches the card; write and egress tools stay separate from tools that read imported text (the lethal-trifecta rule). Already the design of section 3.5.


### 3.14 Optimizations from research (replaces the earlier guardrail and scorecard idea; evidence in the two surveys of 2026-11-25, partly unverified)

Principle: reduce risk by design (a small core, a disposable index, fast checks), not by ceremony or long observation periods. Fossil and git-bug both keep the authored log canonical and the index rebuildable, which is already this design; the research adds the following.

Solver and what-if (measured facts about the current solver are in `docs/SOLVER.md`):
1. Trust fix, first and in 0.3.0 (task S1): OR-Tools 9.15.6755 has a reported defect where a run with a solution hint can report OPTIMAL above the true optimum (upstream issue 5582, fix only in the 10.0 release candidate, which regresses large neighborhood search, issue 5571, so no upgrade). Rule: never accept OPTIMAL from a hinted stage without an independent recomputation of that stage's objective from the output; hinted stages set `presolve_inclusion_work_limit=0`; a test replays a deliberately wrong hint and fails if the reported objective beats the proven bound. `sufficient_assumptions_for_infeasibility` is not trusted with presolve on (upstream issue 5141); infeasibility is explained by the existing relaxed-cost model plus deletion-based minimization.
2. What-if without the solver for the check: a move only affects the cone of its transitive descendants and the target person-sprint cell, so the check is propagation over those links (milliseconds). The solver is called only for a repair suggestion, with every ticket outside the cone fixed and a complete hint, and a stability objective (owner changes and sprint moves first). Task 11 of 0.5.0 builds the check on this; the repair suggestion is 0.5.0 Task 15.
3. Presolve cost: the 12 s rebuild per lexicographic stage is the dominant cost at the owner's size. 0.5.0 Task 16 measures, on a synthetic plan of that size, folding the stages into one weighted objective with exact dominance weights versus dropping the previous optimum as a hard constraint, and keeps whichever is faster without changing results (compared by `verify` and by objective values). Structured neighborhoods (one sprint window or the cone of a changed ticket) replace random ones if they win over 5 seeds. `--decompose` stays off (measured no better). A topological list-scheduling heuristic with a critical-path bound is measured against the solver's end sprint; if equal on the real shape it becomes the instant first answer and the solver the polish, and it is labelled an upper bound.
4. Determinism stays: one worker with deterministic time and no wall-clock cap; multi-worker runs are documented as possibly differing.

Validation without a long observation period:
5. Golden questions: 30 to 50 questions drawn from real failures of the tool (not invented), graded deterministically against SQL and the solver, with Wilson intervals; replaces the earlier large benchmark size and the scorecard. Part of Task 7B.
6. Differential tests: rules, `whatif` and the solver against a brute-force oracle on small random instances (new Task 7C replaces the dogfood scorecard); it proves encodings agree, not that semantics are right, so each rule also keeps its hand-written cases.
7. Backtesting (0.5.0 Task 16): expanding-window replay over the owner's completed sprints: plan with the data available before each sprint, compare predicted and actual sprint per ticket (hit rate), and report a Monte Carlo interval from historical item throughput next to the point plan. Cheap only because the Jira ingest already exports history; if an export is missing the task reports that instead of inventing data.

Data layout and merge:
8. One row per line, sorted by key, stable key order inside a row, hash or random ids for new rows (never counters), a `schema_version` per row and unknown fields preserved on rewrite; the keyed merge driver gets adversarial two-sided tests for every file kind (the closest tool shipped a buggy 3-way merge for months).
9. Fewer file kinds: `plantasks.jsonl` is dropped (plan tasks are derived nodes from `refs.plans`), `capacity.jsonl` stays, and a new file kind needs a stated rule that reads it (a node type or relation with no reader is info-only and costs zero tokens by default). The set after 0.4.0: people, sprints, epics, repos, capacity, links, xrefs.
10. Cross-worktree claims (0.6.0) use a local lock plus compare-and-swap on a ref, not git merges.

Performance (measure with hyperfine on `--version`, one query and `card`, cold and warm, on a synthetic 10^4 and 10^5 edge dataset):
11. Lazy imports of heavy modules in the CLI entry (the largest measured start-up win in comparable CLIs, about 3.5x on `--version` in one case) with the existing compile cache kept (about 13 to 25 percent); added to Task 11 of 0.3.0 and checked by a start-up size-ratio test, never a wall-clock limit.
12. Incremental index: per-file fingerprint, rebuild only changed files in one transaction, indexed edge endpoints, WAL with `synchronous=NORMAL` (the index is disposable). No precomputed closure until on-demand recursive queries fail a stated budget; no daemon, no CRDT layer, no database backend.

Answer shape: concise default and detailed opt-in, filter before return, short meaningful ids, byte-stable tool text and output prefix so prompt caching hits, and no reliance on tool-result clearing (clearing a little each step breaks the cache); answers stay valid if cleared.


### 3.15 Token strategy rulings (survey of 2026-11-25; official Claude Code documentation plus two independent studies; vendor claims not relied on)

Facts that bind the design: the prompt cache matches an exact prefix, so byte-stable output and an unchanged tool list matter more than raw size; plugin skills, hooks and commands never invalidate the cache and MCP tools are deferred by default; SessionStart hooks run again on `compact` and `resume`; hook and MCP output is capped (10,000 characters for hook context, 25,000 tokens for MCP output by default, larger results are spilled to a file); skill listings cut `description` plus `when_to_use` at 1,536 characters and re-attach each invoked skill after compaction up to 5,000 tokens, keeping the start of the file; the docs themselves say CLI tools beat MCP because they add no per-tool listing. Two independent paired studies found that a shell-output proxy that shrinks tool output by 60 to 90 percent did not lower session cost (median cost +2.4 to +7.6 percent at low effort, no change at high effort): smaller output is not cheaper if it changes the agent's next steps.

Rulings:
1. Keep CLI first, a skill that teaches it, one small deferred MCP. Never change the MCP tool list or definitions mid-session; keep every answer byte-stable (sorted keys, no timestamps, no random ids).
2. The SessionStart hook keeps matching `startup|resume|clear|compact|fork`, injects a fixed-size current line well under the cap, and states facts, not commands (a framing as system commands can trigger injection defenses).
3. Skill descriptions put the trigger first; the key instructions sit at the top of each skill body (compaction keeps only the first 5,000 tokens).
4. Companion detection (0.5.0): the hook checks the filesystem, settings and PATH for superpowers, openwolf and optional helpers (Context7 or Ref for library docs, an LSP or code-intelligence plugin or Serena for symbol lookup, `ccusage` for observability) and prints one line per companion that is present, nothing when absent; plangraph recommends them and never installs or bundles them. `dependencies` in `plugin.json` is never used for soft integration (it forces enablement).
5. No bundled output proxy and no claim of savings from output compression; no `terse` output style (independent tests show 12 to 23 percent of output tokens at best, and output is a small share of spend).
6. Measurement is cost per successful task with cache reads counted (paired A/B), not bytes saved: Task 7B's benchmark adds this metric next to answer correctness and tokens per answer.
7. A plugin cannot reliably ship session-wide permission allow rules: `docs/TEAM.md` and the README give the user the exact rules to add to their own settings (a Bash rule for `plangraph *` and the plugin-qualified MCP tool names `mcp__plugin_plangraph_<server>__<tool>`), and skills keep `allowed-tools` for the per-turn grant.
8. Optional later: a PostToolUse trim of plangraph's own oversized output and a PreToolUse cap on plangraph CLI calls, only if a measured case shows a gain.


## 4. Rulings on defects found in the graph plan

1. Rename: every `brain` command, `.brain`, `brain.sqlite`, `bin/brain-solve` and `brain-jsonl` in the graph plan reads as its plangraph name from the rename map of `2026-11-25-plangraph-0.3.0-revised.md` section 3. `.baseline/pre-040` is captured on the renamed 0.3.0 tree.
2. Person rename is not solved by 0.4.0: `person.id` equals the schedule owner string (D7). A rename stays a text edit in `schedule.jsonl` plus `people.jsonl`; no command promises more. The spec's claim is narrowed accordingly.
3. `capacity.jsonl` is a data file, not a node type; the plan and spec say so.
4. `openitem` is a node type and appears in `g_nodes`; `plangraph graph 'K|kind' --type openitem` works. (The old plan's exclusion is reversed.)
5. Spec section 4 is rewritten: nodes are keyed per file (sprints by `n`, open items by key and kind) and no file stores a `type` field.
6. `edges.kind` stays a free string; "closed set of relations" applies to `links.jsonl` and to extension grammar only.
7. Node ids get the charset and length rule above; `src/mcp.ts` key validation accepts the URI grammar.
8. `docs/CONTRACT.md` line 178 ("the eight text files") is updated in Task 2.
9. One work item must not be two scheduled tickets: `DOUBLE_PLACED_WORK` plus `sp-link --track`.
10. "Respecting blockers" in whatif: section 3.7.
11. Line references in the graph plan are pinned to 0.2.3; the first task re-checks every file and interface against the released 0.3.0 tree.

## 5. Plan task changes

| Task | Change |
|---|---|
| 0 (new, controller) | Re-quote the graph plan against the released 0.3.0 tree and the rename map; record rulings in the ledger. |
| 1 | Add the `xrefs.jsonl` and `repos.jsonl` schemas and merge keys, core type `repo`; open type and relation grammars (`CORE_NODE_TYPES`, extension regex); id rule; `GRAPH_SRC_FILES` 6 to 7; mixed-version fuzz including xrefs. |
| 1A (new) | `lib/graph/uri.ts` (`nodeUri`, `parseNodeUri`), pure, with a fuzz test for the encoding rules. |
| 2 | `xref` table; derived `plan` and `doc` nodes; `part_of`, `specified_by`, `tracked_by` in `g_links`; Python mirror; `docs/CONTRACT.md:178`. |
| 1B (new) | `plangraph repo scan` and `--check`, `repos.jsonl` writer, `part_of`/`owned_by`/`depends_on` derivation, manual `touches` |
| 3 | `XREF_DUPLICATE`, `XREF_MISSING_NODE`, `XREF_BAD_ID`, `DOUBLE_PLACED_WORK`; `ext ignored N` in doctor. |
| 4 | `REL_SEMANTICS`; `blockersOf` reads only gate and order relations (test); openitem in `g_nodes`. |
| 5 | `graph` KEY accepts `pg:` URIs; `--json` ids in URI form; xrefs printed fenced. |
| 6, 6A, 7 | Unchanged; Task 7's audit adds the forward-compatibility fixture (section 6). |
| 7B (new) | Format benchmark `evals/graph-format` (section 3.11); the default answer format is set from its result before 0.4.0 ships. |
| 7C (new) | Differential tests of rules, whatif and the solver against a brute-force oracle on small random instances (section 3.14 item 6). |
| 8 | Becomes `plangraph graph materialize` (no format bump) per D23. |
| 9 (0.5.0) | Provider seam, `jira`, `sp` and `generic` providers, `plangraph import --sys`, `obs` table, cache git-ignore. |
| 10 (0.5.0) | `lib/graph/drift.ts`, `plangraph sync --plan`. |
| 11 (0.5.0) | whatif gate and slot reasons and the `touches` line. |
| 12 (0.5.0) | MCP: `graph` tool, resource templates, URI key validation, bench bound. |
| 13 (0.5.0) | `sp-link --track`. |
| 14 (0.5.0) | GitHub provider (key in branch name or PR title), `touches` heuristic with `conf` and `why`, monorepo `paths`, `catalog-info.yaml` seed |
| 15 (0.5.0) | Whatif repair suggestion: cone-fixed solver call with a complete hint and a stability objective (section 3.14 item 2). |
| 16 (0.5.0) | Solver measurement and backtesting: stage folding vs dropped constraint, structured neighborhoods, heuristic bound, expanding-window replay and Monte Carlo interval (section 3.14 items 3 and 7). |

Decisions: D23 materialize instead of migrate (answer: materialize); D24 xref `sys` grammar and no account ids or emails committed (answer: as written); D25 MCP resources in 0.5.0 are templates and read only (answer: as written). Each dependent commit records `Decision Dn: <answer>`.

## 6. Risks and the tests that can fail

| Risk | Tests |
|---|---|
| Format churn | The frozen 0.4.0 tree builds a fixture with `x-github.pr` nodes, `x-github/closes` links and an unknown `sys` in xrefs: exit 0, v1 answers byte-identical. The merge driver of 0.3.0 and of 0.4.0 on a two-sided xref edit: one row on 0.4.0, a recorded limit on 0.3.0. A v1-only directory keeps `fresh.fp` and the card digest. `graph materialize` is idempotent and writes no v1 file. |
| Trust and injection | Hostile fuzz of every provider (newline, `</untrusted>`, bidi, `__proto__` keys, `../` xids, 2 MiB lines); `import` never changes the bytes of `edges`, `schedule`, `tickets`; the card contains no observation text; a `%2e%2e` or double-encoded URI is refused; an `x-` relation never changes `blockersOf` or `capacityFor` (property test); MCP `resources/read` of a non-grammar URI is an `isError` with a fixed message. |
| Token cost | The `touches` line at most 40 estimated tokens; `graph` default output under 250 tokens; `bench-mcp` bound on `tools/list`; `explain` unchanged. |
| Solver coupling | `xref` and `obs` tables accepted and mirrored by the Python `schema_ok`, never read by the solver; the solver input digest is the same with and without a cache; `verify` after the solver agrees with capacity rows present; whatif never accepts what verify rejects (extended to gate and slot). |
| Identity drift | `DOUBLE_PLACED_WORK` fixture; drift codes are byte-stable across re-imports of the same input. |
| Rename collision | Task 0 asserts the baseline was captured on the renamed tree. |

## 7. Order of work

After 0.3.0 is published: Task 0, then 1, 1A, 2, 3, 4, 5, 6, 6A, 7 (release 0.4.0, report), then 8 (materialize), 9 to 13 (release 0.5.0, report). 0.6.0 is planned separately after the owner reads the 0.5.0 report.
