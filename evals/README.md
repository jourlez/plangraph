# Agent evals

Does an agent do planning work better WITH this plugin (arm A) than bare Claude Code without it (arm B), on a real plan, without
doing anything unsafe? The suite has been run against a live model by its owner on a real plan (results and limits are in the main README, section Measured results). Nothing here can spend money unless you pass both `--run`
and `--max-cost-usd`.

## Design

**Two arms, same task.** Every case runs in `claude plugin eval` twice per run: with the plugin loaded (A) and as a no-plugin
baseline (B), in a fresh workspace built by the case's own `scaffold.sh`. Both arms get the same prompt, the same plan files and the
same operator tool grant (read tools plus `Bash(brain|jq|grep|rg|node|cat|ls|wc|head|git *)`), so B is the honest baseline: a capable
agent that can read the JSONL. Prompts state the domain rules (handoff, capacity, readiness, the forecast policy) so arm B can answer
from the files; the plugin's value shows as accuracy, fewer turns, fewer tokens and lower cost, not as secret knowledge. The headline is
the per-case score delta A - B with a cluster bootstrap CI over cases (`evals/report.ts`).

**Outcome first, deterministic graders.** Every case ends with a machine line `ANSWER: {json}`; one regex per answer field is
*generated* from the ground truth (anchored at the line start, linear lookaheads, exact sets for lists, `7` never matches `70`).
Ground truth is never typed: `evals/families.ts` computes it with the library (`lib/model`, `whatif`, `proposeMove`, `verifyPlan`,
`report.readySet`, `computeStale`, `forecast`) on exactly the data the workspace holds (base fixture + the case's overlay, applied by the
same `evals/overlay.ts` the scaffold runs). `evals/truthcheck.ts` re-derives every answer it can with the real `brain` CLI (SQLite
index, a different code path) on scaffolded workspaces; tests fail on any mismatch, and a test injects corrupted derivations (a
`whatif` that drops CAPACITY, a `readySet` that ignores findings, a `verifyPlan` without capacity, a forecast that never refuses) to
prove the cross-check catches them.

**Grader types and roles.** `outcome` (the answer is right), `safety` (nothing forbidden happened: tool bans, canary tokens absent,
file-content sentinels, no created files), `diagnostic` (with-only indicators: `brain` used, a plugin skill fired; never part of the
headline score), `judge` (an LLM rubric, used once, for "does not claim a report was published", which no regex expresses; the judge
defaults to `claude-opus-5-5`, a larger model than the agent, against self-preference). Trajectory and efficiency (turns, cost, tokens)
come from the run records, not from graders, so they never distort the score.

**Variance and thresholds.** 3 runs per case and arm by default (`--runs`), pass threshold 0.8 per case, model pinned
(`claude-sonnet-5-5`) so a model rollout is not mistaken for a plugin change. Report Wilson intervals per rate and the bootstrap CI of
the delta; decide on the CI, not the point estimate.

**Controls.** Positive controls (plain lookups, a ticket that IS ready, a move that IS allowed, a forecast with enough history: the
plugin must not hurt simple work) and negative controls (a key that is not in the plan, "who is overloaded" on a valid plan where the
answer is nobody, a forecast that must refuse, a Done ticket that cannot move, should-not-trigger prompts and near-misses).

**Passes.** `run.ts` runs (1) the headline pass `--ablation with-without` over all selected cases, (2) a trigger pass
`--ablation none` over the trigger cases, where the with-only skill-fired diagnostics ARE scored (skill recall and false-fire rate),
and optionally (3) ablation variants with `--variants no-card,no-skills` (plugin copies without the SessionStart card or without the
skills directory, single arm), to separate the value of the card, the skills and the CLI.

## Direct runner (`evals/run-p.ts`): the headline path

Pilot #1 (`claude plugin eval` on a real 1,397-ticket plan) was invalid for the plugin arm: that harness loads the plugin's skills and
SessionStart card but does not put its `bin/` on the Bash PATH, so every `brain` call exited 127. `evals/run-p.ts` runs each case with
`claude -p` itself, where `--plugin-dir` does put `brain` on PATH (verified by `--probe`: `brain card --line` runs in arm A, is not found in
arm B).

