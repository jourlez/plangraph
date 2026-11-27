# A/B benchmark

Offline harness in `evals/ab/`; no model or API call happens unless `EVAL_LIVE=1`. `test/eval-ab.test.ts` checks it offline.

## Question families

- Graph questions (`questions.ts`): at least 200 questions over the synthetic project in `project.ts` (owner, blocker, stack, requirement trace, history). Ground truth is computed from the project data and recomputed independently by the test. `planMarkdown()` is the plan text the baseline arm reads and the graph arm ingests.
- Coding tasks (`coding/*.json`): at least 20 small bug fixes on open-source repositories. Each pins a repository URL and the commit before the fix, a one-paragraph task, and a hidden test: the test files of the fix commit and the command that runs them. `validated: false` until the controller has cloned the repository, seen the hidden test fail at the pinned commit and pass at the fix commit, and checked that the task paragraph matches the real bug.

## Arms and matrix

Graph questions: `baseline` (plugin off, Read, Grep, Bash) and `graph` (plugin on). Coding tasks: `plugin-off` and `plugin-default`. Each pass runs sonnet and haiku three times each and opus once. `summarize` reports accuracy with a Wilson 95 percent interval, median and p90 tokens, median calls and median cost per arm.

## Running the live pass

Set `EVAL_LIVE=1`. The arms run the Claude Code native binary in headless print mode with the user's existing login; no API key is needed (`ANTHROPIC_API_KEY` is only for `countTokens`, and `claudeEnv` removes it and every other secret-named variable from the model's environment). The binary is `$PLANGRAPH_BENCH_CLAUDE`, else `$HOME/.vscode/extensions/anthropic.claude-code-2.1.332-darwin-arm64/resources/native-binary/claude` when that file exists, else `claude` on the PATH (`claudeBin`). See `argvFor`, `runClaude`, `runCodingCell`, `prepareWorkspace`, `runHiddenTests` in `evals/ab/run.ts`, the workspaces in `evals/ab/graph.ts` and the driver `evals/ab/pilot.ts`.

Flags confirmed with `claude --help` (version 2.1.332): `-p`, `--model`, `--output-format` (`json`, `stream-json`), `--verbose`, `--plugin-dir`, `--tools`, `--allowed-tools`, `--permission-mode`, `--setting-sources`, `--strict-mcp-config`, `--no-session-persistence`, `--max-budget-usd`. This binary has no `--max-turns`; the per-run spend cap (`$PLANGRAPH_BENCH_MAX_USD`, default 2) bounds a run instead. Exact command lines (the prompt is argument 2; the variadic flags come last):

```
# plugin-off arms (baseline, plugin-off); coding arms use Read,Edit,Write,Grep,Glob,Bash
claude -p PROMPT --model claude-sonnet-5-5 --output-format stream-json --verbose --setting-sources project --strict-mcp-config --no-session-persistence --permission-mode dontAsk --max-budget-usd 2 --tools Read,Grep,Bash --allowed-tools Read,Grep,Bash
# plugin-on arms (graph, plugin-default): the same plus the plugin and the Skill tool
claude -p PROMPT --model claude-sonnet-5-5 --output-format stream-json --verbose --setting-sources project --strict-mcp-config --no-session-persistence --permission-mode dontAsk --max-budget-usd 2 --plugin-dir REPO --tools Read,Grep,Bash,Skill --allowed-tools Read,Grep,Bash,Skill
```

Clean configuration: a temporary `CLAUDE_CONFIG_DIR` is NOT logged in (the run ends with `terminal_reason: api_error` and zero tokens), so the plugin-off arms keep the real config directory (the login) and isolate with `--setting-sources project --strict-mcp-config`: no user settings, hooks, plugins, MCP servers, skills or CLAUDE.md reach the run (checked: the model reports no skills and no commit instructions). `stream-json` is used instead of `json` so tool calls are counted exactly (`tool_use` blocks); the result line has the same fields as `json`. The model environment also loses the parent session's `CLAUDE*` variables and PATH entries holding a `plangraph` binary.

Graph arm workspace (`buildGraphProject`): a committed `.plangraph/` built from `project.ts` (owner, sprint and blocked-by edges as fields; stack, requirement and history facts in the ticket summary, because `plangraph ticket -v` prints no other free text) and no plan.md. Baseline workspace (`buildBaselineProject`): only plan.md.

