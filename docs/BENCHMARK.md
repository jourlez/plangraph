# A/B benchmark

Offline harness in `evals/ab/`; no model or API call happens unless `EVAL_LIVE=1`. `test/eval-ab.test.ts` checks it offline.

## Question families

- Graph questions (`questions.ts`): at least 200 questions over the synthetic project in `project.ts` (owner, blocker, stack, requirement trace, history). Ground truth is computed from the project data and recomputed independently by the test. `planMarkdown()` is the plan text the baseline arm reads and the graph arm ingests.
- Coding tasks (`coding/*.json`): at least 20 small bug fixes on open-source repositories. Each pins a repository URL and the commit before the fix, a one-paragraph task, and a hidden test: the test files of the fix commit and the command that runs them. `validated: false` until the controller has cloned the repository, seen the hidden test fail at the pinned commit and pass at the fix commit, and checked that the task paragraph matches the real bug.

## Arms and matrix

Graph questions: `baseline` (plugin off, Read, Grep, Bash) and `graph` (plugin on). Coding tasks: `plugin-off` and `plugin-default`. Each pass runs sonnet and haiku three times each and opus once. `summarize` reports accuracy with a Wilson 95 percent interval, median and p90 tokens, median calls and median cost per arm.

## Running the live pass

Set `EVAL_LIVE=1`. Use a clean user config for the plugin-off arms, `claude` on the path, and `ANTHROPIC_API_KEY` only for `countTokens`. See `runCell`, `prepareWorkspace`, `runHiddenTests` in `evals/ab/run.ts`.

## Ruling

Pending the early pass. The controller records here which default injections stay on.
