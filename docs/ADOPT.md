# Adopting plangraph in another project

Two steps: install the plugin once per machine, then paste one prompt into Claude Code inside each project.

## 1. Install once per machine

Type these in a Claude Code session (they are slash commands, so you type them yourself):

```
/plugin marketplace add jourlez/plangraph
/plugin install plangraph@plangraph-marketplace
```

Check with `/plugin`: `plangraph` should be enabled with 8 skills. To have Claude do all of this plus the roadmap documents and the Jira setup, with no questions asked, use the single prompt in [AUTOPILOT.md](AUTOPILOT.md) instead of step 2. The session-start card can be turned off with the plugin's `card` option (`auto` or `off`).

## 2. Paste this into Claude Code in the project

````text
The plangraph plugin is installed. Set it up for THIS project and report back. Work step by step and stop to ask me before anything marked [ASK].

Rules: never write to Jira, never write or print a credential, never edit another tool's files (.wolf/, superpowers files), and do not touch source code. Everything you create goes in the plan directory (default `.plangraph/`) unless I say otherwise.

1. Detect: run `plangraph integrations` and `plangraph doctor`. Tell me what is installed (superpowers, OpenWolf, connectors) and any problem found. If `plangraph` is not found, tell me the plugin is not enabled in this session and stop.
2. Find existing plan data. Check for: an existing plan dir (`.plangraph/` or whatever `.plangraphrc` names), superpowers plan files (docs/superpowers/plans/*.md), a Jira project I use, or nothing. Tell me which you found.
3. Use the `plangraph:onboard` skill to bring that data in:
   - superpowers plans: `plangraph sp-ingest <plan.md>` for each plan;
   - Jira: prefer the Atlassian connector for single tickets; for a bulk import tell me what `docs/JIRA.md` in the plugin says to set up (a scoped read-only token in MY shell, never in a file) [ASK]; then `plangraph jira-import`;
   - nothing yet: run `plangraph init`, and show me the tickets.jsonl, edges.jsonl and schedule.jsonl format from `plangraph explain` so we can fill them.
4. Install the git merge driver for this clone: run `plangraph doctor --fix` [ASK], so concurrent edits to the plan data merge safely.
5. Build and check: run `plangraph build`, `plangraph check`, `plangraph verify`, `plangraph blockers`, `plangraph card`. Explain any violation or unplaced ticket in plain words, with the exact `plangraph` command that shows it.
6. Suggest, do not write: `plangraph init` prints a three-line snippet for this project's CLAUDE.md that steers Claude to use `plangraph` for plan questions. Show it to me and ask whether to add it [ASK].
7. Commit plan: tell me which files to commit (the text files in the plan dir) and which not (plangraph.sqlite and its journal files are ignored). Do not commit for me.
8. Finish with a 6-line summary: what is installed, where the data lives, current health (tickets, violations, unplaced, blocked), what I should do next, and the three commands I will use most (`plangraph blockers`, `plangraph ready --person NAME --sprint N`, `plangraph whatif KEY --find`).

Then wait. From now on, for plan questions use `plangraph` commands, never read the .jsonl files directly.
````

## After setup

Ask in plain words ("what is blocked", "who is overloaded in sprint 7", "where can DEMO-12 go without creating a blocker"). Claude runs the matching `plangraph` command. Anything that writes your data asks first.

The merge driver is wired per clone, and never automatically. Wiring writes the clone's git config and a script that git runs at every merge, so a repository someone else committed must not be able to switch it on. A fresh clone therefore gets one line at session start, `plangraph: merge driver not set up in this clone; merges of .plangraph/*.jsonl conflict until the user runs plangraph doctor --fix`, and nothing is written (a plan directory whose name is not plain `A-Z a-z 0-9 . _ / -` of at most 40 characters shows as `*.jsonl files in the plan directory`). Run `plangraph doctor --fix` yourself, once per clone, to opt in (`plangraph init` does the same). It records your consent as `plangraph.heal` (the plugin version) in the clone's own git config, so the session start repairs the driver from then on (after a plugin update, for example). That config cannot be committed, moves with the clone and is shared by its worktrees, and a new clone never inherits it, even at the same path. A repository copied together with its `.git` directory (an archive or a disk copy, not a clone) carries it. Such a copy whose config already holds a driver is grandfathered too; that adds no new risk, since that config already runs its driver at every merge. Only a version value counts as consent: `false` or `off` does not grant it. A clone wired by an earlier plangraph counts as consented while `plangraph.heal` is unset. `git config plangraph.heal never` declines: no repair and no line at session start.

`plangraph` is a command only inside Claude Code sessions with the plugin enabled. Outside Claude Code run `node bin/plangraph` from the plugin folder.
