# project-brain

A small knowledge graph for planning with Claude Code, shared through git. It holds tickets, dependency links, readiness verdicts with the evidence behind them (fingerprinted, so they go stale when their inputs change), schedules, and learnings. Claude Code queries it with one cheap command instead of re-reading files; there are no model calls in the tool itself.

## Quickstart
Needs Node 24.2 or newer (the index uses built-in `node:sqlite`, the CLI `import.meta.main`). Six steps:
1. In Claude Code, run `/plugin marketplace add jourlez/OpenBrain`, then `/plugin install project-brain@project-brain-marketplace`. To install from a clone instead, add the folder from a local path: `/plugin marketplace add <path to this folder>`, then the same install command.
2. In your project, run `/project-brain:brain-init` (it runs `brain init`: creates `.brain/`, or the directory named in `.brainrc`, e.g. `{"dir": "docs/plan-graph"}`).
3. Put your data in as JSONL (formats below) and fill `config.json` (sprints, capacity per person, default git ref; for Jira `jira.cloud_id` and `jira.jql`).
4. `brain build` turns the text into the throwaway SQLite index (git-ignored).
5. `brain doctor` checks Node, the data format, the merge driver and the solver prerequisites.
6. `brain integrations` lists which companion tools it can see (superpowers, openwolf, caveman, context7, gitkraken).

While the plugin is enabled, `brain`, `brain-solve-run` and `brain-merge` are on the Bash tool's PATH, a session-start hook injects a short card when the project has a brain, and seven skills (`/project-brain:brain`, `brain-init`, `brain-audit`, `brain-onboard`, `brain-plan`, `brain-report`, `whatif`) tell Claude how to use it. Then `brain check` and `brain card --write`; commit the text files. The solver runs through `uv` (or a python3.10-3.14 venv) and needs OR-Tools; it does not work on Python 3.15 yet. Jira: `brain jira-pull --out snapshot.jsonl` with a scoped read-only API token supplied by your own environment, 1Password or keychain (docs/JIRA.md); the token is never written, logged or accepted as an argument.

Needs Claude Code 2.1.329 or newer (`engines.claude-code` in the manifest). It was installed and run on 2.1.329; the newest release at the time of writing, 2.1.330, was not tested.

## What runs on your machine
| What | When | What it does |
|---|---|---|
| Session hook: `node bin/brain card --if-present --heal` (timeout 10 s) | Session start, resume, clear, compact and fork, while the plugin is enabled | Prints a short card if the project has a brain; silent if not; also repairs a missing merge driver. Turn the card off with the plugin option `card = off` (`CLAUDE_PLUGIN_OPTION_CARD`) or `BRAIN_CARD=off`. Reads local files only. |
| Commands in `bin/`: `brain`, `brain-merge`, `brain-solve-run` (and `brain-solve`, which it runs) | When you or Claude run them | Run as you, unsandboxed. Local files and git only, except as listed in the last two rows. |
| `brain init` (git config and `.gitattributes`) | Once per project | Adds `<dir>/*.jsonl merge=brain-jsonl` to `.gitattributes`, sets `merge.brain-jsonl.name` and `.driver` in the repository's local git config, and creates a small shell shim in a data directory so the driver survives plugin updates. `brain doctor --fix` repairs it. |
| Solver first use | First `brain-solve-run` | Downloads pinned Python packages (`ortools`, `numpy` and dependencies) from PyPI, then caches them (docs/SOLVER.md). No ticket data leaves the machine. |
| `brain jira-pull`, `brain jira-text` | Only when you run them | The only network calls in the tool. Read-only requests to Jira, with a credential from your environment, 1Password or keychain (docs/JIRA.md). |

No model calls are made by the tool itself.

## Works with
Detection of these reads files only: no process is started, the tools are never run, and the network is not used (`brain integrations` spawns nothing; `brain doctor` itself runs `uv --version` and git, see SECURITY.md); docs/INTEGRATIONS.md has the exact evidence.

