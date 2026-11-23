// Generator for the committed synthetic suite: three invented plans (S 60, M 300, L 1400 tickets; invented people; no real project)
// and the case files. Ground truth is never typed by hand: evals/families.ts computes every answer with the library on exactly the
// data each case's workspace will hold (base fixture + overlay).
//   node evals/gen.ts            write evals/fixtures/{S,M,L}/ and evals/cases/*.json
//   node evals/gen.ts --check    exit 1 if the committed files differ from a fresh generation (no writes)
// Real-project cases are NEVER written here: see evals/gen-real.ts (temp directory only).
// Output is deterministic (same code, same bytes). No network, no model calls, no clock.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildModel } from '../lib/model.ts';
import type { Ticket, ScheduleRow } from '../lib/model.ts';
import { genPlan } from '../test/fixtures/gen.ts';
import { validateCase } from './schema.ts';
import type { EvalCase } from './schema.ts';
import { buildFamilies, buildSafety, buildTriggers, makeStale, keyCmp } from './families.ts';
import type { GModel, TotalMap } from './families.ts';

export const here = import.meta.dirname;
export const SEED = 7;
export interface Size { n: number; people: number; density: number; cap: number; caps: Record<string, number> }
export const SIZES: Record<string, Size> = {
  S: { n: 60, people: 3, density: 0.06, cap: 40, caps: {} },
  M: { n: 300, people: 4, density: 0.03, cap: 40, caps: { Cleo: 10 } },
  L: { n: 1400, people: 4, density: 0.008, cap: 60, caps: {} },
};
// The families each size carries: M carries everything; S and L carry the scaling set (same questions, smaller and larger graphs).
export const SCALING = ['lookup', 'ready-no', 'chain', 'whatif-producer', 'reassign-safe', 'overload-peak'];
const jl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
const must = (cond: unknown, msg: string) => { if (!cond) throw new Error(`generator invariant: ${msg}`); };

// One invented world: base plan, then deterministic plants (verdict spread, findings, one closed open item, early tickets Done or
// In Progress, a tight person on M) and the stale scenario (plan.md edited after the audit).
export function buildWorld(size: string) {
  const z = SIZES[size];
  const plan = genPlan({ n: z.n, people: z.people, density: z.density, seed: SEED, cap: z.cap, maxSp: 5 });
  plan.config.caps = { default: z.cap, ...z.caps };
  const T = new Map(plan.tickets.map((t: Ticket) => [t.key, { ...t }])) as TotalMap<Ticket>; // every lookup below uses a key of T
  const keys = [...T.keys()].sort(keyCmp);
  const sched = new Map(plan.schedule.map((r: ScheduleRow) => [r.key, r])) as TotalMap<ScheduleRow & { owner: string; sprint: number }>; // keys of the plan's own tickets
  const prods = new Map<string, string[]>(); for (const e of plan.edges) { if (!prods.has(e.consumer)) prods.set(e.consumer, []); (prods.get(e.consumer) as string[]).push(e.producer); } // set on the line before
  const findings: Array<{ key: string; kind: string; text: string }> = [], items: Array<Record<string, unknown>> = [];
  keys.forEach((k, i) => {
    const t = T.get(k), s = sched.get(k).sprint, ps = prods.get(k) || [];
    if (s === 1 && i % 2 === 0 && ps.every((p: string) => T.get(p).jira_status === 'Done')) t.jira_status = 'Done';
    else if (s <= 2 && i % 7 === 1 && ps.every((p: string) => T.get(p).jira_status === 'Done')) t.jira_status = 'In Progress';
    if (t.jira_status !== 'Done') {
      if (i % 17 === 3) t.verdict = 'NEEDS_INFO';
      else if (i % 23 === 5) t.verdict = 'BLOCKED';
    }
    if (i % 31 === 7) findings.push({ key: k, kind: 'missing_ac', text: 'acceptance criteria are not written down' });
    if (i % 41 === 11) findings.push({ key: k, kind: 'export_clash', text: 'two tickets export the same name' });
  });
  // one ticket held back ONLY by an open finding (verdict READY, every producer Done): the ready questions then test the finding rule
  const fo = keys.slice(Math.floor(keys.length / 3)).find((k) => T.get(k).verdict === 'READY' && T.get(k).jira_status === 'To Do' && (prods.get(k) || []).length > 0 && (prods.get(k) || []).every((p: string) => T.get(p).jira_status === 'Done') && !findings.some((f) => f.key === k));
  if (fo) findings.push({ key: fo, kind: 'model_clash', text: 'two tickets define the same model' });
  const ac = findings.filter((f) => f.kind === 'missing_ac');
  if (ac[1]) items.push({ id: 'OI-0001', key: ac[1].key, kind: 'missing_ac', owner: sched.get(ac[1].key).owner, status: 'done', text: 'written down in review' });
  const m = buildModel({ tickets: [...T.values()], edges: plan.edges, schedule: plan.schedule, config: plan.config, findings }) as GModel; // see TotalMap
  const st = makeStale(m, { leaves: size === 'S' ? 2 : 3, maxClosure: 3, maxStale: size === 'L' ? 15 : 12 });
  const files = {
    'tickets.jsonl': jl([...T.values()]), 'edges.jsonl': jl(plan.edges), 'schedule.jsonl': jl(plan.schedule), 'findings.jsonl': jl(findings),
    'open-items.jsonl': jl(items), 'refs.jsonl': jl(st ? st.refs : []), 'learnings.jsonl': '', 'config.json': JSON.stringify(plan.config, null, 1) + '\n',
  };
  return { files, planText: st ? st.planText : '# Plan\n', stale: st ? { stale: st.stale, edited: st.edited } : null };
}

