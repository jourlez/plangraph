// Property (b): the CLI `check` and `verify` agree with each other and with the library, on a stratified subset of the verify families
// (process spawn is slow, so the strata run in-process through src/cli.mjs main over a built index, and a few also through bin/brain).
// Strata: every distinct combination of oracle violation kinds (plus "has a loop" and --enforce-min) in the quick verify enumeration,
// first instance of each (full: up to 3 per combination). Only instances that `brain build` accepts are used (whole sprints, numeric sp,
// no duplicate link key, no opts.frozen, which has no CLI flag).
// Per instance: `verify --json -v` lists exactly lib verifyPlan's violations (code, key, detail), its exit is 1 iff any; and `check`
// agrees with it: strict-rule violations == HANDOFF count, person-sprints over cap == CAPACITY count, loop-free == no CYCLE, the
// `unplaced N` fragment (absent when 0) == UNPLACED count (always), exit 1 iff any of the four. The first three
// hold whenever every scheduled key is a ticket with a valid placement and every ticket is scheduled (check reads the
// schedule only; verify also reads unscheduled tickets, so outside that case only "check finds a loop => verify reports CYCLE" and
// "check's counts <= verify's" are required).
// NOT covered: check/verify output beyond the counts and the violation list; instances outside the strata; --json envelopes of check.
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildModel } from '../../lib/model.mjs';
import { verifyPlan } from '../../lib/verify.mjs';
import { enumerate } from './verify.assure.mjs';
import { oracleViolations, cycleFacts, validPlacement } from './oracle.mjs';
import { makeRepo, run, tmpBase, rmBase } from './cli.mjs';

const BIN = path.join(import.meta.dirname, '../../bin/brain');
const buildable = (inst) => !inst.frozen && new Set(inst.edges.map((e) => `${e.consumer}\t${e.producer}`)).size === inst.edges.length && inst.tickets.every((t) => typeof t.sp === 'number') && [...inst.sched.values()].every((p) => Number.isInteger(p.sprint) && typeof p.owner === 'string');
const fail = (what, x) => assert.fail(`cli: ${what}\n${JSON.stringify(x)}`);

export function strata(perStratum) {
  const by = new Map();
  enumerate('quick', (inst) => {
    if (!buildable(inst)) return;
    const kinds = [...new Set(oracleViolations(inst).map((v) => v.code))].sort();
    if (cycleFacts(inst).onCycle.size) kinds.push('loop');
    if (oracleViolations(inst).some((v) => v.code === 'HANDOFF' && inst.sched.get(v.key).owner !== inst.sched.get(v.producer).owner)) kinds.push('HANDOFF_CROSS_OWNER');
    const sig = kinds.join(',') + (inst.enforceMin ? '|min' : '') + ([...inst.sched.keys()].some((k) => !inst.tickets.some((t) => t.key === k)) ? '|ghost' : '');
    const list = by.get(sig) || [];
    if (list.length < perStratum) { list.push({ ...inst, sched: new Map(inst.sched) }); by.set(sig, list); }
  });
  return by;
}

export async function assureCli(lvl) {
  const by = strata(lvl === 'full' ? 3 : 1);
  let picks = [...by.values()].flat();
  if (lvl === 'quick') { // greedy cover: every violation kind and "loop" at least once, few instances
    const need = new Set([...by.keys()].flatMap((k) => k.split('|')[0].split(',')).filter(Boolean)), out = [];
    for (const [k, l] of by) { const ks = k.split('|')[0].split(','); if (ks.some((x) => need.has(x))) { out.push(l[0]); for (const x of ks) need.delete(x); } }
    picks = out;
  }
  const counts = { strata: by.size, instances: 0, spawned: 0 }, base = tmpBase();
  try {
    for (const inst of picks) {
      const rows = [...inst.sched].map(([key, p]) => ({ key, owner: p.owner, sprint: p.sprint }));
      const root = makeRepo(base, { 'format.json': '{"format_version":1,"min_reader":1}\n', 'tickets.jsonl': inst.tickets, 'edges.jsonl': inst.edges, 'schedule.jsonl': rows, 'config.json': JSON.stringify(inst.config) });
      const b = await run(root, ['build']);
      if (b.code !== 0) fail('build failed', { inst: { ...inst, sched: rows }, err: b.err });
      const flags = inst.enforceMin ? ['--enforce-min'] : [];
      const v = await run(root, ['verify', '--json', '-v', ...flags]), c = await run(root, ['check']);
      const env = JSON.parse(v.out), model = buildModel({ tickets: inst.tickets, edges: inst.edges, schedule: rows, config: inst.config });
      const lib = verifyPlan(model, model.sched, { enforceMin: !!inst.enforceMin });
      const show = (x) => x.map((y) => `${y.code}|${y.key}|${y.detail}`).join('\n');
      if (show(env.data.violations) !== show(lib) || env.data.total !== lib.length || v.code !== (lib.length ? 1 : 0)) fail('verify CLI differs from the library', { rows, cli: env.data, lib });
      const m = /strict-rule violations (\d+) \| person-sprints over cap (\d+) \| loop-free (true|false)/.exec(c.out);
      if (!m) fail('check output not recognized', { out: c.out });
      const [hv, ov, lf] = [+m[1], +m[2], m[3] === 'true'], up = +(/ \| unplaced (\d+) \(brain verify lists them\)$/.exec(c.out)?.[1] ?? 0);
      const n = (code) => lib.filter((x) => x.code === code).length;
      if (up !== n('UNPLACED')) fail('check unplaced differs from verify UNPLACED', { rows, check: c.out, lib });
      const exact = [...inst.sched].every(([k, p]) => inst.tickets.some((t) => t.key === k) && validPlacement(p)) && inst.tickets.every((t) => validPlacement(inst.sched.get(t.key)));
      if (exact) {
        if (hv !== n('HANDOFF') || ov !== n('CAPACITY') || lf !== !n('CYCLE') || c.code !== (hv || ov || up || !lf ? 1 : 0)) fail('check disagrees with verify', { rows, check: c.out, code: c.code, lib });
      } else if ((!lf && !n('CYCLE')) || c.code !== (hv || ov || up || !lf ? 1 : 0)) fail('check reports a loop verify does not see', { rows, check: c.out, lib });
      if (counts.spawned < (lvl === 'full' ? 6 : 1)) { // the real entry point gives the same bytes
        for (const argv of [['check'], ['verify', '--json', '-v', ...flags]]) {
          const p = spawnSync(process.execPath, [BIN, ...argv], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: root, SOURCE_DATE_EPOCH: '1' } });
          const inproc = argv[0] === 'check' ? c : v;
          if (p.stdout.trimEnd() !== inproc.out || p.status !== inproc.code) fail('bin/brain differs from in-process main', { argv, spawned: p.stdout, inproc: inproc.out });
        }
        counts.spawned++;
      }
      counts.instances++;
    }
  } finally { rmBase(base); }
  return counts;
}