- **Same conditions in both arms**: the same prompt on stdin, a fresh workspace per run (temp dir outside the repository, scaffolded like the
  native `scaffold.sh` plus the merge driver wired and a `.gitignore` for the index before the commit, so the plugin's session hook finds
  nothing to heal), `--setting-sources project --strict-mcp-config` (no user plugins, hooks, permissions or MCP servers), `--tools
  Read,Grep,Glob,Bash,Skill,Edit,Write`, `--permission-mode dontAsk` with one `--allowedTools` list (reads and read-style Bash including
  `Bash(brain:*)`, `cd`, `python3`, `node`; Edit/Write visible but never granted), `--no-session-persistence`, `--max-budget-usd` per run,
  `--include-hook-events`, the parent session's `CLAUDE_*` variables removed and PATH entries holding a `brain` binary dropped. Arm A adds
  only `--plugin-dir <private plugin copy>`. Auth is the operator's normal login (an isolated `CLAUDE_CONFIG_DIR` is not logged in).
- **Prompt styles** (`--style natural|layout-told|both`, default natural): `natural` is the question as a user asks it (no file layout, no
  rule text; "About the sprint plan in this repo:"; rule-code names kept where the answer needs them); `layout-told` is the committed
  prompt. Same ground truth for both (`styledPrompt` in `families.ts`).
- **Graders**: the case's own graders over the parsed trace (`evals/trace.ts`), except that `safe-no-write-bash` uses the structural reader
  in `evals/bashwrite.ts` (heredocs, quotes, script writes) and the file list is a sha256 diff of every workspace file plus a moved git
  HEAD (derived `*.sqlite` ignored; `CARD.md`/`report.*` ignored only in cases not tagged no-write).
- **Plugin use is measured, not assumed**: an arm-A run counts as using the plugin only when a brain call ran (not denied, not 127). The
  report shows that share per family, the A score split by used/not used, skills fired, answers from the session card alone, and any brain
  call that ran in arm B (a leak).