export function generate() {
  const fixtures: Record<string, Record<string, string>> = {}, cases: EvalCase[] = [], skipped: Record<string, string[]> = {};
  for (const size of Object.keys(SIZES)) {
    const w = buildWorld(size);
    fixtures[size] = { ...w.files, 'format.json': '{"format_version":1,"min_reader":1}\n', 'plan.md': w.planText };
    const env = { prefix: size.toLowerCase(), size, seed: SEED, dir: '.brain', files: w.files, stale: w.stale };
    const f = buildFamilies(env, size === 'M' ? null : SCALING);
    cases.push(...f.cases);
    skipped[size] = f.skipped;
    if (size === 'M') {
      const s = buildSafety(env), t = buildTriggers(env);
      cases.push(...s.cases, ...t.cases);
      skipped[size].push(...s.skipped, ...t.skipped);
    }
  }
  must(skipped.M.length === 0, `M must carry every family (missing: ${skipped.M.join(', ')})`);
  for (const sz of ['S', 'L']) must(skipped[sz].length === 0, `${sz} must carry the scaling set (missing: ${skipped[sz].join(', ')})`);
  const ids = new Set<string>();
  for (const c of cases) { const e = validateCase(c); must(e.length === 0, `case ${c.id} invalid: ${e.join('; ')}`); must(!ids.has(c.id), `duplicate id ${c.id}`); ids.add(c.id); }
  return { cases, fixtures };
}

export function render() {
  const { cases, fixtures } = generate();
  const files = new Map();
  for (const [size, fx] of Object.entries(fixtures)) for (const [n, t] of Object.entries(fx)) files.set(`fixtures/${size}/${n}`, t);
  for (const c of cases) files.set(`cases/${c.id}.json`, JSON.stringify(c, null, 2) + '\n');
  return files;
}

export const OWNED_DIRS = ['cases', 'fixtures/S', 'fixtures/M', 'fixtures/L'];
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const files = render();
  if (process.argv.includes('--check')) {
    let bad = 0;
    for (const [p, t] of files) { let cur = null; try { cur = fs.readFileSync(path.join(here, p), 'utf8'); } catch { /* absent */ } if (cur !== t) { bad++; if (bad <= 10) console.error(`out of date: evals/${p}`); } }
    for (const dir of OWNED_DIRS) { let list: string[] = []; try { list = fs.readdirSync(path.join(here, dir)); } catch { /* absent */ } for (const f of list) if (!files.has(`${dir}/${f}`)) { bad++; if (bad <= 10) console.error(`unexpected file: evals/${dir}/${f}`); } }
    if (bad) { console.error(`${bad} file(s) differ; run node evals/gen.ts`); process.exit(1); }
    console.log(`evals up to date (${files.size} files)`);
  } else {
    for (const dir of OWNED_DIRS) {
      fs.mkdirSync(path.join(here, dir), { recursive: true });
      // remove only files this generator owns and no longer produces (cases/*.json, fixture files), never anything else
      for (const f of fs.readdirSync(path.join(here, dir))) if (!files.has(`${dir}/${f}`) && (dir !== 'cases' || f.endsWith('.json'))) fs.rmSync(path.join(here, dir, f));
    }
    for (const [p, t] of files) fs.writeFileSync(path.join(here, p), t);
    console.log(`wrote ${files.size} files under evals/`);
  }
}
