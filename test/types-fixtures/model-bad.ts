// expect: TS2741,TS2741
// Negative-type fixture for the plan model (lib/model.ts). Never run, only type-checked by test/types.test.ts.
import type { Model, Ticket } from '../../lib/model.ts';

// TS2741: a ticket needs its key
export const noKey: Ticket = { summary: 'no key' };

// TS2741: a model needs its edges
export const noEdges: Model = {
  tickets: new Map(), prods: new Map(), cons: new Map(), sched: new Map(), config: {}, findings: [], evidence: [], learnings: [], refs: [],
};
