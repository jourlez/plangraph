// Every command group of the plangraph CLI. src/registry.ts registers these into the default registry (Map, frozen specs).
import { commands as queries } from './queries.ts';
import { commands as plan } from './plan.ts';
import { commands as audit } from './audit.ts';
import { commands as openItems } from './openitems.ts';
import { commands as analysis } from './analysis.ts';
import { commands as integrations } from './integrations.ts';
import { commands as report } from './report.ts';
import { commands as explain } from './explain.ts';
import { commands as repo } from './repo.ts';
import { commands as graph } from './graph.ts';
import { commands as importObs } from './import.ts';
import { commands as sync } from './sync.ts';
import { commands as fmt } from './fmt.ts';
import { commands as resolve } from './resolve.ts';
import { commands as compact } from './compact.ts';

export const GROUPS = Object.freeze({ queries, plan, audit, openItems, analysis, integrations, report, explain, repo, graph, importObs, sync, fmt, resolve, compact });