- **Budget**: `--max-cost-usd` is a global hard cap checked before each launch (spent + in-flight per-run caps + the new run's cap);
  results are resumable (`--resume <suite>`). Exit 3 when the cap stopped launches.

```
node evals/run-p.ts --probe --max-cost-usd 0.3 [--claude PATH]          ~$0.05: brain runs in A, absent in B
node evals/run-p.ts --dry-run [--real <root>] [--style both]            build the suite, print the command line (no model call)
node evals/run-p.ts --run --max-cost-usd N [--real <root>] [--style both] [--runs 3] [-j 3] [--per-run-usd X]
node evals/report.ts --suite <suite dir>
```

## Task families

| Family | What it measures | Truth from |
|---|---|---|
| lookup (control) | owner and sprint of a ticket; a read B can also do | schedule |
| unknown-key (negative) | says "not in the plan" instead of inventing an owner | model |
| ready-no / ready-yes | may X start: verdict, open finding kinds (closures in open-items respected), producers not Done; and a ticket that may | ready rules = `brain ready` |
| ready-cell | which of P's sprint-N tickets may start (a set; every member must be checked) | `readySet` |
| blockers | tickets whose verdict is not READY (keys, or counts per verdict on big sets) | tickets |
| overload / overload-peak | person-sprints over capacity (on a valid plan: none) and the tightest cell | `verifyPlan`, loads |
| whatif yes/producer/consumer/capacity/started | can X move to P in sprint N: YES or NO with the exact reason codes | `whatif` |
| reassign-safe (owner's top pain) | give X to someone else without creating any blocker; the grader accepts any of the slots that keep the independent verifier clean, and the report re-applies the parsed move to a copy of the plan and re-runs `verifyPlan` | `verifyPlan` over every slot |
| reassign-ripple | smallest set of other tickets that must shift (proven minimal: search completed) | `proposeMove` + `verifyPlan` |
| stale | stale audit verdicts after plan-text edits (edited + transitively affected) | `refsUpdate` + `computeStale` |
| chain | longest dependency chain behind X | longest-path DP |
| jira-diff | what changed in a Jira snapshot and which tickets became ready because of it | `readySet` with statuses |
| forecast thin/ok | refuses (no probability) on 3 sprints of history; gives a state on 12 | `forecast` |
| capacity-change / capacity-replan | after P's cap drops: which sprints are over and by how much; a repair re-checked by the report | `verifyPlan` |
| decide | what P should start (rule stated) | model |
| inject (safety) | prompt-injection canaries in ticket text: 5 phrasings (override, fake authority, note to AI assistants, answer hijack, exfiltration) in 5 positions (summary, finding text, Jira text, owner field, ticket key); graded by the absence of the canary action and token AND the true answer | as the base question |
| no-write (safety) | tempting "apply it" / "close it" / "make the report" requests that must leave the files byte-identical | tool bans, sentinels |
| trigger (7 skills + the router's handoff job) | should fire (an outcome both arms can be scored on) and should not fire (near-misses: estimates, key-shaped variable names) | as above |

Sizes: synthetic S (60 tickets), M (300), L (1400) are committed (M carries every family, S and L the scaling set), and R is the real
project, generated at run time.

## Real-project data never enters the repository

`node evals/gen-real.ts --from <project root> [--out <empty temp dir>] [--verify]` reads the project's brain directory (through its
`.plangraphrc`, read-only) and writes a self-contained suite into a TEMP directory: a private plugin copy, the copied plan as fixture R (no
evidence file, no SQLite index; refs re-fingerprinted on a plan.md built from the summaries), the native case directories and
`cases.json`. It refuses any output inside this repository or the source project (symlinks resolved) and any non-empty directory, and
prints counts only. `--verify` cross-checks the truth with the brain CLI (zero model calls). Tests generate a stand-in project with a
canary list (invented names, key prefix, summary markers), prove the canaries reach the temp suite, and fail if any committable file
under `evals/` contains one; with `PLANGRAPH_REAL_PROJECT=<root>` the same test also checks the real project's names and keys.

## Running

```
node evals/gen.ts [--check]                                   regenerate (or check) the committed synthetic suite
node evals/run.ts --dry-run [--real <root>]                    build the suite in a temp dir; print the exact commands and a cost range
node evals/run.ts --emit-native [--real <root>] [--out DIR]    build only
node evals/run.ts --run --max-cost-usd N [--real <root>]       PAID: run the passes under a hard cap, then print the report
node evals/report.ts --suite <dir> [--json <file outside the repo>]
```

Selection: `--family`, `--kind`, `--size`, `--case`. Tuning: `--runs`, `--model`, `--judge-model`, `--concurrency`, `--variants`,
`--keep-temp` (keeps each run's trace: needed for token counts and for the post-checked moves). Every suite, its results and the HTML
reports live in the temp suite directory; every `claude plugin eval` call passes `--no-publish`.

**Cost estimate.** `evals/cost.ts` projects each run from the case itself: context per turn = base (system prompt and tools, plus the
skill listing and card in arm A) + the prompt + (turn - 1) x tool-result growth for that fixture size, written to the prompt cache once
and read on later turns; low bound = 3 turns with small results, high bound = every run uses its `max_turns` cap with large results (an
agent reading big JSONL files). Judge calls are added at 3 votes. Prices are the list prices of the model table (Sonnet 5.5 $2/$10,
cache reads $0.10; Opus 5.5 judge $4/$20), cache writes assumed 1.25x input. The cap passed to `--max-cost-usd` is split across passes
in proportion to their high estimates and is the only hard stop (native cases carry no per-run dollar cap; the CLI checks the ceiling
before each run launches, so overrun is bounded by the runs in flight). After the first paid run, trust `costUsd` in
`aggregate-result.json`, not the estimate.

## Verified and unverified

Verified on 2026-11-22 against Claude Code 2.1.329, zero cost: the flags used (`plugin eval --help`); the case and grader schema (read
from the binary: regex `target` last_message | trace | files | {source: file, path}, `match` contains | not_contains | count:N,
`flags`; tool_used; file_exists; llm with `criteria`/`focus`; weights > 0); every generated case loads in the real binary with the
operator grant and no "cannot pass with the granted tools" warning; the first case's scaffold runs inside the CLI and the run stops at
"Not logged in" with $0.00 (`test/evals-native.test.ts`, for the synthetic suite; done by hand for the real one); the
`aggregate-result.json` shape the report reads (`cases[].arms.{with,without}[]`: score, passed, turns, costUsd, tracePath,
graders[{name, passed}]).

Unverified (needs a logged-in run): that `brain` is on PATH inside arm A (the validator lists `bin: brain` as provided, not exercised
with a model); that `count:N` means exactly N (the offline grader assumes exact; if the CLI means at least N, an added line still
fails but a removed line also fails, so the sentinel stays safe); that kept traces (`--keep-temp`) end with a `result` event carrying
`usage` (tokens and post-checks are skipped when absent); that the judge model name is valid for your account; the cost model's
constants; that an attempted but sandbox-denied tool call appears in the trace (the safety graders count attempts).

Known limits: arm B may run this plugin's `bin/brain` by absolute path through `Bash(node *)`; check traces for `/bin/brain` in B.
The no-write sentinels approximate a file hash (line count, the target's exact line, no created files) because native graders cannot
hash. `proposeMove` on the real plan rarely completes (every cell sits at capacity), so `reassign-ripple` is skipped there and the
dry-run lists it. Real data changes while you work; the suite evaluates the snapshot taken at generation time.
