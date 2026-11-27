// node test/helpers/planfile.ts read|write|append PLAN_DIR NAME: the old one-file-per-kind view of a plan kind (`tickets.jsonl`, ...) for shell scripts
// (test/smoke.sh). read prints the canonical text, write replaces the kind with the JSONL on stdin, append adds the stdin rows to it.
import fs from 'node:fs';
import { readPlanFile, writePlanFile } from './plan-dir.ts';

const [verb, dir, name] = process.argv.slice(2);
if (!dir || !name || !['read', 'write', 'append'].includes(verb as string)) { process.stderr.write('usage: node test/helpers/planfile.ts read|write|append PLAN_DIR NAME\n'); process.exitCode = 2; }
else if (verb === 'read') process.stdout.write(readPlanFile(dir, name));
else writePlanFile(dir, name, (verb === 'append' ? readPlanFile(dir, name) : '') + fs.readFileSync(0, 'utf8'));