Coding descriptors. `setup` (string array) runs after the clone in ONE `sh` session with `set -e`; what it exports (`PATH`, `VIRTUAL_ENV`) is saved and sourced before the hidden test command. A `.venv` the setup created is activated even when the descriptor has no export (many only run `uv venv`; without this `python` was not found and every hidden test returned 127). `timeoutSec` (default 600) bounds the hidden test command; setup gets at least 600 seconds. A `validated: false` descriptor is skipped with its `reason` (`runnableTasks`; `prepareWorkspace` and `runHiddenTests` refuse it). Setup and hidden tests, and the git clone and fetch, run in a stripped environment: `env -i PATH=<host PATH> HOME=<temporary directory>` and nothing else, so no token or credential of the host reaches cloned code. The temporary HOME and saved exports live in `<clone>.bench`, outside the clone.

## Ruling

Pending the early pass. The controller records here which default injections stay on.

Status when the 1.0 documentation was written: still pending. `results pending` is what the README says; it claims no token or accuracy benefit, and the pilot below measured equal accuracy and a higher token and cost use for the plugin arm. The live pass (`EVAL_LIVE=1`) and the coding-task validation have not been run.

## Pilot

Model `sonnet` (claude-sonnet-5-5), one run per cell, `EVAL_LIVE=1`, native binary 2.1.332, default config of the owner's login, sequential. Questions (`pilotQuestions`): two per topic (owner, blocker, stack, requirement, history) of different kinds, plus two more multi-hop or list questions: 12 questions, each in both arms. Coding tasks: the two with the fastest setup of four probed (`loguru-size-exponent` 14 s, `click-sentinel-copy` 15 s; `more-itertools-chunked-even-size` 17 s, `cachetools-cached-qualname` 23 s), each in both arms. Tokens in include cache reads and cache creation; cost is the `total_cost_usd` the binary reports.

Graph questions (12 per arm)

| arm | correct | tokens in, median | tokens out, median | cost, median / total | tool calls, median | wall time, median / total | harness errors |
|---|---|---|---|---|---|---|---|
| baseline | 12 of 12 | 14,318 | 169 | $0.0104 / $0.175 | 1 | 4.1 s / 65 s | 0 |
| graph | 12 of 12 | 40,458 | 207 | $0.0408 / $0.513 | 2 | 6.2 s / 94 s | 0 |

Measured per question (both arms together): $0.057 and 13 s. The graph arm costs about three times the baseline here and takes longer: the plugin adds a roughly 26,000-token fixed prefix (skills, card, tool schemas) to every run, and its CLI answers cost more calls on count and list questions (stack-count 10 calls against 2, implements 6 to 7 against 1) because the plan has only 30 tickets and plan.md fits in one Read. It paid off only on the multi-hop questions (down-T-6: 5 calls and 8 s against 8 calls and 17 s). With 12 of 12 in both arms the pilot cannot separate accuracy; a plan this small favours the baseline. A larger synthetic project is needed before the full pass says anything about the graph.

Coding tasks (one run per cell)

| task | arm | correct | tokens in | tokens out | cost | tool calls | agent time | setup time |
|---|---|---|---|---|---|---|---|---|
| loguru-size-exponent | plugin-off | yes | 40,359 | 1,709 | $0.045 | 4 | 17 s | 21 s |
| loguru-size-exponent | plugin-default | yes | 75,872 | 1,628 | $0.066 | 5 | 16 s | 16 s |
| click-sentinel-copy | plugin-off | yes | 26,485 | 1,354 | $0.034 | 3 | 13 s | 17 s |
| click-sentinel-copy | plugin-default | yes | 67,007 | 1,748 | $0.059 | 5 | 18 s | 32 s |

Accuracy 2 of 2 in each arm. Median tokens in: 33,422 (plugin-off), 71,440 (plugin-default); median cost $0.040 and $0.063. The plugin-on arm again carries a fixed extra prefix (about 27,000 to 35,000 tokens) with no effect on the outcome of these simple bugs.

Harness problems found and fixed during the pilot
- A separate `CLAUDE_CONFIG_DIR` is not logged in; the clean config is `--setting-sources project --strict-mcp-config` instead.
- `claude` in this version has no `--max-turns`; a spend cap replaces it.
- `--output-format json` gives only turns, not tool calls; the runner uses `stream-json`.
- A first coding run of `click-sentinel-copy` scored false in both arms only because the descriptor's setup ran `uv venv` without exporting the PATH, so the hidden command `python` exited 127; the runner now activates a `.venv` the setup creates. The loguru runs happened before that change (their setup exports the PATH themselves); the agent in those runs had no venv on its PATH, the later runs do.
- Setup runs once per run in the pilot (14 to 32 s); the full pass should cache one prepared clone per task and copy it.

