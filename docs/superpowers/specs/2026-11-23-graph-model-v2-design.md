> Historical document: written before the 0.3.0 rename to plangraph. It names the tool, its commands, files and variables as they were called then (`brain`, `.brain/`, `BRAIN_*`); the text is unchanged.

# Plan graph model v2: design

Date: 2026-11-23. Status: draft for the owner's review. Executes after the TypeScript migration and the tracker-provider work, because the typed code base makes a model change safe and the differential baseline guards compatibility.

## 1. Purpose

The plugin is called plangraph, but its data model is a graph only in part. Tickets and their `needs` dependencies are a graph. People, sprints, epics, plan tasks and blockers are strings, integers, JSON blobs or computed values, so a question that crosses them ("everything this person owns that waits on this plan task", "what changes if this sprint loses capacity") needs new code each time. This design makes those things first-class and keeps every existing command's output unchanged.

## 2. What exists today (data format v1)

- `tickets.jsonl`: key, summary, epic (string), sp, jira_status, `v2_owner`, `v2_sprint`, verdict, verdict_source, `first_verdict`.
- `edges.jsonl`: consumer, producer, kind (a free string).
- `schedule.jsonl`: version, key, sprint (integer), owner (string).
- `evidence.jsonl`, `findings.jsonl`, `open-items.jsonl`, `learnings.jsonl`, `meta.jsonl`.
- `refs.jsonl`: key, `plans` (JSON blob of `{plan, task, fp}`), `files` (JSON blob), fingerprints, `audited_at`.
- `config.json`: capacity per person, constraints for the solver.

## 3. Problems

1. People, sprints, epics and plan tasks are not nodes, so identity is a string match and renaming a person is a text edit across versions.
2. Edge kinds are free strings. A typo creates a new kind silently; `ignore_link_kinds` in config compensates. (Out of scope for v2, amended 2026-11-24: `edges.jsonl` stays the v1 home of `needs` and keeps its free `kind`; only `links.jsonl` relations are a closed set.)
3. Plan tasks live inside a JSON blob in `refs`, so "which tickets implement this plan task" is a scan.
4. Blockers are recomputed by each command with its own logic; there is no single definition.
5. Capacity lives in `config.json` as a flat map; there is no per-person-per-sprint capacity or availability.
6. Sprints have no dates, so a forecast cannot relate sprints to the calendar except through history.
7. History artifacts (`v2_owner`, `v2_sprint`, `first_verdict`) are baked into the ticket shape.
8. No referential integrity: an edge can name a ticket that does not exist until some command trips on it.

## 4. Target model

Node types, each a JSONL file with a stable `id` (a string key) and a `type`-specific shape:

