// expect: TS2322,TS2345,TS2322,TS2554
// Negative-type fixture for the Jira boundary (lib/jira.ts, src/jira-tenant.ts). Never run, only type-checked by test/types.test.ts:
// each statement below is a deliberate misuse that the compiler must reject with the code listed on line 1, in this order.
import { getCredentialsFor } from '../../lib/jira.ts';
import type { AuthMode, JiraCredentials } from '../../lib/jira.ts';
import { resolveTenant } from '../../src/jira-tenant.ts';

// TS2322: the token is a string, never a number
export const creds: JiraCredentials = { email: 'dev@example.invalid', source: 'env', token: 42 };

// TS2345: an arbitrary string is not an AuthMode
const modes: AuthMode[] = [];
const fromConfig: string = 'basic';
modes.push(fromConfig);

// TS2322: allowGeneric is a boolean, not a string
export const allow: string = resolveTenant(undefined, '/work/acme', {}).allowGeneric;

// TS2554: the host is required
export const missingHost = getCredentialsFor();
