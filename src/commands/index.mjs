// Every command group of the brain CLI. src/registry.mjs registers these into the default registry (Map, frozen specs).
import { commands as queries } from './queries.mjs';
import { commands as plan } from './plan.mjs';
import { commands as audit } from './audit.mjs';
import { commands as openItems } from './openitems.mjs';
import { commands as analysis } from './analysis.mjs';
import { commands as integrations } from './integrations.mjs';
import { commands as report } from './report.mjs';
import { commands as explain } from './explain.mjs';

export const GROUPS = Object.freeze({ queries, plan, audit, openItems, analysis, integrations, report, explain });
