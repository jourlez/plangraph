// expect: TS2741
// Negative-type fixture for the CLI layer (src/registry.ts, src/context.ts). Never run, only type-checked by test/types.test.ts:
// each statement below is a deliberate misuse that the compiler must reject with the code listed on line 1, in this order.
import type { CommandMap } from '../../src/registry.ts';

// A command group entry without its handler: `run` is required (TS2741).
export const noRun: CommandMap = { orphan: { summary: 'a command with nothing to run', positionals: [0, 0] } };
