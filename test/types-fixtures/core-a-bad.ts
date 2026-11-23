// expect: TS2741,TS2741,TS2322,TS2322
// Negative-type fixture for the core libraries, part A (lib/model.ts, lib/verify.ts). Never run, only type-checked by test/types.test.ts.
import type { Model, Ticket } from '../../lib/model.ts';
import { buildModel } from '../../lib/model.ts';
import type { Violation } from '../../lib/verify.ts';

// TS2741: a ticket needs its key
export const noKey: Ticket = { summary: 'no key' };

// TS2741: a model needs its edges
export const noEdges: Model = {
  tickets: new Map(), prods: new Map(), cons: new Map(), sched: new Map(), config: {}, findings: [], evidence: [], learnings: [], refs: [],
};

// TS2322: buildModel's records are Ticket rows, so a string sp is refused (an ill-typed test fixture says `as unknown as Ticket[]`)
export const badSp = buildModel({ tickets: [{ key: 'A', sp: '3' }] });

// TS2322: Violation is discriminated on code, so a switch that forgets a code leaves a remainder that is not never
export function describe(v: Violation): string {
  switch (v.code) {
    case 'CONFIG': case 'UNKNOWN_TICKET': case 'UNPLACED': case 'BEFORE_FIRST': case 'HANDOFF': case 'CAPACITY': case 'FROZEN_MOVED': case 'MINLOAD':
      return v.key;
    default: {
      const rest: never = v; // CYCLE is not handled
      return rest;
    }
  }
}
