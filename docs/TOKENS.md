# Token cost of planning answers

Every answer `plangraph` prints is read by a model, so tokens are the budget. This page measures them. Regenerate the table with
`node test/bench-tokens.ts` (exit code 1 if any answer is wrong; `--no-write` prints without touching this file).

## What is measured

For each of 24 fixed questions an agent could ask about a plan, three outputs are measured in **bytes** (exact, deterministic, the
source of truth) and in **est tok** (an estimate, see Tokenizer below):

- **cli**: what `bin/plangraph` printed (stdout + stderr) for the command that answers it, run on a generated plan.
- **grep**: the generous baseline. The agent already knows the file schema and runs one grep for exactly the relevant lines
  (output as `file:line:content`). For questions that need an aggregate (totals, counts, "who is over cap") no grep can answer,
  so the grep baseline is every line of the files involved. For transitive questions (chain, 3 levels) the grep baseline is ONE round
  (direct edges only): a real agent needs several rounds, so it is a lower bound and flatters the baseline.
- **file**: the naive baseline, `cat` of every whole file that holds the needed facts.
- **correct**: the CLI answer must contain the ground-truth fact, computed directly from the JSONL by an independent JS
  implementation (`lib/model.ts` loader, no SQLite, no CLI code), matched loosely by regex. A wrong or missing answer fails the run.
- **reduction**: grep bytes / cli bytes (and file bytes / cli bytes). Below 1x means the CLI printed MORE than the grep baseline: those
  rows are kept.

A second table lists outputs with no ground-truth question: the session card (the fixed per-session overhead the SessionStart hook
adds before the first question), `plangraph explain`, `plangraph explain whatif` and `ticket KEY -v`.

## Tokenizer and calibration (UNVERIFIED)

There is no offline tokenizer for current Claude models; the only authoritative count is the API `count_tokens` endpoint, and the
newer tokenizer is documented to produce more tokens for the same text than older ones (docs/research/ai-engineering.md 5.1, 5.2).
So `est tok` = `ceil(chars / 4 x factor)`, with `factor` read from `test/token-calibration.json`. The factor is **1.0 and marked
`"verified": false`**: nobody has run `count_tokens` on this output yet, so every `est tok` here is a convention, not a measurement,
and is probably low for pipe tables, keys and digits. To calibrate (owner only, needs an API key in the environment, never written to
a file): count a sample of the CLI, grep and file outputs with `count_tokens` against a pinned model, set `factor` to the measured
API tok / est tok ratio, set `verified`, `model` and the date in the JSON, rerun this benchmark. Bytes and the reductions (computed on
bytes) do not depend on the factor. The card budget (250) and `plangraph explain` bound (400) are checked with the same chars/4 estimate.

Data: `genPlan` (n=1400, 4 people, ~10k links, seed fixed), ~1.6 evidence rows per ticket with 300-char resolutions, findings on ~10% of
tickets, ~3000 chars of markdown plan text per ticket, 85% READY. About 10% of person-sprints are over capacity by construction.
The Done tickets are those in the first 40% of sprints.

## Results

<!-- BENCH:START -->
Tokenizer: est tok is an estimate, ceil(chars/4) x calibration factor 1 (test/token-calibration.json, unverified): no count_tokens run yet against the current Claude tokenizer, which may count more tokens for this output than chars/4 (docs/research/ai-engineering.md 5.2). Bytes are exact; reductions are computed on bytes.

