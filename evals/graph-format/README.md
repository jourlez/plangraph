# graph-format

Offline pieces of the 0.4.0 graph answer-format benchmark: the fixed synthetic plan (`plan.ts`), the generated question set with ground truth and golden queries (`questions.ts`), and report helpers with Wilson intervals (`report.ts`). `test/graph-format.test.ts` checks integrity and recomputes the ground truth. No model is called here; a runner that feeds `Result` rows to `summarize` is not included.
