# Adopting open-brain in another project

Two steps: install the plugin once per machine, then paste one prompt into Claude Code inside each project.

## 1. Install once per machine

Type these in a Claude Code session (they are slash commands, so you type them yourself):

```
/plugin marketplace add jourlez/open-brain
/plugin install open-brain@open-brain-marketplace
```

Check with `/plugin`: `open-brain` should be enabled with 8 skills. To have Claude do all of this plus the roadmap documents and the Jira setup, with no questions asked, use the single prompt in [AUTOPILOT.md](AUTOPILOT.md) instead of step 2. The session-start card can be turned off with the plugin's `card` option (`auto` or `off`).

## 2. Paste this into Claude Code in the project

````text
The open-brain plugin is installed. Set it up for THIS project and report back. Work step by step and stop to ask me before anything marked [ASK].

Rules: never write to Jira, never write or print a credential, never edit another tool's files (.wolf/, superpowers files), and do not touch source code. Everything you create goes in the brain directory (default `.brain/`) unless I say otherwise.

1. Detect: run `brain integrations` and `brain doctor`. Tell me what is installed (superpowers, OpenWolf, connectors) and any problem found. If `brain` is not found, tell me the plugin is not enabled in this session and stop.
2. Find existing plan data. Check for: an existing brain dir (`.brain/` or whatever `.brainrc` names), superpowers plan files (docs/superpowers/plans/*.md), a Jira project I use, or nothing. Tell me which you found.
3. Use the `open-brain:brain-onboard` skill to bring that data in:
   - existing brain data in an older format: run `brain migrate --write` [ASK first], then `brain build`;
   - superpowers plans: `brain sp-ingest <plan.md>` for each plan;
   - Jira: prefer the Atlassian connector for single tickets; for a bulk import tell me what `docs/JIRA.md` in the plugin says to set up (a scoped read-only token in MY shell, never in a file) [ASK]; then `brain jira-import`;
   - nothing yet: run `brain init`, and show me the tickets.jsonl, edges.jsonl and schedule.jsonl format from `brain explain` so we can fill them.
4. Install the git merge driver for this clone: run `brain doctor --fix` [ASK], so concurrent edits to the plan data merge safely.
5. Build and check: run `brain build`, `brain check`, `brain verify`, `brain blockers`, `brain card`. Explain any violation or unplaced ticket in plain words, with the exact `brain` command that shows it.
6. Suggest, do not write: `brain init` prints a three-line snippet for this project's CLAUDE.md that steers Claude to use `brain` for plan questions. Show it to me and ask whether to add it [ASK].
7. Commit plan: tell me which files to commit (the text files in the brain dir) and which not (brain.sqlite and its journal files are ignored). Do not commit for me.
8. Finish with a 6-line summary: what is installed, where the data lives, current health (tickets, violations, unplaced, blocked), what I should do next, and the three commands I will use most (`brain blockers`, `brain ready --person NAME --sprint N`, `brain whatif KEY --find`).

Then wait. From now on, for plan questions use `brain` commands, never read the .jsonl files directly.
````

## After setup

Ask in plain words ("what is blocked", "who is overloaded in sprint 7", "where can DEMO-12 go without creating a blocker"). Claude runs the matching `brain` command. Anything that writes your data asks first.

`brain` is a command only inside Claude Code sessions with the plugin enabled. Outside Claude Code run `node bin/brain` from the plugin folder.
