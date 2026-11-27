// node evals/adopt.ts PLAN_DIR: converts the old-layout JSONL files of an eval fixture (plus the overlay applied to them) into the entity layout and
// stamps format.json, the one step between "copy the fixture" and "plangraph build" in a generated scaffold.
import { adoptOldLayout } from '../lib/store2/adopt.ts';

const dir = process.argv[2];
if (dir) adoptOldLayout(dir); else { process.stderr.write('usage: node evals/adopt.ts PLAN_DIR\n'); process.exitCode = 2; }