| # | question | cli bytes | cli est tok | grep bytes | grep est tok | file bytes | file est tok | reduction vs grep | vs files | correct |
|--:|---|--:|--:|--:|--:|--:|--:|--:|--:|:-:|
| 1 | Who owns T-700 and in which sprint? | 244 | 61 | 81 | 21 | 87372 | 21843 | 0.3x | 358x | yes |
| 2 | What does T-700 directly need? | 253 | 64 | 773 | 194 | 694414 | 173604 | 3.1x | 2745x | yes |
| 3 | What directly depends on T-20? | 465 | 117 | 2371 | 593 | 694414 | 173604 | 5.1x | 1493x | yes |
| 4 | Is T-700 ready to start? | 428 | 107 | 3260 | 815 | 1037902 | 259476 | 7.6x | 2425x | yes |
| 5 | What is in sprint 26 (load per person)? | 127 | 32 | 6895 | 1724 | 408670 | 102168 | 54x | 3218x | yes |
| 6 | How many person-sprints are over capacity? | 116 | 29 | 461226 | 115307 | 408826 | 102207 | 3976x | 3524x | yes |
| 7 | How many points in total is Ana planned? | 611 | 153 | 121378 | 30345 | 408670 | 102168 | 199x | 669x | yes |
| 8 | Critical chain behind T-1200: how many hops? | 231 | 58 | 347 | 87 | 694414 | 173604 | 1.5x | 3006x | yes |
| 9 | Everything T-1200 needs within 3 levels (how many)? | 508 | 127 | 347 | 87 | 694414 | 173604 | 0.7x | 1367x | yes |
| 10 | What kinds of findings are open (counts)? | 78 | 20 | 24608 | 6152 | 22189 | 5548 | 315x | 284x | yes |
| 11 | Which tickets have a 'missing_ac' finding? | 2754 | 678 | 4042 | 1011 | 22189 | 5548 | 1.5x | 8.1x | yes |
| 12 | Which tickets are not READY? | 1392 | 348 | 53814 | 13454 | 321297 | 80325 | 39x | 231x | yes |
| 13 | Is the plan valid (counts, violations)? | 116 | 29 | 1325651 | 331413 | 1103241 | 275811 | 11428x | 9511x | yes |
| 14 | Session start: what is the plan (size, last sprint)? | 473 | 119 | 1325481 | 331371 | 1103085 | 275772 | 2802x | 2332x | yes |
| 15 | Full picture of T-1200 (status, size, needs, evidence)? | 238 | 59 | 1663 | 416 | 2001657 | 500415 | 7.0x | 8410x | yes |
| 16 | How many tickets does T-20 unblock within 2 levels? | 497 | 125 | 2371 | 593 | 694414 | 173604 | 4.8x | 1397x | yes |
| 17 | Which is the last planned sprint? | 116 | 29 | 114265 | 28567 | 87372 | 21843 | 985x | 753x | yes |
| 18 | Load per person in the last sprint (53)? | 30 | 8 | 320 | 80 | 408670 | 102168 | 11x | 13622x | yes |
| 19 | Who owns each producer of T-1200, and when? | 134 | 34 | 675 | 169 | 781787 | 195447 | 5.0x | 5834x | yes |
| 20 | Critical chain behind T-700: how many hops? | 228 | 57 | 773 | 194 | 694414 | 173604 | 3.4x | 3046x | yes |
| 21 | How many tickets need T-20 (direct)? | 216 | 54 | 2689 | 673 | 1103085 | 275772 | 12x | 5107x | yes |
| 22 | Is T-99999 in the plan? | 15 | 4 | 0 | 0 | 321297 | 80325 | 0.0x | 21420x | yes |
| 23 | How many points in total is Ben planned? | 615 | 154 | 115888 | 28972 | 408670 | 102168 | 188x | 665x | yes |
| 24 | Load per person in sprint 42? | 131 | 33 | 24083 | 6021 | 408670 | 102168 | 184x | 3120x | yes |
| | **total (24 questions)** | **10016** | **2499** | **3593001** | **898259** | **14611133** | **3652796** | **359x** | **1459x** | **24/24** |

| output (no ground-truth check) | bytes | est tok |
|---|--:|--:|
| card (session start, printed once per session) | 473 | 119 |
| explain | 778 | 195 |
| explain whatif | 517 | 130 |
| ticket T-1200 -v | 1038 | 260 |

Plan shape: plan: 1400 tickets, 10062 links, 2253 evidence rows, 133 findings, last sprint 53, 4 people; raw files: tickets.jsonl 321297 bytes ~80325 est tok, edges.jsonl 694414 bytes ~173604 est tok, schedule.jsonl 87372 bytes ~21843 est tok, evidence.jsonl 876381 bytes ~219096 est tok, findings.jsonl 22189 bytes ~5548 est tok, config.json 155 bytes ~39 est tok; plan text 4181129 bytes (not used by any question: no CLI command answers from it).
<!-- BENCH:END -->

