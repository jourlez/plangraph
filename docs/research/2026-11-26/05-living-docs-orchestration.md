# Living docs and orchestration: research (2026-11-26)

Tags: [verified: URL] = fetched this session. [claimed/unverified] = from memory or search snippet only.

## A. Living documentation

### A1. Generated regions and drift
- terraform-docs "inject" mode (default) replaces only content between `<!-- BEGIN_TF_DOCS -->` and `<!-- END_TF_DOCS -->`. If the file is missing, it is created. If it exists with no markers, output is appended. "replace" mode overwrites the whole file, so manual edits are lost. Alternate comment syntax exists for hosts without HTML comments. [verified: https://terraform-docs.io/user-guide/configuration/output/]
- That page does not document a CI drift check. A `--output-check` flag exists in the tool, but this was not confirmed. [claimed/unverified]
- Generic drift-detection pattern: regenerate in CI and fail on `git diff`. Generators such as doctoc, cog and mdsf work this way. [claimed/unverified]
- Pattern for plangraph: generated region = pure function of graph state. A fingerprint (hash of the input subgraph + template version) is stored in the marker. "Stale" means the stored hash differs from the recomputed hash. This design is mine, not a sourced standard. [claimed/unverified]

### A2. Templates vs LLM prose
- Anthropic: prefer workflows (predefined code paths) for predictability. Use LLM agents only where flexibility is needed. Start simple. [verified: https://www.anthropic.com/engineering/building-effective-agents, 2024-12-19]
- Implication: deterministic templates for facts (tables, status, links, counts). LLM prose only in separate, marked "narrative" blocks. Narrative blocks are cached by input fingerprint and regenerated only when the fingerprint changes.
- ADR format. MADR files are `NNNN-title-with-dashes.md`, with optional front matter `status`, `date`, `decision-makers`, `consulted`, `informed`. Status values: proposed, rejected, accepted, deprecated, "superseded by ADR-NNNN". [verified: https://adr.github.io/madr/] ADRs suit graph-derived indexes plus human-written bodies.

### A3. Publishing targets and not clobbering human edits
- Google Docs API: `batchUpdate` with `writeMode: SUGGEST` creates suggestions rather than direct edits. Some request types cannot be suggested (e.g. AddDocumentTab, DeleteTab, document format, header/footer settings). [verified: https://developers.google.com/workspace/docs/api/how-tos/suggestions]
- Google Docs reads: `suggestionsViewMode` changes indexes, so fetch in the mode you will edit against. A `batchUpdate` is atomic: one invalid request fails the whole batch. Named ranges are keyed by name and output-only on the document. [verified: https://developers.google.com/docs/api/how-tos/suggestions (search snippet summary)]
- Notion: append-children endpoint adds blocks (max 100 per request). Existing blocks cannot be moved with it. Blocks carry `last_edited_time` and `last_edited_by`. The page does not describe optimistic locking. [verified: https://developers.notion.com/reference/patch-block-children]
- Confluence Cloud v1 update requires an incremented `version.number`, and a stale version gives a 409. The pages fetched did not state this. [claimed/unverified]. Confluence v2 page update is `PUT /pages/{id}`. [verified: https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-page/ (operation listed only; version rule not shown)]
- Claude Docs connector and Artifacts. Docs are editable, shared, comment-capable, and can be created with batch ops. Artifacts suit read-only rendering. [verified: tool descriptions in this session; no external URL]
- Strategies, strongest to weakest:
  1. Protected/marker regions, as terraform-docs inject does. Only the region is rewritten.
  2. Suggestion mode (Google Docs SUGGEST) or comments, so a human accepts changes.
  3. Three-way merge: base = last generated text, ours = new generation, theirs = current published text. Needs the last-published text stored locally. Standard git practice. [claimed/unverified]
  4. Whole-file replace, only for fully generated files marked "do not edit".
- Remote targets are weaker than repo Markdown. Notion has no documented lock, and Confluence/Docs need version or revision checks. Publish remote copies as one-way mirrors with a source link back to the repo file.

### A4. Provenance markers
No standard found. Proposed: per region, `source graph hash`, `generator + template version`, `generated-at`, and `reviewed-by`/`reviewed-at` (human). Prose blocks also carry model ID and an "unreviewed" flag. [claimed/unverified]

## B. Orchestration from one document

### B1. Anthropic guidance
- Long-running harness (published 2025-11-26). Handoff artifacts: a progress file, a JSON feature list with a `passes` field, git history, and `init.sh`. An initializer session creates them. Coding sessions do one feature at a time, test end to end, commit, and update progress. All features start failing. Agents may change only `passes`. JSON was chosen over Markdown because models are less likely to alter it inappropriately. Startup routine: read git log, progress file, feature list, then pick the top unfinished feature. [verified: https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents]
- Multi-agent research (2025-06-13). Lead agent saves its plan to memory because context truncates past 200k tokens. Subagents write outputs to external storage and pass lightweight references back. The system resumes from the failure point, with retries and checkpoints. [verified: https://www.anthropic.com/engineering/multi-agent-research-system]
- Effective agents (2024-12-19). Orchestrator-workers: subtasks are determined at runtime from the input. Agents should check ground truth from the environment each step, pause at checkpoints, and have stopping conditions. [verified: https://www.anthropic.com/engineering/building-effective-agents]

### B2. Superpowers workflow (current main branch, fetched 2026-11-26)
- writing-plans: plan saved at `docs/superpowers/plans/YYYY-MM-DD-<feature>.md`. Header: goal, architecture, tech stack, Spec path, Global Constraints, Review Focus. Each task lists Files (create/modify/test) and Interfaces (Consumes/Produces). Steps are `- [ ]` checkboxes, one action each. Self-review checks coverage against the spec. [verified: https://raw.githubusercontent.com/obra/superpowers/main/skills/writing-plans/SKILL.md]
- subagent-driven-development: fresh implementer per task, then spec-compliance and quality review, with a fix loop and round cap. Implementer statuses: DONE, DONE_WITH_CONCERNS, NEEDS_CONTEXT, BLOCKED. A git-ignored workspace holds a progress ledger, briefs, reports and review packages. The ledger, not todos, is the source of truth after compaction. Todos are pending, in progress, complete. [verified: https://raw.githubusercontent.com/obra/superpowers/main/skills/subagent-driven-development/SKILL.md]
- Gap for plangraph: checkbox state in plan files is the only durable per-step status. Ledger files are ephemeral (deleted at the end). There is no link from tasks to tracker tickets or PRs.

### B3. Workflow engine concepts (only what informs a file graph)
- Temporal: Event History is an append-only, durable log, and doubles as an audit log. [verified: https://docs.temporal.io/workflow-execution/event] Replay mechanics were not on that page. State derived from an append-only log is the takeaway. [claimed/unverified]
- Airflow task states: none, scheduled, queued, running, success, restarting, failed, skipped, upstream_failed, up_for_retry, up_for_reschedule, deferred, awaiting_input, removed. Default trigger rule is all_success. none_failed tolerates skipped upstreams. [verified: https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/tasks.html]
- Useful ideas: separate "blocked by upstream failure" from "failed", a distinct "skipped", a "waiting on human" state, and a "removed from the plan" state.
- GitHub: closing keywords (`closes #N`) in a PR description or commit close the issue only when merged into the default branch. A PR links up to 10 issues. Linking can move an issue to "In progress" or "In review". [verified: https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue]

### B4. Requirements practice
- EARS (Mavin et al., Rolls-Royce, first published 2009). Patterns: ubiquitous, state-driven (While), event-driven (When), optional (Where), unwanted (If/Then), complex. All use "the <system> shall <response>". [verified: https://alistairmavin.com/ears/]
- Gherkin: Feature, Rule (since Gherkin 6), Scenario/Example, Given/When/Then. 3-5 steps per scenario is recommended. Then checks observable output. [verified: https://cucumber.io/docs/gherkin/reference/]
- ISO/IEC/IEEE 29148:2018 has clauses on characteristics of individual requirements and of requirement sets. The full text is paywalled, and only the table of contents was seen. [verified: https://webstore.ansi.org/preview-pages/ISO/preview_ISO+IEC+IEEE+29148-2011.pdf (2011 ed. preview; the 2018 contents list came from a search summary)]. Traits commonly listed: necessary, unambiguous, complete, consistent, verifiable, feasible, traceable. [claimed/unverified]
- Bidirectional traceability: links must be followable in both directions. It ensures every requirement traces up to a parent and down to design/code/test, and guards against unjustified functionality. [verified: https://swehb.nasa.gov/x/7QL7 (via search summary; NASA attributes the definition to ISO/IEC/IEEE 24765)]
- RTM = requirement -> plan task -> ticket -> branch/PR -> test -> status. It is best derived from graph edges, not kept as a hand-edited table. [claimed/unverified]

### B5. Plan-task node states (proposal; my synthesis)
States: `proposed` -> `ready` (all deps done) -> `claimed` (owner/agent assigned) -> `in_progress` -> `in_review` (PR open) -> `done` (merged + verification passed).
Side states: `blocked` (upstream not done, or external), `needs_input` (human decision), `failed` (retry or escalate), `skipped` (explicit, with reason), `cancelled`/`removed` (dropped from the plan, kept in history).
Rules:
- `ready` and `blocked` should be computed from dependency edges, not stored. Only human/agent-asserted facts are stored.
- A task is `done` only with evidence: merged PR, test result, or commit range. Mirror the harness rule that only the pass flag changes.
- Each transition is an append-only event: who, when, evidence, source (plan file, tracker, git).

### B6. Reconciling plan state with tracker state
- Assign ownership per field. Plan owns scope, deps and acceptance. Tracker owns assignee, workflow status and comments. Git/PR host owns branch and merge facts.
- Reconcile by observation: read tracker and git, compute a diff against the graph, and report drift. Propose changes; do not auto-write both ways. Tracker status names map through a configurable table (tracker "In Review" -> `in_review`).
- Stable IDs: the ticket key and the PR link are stored on the node. Closing keywords in PR text give the PR-to-issue link. Merge to the default branch is the trigger for `done`.
- Conflicts (plan says done, tracker open) become a flagged finding, not a silent overwrite.

## Implications for a project-graph plugin
1. Keep the graph (JSON, deterministic key order) as the single source of truth. All docs are derived views.
2. Generate docs with marker-delimited regions (terraform-docs inject style). Use whole-file replace only for files marked fully generated.
3. Store a fingerprint (input subgraph hash + template version) per region. `check` command = regenerate and compare, for CI drift detection.
4. Facts come from templates. LLM prose lives in separate marked blocks, cached by fingerprint, flagged "unreviewed" until a human signs off.
5. Record provenance per region: source hash, generator version, time, reviewer. Keep the last-published text locally so a three-way merge is possible.
6. Repo Markdown is the primary target. Remote targets (Confluence, Notion, Google Docs, Claude Docs) are one-way mirrors that use suggestion/comment mode where available and check version or revision before writing.
7. Model tasks with a small state machine (proposed, ready, claimed, in_progress, in_review, done, plus blocked, needs_input, failed, skipped, removed). Compute ready/blocked from edges.
8. Make `done` require evidence (merged PR, test result). Keep status changes in an append-only event log, like Temporal history, with a ledger that survives compaction.
9. Capture requirements in EARS with Gherkin acceptance criteria. Link requirement -> task -> ticket -> PR -> test as typed edges, so the RTM is a query and orphans are findings.
10. Reconcile with trackers by observe-and-diff with per-field ownership and a status mapping table. Surface conflicts for the human. Never write both directions silently.
