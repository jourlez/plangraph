// Every command group of the plangraph CLI. src/registry.ts registers these into the default registry (Map, frozen specs).
import { commands as queries } from './queries.ts';
import { commands as plan } from './plan.ts';
import { commands as audit } from './audit.ts';
import { commands as openItems } from './openitems.ts';
import { commands as analysis } from './analysis.ts';
import { commands as integrations } from './integrations.ts';
import { commands as report } from './report.ts';
import { commands as explain } from './explain.ts';
import { commands as migrateNames } from './migrate-names.ts';

export const GROUPS = Object.freeze({ queries, plan, audit, openItems, analysis, integrations, report, explain, migrateNames });
