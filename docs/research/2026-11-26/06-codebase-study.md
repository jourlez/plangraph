# plangraph 0.5.0 codebase study (read-only, 2026-11-26)

Paths are relative to the repository root. "not found" = grepped, absent.

## 1. Architecture in one paragraph
Text JSONL in `.plangraph/` (or `.plangraphrc` dir, README.md:455) is truth; SQLite `plangraph.sqlite` is a rebuildable index (docs/FORMAT.md:3). Index tables come from `DEFS` (src/db.ts:51-66): ticket, schedule, edge, evidence, finding, meta, learning, ref (v1, `V1_TABLE_COUNT=8`, db.ts:67) then person, sprint, epic, repo, capacity, link, xref, obs. Every table has a nullable `extra` column for unknown fields (db.ts:~93, FORMAT.md:12). Index is stamped with a sha256 source fingerprint (db.ts:201-211); stale index opens query-only (db.ts:453). Graph = two SQL views `g_nodes`, `g_links` (lib/graph/views.ts:~44-70) plus `graphReader` (open items added in TS because open-items.jsonl is not indexed, views.ts:9-10).

## 2. Node types (lib/graph/files.ts:17 CORE_NODE_TYPES; extension regex :20)
| type | stored in | semantics |
|---|---|---|
| ticket | tickets.jsonl (key) store.ts:46 | unit of work; Jira key or `sp:<slug>[/<id>]` (FORMAT.md:85) |
| person | people.jsonl or implied by schedule.owner (views.ts g_nodes) | id = owner string, no rename support |
| sprint | sprints.jsonl `n`, or schedule.sprint | endpoint `S<n>` |
| epic | epics.jsonl or ticket.epic | grouping |
| plantask | derived from refs.plans `<plan>#<task>` | views.ts g_nodes; no file |
| plan | derived from refs.plans | no file |
| doc | derived: epic row `refs.files` of an `sp:<slug>` key (the plan `**Spec:**` line) | only specified_by target |
| openitem | open-items.jsonl, `<key>\|<kind>` | gate (blocks) |
| repo | repos.jsonl (+ `<repo>#<sub>` from `paths`) | scanned by `repo scan` |
| x-<sys>.<kind> | nowhere committed; cache `obs` + xref-derived `x-<sys>.ref` | opaque; no rule reads it (FORMAT.md:107) |
No `team`, `requirement`, `artifact`, `commit`, `pr`, `milestone` node exists (not found).

## 3. Relations (files.ts:25-45; REL_SEMANTICS :35-41)
| rel | home file | semantic class |
|---|---|---|
| needs | edges.jsonl (kind plan_need / sp_needs) | order (blockers, verify, solver) |
| assigned_to / scheduled_in | schedule.jsonl (per `version`) | load / slot |
| belongs_to | tickets.epic | group |
| held_by | open-items.jsonl | gate |
| implements | refs.plans (plantask -> ticket) | trace |
| part_of | refs.plans (task->plan) / repos.paths | trace |
| specified_by | epic refs.files (plan -> doc) | trace |
| tracked_by | xrefs.jsonl (ticket -> `sys:xid`) | identity |
| owned_by | repos.owners | info |
| relates_to, depends_on, touches | links.jsonl (only stored rels) | info / trace |
| x-<sys>/<rel> | links.jsonl or obs.links | info; never read by a rule |
Derived rels in links.jsonl = `LINK_DERIVED_REL` error (FORMAT.md:107). Only order/load/slot/gate affect verdicts (lib/graph/blockers.ts:1-5). So any new relation we add is inert unless a rule is coded.

## 4. Files and merge keys (store.ts:45-67, FORMAT.md:14-31)
Keys: tickets `key`; edges consumer+producer; schedule version+key; findings key+kind+text; refs `key` (plans = set); open-items key+kind; people/epics/repos `id`; sprints `n`; capacity person+sprint; xrefs type+id+sys+xid; links = whole record (set); unknown `*.jsonl` = set (FALLBACK store.ts:68). Rows may carry `schema_version`; unknown fields preserved. A new file kind needs: SCHEMAS entry, DEFS row, validator (lib/schema.ts), `GRAPH_FILES`/fingerprint handling, and merge key; an unknown `*.jsonl` is already merged safely as a set by `plangraph-merge` (FORMAT.md:24,65).

