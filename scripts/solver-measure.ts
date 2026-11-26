// Solver measurement (amendment 3.14 item 3). Runs bin/plangraph-solve-run on a synthetic plan for several seeds, once per variant given as
// extra solver flags, and prints one JSON line per run, a keep verdict per variant against the baseline (same results, lower median wall time)
// and the list-scheduling heuristic's end sprint with its bound next to the solver's end sprint.
// usage: node scripts/solver-measure.ts <tickets> <seconds> <seeds, comma separated> [variant ...]   a variant is "name=--flag --flag"
// Needs uv or a python3 with ortools; never part of the test run. Stage folding and structured neighborhoods are variants only once the solver
// has a flag for them (today: --lns, --decompose); --decompose stays off unless measured better here.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { spawnSync } from 'node:child_process';
import { genPlan } from '../test/fixtures/gen.ts';
import { listSchedule } from '../lib/heuristic.ts';
import { openStore } from '../lib/planstore.ts';
import { keepVariant } from '../lib/solver-measure.ts';
import type { Run } from '../lib/solver-measure.ts';

const root = path.resolve(import.meta.dirname, '..');
const [N = '1200', T = '60', seedsArg = '1,2,3,4,5', ...variants] = process.argv.slice(2);
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'solver-measure-'));
process.on('exit', () => fs.rmSync(work, { recursive: true, force: true }));
const g = genPlan({ n: Number(N), people: 4, density: 0.1, seed: 7, cap: Number(process.env.CAP || 60) });
const dir = path.join(work, 'plan'); fs.mkdirSync(dir);
const store = openStore({ dir, root: work });
store.writeKind('ticket', g.tickets); store.writeKind('edge', g.edges); store.writeKind('schedule', g.schedule); fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(g.config));

const run = (extra: string[], seed: number): Run & { end: number | null } => {
  const out = path.join(work, `out-${extra.join('_').replace(/\W/g, '')}-${seed}.json`);
  const t0 = Date.now();
  spawnSync(path.join(root, 'bin/plangraph-solve-run'), ['--jsonl-dir', dir, '--out', out, '--time', T, '--seed', String(seed), '--deterministic', ...extra], { cwd: work });
  const wallS = (Date.now() - t0) / 1000;
  const meta = JSON.parse(fs.readFileSync(out + '.meta.json', 'utf8')) as { end_sprint?: number; owner_changes?: number; stages?: Array<{ objective?: number | null }> };
  const objectives = (meta.stages ?? []).map((s) => s.objective ?? -1);
  // verify is `plangraph verify`; a missing meta or objective counts as unverified so the keep rule refuses it
  return { seed, wallS, objectives, verified: fs.existsSync(out) && objectives.every((x) => x >= 0), end: meta.end_sprint ?? null };
};
const seeds = seedsArg.split(',').map(Number);
const all = (name: string, extra: string[]) => seeds.map((s) => { const r = run(extra, s); console.log(JSON.stringify({ variant: name, ...r })); return r; });
const base = all('baseline', []);
for (const v of variants) {
  const [name, flags = ''] = v.split('=');
  console.log(JSON.stringify({ variant: name, ...keepVariant(base, all(name, flags.split(/\s+/).filter(Boolean))) }));
}
const h = listSchedule(g.tickets.map((t) => ({ key: t.key, owner: String(t.v2_owner), sp: Number(t.sp), deps: g.edges.filter((e) => e.consumer === t.key).map((e) => e.producer) })), { cap: Number(process.env.CAP || 60) });
console.log(JSON.stringify({ heuristic_end: h.end, lower_bound: h.lowerBound, label: h.label, solver_ends: base.map((b) => b.end) }));
