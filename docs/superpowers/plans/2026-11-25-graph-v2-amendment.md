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
| 0.6.0 (follow-up, owner decides after 0.5.0) | write side: `sync --write` for plan-side edits, push lists, GitHub and CI providers, MCP subscriptions, capacity rows in the solver and verify, atomic claim, graph.json and HTML export | 1 |
| 1.0.0 | contract: format 2 (drop `v2_owner`, `v2_sprint`, `first_verdict`) | 2 |

Every file shape and grammar the later releases need ships in 0.4.0, so no later release changes the format and 0.3.0 and 0.4.0 tools never reject a directory only because it holds a newer additive row.

## 3. Design

### 3.1 Node identity

- Storage is unchanged: raw ids are unique per type; a node is `(type, id)`.
- External form (command arguments, `--json`, MCP): `pg:<type>/<pct(id)>`, with percent-encoding of `%`, `/`, `#`, `|`, `?`, space, controls and non-ASCII (UTF-8). Decoding is single pass; a decoded value that does not re-encode to the input is refused (no double encoding). Examples: `pg:ticket/ABC-123`, `pg:person/Ana%20Silva`, `pg:sprint/S3`, `pg:plantask/docs%2Fp.md%23Task%203`. The scheme name `pg` stays (a short stable prefix, not a product name in a path).
- Id rules for new rows: at most 200 characters, no C0 or C1 controls, bidirectional or line-break characters. Old values outside the rules are a warning, never an error.
- Type grammar: core `ticket person sprint epic plantask openitem plan doc` plus extension types `x-<sys>.<kind>` (`[a-z][a-z0-9-]{0,23}` each part). `plan` and `doc` ids are repo paths and are derived from `refs.plans[].plan` and `refs.files`; derived relations `part_of` (plantask to plan) and `specified_by` (plan to doc). An extension type is opaque: reachable only through `relates_to` and extension relations, never read by blockers, capacity, the solver or verify.
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
| 1 | Add the `xrefs.jsonl` schema and merge key; open type and relation grammars (`CORE_NODE_TYPES`, extension regex); id rule; `GRAPH_SRC_FILES` 6 to 7; mixed-version fuzz including xrefs. |
| 1A (new) | `lib/graph/uri.ts` (`nodeUri`, `parseNodeUri`), pure, with a fuzz test for the encoding rules. |
| 2 | `xref` table; derived `plan` and `doc` nodes; `part_of`, `specified_by`, `tracked_by` in `g_links`; Python mirror; `docs/CONTRACT.md:178`. |
| 3 | `XREF_DUPLICATE`, `XREF_MISSING_NODE`, `XREF_BAD_ID`, `DOUBLE_PLACED_WORK`; `ext ignored N` in doctor. |
| 4 | `REL_SEMANTICS`; `blockersOf` reads only gate and order relations (test); openitem in `g_nodes`. |
| 5 | `graph` KEY accepts `pg:` URIs; `--json` ids in URI form; xrefs printed fenced. |
| 6, 6A, 7 | Unchanged; Task 7's audit adds the forward-compatibility fixture (section 6). |
| 8 | Becomes `plangraph graph materialize` (no format bump) per D23. |
| 9 (0.5.0) | Provider seam, `jira`, `sp` and `generic` providers, `plangraph import --sys`, `obs` table, cache git-ignore. |
| 10 (0.5.0) | `lib/graph/drift.ts`, `plangraph sync --plan`. |
| 11 (0.5.0) | whatif gate and slot reasons and the `touches` line. |
| 12 (0.5.0) | MCP: `graph` tool, resource templates, URI key validation, bench bound. |
| 13 (0.5.0) | `sp-link --track`. |

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