## 5. State: stored vs derived
- Stored (committed): the 8 v1 files + 7 graph files + config.json + format.json. Stored (uncommitted, git-ignored, mode 0600): `cache/<sys>.jsonl` observations (FORMAT.md:116). `plangraph.sqlite` index (ignored).
- Derived, never stored: plan and plantask nodes; doc node; epic/person/sprint nodes unless materialized (`graph-materialize`, graph.ts:57-80, idempotent, bare rows only); all derived relations; verdicts of `ready`/`verify`/`check`; blockers (blockers.ts); card (render.ts:83); drift findings (drift.ts); touches line (whatif.ts:772); report (lib/report.ts).
- Stored but really an agent judgement: `tickets.verdict`, `evidence.jsonl`, `findings.jsonl` (audit output via `units`/`bundle`, audit.ts:212-213).
- Progress: `jira_status` (tracker) vs `impl_status` (superpowers ledger only; never from checkboxes, FORMAT.md:84).

## 6. Exact chain today: superpowers plan -> plan node -> ticket -> person -> repo
1. `plangraph sp-ingest PLAN [--ledger] [--owner N --sprint S]` (integrations.ts:99-135) calls `parsePlan` (lib/integrations/superpowers.ts:194) then `ingestPlan` (:468).
2. Plan header parsed: title, goal, architecture, techStack, spec only (`PlanHeader`, superpowers.ts:20). No assignee, ticket, repo or owner field is parsed (grep Assignee/Owner/Ticket: not found).
3. Output (superpowers.ts:493-560): epic ticket `sp:<slug>` (sp=0) and `sp:<slug>/<id>` per `### Task`; `sp_needs` edges from Consumes/Produces; findings `sp_constraint`/`sp_review_focus` (plan) and `sp_ruling/parked/deferred` (ledger); refs row per task `plans:[{plan,task}]`, `files` from task Files lines; epic ref `files` holds the spec path. `impl_status` only from a ledger (:503).
4. Plan node: derived by the g_nodes view from refs.plans (views.ts PE CTE). plantask `implements` the ticket.
5. Ticket -> person: ONLY via `--owner NAME --sprint N`, which adds schedule rows for tasks lacking one (superpowers.ts:562-570). One owner for every task of the plan; no per-task owner; the plan itself has no assignee. Person node exists only if materialized or implied by schedule.
6. Ticket -> Jira: `sp-link sp:SLUG/N --track ABC-123` writes one xref row `{type:ticket,id,sys:jira,xid}` (integrations.ts:143-162). One-to-one enforced. Manual, per task; no bulk or auto-match. Reverse `sp-link TICKET PLAN --tasks` points an existing (Jira) ticket at plan tasks via refs.plans (integrations.ts:165-190).
7. Ticket/plan -> repo: BREAKS HERE. No command writes a ticket->repo link. `touches` rows in links.jsonl must be hand-written (files.ts:25). `touchesFor()` (lib/graph/touches.ts:42) and `parseCatalogInfo` (catalog.ts:11) have no caller in src/ or lib/ (grep: not found); the 0.5.0 audit admits it (docs/audit/0.5.0-audit.md "Task 14"). Task `files` in refs are path strings, never matched to `repos.paths`. GitHub provider reads a saved file only and links PR/branch to a Jira key (github.ts:1-8), not to sp tickets.
8. Person -> repo: `repos.owners` from CODEOWNERS during `repo scan` (repo.ts, only ids already in people.jsonl). Reverse walk possible with `graph --reverse`.
9. Assignee live data: only via `import --sys jira` observation `assignee` (provider.ts jira block), compared with schedule in `sync --plan` (DRIFT_ASSIGNEE). It never writes the plan.
Break points: (a) assignee not a plan field, (b) ticket link manual per task, (c) repo link missing, (d) `sp` provider ticket observations are advisory and not tied to xrefs.

