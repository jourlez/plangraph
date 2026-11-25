> Historical document: written before the 0.3.0 rename to plangraph. It names the tool, its commands, files and variables as they were called then (`brain`, `.brain/`, `BRAIN_*`); the text is unchanged.

# superpowers integration research

Date: 2026-11-22. Scope: how plangraph should detect, ingest, read through, and recommend the `superpowers` Claude Code plugin without duplicating it or contradicting it.

Evidence tags:
- **VERIFIED-source (path)**: read in the installed plugin cache, `~/.claude/plugins/cache/superpowers-dev/superpowers/6.1.1/` (written below as `SP6/`), or in the upstream git clone at commit `22f0b46` = tag `v7.0.2` (written as `SP7:`; read with `git show 22f0b46:<path>` in `~/.claude/plugins/marketplaces/superpowers-dev`).
- **VERIFIED-docs (URL)**: public page.
- **VERIFIED-example**: seen in this repo's own superpowers output (`docs/superpowers/plans/2026-11-22-project-brain-excellence.md`, `.superpowers/sdd/`).
- **UNVERIFIED**: inference or untested claim.

## 0. Headline findings

1. **The installed copy is behind upstream on everything plangraph cares about.** Installed: 6.1.1, commit `d884ae0`, released 2026-07-02. Upstream latest: v7.0.2, commit `22f0b46`, released 2026-11-03. The official Anthropic marketplace entry is already pinned to that same sha. Between the two releases, the SDD workspace moved from `.superpowers/sdd/` to `.superpowers/sdd/<plan-basename>/`. The ledger gained an identity first line. The workspace is now **deleted** after a clean final review. Plans gained `**Spec:**` and `## Review Focus`, and steps no longer contain full code. Task IDs like `A1`, `6b` and `2.1` became first-class. Ledger line types multiplied (fix rounds, parked findings, rulings, deferred minors). A parser written only against 6.1.1 will silently miss 7.x progress. VERIFIED-source (`SP6/RELEASE-NOTES.md:3`, `SP7:RELEASE-NOTES.md` sections v6.2.0, v6.3.0, v6.4.1, v6.4.2, v7.0.2; `~/.claude/plugins/marketplaces/claude-plugins-official/.claude-plugin/marketplace.json` superpowers entry `sha 22f0b46...`).
2. **Plan checkboxes are not a progress signal.** No superpowers skill ever edits `- [ ]` to `- [x]` in the plan file, in either version. The one exception is the Antigravity harness note. Progress lives in harness todos (lost on exit) and in the git-ignored ledger. VERIFIED-source (`git grep "\[x\]" 22f0b46 -- skills` hits only `using-superpowers/references/antigravity-tools.md:20` and an issue template). VERIFIED-example: the real 646-line plan has all 8 Wave A tasks finished per its ledger, yet still has 0 `- [x]`.
3. **The ledger is ephemeral by design. plangraph is the natural place to keep its durable record.** Both versions git-ignore it, `git clean -fdx` destroys it, and 7.x `rm -rf`s it after the final review. In 7.x the `Ruling:` lines (decisions the agent took on the human's behalf) survive only in the final chat message. VERIFIED-source (`SP6/skills/subagent-driven-development/SKILL.md:263-264`; `SP7:skills/subagent-driven-development/references/final-review.md:35-47`). Snapshotting ledger facts into brain JSONL is real value that nothing else provides.
4. **plangraph already speaks superpowers' task-heading dialect.** `lib/stale.ts:8` `DEFAULT_HEADING = '^#{2,3} Task {id}:'` matches `### Task N:`. `refs.plans[{plan,task}]` can already point a ticket at a superpowers plan task and fingerprint its section. VERIFIED-source (`lib/stale.ts:8,27-32,38-45`, `lib/store.ts:31`).
5. **Real-world output drifts from the documented format.** The example ledger uses a custom header, `Task 1 (A1): implemented <sha>; review 1: ...`, indented `Minor` continuation lines, `commits 4e3d1b3..HEAD incl. ...`, and free prose ("REUSE AUDIT ..."). The real plan uses inline `**Files:** Modify ...` paragraphs and inline `**Interfaces:** Produces ...`, and some tasks have no Interfaces block. `[A1]`-style secondary IDs appear in task titles. The parser must be tolerant, and it must report what it could not classify. VERIFIED-example.

## 1. What superpowers is

A zero-dependency skills library and runtime bootstrap by Jesse Vincent, MIT license. Homepage `https://github.com/obra/superpowers`. VERIFIED-source (`SP6/.claude-plugin/plugin.json`). It ships 14 skills in 6.1.1 and 15 in 7.x (7.x adds `diagnosing-superpowers`), one SessionStart hook, no MCP servers, no agents and no commands. VERIFIED-source (`SP6/skills/`, `SP7:RELEASE-NOTES.md` v6.4.1 "New Skills").

### 1.1 Skills: trigger (frontmatter `description`) and what each is best at

| Skill | Trigger (verbatim gist) | Shines at | plangraph stance |
|---|---|---|---|
| using-superpowers | "Use when starting any conversation"; injected by the hook | Forcing skill-first behavior | never touch; must not contradict (1.3) |
| brainstorming | "MUST use this before any creative work" | Intent, design and spec document, one question at a time, HARD-GATE before code | recommend-only |
| writing-plans | "spec or requirements for a multi-step task, before touching code" | Plan with Global Constraints, per-task Files and Interfaces, TDD steps | recommend-only, then **ingest** its output |
| subagent-driven-development (SDD) | "executing implementation plans with independent tasks in the current session" | One fresh implementer and one task reviewer per task, a ledger, a final whole-branch review | recommend-only, **read-through** ledger |
| executing-plans | 6.1.1: separate session, stub. 7.x: "Native" inline mode with `task-start` and `task-done` | Cheap inline execution that shares the SDD ledger | recommend-only, read-through ledger |
| test-driven-development | "implementing any feature or bugfix, before writing implementation code" | Red-green iron law | never duplicate |
| verification-before-completion | "about to claim work is complete" | Evidence-before-claims gate | recommend-only (brain's own skills must obey it) |
| requesting-code-review / receiving-code-review | completing tasks, before merge / receiving feedback | Reviewer template, severity calibration | never duplicate |
| finishing-a-development-branch | "implementation is complete, all tests pass" | Exactly 4 options (merge, PR, keep, discard) plus worktree cleanup | recommend-only; brain hooks after it |
| using-git-worktrees | "starting feature work that needs isolation" | Detects existing isolation, prefers native `EnterWorktree`, falls back to `.worktrees/` | never touch, but **scan worktrees for ledgers** |
| dispatching-parallel-agents | "2+ independent tasks ... without shared state" | Parallel investigation | never duplicate |
| systematic-debugging, writing-skills | bugs / authoring skills | n/a | none |

VERIFIED-source: frontmatter of every `SP6/skills/*/SKILL.md`.

### 1.2 The workflow chain

`brainstorming` → spec, committed → user reviews spec → `writing-plans` (the **only** skill brainstorming may invoke next) → plan saved → user picks an execution mode → `using-git-worktrees` → `subagent-driven-development` or `executing-plans` → per-task TDD, task review, ledger line → final whole-branch review (`requesting-code-review/code-reviewer.md`) → `finishing-a-development-branch`.

VERIFIED-source:
- `SP6/skills/brainstorming/SKILL.md:20-32,61,128-131` (checklist; "The ONLY skill you invoke after brainstorming is writing-plans")
- `SP6/skills/writing-plans/SKILL.md:156-174` (execution handoff)
- `SP6/skills/subagent-driven-development/SKILL.md:47-83,406-418`
- `SP6/skills/executing-plans/SKILL.md:32-37`

Changes in 7.x:
- writing-plans now requires the user to review the saved plan before anything runs, and offers "Subagent-driven" vs "Native" with a recommendation. VERIFIED-source (`SP7:skills/writing-plans/SKILL.md` "Execution Handoff").
- brainstorming sizes the work. A small change gets a short design with no builder check. VERIFIED-source (`SP7:skills/brainstorming/SKILL.md:228-262`).

### 1.3 Mandatory behavior plangraph must not contradict

From `SP6/skills/using-superpowers/SKILL.md`, which is injected into every main session:
- **L6-8** `<SUBAGENT-STOP>`: subagents dispatched for a specific task ignore the skill.
- **L10-16** "even a 1% chance a skill might apply ... you ABSOLUTELY MUST invoke the skill."
- **L20** "Invoke relevant or requested skills BEFORE any response or action, including clarifying questions, exploring the codebase, or checking files."
- **L22** "Before entering plan mode: if you haven't already brainstormed, invoke the brainstorming skill first."
- **L28-31** Process skills come first. "Let's build X" means brainstorming first.
- **L62** "User instructions (CLAUDE.md, AGENTS.md ...) take precedence over skills."

Hard gates in other skills:
- brainstorming HARD-GATE: no implementation before an approved design (`SP6/.../brainstorming/SKILL.md:12-14`).
- SDD "Continuous execution: Do not pause to check in with your human partner between tasks" (`SP6/.../subagent-driven-development/SKILL.md:17`).
- SDD: "Never: Dispatch multiple implementation subagents in parallel" (`:373`).
- SDD: "Never: Start implementation on main/master branch without explicit user consent" (`:370`).
- verification "NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE" (`SP6/.../verification-before-completion/SKILL.md:18-20`).

Rules this imposes on plangraph skills and the session card (design rules; follow from the above):
- R1. Never tell the agent to "answer directly" or "skip skills". The card is data, not instructions.
- R2. Never insert a brain step between brainstorming and writing-plans. Ingest happens after writing-plans has saved the plan.
- R3. Never ask the agent to stop between SDD tasks to update brain. Brain reads the ledger after the fact, so it needs no cooperation mid-run.
- R4. A brain "plan" skill (planning sprints and people) is not superpowers "planning". Name brain skills so that "plan" in a user request does not pre-empt `writing-plans`/`brainstorming`, and do not claim "Use before any creative work". UNVERIFIED (trigger competition is model behavior; needs an eval).
- R5. Brain's claims ("ready", "done") must cite evidence (ledger line plus commit range), which is consistent with verification-before-completion.

## 2. Artifacts superpowers writes

| Artifact | Path / naming | Created by | Git |
|---|---|---|---|
| Design spec | `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` (user preference overrides) | brainstorming | **committed** ("Commit the design document to git") |
| Plan | `docs/superpowers/plans/YYYY-MM-DD-<feature-name>.md` (user preference overrides) | writing-plans | Not instructed to commit in either version; in practice committed (VERIFIED-example: tracked in this repo) |
| SDD workspace, 6.1.1 | `<worktree-root>/.superpowers/sdd/` + self-ignoring `.gitignore` containing `*` (overwritten every run) | `scripts/sdd-workspace` | ignored |
| SDD workspace, 6.2+/7.x | `<worktree-root>/.superpowers/sdd/<plan-basename>[-<parent>[-N]]/` with a `plan-path` marker file (repo-relative plan path); `.superpowers/sdd/.gitignore` created only if missing | `scripts/sdd-workspace PLAN` | ignored, **deleted after clean final review** |
| Ledger | 6.1.1: `.superpowers/sdd/progress.md`. 7.x: `<workspace>/progress.md` | SDD controller (by hand) or `task-done` (7.x) | ignored |
| Task brief | `<workspace>/task-<N>-brief.md` (verbatim task section) | `scripts/task-brief PLAN N` | ignored |
| Implementer report | `<workspace>/task-<N>-report.md` (free text; Status, RED/GREEN evidence) | implementer subagent | ignored |
| Review package | `<workspace>/review-<base7>..<head7>.diff` (`# Review package`, `## Commits`, `## Files changed`, `## Diff`) | `scripts/review-package [PLAN] BASE HEAD` | ignored |
| Test log (7.x Native) | `<workspace>/task-<N>-tests.log` | `task-done` | ignored |
| Brainstorm companion | `.superpowers/brainstorm/<session-id>/{content,state}`, `.last-port`, `.last-token` | `brainstorming/scripts/start-server.sh --project-dir` | **not auto-ignored**; skill says to remind the user to add `.superpowers/` to `.gitignore`. The session key files are written owner-only. |
| Worktrees | `.worktrees/<branch>` (or `worktrees/`), only when no native tool exists | using-git-worktrees | skill adds the directory to `.gitignore` and commits that |

VERIFIED-source for the table:
- `SP6/skills/brainstorming/SKILL.md:29,106-109`
- `SP6/skills/writing-plans/SKILL.md:18-19`
- `SP6/.../subagent-driven-development/scripts/sdd-workspace:18-22`, `task-brief:7,20-25`, `review-package:8,30-41`
- `SP7:.../scripts/sdd-workspace` (whole file), `SP7:.../executing-plans/scripts/task-done`
- `SP6/skills/brainstorming/visual-companion.md:42-58`, `scripts/start-server.sh:9,117-121`
- `SP6/skills/using-git-worktrees/SKILL.md:63-98`

Extra files are not part of superpowers. The example workspace also holds `global-constraints.md` and `cleanup-a*.md`. Those were written by that run's controller on its own initiative. The parser must ignore unknown files. VERIFIED-example.

### 2.1 Plan grammar

The plan header is mandatory per `SP6/skills/writing-plans/SKILL.md:56-77`. In 7.x, `**Spec:**` and `## Review Focus` are added (`SP7:skills/writing-plans/SKILL.md`). Parse line by line, outside code fences (2.3), with these patterns (JavaScript flavor, `m` flag implied per line):

```
H1            ^#\s+(?<title>.+?)\s*$                      first non-empty line; strip /\s+Implementation Plan$/ for the epic summary
BANNER        ^>\s*\*\*For agentic workers:\*\*.*\bsuperpowers:(subagent-driven-development|executing-plans)\b
FIELD         ^\*\*(?<k>Goal|Architecture|Tech Stack|Spec):\*\*\s*(?<v>.*)$     value may continue on following non-blank lines
SECTION       ^(?<h>#{2})\s+(?<name>Global Constraints|Review Focus)\s*$       body runs to next ^#{1,2}\s or ^---\s*$ or ^#{2,4}\s+Task\s
BULLET        ^\s*[-*]\s+(?<text>.+)$                     one constraint / focus item per bullet; indented lines continue it
HRULE         ^---\s*$
TASK          ^(?<lvl>#{2,4})[ \t]+Task[ \t]+(?<id>[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*)(?<rest>(?:[:\s].*)?)$
              accept only if id contains a digit (/[0-9]/), mirroring SP7 task-brief
TITLE         from rest: ^:?\s*(?:\[(?<alias>[^\]]{1,20})\]\s*)?(?<title>.*)$     the [A1] alias is a real-world convention, not superpowers
FILES_HDR     ^\*\*Files:\*\*\s*(?<inline>.*)$
FILE_ITEM     ^\s*[-*]\s+(?<verb>Create|Modify|Test|Delete|Rename|Move):\s*`(?<path>[^`]+)`(?<more>.*)$
PATH_RANGE    on path: ^(?<p>.+?)(?::(?<a>\d+)(?:-(?<b>\d+))?)?$      strip :123-145 line ranges
INLINE_FILES  in inline/paragraph form: (?:(?<verb>Create|Modify|Test|add|create|modify|delete)\b[^`]*)?`(?<path>[^`\s]+\.[A-Za-z0-9]+|[^`\s]+/)`
              heuristic: keep backticked tokens that look like paths (contain / or a file extension, no spaces, no '(')
IFACE_HDR     ^\*\*Interfaces:\*\*\s*(?<inline>.*)$
IFACE_ITEM    ^\s*[-*]\s+(?<dir>Consumes|Produces):\s*(?<text>.*)$    indented continuation lines append
IFACE_INLINE  \b(?<dir>Consumes|Produces)\b:?\s*(?<text>.*?)(?=\bConsumes\b|\bProduces\b|$)
STEP          ^\s*[-*]\s+\[(?<done>[ xX])\]\s+(?:\*\*)?Step\s+(?<n>\d+)\b[:.]?\s*(?<label>.*?)(?:\*\*)?:?\s*(?<tail>.*)$
              matches "- [ ] **Step 1: Write the failing test**" and "- [ ] **Step 2:** run ..."
ANY_CHECKBOX  ^\s*[-*]\s+\[(?<done>[ xX])\]\s+(?<text>.+)$
TASK_REF      \bTask\s+(?<ref>[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*)\b       references inside Consumes/Produces text
SYMBOL        `(?<sym>[A-Za-z_$][\w$.]*)\s*(?:\(|`)                    identifiers declared in Produces, looked up in later Consumes
```

**Task section boundary.** A task runs from its heading to the next TASK heading at the same or a shallower level, except a deeper heading whose ID extends this one (`#### Task 7a` stays inside `### Task 7`), per `SP7:task-brief`. The task-brief tool and `lib/stale.ts` planSection both end only at the next Task heading. As a result, the **last task of a wave swallows the following `## Wave B` intro**, and the last task of the plan swallows the trailing `## Self-review`. VERIFIED-example (`.superpowers/sdd/task-8-brief.md` ends with the `## Wave B` paragraph). For ingest, end a task section at the first heading of level less than or equal to the task heading's level, or at an HRULE followed by such a heading. Keep the superpowers-compatible span only for fingerprint parity with `lib/stale.ts`.

**IDs.** In 6.1.1, task-brief accepts only `Task[ \t]+[0-9]+` prefix matching, so `Task 6` also matched `6b`. In 7.x the ID is a whole token containing a digit (`3`, `6b`, `A1`, `2.1`) and the comparison is exact. The word must be the English literal `Task`. VERIFIED-source (`SP6/.../task-brief:27-33`; `SP7:.../task-brief` comment block and awk).

### 2.2 Ledger grammar

**Documented line formats.** VERIFIED-source: 6.1.1 `SP6/.../subagent-driven-development/SKILL.md:258-259`; 7.x `git grep` over `SP7:skills`, listed with their files:

```
LEDGER_ID_7   ^#\s*SDD ledger\s*[—-]+\s*plan:\s*(?<plan>.+?)\s*$                         SKILL.md:123, executing-plans/SKILL.md:140, task-done
LEDGER_ID_ANY ^#.*\bledger\b.*?\bplan\b[^A-Za-z0-9]*(?<plan>[^\s;)]+\.md)\b               tolerant (matches the real custom header)
ID            (?<id>[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*)
TASK_PREFIX   ^Task\s+ID(?:\s*\((?<alias>[^)]{1,20})\))?:\s*                              "(A1)" alias seen in the real ledger
COMPLETE      TASK_PREFIX complete\b(?:\s*\((?<detail>.*)\))?\s*$
  detail forms: "commits <b7>..<h7>, review clean" | "commits <b7>..<h7>, <K> parked" | "commits <b7>..<h7>, tests: <cmd> → <last line>"
COMMITS       \bcommits\s+(?<base>[0-9a-f]{7,40}|HEAD)\.\.(?<head>[0-9a-f]{7,40}|HEAD)\b
PARKED_N      \b(?<k>\d+)\s+parked\b
REVIEW_CLEAN  \breview clean\b
TESTS         \btests:\s*(?<cmd>.+?)\s*→\s*(?<last>.*)$
FIX_ROUND     TASK_PREFIX fix round\s+(?<r>\d+)\s*/\s*(?<max>\d+)\s*\((?<x>\d+)\s+addressed,\s*(?<y>\d+)\s+open\b(?<rest>.*)\)\s*$
PARKED        TASK_PREFIX parked\s+[—-]+\s+(?<finding>.+?)\s+[—-]+\s+Ruling:\s*(?<why>.+)$
TASK_RULING   TASK_PREFIX Ruling:\s*(?<finding>.+?)\s+[—-]+\s+(?<decision>.+)$
RULING        ^(?:Task\s+ID:\s*)?Ruling:\s*(?<what>.+?)(?:\s+[—-]+\s+(?<why>.+?))?(?:\s+[—-]+\s+(?<cost>.+))?$
MINOR         ^(?:Task\s+ID|Final):\s*minor\s*\(deferred\):\s*(?<text>.+)$
FINAL_FIXED   ^Final:\s*fixed\s+(?<finding>.+?)\s+[—-]+\s+(?<test>.+?)\s+RED→GREEN,\s*suite\s+(?<p>\d+)\/(?<t>\d+)
FINAL_SELF    ^Final review:\s*self-review\b
```

The 6.1.1 skill specifies only one line, `Task N: complete (commits <base7>..<head7>, review clean)`. Everything else is 6.3+ or 7.x. The preflight table also goes into the ledger in 7.x, but its format is a free-form table (`SP7:.../references/preflight.md`).

**Real-world forms seen (VERIFIED-example) that the strict patterns miss:**
- `Task 1 (A1): implemented 2d69d2b; review 1: Needs fixes (...)` gives `in_progress`, implemented at `2d69d2b`.
- `Task 3: complete (commits 4e3d1b3..HEAD incl. 2855979, ...; 3 review rounds, ...)`. Here `HEAD` is a moving ref: resolve it at ingest time? No: record it as unresolved and flag it.
- Indented `  Minor (final triage): ...` and `  Minor from re-review ...` continuation lines attach to the preceding Task line.
- Unprefixed prose lines (`REUSE AUDIT ...`, `CLEANUP BATCH A ...`) become `unclassified`. Count and surface them; never drop them silently.

**Status derivation per task id. The last matching line wins, except that COMPLETE is sticky.**
- `todo`: no line.
- `in_progress`: any TASK_PREFIX line, FIX_ROUND, or `implemented`.
- `done`: COMPLETE.
- `done_parked`: COMPLETE with K parked, or any PARKED line.

Resume semantics in superpowers itself: "tasks with a `Task <N>: complete` line are DONE ... A task whose last line is a fix round is mid-loop". VERIFIED-source (`SP7:.../references/resuming.md`).

**Ownership check.** Accept a ledger only if its identity line names the plan being ingested. A plan-less ledger is accepted only when it is the legacy flat `.superpowers/sdd/progress.md` and the plan's task IDs and commit ranges are consistent with it. Otherwise refuse with `foreign ledger`. Superpowers itself treats a different-plan ledger, or the old flat path, as "another plan's progress" (`SP7:.../references/resuming.md`).

### 2.3 Code fences

Superpowers' awk toggles on any line matching `/^```/`. It ignores `~~~` and does not pair fence lengths, so a ```` fence wrapping a ``` block (exactly what the writing-plans skill's own Task Structure template does, `SP6/skills/writing-plans/SKILL.md:81-126`) mis-toggles. VERIFIED-source (`SP6/.../task-brief:28`). In 6.1.1 an unclosed fence silently produces a multi-task brief. 7.x refuses with exit 4. VERIFIED-source (`SP7:.../task-brief`; `SP7:RELEASE-NOTES.md` v7.0.2 "#2436").

Brain's parser should implement CommonMark fences: an opener is `^ {0,3}(`{3,}|~{3,})`, and the closer uses the same character with length greater than or equal to the opener. On EOF inside a fence, emit error `unclosed fence at line N` and **refuse** the ingest (fail loudly, like 7.x).

## 3. Hooks and context cost

- One hook: `SessionStart`, matcher `startup|clear|compact` (**not** `resume`), command `"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd" session-start`, `async: false`. VERIFIED-source (`SP6/hooks/hooks.json`). 7.x adds a `powershell` form and `"shell": "bash"`. VERIFIED-source (`SP7:hooks/hooks.json`).
- Output: JSON `hookSpecificOutput.additionalContext` holding `<EXTREMELY_IMPORTANT>\nYou have superpowers.\n\n**Below is the full content of your 'superpowers:using-superpowers' skill ...**` followed by the full `using-superpowers/SKILL.md`. VERIFIED-source (`SP6/hooks/session-start:11,27,46-48`).
- Size, measured by running the installed hook: 3,484 bytes of JSON; the additionalContext string is 3,276 chars / 509 words, about **820 tokens** by the repo's `ceil(chars/4)` rule. The 7.0.2 SKILL.md is 3,192 bytes (vs 3,063), so cost is about the same. VERIFIED-source (measured). Beyond that, the 14 skill descriptions add about 2,711 chars (about 680 tokens) to the skill listing every session. VERIFIED-source (measured). The exact tokenizer count is UNVERIFIED.
- It re-injects on every `/clear` and every compaction. VERIFIED-source (matcher).

**Coexistence rules for the brain card (design):**
- Brain's hook (`hooks/hooks.json`: `startup|resume|clear|compact|fork`, `brain card --if-present`) is independent. Claude Code concatenates additionalContext from both. Sharing an event is safe. UNVERIFIED: ordering between plugins' SessionStart hooks is not documented here.
- The card must not restate any skill guidance ("use TDD", "brainstorm first"). That would duplicate about 800 tokens of text the model already has, and could conflict on wording.
- The card may carry at most one superpowers-aware line when relevant, for example `sp: plan 2026-11-20-widget-export 3/5 done (ledger), next Task 4`. Derive it from the brain index, never by reading superpowers files in the hook (hook p95 budget is 150 ms, plan Task 15).
- Do not wrap card text in `<EXTREMELY_IMPORTANT>` or similar tags. That is superpowers' convention, and stacking such blocks dilutes both.

## 4. Detection (cheap, reliable)

Evaluate in order; every check is a file read or JSON parse.

1. **Installed (user):** `~/.claude/plugins/installed_plugins.json` (top-level `version: 2`). Look for any key matching `/^superpowers@/` under `.plugins`. Its value is an **array** of installs `{scope: "user"|"project", projectPath?, installPath, version, installedAt, lastUpdated, gitCommitSha}`. VERIFIED-source (local file). The marketplace suffix varies: `superpowers@superpowers-dev` (repo marketplace) or `superpowers@claude-plugins-official` (official listing, `~/.claude/plugins/marketplaces/claude-plugins-official/.claude-plugin/marketplace.json`). VERIFIED-source. Match on the name before `@`.
2. **Enabled:** `enabledPlugins["superpowers@<mkt>"] === true` in, by precedence, `<repo>/.claude/settings.local.json`, then `<repo>/.claude/settings.json`, then `~/.claude/settings.json`. VERIFIED-source (`~/.claude/settings.json` has `"superpowers@superpowers-dev": true`). The precedence order is the documented Claude Code settings hierarchy and is UNVERIFIED here. Treat "installed but explicitly `false`" as disabled.
3. **Project install:** an `installed_plugins.json` entry with `scope:"project"` and `projectPath` equal to the repo root. VERIFIED-source (such an entry exists for another local project).
4. **Version:** `installPath/.claude-plugin/plugin.json` → `.version`. Fallback to the `version` field of the install entry. VERIFIED-source.
5. **Runtime (inside a session):** `CLAUDE_PLUGIN_ROOT` is set only for the plugin's own hook, so brain cannot use it. Instead, the skill listing contains `superpowers:` entries. UNVERIFIED as a programmatic signal; skip it.
6. **Project markers (used, not installed):** `docs/superpowers/plans/*.md` whose first 5 lines match BANNER; `docs/superpowers/specs/*-design.md`; `.superpowers/sdd/` in any worktree root from `git worktree list --porcelain`. These prove usage even when the plugin is absent on this machine (for example, a teammate's plan).

Output a `brain doctor` line such as `superpowers: 6.1.1 enabled (user); upstream ledger format >=6.2 differs: run plugin update`. That gives version-drift awareness without network: compare against a `KNOWN_FORMATS` table in brain.

## 5. Integration design, ranked by value

### 5.1 (a) INGEST a plan [ingest]: highest value

Command: `brain sp-ingest <plan.md> [--ledger auto|PATH|none] [--epic KEY] [--dry-run]`. It is read-only on superpowers files. It writes only `.brain/*.jsonl` through `writeAtomic`. It is idempotent: the same inputs give byte-identical JSONL, because the canonical form (FORMAT.md section 1) guarantees it once the records are deterministic.

**Keys.**
- Plan slug = basename without `.md` (the same slug superpowers' workspace uses).
- Epic pseudo-ticket key: `sp:<slug>`.
- Task ticket key: `sp:<slug>/<task-id>`, for example `sp:2026-11-20-widget-export/3`.

Rationale: plan-local IDs are only unique per plan; the slug mirrors `sdd-workspace`. Keys must never collide with Jira keys, and Jira keys never contain `:`. Do not use the `[A1]` alias as the key (it is not superpowers syntax). Store it as an unknown field `alias`, which FORMAT.md section 1 preserves.

**Renumbering risk.** Inserting a task renumbers later ones, so keys shift. Store `title_fp = sha16(normalized title)` on each ticket. When re-ingest sees key K with a different title_fp while another key now carries the old title_fp, report `renumbered: sp:x/4 -> sp:x/5` and stop, unless `--accept-renumber`. Re-pointing edges, schedule and refs silently would corrupt assignments. A plan file rename changes the slug: treat it as a new epic and report `orphaned epic sp:<old>`.

**Mapping.**

| superpowers | plangraph record |
|---|---|
| H1 (minus " Implementation Plan"), Goal | `tickets {key: "sp:<slug>", summary: <title>, epic: "", sp: null, jira_status: "", verdict: "", verdict_source: "sp-ingest"}` + unknown fields `kind: "sp_plan"`, `goal` (sanitized, capped) |
| `### Task N: Title` | `tickets {key: "sp:<slug>/N", summary: Title (sanitized, ≤200), epic: "sp:<slug>", sp: null}` + `kind: "sp_task"`, `alias`, `title_fp`, `order: i` |
| Task order | **not** an edge by default. SDD executes serially anyway (no parallel implementers, `SP6/.../SKILL.md:373`), so order constrains one executor, not handoffs. Opt-in `--order-edges` adds `edges {consumer: task i+1, producer: task i, kind: "sp_order"}` |
| `Consumes:` text with `Task M` | `edges {consumer: "sp:<slug>/N", producer: "sp:<slug>/M", kind: "sp_consumes", note: <≤120 chars>}` |
| `Produces:` symbol S of task M, found in `Consumes:` of task N (M before N) | `edges {..., kind: "sp_iface", note: "S"}`. Only exact backticked identifiers; ambiguous symbols (produced by 2+ tasks) become a finding, never an edge |
| Consumes text naming a task in another plan or a Jira key | `findings {key: task, kind: "sp_external_dep", text}`. A person decides; brain never guesses cross-plan edges |
| Consumes "nothing" / missing Interfaces | no edge. A task with no Interfaces block gets `findings kind "sp_no_interfaces"` (6.0+ plans should have one) |
| `**Files:**` items | `refs {key: task, files: {"<path>": ""}}` (fingerprints are filled by the existing `refs-update`/stale machinery), `plans: [{plan: "<repo-rel path>", task: "N"}]`. The verb (Create/Modify/Test) goes into an unknown field `file_verbs` |
| `## Global Constraints` bullets | `findings {key: "sp:<slug>", kind: "sp_constraint", text}`, one per bullet. **Not** `learnings`: per `docs/REUSE.md`, learnings are cross-project planning-method rules served by `brain rules`; per-plan constraints there would pollute every project. A person can promote one with an explicit `brain learn --from-finding` (not built; recommend-only) |
| `## Review Focus` bullets (7.x) | `findings {key: "sp:<slug>", kind: "sp_review_focus", text}` |
| `**Spec:**` path / sibling `docs/superpowers/specs/<date>-<topic>-design.md` | `refs {key: "sp:<slug>", files: {"<spec path>": ""}}`, so spec edits make the epic stale through the existing `lib/stale.ts` |
| Ledger status per task | unknown field `impl_status: todo\|in_progress\|done\|done_parked`, plus `impl_range: "<b7>..<h7>"` on the ticket. **Not** `jira_status`: that field means "status in Jira" and is overwritten by `jira-pull`/`jira-import`. Add `impl_status` through FORMAT.md's expand step (optional field, default `""`) |
| Ledger `Ruling:` / `parked` / `minor (deferred)` | `findings {key: task or "sp:<slug>", kind: "sp_ruling"\|"sp_parked"\|"sp_minor", text}`. This is the durable record superpowers deletes |
| Checkbox state | Ignored for status (finding 2). Only `done == total` across all steps of a task, with no ledger, gives the weak hint `impl_status: "done?"`. That covers someone ticking boxes by hand or the Antigravity harness |

**Idempotence and round-trip rules.**
- Brain owns every `sp:<slug>*` record. Re-ingest computes the full desired set for that slug, then diffs: add, update and remove only records with `verdict_source == "sp-ingest"` or kind `sp_*`. It never touches `schedule` rows (people and sprints assigned in brain survive re-ingest) unless the task key disappeared. In that case it reports `schedule row for removed task` and leaves it.
- It never writes into `docs/superpowers/**` or `.superpowers/**`. A test asserts mtime and bytes are unchanged for every superpowers file after ingest.
- The ledger is optional input. A missing ledger means "no new status info", **not** "todo": keep the last ingested `impl_status`. A 7.x workspace deleted after the final review must not reset progress. Use git as a fallback (`git log --format=%s` lines matching `Task N`) only as a hint, flagged `impl_source: "git-heuristic"`.
- `--dry-run` prints the diff as counts plus at most 20 lines, per the CONTRACT token budget.

**Ledger discovery.**
- 7.x: for each worktree root in `git worktree list --porcelain`, look in `.superpowers/sdd/*/plan-path` for a marker equal to the plan's repo-relative path. The ledger is the `progress.md` next to the marker.
- 6.1.1: `.superpowers/sdd/progress.md`, accepted only after the ownership check (2.2).
- SDD runs in a worktree (`.worktrees/<branch>/...`), so the ledger usually lives **outside the main checkout**. VERIFIED-source (`sdd-workspace` resolves `git rev-parse --show-toplevel` of the cwd).

### 5.2 (b) Link plans to Jira tickets, people and sprints [ingest + read-through]

- Link: `brain sp-link <JIRA-KEY> <plan.md> [--tasks 1,2,4]` writes `refs {key: JIRA-KEY, plans: [{plan, task}...]}`. `refs.plans` and `lib/stale.ts` already support this. It also writes `edges {consumer: JIRA-KEY, producer: "sp:<slug>/<t>", kind: "sp_implements"}`, so the Jira ticket is only `ready` to close once its tasks are `done`. Direction follows "consumer needs producer".
- Suggest, never auto-link: if the plan filename, H1 or Goal contains `/\b[A-Z][A-Z0-9]+-\d+\b/`, print `suggest: brain sp-link KEY plan.md`. Superpowers has no ticket field, and brain must not edit the plan to add one.
- People and sprints: assignment uses brain's normal `schedule` (owner, sprint) on `sp:` keys. The strict handoff rule then applies to `sp_consumes`/`sp_iface` edges: if Task 4 consumes Task 2 and they have different owners, Task 2 must land a sprint earlier. Brain adds unique value here, because superpowers assumes one executor per plan.
- **Adversarial caveat:** SDD has no "execute only tasks X to Y" mode. It resumes at the first task without a `complete` line (`SP7:.../references/resuming.md`). Splitting one plan across people therefore means either (i) brain recommends splitting the plan into per-owner plans (preferred), or (ii) each person tells their controller explicitly "execute Tasks 3-4 only". Option (ii) is UNVERIFIED to be honored reliably, and both people's ledgers would live in different worktrees. Brain must merge ledgers per task and flag a task marked complete in two ledgers with different ranges.
- `sp` (story points) stays empty. Do not invent estimates from step counts. Forecasting on these tickets needs history, which `lib/forecast` already refuses without.

### 5.3 (c) Hand-off points [recommend-only]

Brain skills print the next action. They never invoke superpowers skills programmatically and never restate their content.

| Situation in brain | Brain recommends | Feed back into brain |
|---|---|---|
| Ticket with no plan, verdict needs design | "Use superpowers:brainstorming, then superpowers:writing-plans" | after the plan is saved: `brain sp-ingest <plan> && brain sp-link KEY <plan>` |
| Plan ingested | `brain check`/`verify` on `sp:` edges; assign owners and sprints (`whatif`) | schedule rows |
| A person starts a ticket | "Execute with superpowers:subagent-driven-development (Native/executing-plans for cheap)", plus the plan path and task list for that person | none during the run (rule R3) |
| Run in progress / resumed session | card line from last ingest; `brain sp-ingest --ledger auto` refreshes | impl_status, rulings |
| Implementer claims done | brain says "unverified" until a ledger COMPLETE line exists; points to superpowers:verification-before-completion | — |
| After the final review, before finishing-a-development-branch deletes the workspace (7.x) | "run `brain sp-ingest` now: the ledger is deleted after the final review" | rulings and parked findings kept |
| finishing-a-development-branch option 1/2 | `brain verify`, `brain ready <JIRA-KEY>`; Jira transition via the Atlassian connector (REUSE: brain never writes Jira) | — |

Ordering conflict: in 7.x, SDD deletes the workspace **before** invoking finishing-a-development-branch (`SP7:.../SKILL.md` process graph: "Final review clean: delete this plan's workspace" → finishing). No hook point exists between them. Only a SessionStart or Stop-time ingest, or the user, can catch the ledger in time. Mitigation: brain ingests on every card refresh when a matching workspace exists. That costs one stat plus a read of a small file, and has to fit the 150 ms budget (UNVERIFIED that it fits). Keep `impl_status` sticky so a deleted ledger is harmless.

### 5.4 (d) Never duplicate [never touch]

Plan writing, spec writing, TDD discipline, per-task and whole-branch code review, parallel-agent orchestration, worktree creation and cleanup, branch finishing menus, verification rhetoric, model-selection guidance. Also: never generate superpowers-format plans from brain tickets. That would be a second plan writer, and writing-plans has a self-review and user-review gate brain would bypass. Already consistent with `docs/REUSE.md` row "Dev workflow ... superpowers skills: Reuse".

### 5.5 Summary

| # | Integration | Mode |
|---|---|---|
| 1 | Plan → tickets, edges, refs, constraint findings | ingest |
| 2 | Ledger → impl_status, rulings, parked, minors (durable copy) | ingest |
| 3 | Plan task section fingerprints via `refs.plans` / `lib/stale.ts` | read-through |
| 4 | Detection and version-drift line in `brain doctor` | read-through |
| 5 | Jira ↔ plan links, people and sprints with the handoff rule on sp edges | ingest (brain-owned records) |
| 6 | Hand-off recommendations in brain skills | recommend-only |
| 7 | Card line for active plan progress | read-through (from the index) |
| 8 | Plan writing, TDD, review, worktrees, parallel agents, finishing | never touch |

## 6. Conflicts and risks

1. **Instruction conflicts.** (i) using-superpowers "invoke skills before ANY response" vs a brain skill telling the model to run `brain card` first. Fine if the brain skill is itself a skill being invoked; harmful if the card says "do X before anything" (R1). (ii) brainstorming "ONLY writing-plans next" vs brain wanting ingest in between (R2). (iii) SDD "do not pause" vs any brain request for mid-run updates (R3). (iv) superpowers defaults to a feature branch and a worktree; this repo's Global Constraints say "local commits only on the working branch". User instructions win per using-superpowers L62, and brain should not add a third opinion. (v) The word "plan": brain sprint plans vs superpowers implementation plans (R4). VERIFIED-source for the quoted rules; trigger competition is UNVERIFIED.
2. **Hook size.** About 820 tokens per startup, clear and compact from superpowers, plus brain's card. Keep the card under its CONTRACT budget and never echo skill text (section 3).
3. **Prompt injection.** Plans, specs, ledgers, briefs and reports are agent-written free text. They may quote web pages, issue text or Jira descriptions, and other agents read brain output. The brainstorm companion even relays browser events "the agent treats as your input" (`SP6/RELEASE-NOTES.md` v6.0.0 companion section). Brain must:
   - pass every ingested string through `lib/sanitize.ts` `sanitizeText` (control, OSC, bidi, zero-width, tag characters) and cap it: summary ≤200, finding ≤500, note ≤120;
   - print it only inside `fence('sp-plan'|'sp-ledger', ...)`;
   - never put plan text in the card, only counts and keys;
   - store paths only after `checkRepoPath` (no absolute paths, no `..`, no leading `-`), and drop the `:123-145` suffix before the check;
   - never execute `Run:` commands or `tests:` commands from plans or ledgers (consistent with the Task 3 removal of command execution);
   - treat `**Spec:**` as a path to fingerprint, never to follow outside the repo;
   - cap input size (reuse `readCapped`, refuse non-regular files) and cap counts (≤500 tasks, ≤2,000 ledger lines, else refuse);
   - never treat ledger text as an instruction ("Ruling: delete X" is data).
4. **Version drift.** Breaks if: the heading word or shape changes (7.x already requires literal English `Task`); the `.superpowers/sdd` layout moves again (it moved in 6.0.3 and in 6.2.0); ledger phrasing changes (`complete` is the only line stable across versions); `**Files:**`/`**Interfaces:**` labels change; the plan location is overridden by user preference. Strategy:
   - Parse tolerantly (case-insensitive labels, inline and list forms, `—` or `-` separators).
   - Classify every line as recognized, ignored-known or unclassified, and print `sp-ingest: 3 unclassified ledger lines (first: line 14)`.
   - Fail loudly with exit 2 and write nothing on: zero Task headings in a file with BANNER; an unclosed fence; duplicate task IDs; a foreign ledger; a COMPLETE line for an unknown task ID; a renumbering conflict.
   - Record `sp_format: "6.1"|"7"` (detected via `**Spec:**`/`## Review Focus`/ledger identity line) and the superpowers version from detection in `meta.jsonl`, so later diffs explain themselves.
5. **Ephemeral and moving inputs.** A 7.x workspace is deleted after the final review, and `git clean -fdx` deletes it in any version. `HEAD` in a recorded range moves. The ledger lives in a worktree that may be removed by finishing option 1 or 4. Keep status sticky, store short SHAs as given, and never resolve `HEAD` later.
6. **Checkbox false negatives** (finding 2). Any brain logic computing progress from `- [x]` is wrong for superpowers runs.
7. **Plan edits after ingest.** SDD controllers in 6.3+ record rulings instead of editing the plan, but humans and controllers do edit plans (the real ledger says "plan revised", "plan updated"). VERIFIED-example. The existing stale machinery on `refs.plans` detects this per task. Re-ingest is required for structural changes.

## 7. Parsing spec and synthetic fixtures

Fixture names are invented. Use the files under `test/fixtures/superpowers/`. They are not created by this research; this section is their content.

### 7.1 Parser contract (for `lib/superpowers.mjs`, pure, no I/O)

```
parsePlan(text, { path }) -> {
  format: '6.1' | '7',                // '7' if **Spec:** or ## Review Focus present
  title, goal, architecture, techStack, spec: string|null,
  constraints: string[], reviewFocus: string[],
  tasks: [{ id, alias|null, title, level, line, files: [{verb, path, range|null}],
            consumes: string, produces: string, steps: [{n, label, done}] }],
  errors: string[], warnings: string[]   // errors => caller writes nothing
}
parseLedger(text, { planPath }) -> {
  identity: string|null, owned: boolean,
  tasks: Map<id, { status, base|null, head|null, parked: number, lines: number[] }>,
  rulings: [{ task|null, text, line }], minors: [...], parked: [...],
  unclassified: [{ line, text }]
}
toRecords(plan, ledger|null, { slug, existing }) -> { tickets, edges, refs, findings, report }
```

Determinism rules: sort tasks by file order; sort edges by (consumer, producer) with plain `<`; no timestamps in records.

### 7.2 Fixture: spec `docs/superpowers/specs/2026-11-20-widget-export-design.md`

```markdown
# Widget Export Design

## Intent

Teams want to export their widget list to CSV so they can share it in a spreadsheet.

## Goals

- Export all widgets for one workspace as RFC 4180 CSV.
- Columns: `id,name,color,created_at`, in that order.

## Non-goals

- Import. Excel-specific formats.

## Constraints

- Max 50,000 rows per export; above that return error `EXPORT_TOO_LARGE`.
- Dates in ISO 8601 UTC.

## Approach

Stream rows from the store through a pure formatter; the HTTP handler only sets headers.
```

### 7.3 Fixture: plan `docs/superpowers/plans/2026-11-20-widget-export.md`

```markdown
# Widget Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Export a workspace's widgets as RFC 4180 CSV.

**Architecture:** A pure CSV formatter, a streaming store query, and a thin HTTP handler that wires them together.

**Tech Stack:** Node 24, node:test.

**Spec:** docs/superpowers/specs/2026-11-20-widget-export-design.md

## Global Constraints

- Columns are exactly `id,name,color,created_at`, in that order.
- Max 50,000 rows per export; above that the error code is `EXPORT_TOO_LARGE`.
- Dates are ISO 8601 UTC.

## Review Focus

- A widget name containing a comma, quote or newline must round-trip through a spreadsheet unchanged.

---

### Task 1: CSV formatter

**Files:**
- Create: `src/export/csv.mjs`
- Test: `test/export/csv.test.mjs`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `formatRow(widget: {id, name, color, createdAt: Date}): string` and `HEADER: string`.

- [ ] **Step 1: Write the failing test**

```js
test('formatRow quotes commas and quotes', () => {
  assert.equal(formatRow({ id: 1, name: 'a,"b"', color: 'red', createdAt: new Date(0) }), '1,"a,""b""",red,1970-01-01T00:00:00.000Z');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/export/csv.test.mjs`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement `formatRow` in `src/export/csv.mjs`**

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/export/csv.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

### Task 2: Streaming widget query

**Files:**
- Modify: `src/store/widgets.mjs:40-62`
- Test: `test/store/widgets.test.mjs`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `streamWidgets(workspaceId: string, { limit: number }): AsyncIterable<Widget>` that throws `ExportTooLarge` past `limit`.

- [ ] **Step 1: Write the failing test** for 50,001 rows throwing `ExportTooLarge`.
- [ ] **Step 2: Run** `node --test test/store/widgets.test.mjs`, expect FAIL.
- [ ] **Step 3: Implement** `streamWidgets`.
- [ ] **Step 4: Run** the test, expect PASS.
- [ ] **Step 5: Commit**

### Task 3: Export HTTP handler

**Files:**
- Create: `src/http/export-handler.mjs`
- Test: `test/http/export-handler.test.mjs`

**Interfaces:**
- Consumes: `formatRow` and `HEADER` from Task 1; `streamWidgets` from Task 2.
- Produces: `GET /workspaces/:id/widgets.csv`.

- [ ] **Step 1: Write the failing test** asserting `content-type: text/csv` and the first line equals `HEADER`.
- [ ] **Step 2: Run** `node --test test/http/export-handler.test.mjs`, expect FAIL.
- [ ] **Step 3: Implement** the handler; map `ExportTooLarge` to HTTP 413 with body `EXPORT_TOO_LARGE`.
- [ ] **Step 4: Run** the test, expect PASS.
- [ ] **Step 5: Commit**
```

### 7.4 Fixture: ledger `.superpowers/sdd/2026-11-20-widget-export/progress.md` (7.x layout)

Sibling file `plan-path` contains `docs/superpowers/plans/2026-11-20-widget-export.md`.

```
# SDD ledger — plan: docs/superpowers/plans/2026-11-20-widget-export.md
Preflight: Task 3 consumes formatRow/HEADER (Task 1) and streamWidgets (Task 2): names and types agree. Clean.
Task 1: complete (commits a1b2c3d..b2c3d4e, review clean)
Task 1: minor (deferred): HEADER is not exported as a frozen constant
Task 2: fix round 1/5 (1 addressed, 0 open — limit off by one; commits b2c3d4e..c3d4e5f)
Task 2: complete (commits b2c3d4e..c3d4e5f, review clean)
Task 3: fix round 1/5 (0 addressed, 1 open — 413 body is JSON not plain text; commits c3d4e5f..d4e5f6a)
Ruling: plain-text 413 body per spec Constraints — spec names the code, not a JSON shape — a client parsing JSON would break
```

### 7.5 Expected records (golden, abbreviated)

```
tickets:  sp:2026-11-20-widget-export        kind sp_plan  summary "Widget Export"
          sp:2026-11-20-widget-export/1      impl_status done         impl_range a1b2c3d..b2c3d4e
          sp:2026-11-20-widget-export/2      impl_status done         impl_range b2c3d4e..c3d4e5f
          sp:2026-11-20-widget-export/3      impl_status in_progress
edges:    (sp:…/3 <- sp:…/1, sp_consumes)  (sp:…/3 <- sp:…/2, sp_consumes)
          sp_iface edges for formatRow, HEADER, streamWidgets are deduplicated into the sp_consumes edge note, not separate rows (same pair)
refs:     sp:…/1 files {src/export/csv.mjs, test/export/csv.test.mjs} plans [{plan: docs/superpowers/plans/2026-11-20-widget-export.md, task: "1"}]
          sp:…/2 files {src/store/widgets.mjs (range 40-62 stripped), test/store/widgets.test.mjs}
          sp:2026-11-20-widget-export files {docs/superpowers/specs/2026-11-20-widget-export-design.md}
findings: sp:2026-11-20-widget-export sp_constraint ×3, sp_review_focus ×1, sp_ruling ×1
          sp:…/1 sp_minor "HEADER is not exported as a frozen constant"
report:   format 7, 3 tasks, 2 edges, 1 unclassified-free ledger (Preflight line = ignored-known)
```

### 7.6 Negative fixtures (each must exit 2 and write nothing)

1. The plan with Task 2's closing ``` removed (unclosed fence).
2. A plan whose headings say `### Tarea 1:` (no Task headings; list the task-shaped headings).
3. A ledger whose identity line names `docs/superpowers/plans/other.md` (foreign ledger).
4. A ledger with `Task 9: complete (...)` (unknown task).
5. A plan where a new Task 2 was inserted after a previous ingest (renumber conflict).
6. A plan with two `### Task 2:` headings (duplicate ID).
7. A Files item with `` `../../etc/passwd` `` or `` `/abs/path` `` (path refused, reported, other files kept). This is a warning, not a refusal.
8. A 6.1.1 flat ledger `.superpowers/sdd/progress.md` with no identity line, plus a real-world variant using `Task 1 (A1): implemented <sha>; review 1: Needs fixes`, indented `Minor` lines and a prose line. Expected: in_progress, continuation lines attached, 1 unclassified.

## 8. What I could not verify

- Exact token counts with the real tokenizer. I used chars/4.
- Ordering and concatenation of additionalContext from two plugins' SessionStart hooks. That `resume` does not re-run superpowers' hook is verified from the matcher; the context still present after resume is not verified.
- The settings precedence for `enabledPlugins` across user, project and local files (assumed from Claude Code conventions, not read in docs during this session).
- Whether an SDD controller reliably honors "execute only Tasks X to Y" when asked.
- Whether trigger competition between a brain skill mentioning "plan" and superpowers' writing-plans or brainstorming changes which skill fires (needs an eval).
- Whether a 7.x-written plan actually omits code in practice. The skill says so; I saw no 7.x plan output.
- Upstream web docs beyond the release notes. The upstream source was read from the local git clone at tag v7.0.2 (sha `22f0b46`), which matches the official marketplace pin. Web confirmation of the versions: https://github.com/obra/superpowers/releases , https://raw.githubusercontent.com/obra/superpowers/HEAD/RELEASE-NOTES.md , https://newreleases.io/project/github/obra/superpowers/release/v7.0.2 (VERIFIED-docs: release list and notes exist; content was read from source).
- Side effect disclosure: to compare versions I ran `git fetch` in the superpowers marketplace clone under `~/.claude/plugins/marketplaces/superpowers-dev`. That updated its remote-tracking refs and objects but not the working tree, the installed cache or any settings. No other file outside this report was changed.
