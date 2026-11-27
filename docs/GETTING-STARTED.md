# Getting started

This walks one small project from nothing to a plan graph: take over an existing repository, look at what plangraph found, see what to work on next, and generate the documents. Every command marked `# runs` below is executed by `test/docs-examples.test.ts` in a temp copy of a synthetic project (a git repository with three commits by two authors, three source files and one plan document), and its output is compared with the block that follows. If a command prints something else, that test fails, so what you read here is what the tool prints.

## Before you start

- macOS or Linux. Windows is not supported (the file layer needs `O_NOFOLLOW`); use WSL. The Claude Code hooks of the plugin run `node` directly (no shell script). The optional git hook scripts in `.githooks/` are three-line POSIX `sh` wrappers, which every macOS and Linux has.
- Node 26.0 or newer (`node --version`) and git.
- Python 3 and OR-Tools, only for the scheduling solver (`plangraph-solve-run`). The easiest way is uv: `uv` reads the pinned requirements and installs OR-Tools into its own cache. Everything in this guide works without the solver.
- Optional: `gh`, signed in, if you want `plangraph sync-fetch` to read GitHub issues and pull requests. This guide does not use it.
- plangraph itself: `claude plugin marketplace add jourlez/plangraph` then `claude plugin install plangraph@plangraph-marketplace` (see the [README](../README.md#installation)). Inside a Claude Code session with the plugin, `plangraph` is on the Bash PATH. In a terminal outside Claude Code, run `node /path/to/plangraph/bin/plangraph ...` instead.

plangraph sends no telemetry. The only network calls are the documented read-only fetchers (`sync-fetch`, `jira-pull`), and they run only for targets you named in `config.json` and trusted with `plangraph trust`.

## 1. Set up the plan directory

```bash
plangraph init   # runs
```

```text
initialised .plangraph: edit config.json, then fill the plan with `plangraph takeover` (an existing project) or `plangraph sp-ingest PLAN` (a plan document), then `plangraph build`
suggested lines for this repo's CLAUDE.md (printed only, nothing written):
## Plan questions
Use `plangraph` for plan questions (ticket, ready, whatif, blockers, sprint, person); do not read .plangraph/*.jsonl or the index.
Run `plangraph explain` for the full command list.
```

`init` creates `.plangraph/` with `config.json`, `format.json`, the generic learnings and a `.gitignore` for the derived files. It writes no git config and no CLAUDE.md. Everything it does not print, it did not do.

## 2. Take over the project

```bash
plangraph takeover --no-fetch   # runs
```

```text
detect: ok
scan: ok
history: ok
plans: ok
fetch: skipped (no-fetch)
links: ok
build: ok
check: ok
map: ok
docs-build: ok
gaps: 2
- no CODEOWNERS
- no tracker access (fetch skipped by --no-fetch)
questions: 1
<untrusted src="takeover-questions" n="c406a314" len="156">
tracker-access: give plangraph tracker access: name the targets in config.json, trust them with `plangraph trust`, and sign in to gh or the Atlassian tenant
</untrusted>
```

`takeover` is one resumable pipeline: detect, scan, history, docs, plans, fetch, links, identities, build, check, map, docs-build, report. Each step prints `ok`, `skipped (reason)` or `failed (reason)`; a step with no input (here, no requirements or ADR documents) prints nothing. `--no-fetch` skips the tracker, so the run needs no network and no sign-in. Progress is checkpointed in `.plangraph/cache/takeover.json`, so an interrupted run continues where it stopped, and `--from STEP` or `--skip STEP` change the order.

The end of the output is the gap report. It lists every unknown instead of guessing: no `CODEOWNERS` file, no tracker access, and (when it applies) authors in the history that map to no person. The fenced block is the questions only you can answer, printed as data. Nothing in it is an instruction.

The plan document in `docs/superpowers/plans/` became three tickets and one epic. The git history was read into a repository node with its modules and authors. None of it is committed yet: review it, then `git add .plangraph`.

## 3. Check the result

```bash
plangraph build   # runs
```

```text
built .plangraph/plangraph.sqlite: 4 tickets, 2 links, 0 evidence rows, 0 findings, 16 learnings
```

`build` rebuilds the SQLite index (`.plangraph/plangraph.sqlite`, git-ignored) from the plan files. It is cheap and safe to repeat.

```bash
plangraph check   # runs
```

```text
tickets 0 | links 2 | strict-rule violations 0 | person-sprints over cap 0 | loop-free true | last sprint 0
```

`check` is the guard for what git cannot see after a merge: broken links, a file with conflict markers, a person over capacity, a handoff that breaks the rule. It exits 1 on a violation and prints one line per problem with the file and a fix. The `tickets 0` here counts tickets that are placed in a sprint: the three tasks are not placed yet (nobody owns them), which is not a violation.

## 4. The overview, and one task

```bash
plangraph map   # runs
```

```text
plangraph map | 4 tickets, 1 repos, 0 people
epics: sp:2026-01-05-widget-export 0/3
fresh: index b1db18c1, cache age unknown
```

`map` is the short overview Claude reads at the start of a task: counts, epics with progress, how fresh the index is. It is bounded at 500 estimated tokens.

```bash
plangraph context   # runs
```

```text
plangraph: no task detected, pass a ticket key: `plangraph context KEY`
```

With no argument, `context` looks at the current git branch and the changed files for a task key, and says so when it finds none. Name the task:

```bash
plangraph context sp:2026-01-05-widget-export/3   # runs
```

```text
context sp:2026-01-05-widget-export/3 <untrusted n="a471bcf9">HTTP handler</untrusted> | unowned | unplaced | 2sp
blockers: sp:2026-01-05-widget-export/1, sp:2026-01-05-widget-export/2
```

Text that came from your documents (here the task title) is printed inside `<untrusted>` fences, so a model treats it as data.

## 5. What to work on next

```bash
plangraph flow next   # runs
```

```text
sp:2026-01-05-widget-export unowned <untrusted n="5f206347">Widget Export</untrusted>
sp:2026-01-05-widget-export/1 unowned <untrusted n="7a2a5f1e">CSV formatter</untrusted>
sp:2026-01-05-widget-export/2 unowned <untrusted n="9facf63a">Export query</untrusted>
```

`flow next` lists the tasks that can start now. A task whose producers are not done does not appear. `plangraph flow brief KEY` prints a bounded brief for one task, and `plangraph flow-claim`, `flow-progress`, `flow-done` and `flow-link` record who took it, how far it is and the evidence that it is done, as append-only events under `.plangraph/events/`.

```bash
plangraph flow brief sp:2026-01-05-widget-export/3   # runs
```

```text
brief sp:2026-01-05-widget-export/3
<untrusted src="task" n="a471bcf9" len="12">
HTTP handler
</untrusted>
```

The brief is bounded at 1,200 estimated tokens. It can hold the task's steps, what it consumes and produces, linked requirements and decisions, and the names of the repository's build and test scripts (labeled as data from the repository). Here it holds only the title and the owner line, because that is all this project's plan data says about the task.

## 6. Generate the documents

```bash
plangraph docs-build   # runs
```

```text
wrote 0 documents to docs/plangraph
```

`takeover` already generated the documents, so this run finds everything current. `docs-build` writes the roadmap, status, requirements trace, architecture and onboarding pages, the decision index, release notes and one page per repository into `docs/plangraph/`, from the plan files. The directory is derived, so it is git-ignored unless `docs.commit` is true in `config.json`.

```bash
plangraph docs check   # runs
```

```text
architecture fresh
adr-index fresh
onboarding fresh
release-notes fresh
repo-page fresh
roadmap fresh
rtm fresh
status fresh
```

`docs check` says which generated documents are fresh and which have drifted from the plan.

## 7. Keep the index fresh with git hooks

```bash
plangraph githooks-install --dry-run   # runs
```

```text
would write .githooks/post-commit
would write .githooks/post-merge
would write .githooks/post-checkout
would write .githooks/post-rewrite
to enable them, pick one (this command never changes git config):
  git:      git config core.hooksPath .githooks
  lefthook: add to lefthook.yml, one block per hook, e.g.
              post-commit: { commands: { plangraph: { run: plangraph refresh --fast --quiet || true } } }
              (also post-merge, post-checkout, post-rewrite; for the check: pre-commit: plangraph check --quiet)
  husky:    copy a script to .husky/<hook> (for example cp .githooks/post-commit .husky/post-commit)
```

Without `--dry-run`, the four `post-*` scripts are written to `.githooks/`. Each runs `plangraph refresh --fast --quiet || true`, so a hook rebuilds a stale index and never blocks git. plangraph never changes git config: enabling the hooks is the line you copy from the output. `--pre-commit` adds a `plangraph check --quiet` script that can stop a commit. The scripts are three-line `sh` wrappers that call the tool; nothing else runs in them. The Claude Code hooks (the session card and the prompt hook) come with the plugin and are separate from these.

## 8. Remove it

`plangraph uninstall` undoes what `init`, `githooks-install` and `docs-build` added: the unmodified `.githooks/` scripts and the `.gitignore` lines plangraph wrote. After a confirmation (`--yes`, or typing `y`), it also removes the local cache and the index. It never deletes `nodes/`, `events/`, `runs/`, `schedules/`, `config.json` or `format.json`: that is your plan. Then `claude plugin uninstall plangraph@plangraph-marketplace` removes the plugin.

## What this guide did not check

It ran on a synthetic project with no tracker. The tracker fetchers (GitHub, Jira, Confluence) were not part of it, and neither was the scheduling solver. `results pending`: whether an agent that uses plangraph spends fewer tokens or answers more accurately is not established here (see [docs/BENCHMARK.md](BENCHMARK.md)).