| Type | File | Fields |
|---|---|---|
| Ticket | `tickets.jsonl` | existing fields; `epic` stays the epic string (amended 2026-11-24: the Epic node's `id` equals that string; `belongs_to` is derived from every non-empty `epic`, never written, and the Epic node is implicit when `epics.jsonl` has no row for it) |
| Person | `people.jsonl` | id, name, active |
| Sprint | `sprints.jsonl` | n (integer), name, start, end (both optional dates), state |
| Epic | `epics.jsonl` | id, name |
| PlanTask | `plantasks.jsonl` | id (`<plan>#<task>`), plan path, task id (amended 2026-11-24: no fingerprint; the per-link fingerprint stays in `refs.plans[].fp`) |
| OpenItem | `open-items.jsonl` | existing |

Relations form one typed view, `g_links`, with a closed set of relations validated at build (amended 2026-11-24: all six below are derived from their v1 homes and never stored; `links.jsonl` `{ from, from_type, rel, to, to_type, attrs? }` (endpoint types required, because ids are unique only per type) holds only hand-authored links with no v1 source, decision D18):

| rel | from, to | meaning | versioned |
|---|---|---|---|
| `needs` | Ticket, Ticket | consumer needs producer (v1 home `edges.jsonl`) | no |
| `assigned_to` | Ticket, Person | owner in a schedule version | yes (per version) |
| `scheduled_in` | Ticket, Sprint | placement in a schedule version | yes |
| `belongs_to` | Ticket, Epic | grouping (v1 home `tickets.epic`) | no |
| `implements` | PlanTask, Ticket | the plan task a ticket realizes (v1 home `refs.plans`) | no |
| `held_by` | Ticket, OpenItem | the open item that blocks it (v1 home `open-items.jsonl`) | no |

`edges.jsonl`, `schedule.jsonl`, `tickets.jsonl` (`epic`), `refs.jsonl` (`plans`) and `open-items.jsonl` stay readable and writable in v2 and remain the only home of all six relations; the relations are derived views in the index and are never written to `links.jsonl` (a `links.jsonl` row with one of them is a data error naming its v1 file), so nothing is stored twice (amended 2026-11-24: earlier drafts stored `belongs_to`, `implements` and `held_by` in `links.jsonl`, which duplicated `tickets.epic`, `refs.plans` and `open-items.jsonl`). `links.jsonl` holds only hand-authored links with no v1 source (decision D18; recommended: `relates_to`, informational only). Node files have primary keys (`people` and `epics` by `id`, `sprints` by `n`, `plantasks` by `<plan>#<task>`, `capacity` by `person` and `sprint`) and the merge driver merges them by key; `links.jsonl` is merged as a set.

Amended 2026-11-26 (graph amendment, section 4 item 5, and Task 1 of 0.4.0): nodes are keyed per file (people and epics by `id`, sprints by `n`, repos by `id`, capacity by `person` and `sprint`, open items by `key` and `kind`) and no file stores a `type` field; the type of a row is the file it is in, and the type of a link endpoint is written in the link row (`from_type`, `to_type`). `plantasks.jsonl` does not exist: plan tasks are derived nodes. The graph files are `people`, `sprints`, `epics`, `repos`, `capacity`, `links` and `xrefs`; node types and relations are open grammars (extension types `x-<sys>.<kind>` and relations `x-<sys>/<rel>` are accepted and counted, never an error); the format is `docs/FORMAT.md` section 7.

Capacity becomes data: `capacity.jsonl` rows `{ person, sprint, sp }` with the config map as the default when no row exists. In v2 the rows are advisory: `whatif` and `--relieve` read them and use `min(row, config)`, so a row never lets `whatif` accept a move that `verify` rejects, while the solver and `verify` keep the per-person config capacity so their schedules always agree (amended 2026-11-24); feeding rows to the solver and verifier is a later change.

A blocker is a derived view, defined once in the library (amended 2026-11-24 to match `brain ready` on 0.2.3 rule by rule): a ticket whose own status is closed is done and has no blockers; otherwise it is blocked when its verdict is not READY, or a finding of the ticket is not closed in the open-items register, or an open `held_by` item exists, or a `needs` producer (link kinds in `ignore_link_kinds` left out) is not done; a `--jira` snapshot status overrides the stored one. Every command that reports blockers calls that one function. The reason set is returned with the answer. (Amended 2026-11-24: a `needs` producer with no ticket row is skipped, as in `brain ready`; `brain blockers` is not a blocker report, it lists the stored verdicts other than READY including closed tickets, so it keeps its own query.)

## 5. Queries

The index gets the views `g_nodes` and `g_links` and one traversal, a breadth-first search over them with a visited set keyed by `(id, type)` and a depth cap of 20 (amended 2026-11-24: not a recursive CTE, whose path enumeration is exponential on diamond-shaped `needs` chains; `held_by` comes from the open-items file, which stays out of the index), and one generic command:

`brain graph KEY [--rel R[,R]] [--depth N] [--reverse] [--type T]` prints the reachable nodes with their relation path, bounded by the existing output limits, with every id other than a ticket key fenced as untrusted text. Existing commands keep their output (amended 2026-11-24): `ticket`, `person` and `sprint` are re-implemented on the traversal, which follows the `current` schedule version only; `neighbors` (depth 0 to 50) and `chain` (unbounded longest path with its cycle error) read the `needs` rows of the same views with their own algorithms, because a depth-capped shortest-path search cannot give their answers; `blockers` keeps its verdict query (section 4).

## 6. Integrity

`brain build` and `brain check` validate (amended 2026-11-24: endpoints carry their type, `from_type` and `to_type`, so a wrong-type check does not exist under D18; one owner per check, graph plan "Design on a page"): the relation is in the closed set (an unknown relation is a data error naming the known ones) and is not one of the six derived ones; a link names no missing node; node ids are unique per type (amended 2026-11-24: a `needs` cycle stays reported by `brain check` and `brain verify` as today, not as a new integrity code, so a v1-only directory keeps its output; one placement per ticket per schedule version is already guaranteed by the `schedule.jsonl` key). A person or sprint that appears only in v1 data (an owner string, a sprint integer) is an implicit node, not a missing one (amended 2026-11-24: sprints and people may be implicit). `brain doctor` reports violations by count and the exact command that lists them (`brain check`, which exits 1 on a missing node and never on a warning alone).

## 7. Compatibility and migration

Uses the repository's expand, migrate, contract protocol (`docs/FORMAT.md` section 2):

1. **Expand (0.4.0, format version 1, additive).** New files are read when present; the views are also derived from v1 data, so a v1-only directory answers exactly as before. Commands read the graph views; v1 fields stay authoritative.
2. **Migrate (0.5.0, format version 2, `min_reader` 1; amended 2026-11-24: readable and writable by 0.4.0 and later only, because the format guard of 0.3.0 and older runs `checkFormat` in write mode for every command and refuses any newer directory, measured on 0.2.3; 0.4.0 changes the guard to read mode, graph plan Task 2A, and amends `docs/FORMAT.md` section 2).** `brain migrate --write` appends to `people`, `sprints`, `epics`, `plantasks` the nodes derived from owners, sprint integers, non-empty epic strings and `refs.plans` that the files do not hold yet, keeps every existing (hand-authored) row unchanged, and writes no `links.jsonl` (amended 2026-11-24: an earlier draft rewrote the node files and would have dropped hand-authored rows such as sprint dates). It writes no relation row and changes no v1 file, so tools that keep editing the v1 files cannot make the graph disagree with them. Differential baseline: every command's output on the fixtures and on a real brain directory is byte-identical before the migration and after the migration followed by `brain build`, except the doctor format line, the card digest, the source-fingerprint prefix of the `brain card` header line and `fresh.fp`/`fresh.built` of the `--json` envelope (amended 2026-11-24: the node files join the card hash and the source fingerprint when present; a missing graph file adds nothing to either, so a v1-only directory keeps its 0.3.0 values; the card header prints the fingerprint prefix, measured on a prototype), and the output of `brain migrate` itself, which plans the 1-to-2 step before and prints `up to date` after (amended 2026-11-24, measured: the four `cli.plan.migrate.*` probes). The before side is a format-1 copy of each fixture: a fixture created by the 0.5.0 `brain init` is already format 2. Rollback for a member who must stay on 0.3.0: write `{"format_version":1,"min_reader":1}` to `format.json`, then run `brain build` with 0.3.0, which refuses the index built by 0.4.0 or later because of the graph tables.
   Mixed versions: an older merge driver treats the new files as unknown files and merges them as sets; a two-sided edit of one node id can then yield two rows, which 0.4.0 refuses with a named fix (`docs/superpowers/plans/2026-11-24-graph-model-v2.md`, Task 1).
3. **Contract (a later major version).** Drop `v2_owner`, `v2_sprint`, `first_verdict` from the ticket shape, with a migration that moves them into `meta` history rows.

## 8. Testing

- Property tests over random plans: the graph views and the v1 tables agree on every `needs`, owner and sprint.
- The exhaustive oracles of `test/assure/` keep running unchanged against the new views.
- A fuzz test for the merge driver on the new files: node files merge by key, `links.jsonl` as a set, no lost line.
- The differential baseline harness is the compatibility proof for step 2.
- Referential-integrity tests: each violation class in section 6 has a fixture and an expected one-line message.

## 9. Non-goals

No graph database, no query language, no network access, no change to the solver's constraints, no Jira writes.

## 10. Open questions for the owner

1. Should Person hold the tracker account id per tenant (so reassigning across companies is one node), or stay a display name?
2. Should Sprint dates be required once a project has them, so the forecast can use the calendar?
3. Is `implements` from plan tasks the right direction for superpowers plans, or should the plan task point at several tickets with a share of the work?

## 11. Proposed decisions (2026-11-24)

The three open questions of section 10 have proposed answers, with reasoning, in `docs/superpowers/specs/2026-11-24-zero-gaps-design.md`
section 14 (decision D7): Person stays a display-name node without tracker account ids; Sprint dates stay optional; `implements` points
from PlanTask to Ticket, many-to-many, without a share attribute. The release split (0.4.0 expand, 0.5.0 migrate, contract in a later
major version) and the compatibility proof are in the same section. Plan: `docs/superpowers/plans/2026-11-24-graph-model-v2.md`.
