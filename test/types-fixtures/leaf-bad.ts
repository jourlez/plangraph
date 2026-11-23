// expect: TS2345,TS2345,TS2345
// Negative-type fixture for the leaf libraries (lib/gitsafe.ts, lib/fsafe.ts). Never run, only type-checked by test/types.test.ts:
// each statement below is a deliberate misuse that the compiler must reject with the code listed on line 1, in this order.
import { checkRef } from '../../lib/gitsafe.ts';
import type { SafeRef } from '../../lib/gitsafe.ts';
import { assertInside } from '../../lib/fsafe.ts';
import type { SafePath } from '../../lib/fsafe.ts';

declare const needsRef: (ref: SafeRef) => void;
declare const needsPath: (file: SafePath) => void;
needsRef(checkRef('main')); // valid: the validator returns a SafeRef
needsPath(assertInside('/repo', '/repo/a')); // valid: the validator returns a SafePath

// TS2345: a plain string was never validated, so it is not a SafeRef
needsRef('main' as string);

// TS2345: a plain string was never validated, so it is not a SafePath
needsPath('/repo/a' as string);

// TS2345: a validated git ref is not a confined path (the two brands are distinct)
needsPath(checkRef('main'));