Estimate of the full final pass (sonnet and haiku, three repeats; opus once adds about 40 percent). Sonnet cost is the pilot mean; haiku is assumed at one third of it (not measured).
- Graph questions: 200 questions x 2 arms x 3 repeats x 2 models = 2,400 runs. Sonnet: 200 x 3 x $0.057 = about $34; haiku about $11; total about $45 (about $65 with opus once). Time: 13 s per question for both arms, so 2.2 hours of sonnet plus about 2 hours of haiku run one after another, about 1 hour with 4 runs in parallel.
- Coding: 24 tasks x 2 arms x 3 repeats x 2 models = 288 runs. Pilot mean $0.051 per sonnet run: 144 x $0.051 = about $7 plus haiku about $2.5; real tasks are harder than the two fastest, so plan for 3 times that: $10 to $30. Time per run about 16 s agent plus 20 to 30 s setup (or about 5 s with a cached clone) plus the hidden tests: 3 to 5 hours sequentially, about 1 hour with 4 in parallel.
- Total: about $55 to $100 and 7 to 9 hours sequential, 2 to 3 hours with 4 runs in parallel, on the owner's login (list-price cost as the binary reports it).

## Prefix overhead

The pilot's "26,000-token fixed prefix" is not one prefix. Median tokens in sums input, cache creation and cache reads over every API call of a run, so the per-call prefix is counted once per turn (a graph run is 3 to 6 calls, a coding run 5 or more). Measured on one call, the plugin adds far less, and most of that is Claude Code's own Skill tool, which only the plugin arms were given.

Method: native binary 2.1.332, model haiku, prompt `say ok`, `--output-format json`, the pilot's flags (`--setting-sources project --strict-mcp-config --no-session-persistence --permission-mode dontAsk`, `--tools Read,Grep,Bash[,Skill]`), run in a clean temp project holding only a committed `.plangraph/` (the synthetic 30-ticket plan; no CLAUDE.md, AGENTS.md or docs). The repository has no root CLAUDE.md or AGENTS.md. Tokens in = input + cache creation + cache reads of the single call. Components were isolated by copying the plugin and emptying `hooks/hooks.json`, `.mcp.json` or deleting `skills/`.

| component | tokens in, one call | note |
|---|---|---|
| no plugin, tools Read,Grep,Bash | 7,858 | the baseline arm |
| no plugin, plus the Skill tool | 11,202 | Claude Code itself: the Skill tool definition costs 3,344 with no plugin loaded |
| empty plugin (manifest only) | 11,256 | +54 |
| skills (listed descriptions of 5 model-invocable skills) | +613 | 1,793 characters of descriptions; skill bodies are not loaded until invoked |
| SessionStart card + prompt hook | about +60 to +120 | card 243 characters, prompt facts about 212 characters, cached after the first call |
| MCP bundle, strict MCP config (the pilot) | 0 | `--strict-mcp-config` drops plugin servers: the pilot never loaded the MCP server |
| MCP bundle, default config | +196 | server instructions (707 characters); the 7 tool definitions (3,363 characters, about 840 tokens) are deferred by tool search |
| full plugin vs no plugin plus Skill tool (before) | +799 to +2,173 | strict to default MCP config |

Where the 26k comes from, per call about 4,100 (Skill tool 3,344 plus plugin about 800) times 4 to 6 calls per run, plus the longer prompts of tool turns. The plugin's own share is about 800 tokens per call; the Skill tool is Claude Code's and any plugin that ships skills pays it. A fair control gives the plugin-off arm the Skill tool too.

After the fix (descriptions of the model-invocable skills cut from 1,793 to 1,464 characters, MCP instructions from 707 to about 440 characters): full plugin 11,928 (strict) and 13,143 (default config) against 11,202 for no plugin plus the Skill tool, so plugin-on minus plugin-off is about 730 tokens strict and 1,940 default (one run each, noise a few tokens), both under the 3,000 target. The limiting factor is the Skill tool definition (3,344) and the 7 deferred MCP tools, not our text. No `alwaysLoad` is set: it would only add the tool definitions to every prompt.
