// Imported first by a test file whose module under test has scan loops: any string search or character read past 200 thousand calls in this
// process throws, so a mutant that makes such a loop endless fails the test at once instead of hanging until the runner's timeout.
// Counts calls, never time. NOT a limit for normal use: the tests that import it make a few thousand calls.
import { mock } from 'node:test';

const LIMIT = 200_000;
let calls = 0;
const real = { indexOf: String.prototype.indexOf, charCodeAt: String.prototype.charCodeAt };
mock.method(String.prototype, 'indexOf', function (this: string, ...a: [string, number?]) { if (++calls > LIMIT) throw new Error('runaway string search loop'); return real.indexOf.apply(this, a); });
mock.method(String.prototype, 'charCodeAt', function (this: string, i: number) { if (++calls > LIMIT) throw new Error('runaway character scan loop'); return real.charCodeAt.call(this, i); });
/** the number of guarded calls so far */
export const guardedCalls = (): number => calls;
