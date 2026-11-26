# graph-format

Offline pieces of the 0.4.0 graph answer-format benchmark: the fixed synthetic plan (`plan.ts`), the generated question set with ground truth and golden queries (`questions.ts`), report helpers with Wilson intervals (`report.ts`), and the runner and ruling (`run.ts`). `test/graph-format.test.ts` checks integrity and recomputes the ground truth. `runFormats` is the only function that spends anything and it refuses without `EVAL_LIVE=1`; `rule` picks the winning format from `Result` rows. The A/B harness in `evals/ab` builds on this.