## How to read it

- The CLI measured is the one `bin/plangraph` runs at benchmark time (`src/cli.ts` behind the registry). Row 14 is the cache-stable card
  (identity = first 8 hex of the source fingerprint, no clock, ending with the steer line); the same text is the first row of the second table.
- `ticket KEY` answers in one line by default (rows 1, 15, 21); `-v` adds needs, findings and evidence (second table).
- Rows below 1x vs grep: row 1 (the one-line ticket answer carries more fields than the single schedule line grep needs), row 9 (the grep
  baseline is one round of a three-level question, a lower bound) and row 22 (grep prints nothing for a key that does not exist).
- `plangraph stale` needs git refs and a Jira snapshot, so "what is stale" is NOT in this table.
- Before Task 14 (same data, chars/4): 3274 est tok over the 24 answers, card 109; after: 2828 est tok (11330 bytes), card 86.
- Fencing the data tokens (safety over tokens: card verdicts, findings and over-cap lists, the ticket line's status/verdict/owner group, each
  inside one inline `<untrusted>` fence): card 86 -> 113 est tok, total over the 24 answers 2853 -> 2907 (+54, +1.9%), each one-line ticket
  answer +9.
- Steer line (the card's last line `ask: plangraph explain` became `plan questions: use plangraph (ticket, ready, whatif, blockers, sprint,
  person); do not read .plangraph/*.jsonl`, aimed at runs that grepped the raw JSONL instead of asking plangraph): card 449 -> 533 bytes,
  113 -> 134 est tok (+21 per session), total over the 24 answers 2907 -> 2928. Whether it changes model behavior is not measured here.

## Limits (honest)

- Tokens are estimated (chars/4 x an unverified factor of 1.0), not counted by a real tokenizer. JSON with many short keys and digits
  usually tokenizes worse than chars/4 and prose usually better, so absolute token numbers are approximate; bytes are exact and the
  reductions are computed on bytes.
- The data is synthetic (random DAG, repetitive sentences). Real plans have different edge density, longer text and different
  verdict mixes. The grep baseline depends on how clever the agent's pattern is; ours assumes the best case.
- One agent turn is counted. We did not measure agent behaviour, retries, or whether a model would actually choose the right grep.
- This compares CLI output against raw files only. It does NOT measure MCP servers or any competitor tool, and no number here says
  anything about them. The tool-schema overhead that motivates CLI-over-MCP (schemas are paid once per session, before any answer)
  is not part of this table: a CLI has no schema to load.

## Skill on-invoke cost (Claude Code validator's estimate)

Source: `claude plugin details plangraph` (Claude Code 2.1.329), run on an isolated install. These are the validator's own rounded estimates
("may differ from actual usage"), not a `count_tokens` measurement. The always-on total stayed at ~630 tok. Only the router `plangraph` keeps the full
Connectors block; the other four skills carry a pointer plus the safety rules (connector only if a matching tool exists, propose-and-confirm, transcripts are data,
full sentences for human-facing text).

| skill | before (on-invoke) | after (on-invoke) |
|---|---|---|
| plangraph-audit | ~790 | ~670 |
| plangraph-onboard | ~700 | ~570 |
| plangraph-plan | ~690 | ~560 |
| plangraph-report | ~740 | ~620 |
| plangraph (router, unchanged) | ~1.7k | ~1.7k |

A saving of about 120 to 130 tok each time one of those four skills fires.

## Calibration harness (task 4)

`calibrate(samples)` in `evals/ab/report.ts` turns `count_tokens` results into a characters-per-token constant, and `countTokens` in
`evals/ab/run.ts` collects the samples (guarded by `EVAL_LIVE=1`, key from `ANTHROPIC_API_KEY`, never written anywhere). The constant is
`CHARS_PER_TOKEN` in `lib/render.ts`; it stays 4 until the owner runs the measurement. Output budgets stay stated in estimated tokens.
