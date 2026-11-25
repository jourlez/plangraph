// --decompose measurement (docs/SOLVER.md, Polish): a synthetic multi-component instance, 8 components x 150 tickets (genPlan seeds 100..107,
// prefixes C0..C7) sharing 4 people with cap 60 (CAP=...), run monolithic and with --decompose for each seed. Needs uv or a python3 with ortools.
// usage: node test/bench-decompose.ts <time seconds> <seeds, comma separated> [extra solver args]   DET=0 drops --deterministic
// Prints one JSON line per run: status, end sprint, owner changes, stage records, polish summary, wall time, time of the first CP-SAT write.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { spawn, spawnSync } from 'node:child_process';
import { genPlan } from './fixtures/gen.ts';
import type { GenEdge, GenScheduleRow } from './fixtures/gen.ts';
import type { Ticket } from '../lib/model.ts';
const root = path.resolve(import.meta.dirname, '..');
const [T = '60', seedsArg = '1,2,3'] = process.argv.slice(2); const extra = process.argv.slice(4);
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-decompose-')); spawnSync('git', ['init', '-q'], { cwd: work });
process.on('exit', () => fs.rmSync(work, { recursive: true, force: true }));
const dir = path.join(work, 'plan'); fs.mkdirSync(dir, { recursive: true });
const tickets: Ticket[] = [], edges: GenEdge[] = [], schedule: GenScheduleRow[] = [];
for (let c = 0; c < 8; c++) {
  const g = genPlan({ n: 150, people: 4, density: 0.12, seed: 100 + c, cap: 1000, prefix: `C${c}` });
  tickets.push(...g.tickets); edges.push(...g.edges); schedule.push(...g.schedule);
}
const end = Math.max(...schedule.map((s) => s.sprint));
const config = { first_sprint: 1, end_sprint: end, caps: { default: Number(process.env.CAP || 60) }, min_per_sprint: {}, ignore_link_kinds: [] };
const wjl = (f: string, rows: object[]) => fs.writeFileSync(path.join(dir, f), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
wjl('tickets.jsonl', tickets); wjl('edges.jsonl', edges); wjl('schedule.jsonl', schedule); fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
const run = (mode: string, seed: number) => new Promise((res) => {
  const out = path.join(work, `out-${mode}-${seed}.json`);
  const args = ['--jsonl-dir', dir, '--out', out, '--time', T, '--seed', String(seed), ...(process.env.DET === '0' ? [] : ['--deterministic']), '--verbose', ...extra, ...(mode === 'decompose' ? ['--decompose'] : [])];
  const t0 = Date.now(); let first: number | null = null, err = '', lastImp: number | null = null, writes = 0;
  const ch = spawn(path.join(root, 'bin/plangraph-solve-run'), args, { cwd: work });
  ch.stderr.on('data', (d) => { const s = String(d); err += s; const n = (s.match(/^anytime /gm) || []).length; if (n) { writes += n; lastImp = (Date.now() - t0) / 1000; } if (first === null && /anytime \{"source":"cp-sat"/.test(err)) first = (Date.now() - t0) / 1000; });
  let so = ''; ch.stdout.on('data', (d) => { so += d; });
  ch.on('close', (code) => {
    const meta = JSON.parse(fs.readFileSync(out + '.meta.json', 'utf8'));
    res({ mode, seed, code, wall: (Date.now() - t0) / 1000, first_cpsat_s: first, last_write_s: lastImp, anytime_writes: writes, wall_s_meta: meta.wall_s, det: meta.deterministic, status: meta.status, end: meta.end_sprint, owner_changes: meta.owner_changes,
      stages: meta.stages.map((s: { name: string; status: string; objective?: number | null; gap_pct?: number | null; gap_note?: string }) => `${s.name}=${s.status}${s.objective != null ? `:${s.objective}` : ''}${s.gap_pct != null ? `(${s.gap_pct}%)` : s.gap_note ? `(${s.gap_note})` : ''}`).join(' '),
      polish: meta.polish ? `${meta.polish.method} rounds ${meta.polish.rounds} improved ${meta.polish.improved} comps ${meta.polish.components ?? '-'} before ${JSON.stringify(meta.polish.before)} after ${JSON.stringify(meta.polish.after)}` : '-', line: so.trim().slice(0, 160) });
  });
});
console.log(JSON.stringify({ tickets: tickets.length, edges: edges.length, end_sprint_cfg: end, cap: Number(process.env.CAP || 60) }));
for (const seed of seedsArg.split(',').map(Number)) for (const mode of ['monolithic', 'decompose']) console.log(JSON.stringify(await run(mode, seed)));
