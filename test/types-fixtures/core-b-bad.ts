// expect: TS2322,TS2741
// Negative-type fixture for the core libraries, part B (lib/stale.ts). Never run, only type-checked by test/types.test.ts.
import type { StaleReason, StaleResult } from '../../lib/stale.ts';

// TS2322: a stale reason outside REASONS
export const badReason: StaleReason = 'typo';

// TS2741: a stale result needs the ref it was computed against
export const noRef: StaleResult = { stale: [], clean: 0 };