| Tool | What the brain does with it | Verified |
|---|---|---|
| superpowers | `brain sp-ingest` reads a superpowers plan and ledger into tickets; `sp-link` points a ticket at plan tasks | Detection and ingest are tested against fixtures. Not tried with a live superpowers session. |
| openwolf | Detects whether it is `active`, `disabled` or rules-only (`protocol-only`); the skill asks for one marked `brain card --line` in the handoff | Detection is tested against fixtures. Not tried with a live OpenWolf install. |
| caveman, context7, gitkraken | Reported as `absent`, `installed` or `enabled` | Detection is tested against fixtures only. |
| Atlassian connector | `brain jira-import` merges a connector result saved to disk into a snapshot (no network, no credentials) | Tested with saved sample data; not run against a live connector. |
| Slack, Meetings, Artifact, Claude Docs, Google Drive connectors | Not detectable from a shell. The skills embed name-glob hints (`brain integrations -v` prints them) and use a connector only if a tool matching the pattern exists. Slack text is a draft a person sends; meeting text is data and never stored; Artifact and Confluence are where reports go | Skill text and routing tests only; never run against a live connector. |
| context7 | Used only inside sizing or audit agents for library-dependent verdicts, never in the main flow | Skill text only. |

The `brain` skill is the router: it starts with `brain integrations`, then follows a table of ordered steps per job (onboarding, planning, replanning, reassigning, reporting, handoff). Each step names the owning tool and the fallback when that tool is missing. Superpowers skills are recommended, never started automatically. `/project-brain:brain-onboard` and `/project-brain:brain-plan` hold the two longest flows. The routing contract is checked by `test/skills-routing.test.mjs` (file contents only; no live session was used to confirm that Claude picks the right skill).

## Data (one JSON object per line)
- `tickets.jsonl`: `key, summary, epic, sp, jira_status, v2_owner (baseline owner), v2_sprint, verdict, verdict_source, first_verdict`
- `edges.jsonl`: `consumer, producer, kind, note` (consumer needs producer; kinds listed in `config.ignore_link_kinds` are skipped by the solver and the check)
- `schedule.jsonl`: `version ("current" or an archive name), key, owner, sprint`
- `evidence.jsonl`, `findings.jsonl`, `meta.jsonl`, `refs.jsonl` (input fingerprints), `learnings.jsonl` (rules, methods, measured costs; seeded with 16 generic ones)

## Commands
`brain ready|whatif|simulate|ticket|neighbors|chain|sprint|person|blockers|findings|rules|learn|check|verify|open-items|stale|refs-update|forecast|report|schedule-load|jira-pull|jira-text|jira-import|sp-ingest|sp-link|integrations|bundle|units|build|export|card|init|migrate|doctor|explain`; `brain-solve-run --out schedule.json`. Each answers in a few tokens (counts first, lists capped; `-v` for all, `--json` for a versioned envelope). `brain explain` lists them (generated from the registry; `brain explain COMMAND` for one). Design notes: docs/CONTRACT.md, FORMAT.md, STALE.md, JIRA.md, FORECAST.md, TOKENS.md, OPENITEMS.md.

## Incremental replanning
`brain stale --ref origin/dev --jira snapshot.json --list` compares each verdict's recorded inputs (plan section text, Jira updated stamp, files it touches, its producers) with the current repo and Jira, and lists only what changed. Audit only those. `brain-solve` first solves with owners fixed (small, exact), then frees owners and polishes. A strict handoff rule is built in: a need produced by another person must be in a strictly earlier sprint; the same person's ticket may share the sprint.

## Audit preparation (the costly step, made cheap)
`brain jira-text KEY... --out texts/` (description and comments as text), `brain bundle KEY...` (one ticket per section: row, plan task text, needs with plan positions, findings, Jira text) and `brain units (--stale | --keys A,B) --size 5 --text texts/ --out units/` (bundles of 5 tickets for agents, plus a cost preview before anything is spent). Generic agent briefs are in `briefs/` (auditor, re-verifier, loop reader), a Workflow template in `workflows/audit.workflow.js`, and the `/brain-audit` skill describes the whole incremental procedure. Measured on a large project: about 130,000 tokens per unit of 5 tickets; `brain stale` limits the units to what changed.