## 7. Commands (src/commands/index.ts; groups)
queries: ticket neighbors chain sprint person blockers findings rules check verify ready card. plan: whatif schedule-load export build init migrate doctor. audit: stale refs-update units bundle jira-pull jira-text jira-import. openitems: open-items. analysis: forecast simulate. integrations: integrations sp-ingest sp-link learn. report: report. explain. migrate-names. repo: repo scan. graph: graph graph-materialize. import. sync.
Writers: init, build, export, schedule-load, whatif --apply-plan --write, sp-ingest, sp-link, learn, open-items, refs-update, repo scan, graph-materialize, import (cache only), report, units/jira-* (files), migrate, card --write.
Missing commands for the goals: nothing for git-history ingest, requirements ingest, task creation/edit, link/xref/touches add, doc generation beyond report.

## 8. Documents/artifacts generated today
Only `plangraph report` -> `report.md` + `report.html` (src/commands/report.ts:~40-52; lib/report.ts; deterministic; sprint load, can-start, blockers, chain, optional forecast and stale count). `card --write` -> CARD.md (queries.ts:430). `units --out`/`bundle` -> audit tickets text for subagents. `export` = canonical JSONL, not a document. Publishing (Artifact, Slack) is left to the `plangraph:report` skill (report.ts header). No requirements doc, ADR, changelog, roadmap, per-epic page generation; no regeneration trigger. `autopilot` skill (disable-model-invocation: true, SKILL.md:1-12) writes `docs/roadmap/ASSUMPTIONS.md` etc. by LLM instruction, not by plangraph code.

## 9. Providers (lib/graph/provider.ts) and extension points
Built-in frozen map: jira, sp, generic, github (provider.ts end). Interface `GraphProvider {sys, schema:1, input json|text, validXid, normalize(input,{tenant,now,prev})}` (:20-27). Pure; no I/O; nothing loads dynamically ("nothing loads dynamically", provider.ts bottom). Limits: 50,000 observations, 8 MiB (:30-31), 40 fields, 100 links, 200-char strings (obs.ts:7-8); fields are scalars only; generic batch can only use its own `x-<name>` sys and types (provider.ts generic); cache file list fixed in `CACHE_FILES` (obs.ts:12) so a new built-in provider needs a code edit in 3 places (PROVIDERS, CACHE_FILES, import usage). Observations are read by `sync` only, by no rule and no solver (FORMAT.md:116). `x-` types/relations/xrefs sys are accepted but inert. Committed xref `xid` forbids URLs, emails, account ids (D24, files.ts:XID_RE).

