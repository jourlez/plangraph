// The plan fixture helpers: adoptPlanDir, writePlanDir, readPlanFile, writePlanFile, normalizeGolden, and the guard that every test authoring
// old-layout files goes through them or is listed as text-only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adoptPlanDir, writePlanDir, normalizeGolden, TEXT_ONLY } from './helpers/plan-dir.ts';
import { genPlan } from './fixtures/gen.ts';
import { readStoreAt } from '../lib/planstore.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-plandir-'));
const HERE = import.meta.dirname;

test('adoptPlanDir converts the old files, removes them, stamps the directory, and is safe to repeat', () => {
  const d = tmp(), p = genPlan({ n: 5, seed: 2 });
  fs.writeFileSync(path.join(d, 'tickets.jsonl'), p.tickets.map((t) => JSON.stringify(t)).join('\n') + '\n');
  adoptPlanDir(d);
  assert.ok(!fs.existsSync(path.join(d, 'tickets.jsonl')));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(d, 'format.json'), 'utf8')), { format_version: 2, min_reader: 2, storage: 'entity' });
  const s = readStoreAt(d);
  assert.equal(s.describe().backend, 'entity');
  assert.equal(s.readKind('ticket').length, 5);
  adoptPlanDir(d); // nothing left to convert
  assert.equal(s.readKind('ticket').length, 5);
});
test('writePlanDir writes a genPlan through the store', () => {
  const d = tmp(), p = genPlan({ n: 6, seed: 3 });
  writePlanDir(d, p);
  const s = readStoreAt(d);
  assert.equal(s.readKind('ticket').length, 6);
  assert.equal(s.readKind('edge').length, p.edges.length);
  assert.equal(s.readKind('schedule').length, 6);
  assert.ok(JSON.parse(fs.readFileSync(path.join(d, 'config.json'), 'utf8')).caps);
});
test('normalizeGolden makes goldens that differ only by fingerprint or plan file name equal', () => {
  const a = '{"fresh":{"fp":"0512544c","built":"0512544c"}}\nplangraph 0512544c | 40 tickets\n0 violations @b6280500\n--- file .plangraph/tickets.jsonl\n';
  const b = '{"fresh":{"fp":"deadbeef","built":"deadbeef"}}\nplangraph deadbeef | 40 tickets\n0 violations @11111111\n--- file .plangraph/edges.jsonl\n';
  assert.equal(normalizeGolden(a), normalizeGolden(b));
  assert.match(normalizeGolden(a), /"fp":"<FP>"/);
  assert.match(normalizeGolden(a), /@<FP>/);
  assert.match(normalizeGolden(a), /<FILE>/);
  assert.notEqual(normalizeGolden('{"fp":"abcd1234"} 39 READY'), normalizeGolden('{"fp":"abcd1234"} 38 READY'));
});
test('every test that authors the old layout goes through the plan-dir helpers or is listed text-only', () => {
  const OLD = /(?:tickets|edges|schedule|refs|evidence|findings|open-items|learnings|people|sprints|epics|repos|capacity|links|xrefs)\.jsonl|canonFile|readRecords|writeState/;
  const self = path.basename(import.meta.filename);
  const bad: string[] = [];
  for (const f of fs.readdirSync(HERE).filter((x) => x.endsWith('.test.ts') && x !== self).sort()) {
    const t = fs.readFileSync(path.join(HERE, f), 'utf8');
    if (!OLD.test(t)) continue;
    const n = [/\b(adoptPlanDir|readPlanFile|writePlanFile|putFile|writePlanDir)\(/.test(t), TEXT_ONLY.includes(f)].filter(Boolean).length;
    if (n !== 1) bad.push(`${f}: ${n === 0 ? 'neither goes through the plan-dir helpers nor is listed text-only' : 'uses the helpers and is also listed text-only'}`);
  }
  assert.deepEqual(bad, []);
  for (const f of TEXT_ONLY) assert.ok(fs.existsSync(path.join(HERE, f)), `${f} listed but missing`);
});