## Reassigning safely
`brain whatif T-9 --to "Ben" --sprint 5` is a dry run: it lists every rule the move would break (producer too late, consumer too early, capacity, already started) with a fix. `--apply-plan` computes the smallest set of other tickets to shift, and `--write` persists it only after the independent verifier agrees.

## Bulk questions in one call
`brain ready --person "Ana" --sprint 3` answers "which of Ana's sprint-3 tickets can start now" in one call (either filter alone works too): `Ana S3: ready 12 of 45, done 4, not ready 29 (waiting on producers 25, open items 3, verdict not READY 2)`, then the ready keys (25 shown, `-v` up to 500), a few example keys per reason, and the freshness note. It is the same rule as `brain ready KEY` (one shared function, `lib/ready.mjs`); a not-ready ticket can count under several reasons. Exit 0 when something may start, 1 when nothing may; `--json` holds every list. Never loop `brain ready KEY` over a list of tickets.

`brain whatif --relieve "Ana" --sprint 3` answers "Ana is over capacity in sprint 3: what is the smallest set of valid moves" in one read-only call. It moves only that cell's tickets, one slot each (a later sprint, same owner; `--earlier` and `--owner-change` widen it), keeps every frozen ticket in place, and accepts a set only when the cell ends at or under cap, every link of a moved ticket still holds and no other cell goes over cap; the chosen set is then checked again with the independent verifier. Choice: fewest tickets moved, then least total slip, then fewest owner changes, then key order. It prints each move with its exact `brain whatif` dry-run command, in an order where each one passes on its own, or `NO RELIEF` with the reasons (frozen tickets, links, full sprints, not enough points). The search has a budget (1,000,000 steps) and says so when it is hit. It never writes: `--apply-plan` and `--write` are refused with `--relieve`; the owner applies the printed moves one by one.

## Optional MCP adapter (off by default)
`mcp/brain-mcp.mjs` is a read-only MCP server (stdio, no dependencies) with three tools, `ready`, `whatif` (dry run only, never `--apply-plan` or `--write`) and `ticket`, that return exactly the text the CLI prints for the same command. It is not on PATH and the plugin never starts it: there is no `mcpServers` entry and no `.mcp.json`, so a default install pays nothing for it (`claude plugin details` shows `MCP servers (0)`). It duplicates the CLI. Its tool definitions cost about 490 estimated tokens per session on a client that loads them up front; Claude Code 2.1.329 was seen to defer them and load them on demand through `ToolSearch`, so there the up-front cost is a short entry (not measured). Enable it only if your own evals show it is no worse than the CLI. docs/MCP.md has the opt-in snippet, the protocol notes and the measurements. Verified with Claude Code 2.1.329: it connects (`claude mcp list`: Connected), lists the three tools, and in a live session the model selected them with `ToolSearch` and made 3 correct calls (5 turns, $0.046 reported). Not verified: the size of the deferred entry, other clients.

## Status and limits
- Not yet installed in a live Claude Code session by its author. It works locally and is tested here (`node --test $(ls test/*.test.mjs | grep -v solver)`; the solver suite needs Python and runs separately), plus `test/smoke.sh` and `test/validate-plugin.mjs`. `claude plugin validate .` (Claude Code 2.1.329) passes with no warnings (`test/claude-validate.test.mjs` runs it when the binary is present). See CHANGELOG.md for what was removed (claims, hash ids, compaction, command execution from config) and why (docs/REUSE.md), and SECURITY.md for hardening and limits.
- License: MIT (LICENSE).
- Tested here: the CLI, the hook command, the audit preparation commands and the solver on synthetic data (`test/smoke.sh`). The author also reports running the CLI on a real 1,397-ticket project with results matching its project-specific predecessor; that is not reproducible from this repository.
- Not verified here: the Claude Code install flow itself (marketplace schema, local-path install, hook output injection) was built to the documented layout but not run in a live session. Test it once with `/plugin`.
- `refs.jsonl` fingerprinting assumes plans are markdown with a heading per task (`config.ref_heading`, default `^### Task {id}:`).
- Efficiency figures for similar tools are vendor-reported; measure with `/context` in your own sessions.
