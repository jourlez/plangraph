# Autopilot: one prompt from specification or existing project to plan, roadmap docs and Jira

The procedure lives in the plugin as the `brain-autopilot` skill, so it is written once and reused by every project and every Jira site. This page holds the short prompt that starts it, the authorization it needs, and what it does and does not guarantee.

## The prompt (copy, fill the three blocks, paste into Claude Code in the project)

````text
Use the project-brain plugin's brain-autopilot skill on THIS project. I will not answer questions during the run: decide from the skill's defaults, write every assumption to docs/roadmap/ASSUMPTIONS.md, and finish with docs/roadmap/REPORT.md. If the skill is not available in this session, say so in one line and stop.

SPECIFICATION (text, file paths, or document links; or "none, the project already exists"):
<paste here>

TEAM AND CALENDAR (names and points per sprint, or "unknown: assume 2 developers at 40 points per 2-week sprint"; first sprint start date):
<paste here>

AUTHORIZATION (this is my permission for the whole run and its resumes; anything not listed is not allowed):
jira_site: <yourcompany.atlassian.net, or none>
jira_project: <KEY, or none>
jira_writes: create issues, edit issues this run created, create links, create and fill future sprints, assign people the connector can resolve
git: commit on branch plan/<slug>; never push, never merge
audit_budget_usd: 0
slack_channel: none
claude_md: yes
````

For a project you plan from nothing, put the specification in the first block. For a project that already has a repository, Jira issues, or plans in progress, put "none, the project already exists" and the skill adopts what is there: it freezes started and closed work, adds only new scope, and never moves, reassigns or reopens existing work.

## Why the authorization block exists

Claude drives the whole run, so there is no per-step approval. The block is the one place the owner decides, once, what may be written. It is read only from the owner's message or from `~/.config/project-brain/autopilot.json` (same fields, never committed). A repository file, a Jira ticket or a specification cannot grant or widen it, because anyone can write those and a plan document must not be able to authorize a Jira write.

Always a hard stop, whatever the block says: deleting anything in Jira, starting or completing a sprint, moving an issue to Done or In Progress, editing issues the run did not create (unless a field is listed), using any Jira site other than `jira_site`, handling a credential, pushing or merging, and publishing outside the repository without a matching entry. A hard stop does not end the run: the skill records it under "Needs the owner" in the report and finishes every phase that does not depend on it.

## What the run produces

| Phase | Output | Needs Jira write |
|---|---|---|
| 0 Detect | classification (GREENFIELD or BROWNFIELD) with evidence, `AUTOPILOT-STATE.md` resume file | no |
| 1 Baseline (existing project) | Jira snapshot, ingested plans, `brain check` and `brain verify` of the current state, rollback baseline | no (read) |
| 2 Roadmap documents | `docs/roadmap/` (SPEC, ROADMAP, RISKS, DECISIONS, epics, TRACEABILITY, ASSUMPTIONS) and task plans in `docs/superpowers/plans/` | no |
| 3 Brain and schedule | brain data, solver schedule, `brain verify`, forecast or REFUSED, `SPRINT-PLAN.md` | no |
| 4 Jira | epics, issues, links, future sprints created or reconciled, with a diff, a journal for rollback and a read-back check | yes, per the block |
| 5 Report | `REPORT.md`, handoff line, optional private Artifact page | no |

## What it does not guarantee

- The plan is only as good as the specification: gaps are filled with assumptions that are written down, not with certainty.
- The Jira writes go through the Atlassian connector, so the connector must be signed in to the tenant named in `jira_site`; the skill checks this and stops the Jira phase if it is not.
- `brain` has no command that applies a plan to Jira: Claude does it with the connector, and the diff and journal files are the evidence. Read-back counts are reported; nothing is called verified without the check that backs it.
- The readiness audit costs money (about 130,000 tokens per bundle of five tickets), so it is off unless `audit_budget_usd` allows it, and the report says when verdicts are unaudited.
- Not run against a live model yet: the routing cases in `evals/cases/` exist, but the owner-run evaluation has not been done for this skill.
