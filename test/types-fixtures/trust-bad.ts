// expect: TS2741
// Negative-type fixture for the Trust brand (src/jira-tenant.ts). Never run, only type-checked by test/types.test.ts:
// a hand-built Trust lacks the module-private brand and fails without a cast (TS2741).
import type { Trust } from '../../src/jira-tenant.ts';

export const handBuilt: Trust = { tenant: 'a.example.net', allowGeneric: false, pinned: false, userTenant: false };
