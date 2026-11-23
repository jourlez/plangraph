// expect: TS2345,TS2322,TS2322,TS2554
// Negative-type fixture for the scripts and evals (scripts/typecheck.ts, evals/schema.ts, evals/overlay.ts). Never run,
// only type-checked by test/types.test.ts: each statement below is a deliberate misuse that the compiler must reject with the code listed on line 1.
import { parseTsc } from '../../scripts/typecheck.ts';
import { grade } from '../../evals/schema.ts';
import type { Grader } from '../../evals/schema.ts';
import { applyOverlay } from '../../evals/overlay.ts';

// TS2345: parseTsc reads text, not a number
export const counts = parseTsc(42);

// TS2322: a grader weight is a number
export const g: Grader = { id: 'x', role: 'outcome', type: 'regex', weight: '3', arm: 'both' };

// TS2322: an overlay op names its kind with a string `op`
export const o = applyOverlay({}, [{ op: 5 }]);

// TS2554: grade needs the case as its first argument
export const r = grade();