## 10. Automation today (hooks, MCP, skills)
- hooks/hooks.json: ONE hook, SessionStart `startup|resume|clear|compact|fork`, `node src/entry.js card --if-present --heal`, timeout 10 s. No PostToolUse, Stop, PreCompact, UserPromptSubmit, git hook (hooks.json:1-12). `--heal` repairs the merge driver (queries.ts:337-339,413).
- Card text (lib/render.ts:83-113): `plangraph <fp8> | N tickets, N links, S<a>-S<b>, N people`, verdicts (top 5), over cap (top 3), findings (top 3), steer line `plan questions: use plangraph (...); do not read .plangraph/*.jsonl`, `STALE` tail. Budget `CARD_BUDGET=250` est tokens (ceil chars/4, render.ts:14,18); bench measures 553 bytes / 139 est tok (docs/TOKENS.md:75; unverified tokenizer, :30). No index yet -> one fixed nudge line "plan data found ... run plangraph build" (queries.ts:405). Off with plugin option `card=off` or `PLANGRAPH_CARD=off` (queries.ts:416; plugin.json userConfig). The card never contains external text.
- It never rebuilds the index, never syncs, never ingests plans. Everything else needs a human or an agent-run command.
- MCP (src/mcp.ts:1): hand-written JSON-RPC, read-only: tools `ready`, `whatif` (dry run), `ticket`, `graph` (mcp.ts:50-57); resource templates `plangraph://node/{type}/{id}`, `plangraph://graph/{type}/{id}{?rel,depth}` (mcp.ts:116-117); `resources/list` empty; tools list capped at 2,600 bytes (docs/MCP.md). OFF by default; file is `mcp/plangraph-mcp.ts`, not in plugin.json. No write tool; no outputSchema (audit Known gaps).
- Skills (8): plangraph (router), onboard, plan, report, whatif, audit, init, autopilot (skills/*/SKILL.md, 5,760 words total). `allowed-tools` pre-approve read-only `Bash(plangraph ...)` only; writers such as build, sp-ingest need approval (INTEGRATIONS.md "Router skills"). onboard = steps: integrations, doctor, jira-import/pull, sp-ingest per plan in docs/superpowers/plans, rules --repo, build, check, report gaps, card --write (skills/onboard/SKILL.md:8-20). No git-history step. plan skill = brainstorming then ingest (SKILL.md plan; not read in full).

## 11. Config keys
config.json (README.md:432-448): first_sprint, end_sprint, caps, min_per_sprint, minimize_load_of, default_ref, brain_rules_version, closed_statuses, frozen_statuses, frozen_before_sprint, ignore_link_kinds, time_limit_seconds, workers, stage_order, ref_heading, jira{cloud_id,jql,auth.mode,base_url,sprint_field,tenant}, owner_of_decisions, open_items, regime_changes, graph.stale_days (sync.ts:~22; not in the README table). Config is committed and untrusted: cannot run a command (README:451). `.plangraphrc`: `{"dir": ...}` only. Env: PLANGRAPH_DIR, PLANGRAPH_CARD, CLAUDE_PLUGIN_OPTION_CARD. PlanConfig is an open index signature (model.ts:34), so new keys are free.

## 12. Per-goal gap analysis
(a) Take over an existing project, whole history.
 Exists: `onboard` skill; `jira-pull` snapshot; `import --sys jira|github|sp`; sp-ingest of saved plans; `repo scan`; `history.jsonl`/`actuals.jsonl` for forecast only (forecast.ts:84-105).
 Missing: any git-log/commit/PR/release reader (grep `git log`: not found in lib/src); commit/PR/decision/requirement nodes; mapping history to tickets (only a branch/PR title key hint, github.ts); bulk ingestion with size caps (obs limit 50k, 8 MiB per file); incremental "since last" checkpoint; a place to keep history that is committed (cache is uncommitted; only ticket/xref/links are committed and must hold no ids/emails). Tension: D24 forbids committing authors and URLs.
(b) Single requirements doc to end-to-end orchestration.
 Exists: plan skill advises superpowers brainstorming/writing-plans then sp-ingest, solve, verify (skills/plan). `autopilot` skill is spec to roadmap to Jira by LLM prose.
 Missing: requirement node/file; spec -> epics -> tasks decomposition code; any orchestrator or state machine (phase state, "what is next" command), task dispatch, completion detection; `satisfies` relation (proposed only in final-1.0-plan P3). `sp` ingest only handles `### Task` plans, spec only as a path string (superpowers.ts:20). Solver is Python/OR-Tools (bin/plangraph-solve) and independent.
(c) Artifact/document generation kept live.
 Exists: deterministic `report` (md+html) and `card --write`; `stale`/fingerprints for verdict inputs (lib/stale.ts); fingerprint in index_meta usable as change signal.
 Missing: generator registry/templates for other docs; any trigger (no PostToolUse/Stop/git hook); incremental index (full rebuild each time, db.ts:302); dirty-detection per document; a `docs` node binding generated file to its graph source (`doc` node is derived from spec path only); no write-back of edits to docs. Hook runtime limit 10 s (hooks.json) constrains in-hook builds.
(d) Link plan node with assignee, ticket and repo.
 See section 6. Missing: plan-header or task-level fields (Assignee/Ticket/Repo) in parsePlan; auto `tracked_by`; auto `touches`; a command to add links/xrefs (hand edit of links.jsonl/xrefs.jsonl only, except sp-link --track); person identity map (planned UNMAPPED_ASSIGNEE, final-1.0-plan P1.2); writer for `touches` (planned: `repo link`, P1.4). Plan nodes are derived, so any plan-level attribute must live as a link/xref/ref on a key, not on the node.
(e) Automatic use by Claude Code, low tokens.
 Exists: SessionStart card (<=250 est tok; 139 measured), steer line, router skill, token-bounded CLI answers (graph ~900 chars, graph.ts:19; touches line 40 tokens, whatif.ts:765), optional MCP. 
 Missing: per-task `context` digest (planned P2.1, not built: grep `context` command not found); auto build/refresh (card only nudges); hooks on PostToolUse/Stop to update plan state; write tools in MCP; MCP not default-on; `allowed-tools` for writers; branch-to-ticket detection; real tokenizer calibration (TOKENS.md:30, unverified); skill-description always-on cost not measured in this study (not found).

## 13. Design constraints that could block the goals
1. FORMAT_VERSION=1, MIN_FORMAT=1 (store.ts:10-11). Additive files and fields need no bump; a new node kind with committed semantics read by rules would justify `min_reader` raise, which makes 0.3.0/0.4.0 tools refuse the directory (FORMAT.md:42). The 1.0 plan reserves the first bump for 1.0.0 (amendment 3.9) and leaves it as open Decision 1 (final-1.0-plan "Decisions").
2. 0.3.0 reader compatibility: 0.3.0 cannot read node files (final-1.0-plan P5.3) and merges unknown graph files as record sets, producing duplicate keys (FORMAT.md:112). Any new keyed file has the same hazard for older drivers. Cache is exempt (uncommitted).
3. Merge keys fixed per file (store.ts:45-67). New committed history data should be a keyed or set file; unknown `*.jsonl` falls back to whole-record sets, which cannot express "edit".
4. Privacy rule D24: no URL, host, account id, email in committed files (files.ts XID_RE; FORMAT.md:110). History import (authors, PR URLs) and assignee identity must go through aliases or stay in cache.
5. Derived-only nodes (plan, plantask, doc) have no attribute storage; `plantasks.jsonl` was deliberately dropped (FORMAT.md:94; amendment 3.14 item 9). New attributes need a rule that reads them or they stay info-only.
6. Inert extension grammar: x- types/relations are never read by blockers/solver/verify (files.ts REL_SEMANTICS; FORMAT.md:107). An orchestrator needing readiness over requirements would need core relations (code change in blockers.ts, verify, db views whose SQL must be byte-equal, views.ts:3-4, plus a Python mirror in bin/plangraph-solve).
7. Writers are narrow and guarded: write targets prechecked (symlink/outside repo refused, shared.ts precheckTargets), commands declare `writes` class in the registry, MCP is read-only by decision D25 and the lethal-trifecta rule (amendment 3.14 ruling 8). Automatic writes by hooks conflict with that stance and with the 10 s hook timeout.
8. Providers are pure and built-in only; no dynamic loading; fixed CACHE_FILES list (obs.ts:12). External fetch is out of scope in 0.5.0 (audit Known gaps); final plan's "Out of scope: writing to any tracker".
9. Ingest idempotence rules: sp-ingest refuses renumbered tasks (superpowers.ts:481-487), ownership by `sp:<slug>` prefix (FORMAT.md:89), `sp:` keys max 76 chars. A requirements-driven generator must use a new key namespace or it collides with this ownership model.
10. Index is rebuilt in full, with a fingerprint over all files (db.ts:201); large history in committed files raises build time (no incremental build; amendment 3.14 item 12 planned only).

## 14. Already planned (docs/superpowers/plans/2026-11-26-final-1.0-plan.md, a proposal, untracked in git)
P1 live `sync` fetch + identity alias map + actionable drift + `touches` writer; P2 `context` digest, SessionStart digest, MCP outputSchema; P3 `map`, `team` + `requirement` nodes with `satisfies`; P4 verify parity (BLOCKED, SPRINT_CLOSED not enforced by verify today, audit "Known gaps"); P5 init auto-detect. Not covered by that plan: history ingestion (a), orchestration from a requirements doc (b), generated documents beyond report (c), plan-node assignee/ticket auto-link (d) beyond the `touches` writer, automatic hooks beyond SessionStart (e).
