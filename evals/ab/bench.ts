// Full-pass driver (LIVE; refuses without EVAL_LIVE=1, except `report`).
//   EVAL_LIVE=1 node evals/ab/bench.ts run --family graph|coding --out DIR [--parallel N] [--arms a,b] [--models sonnet,haiku,opus]
//                                          [--tasks id,id] [--questions N] [--cache DIR] [--stagger-ms MS]
//   node evals/ab/bench.ts report --out DIR [--family graph|coding]       offline: the table from DIR/<family>.jsonl
// Results are JSONL in `<out>/<family>.jsonl`, one line per finished cell, appended as each cell ends. `--out` must be outside this repository (transcripts and
// results are never committed); stored text is scrubbed of absolute home paths and holds no transcript, only the first 80 characters of the reply.
// A rerun with the same --out resumes: a cell already recorded without error is skipped (cells that ended in a harness error are tried again).
import fs from 'node:fs';
import path from 'node:path';
import { graphQuestions } from './questions.ts';
import type { GraphQuestion } from './questions.ts';
import { buildBaselineProject, buildGraphProject } from './graph.ts';
import { ARMS, renderReport } from './report.ts';
import type { Row } from './report.ts';
import { PLUGIN_DIR, cells, copyWorkspace, grade, loadCodingTasks, preparePullOnlyPlugin, requireLive, rowOf, runClaudeAsync, runCodingCellAsync, runnableTasks, scrubHome, workspaceFromCache } from './run.ts';
import type { Cell, CodingTask } from './run.ts';

export type Unit = { cell: Cell; id: string };
export type Options = { family: 'graph' | 'coding'; out: string; parallel: number; arms: string[]; models: string[]; tasks: string[]; questions: number; cache: string; staggerMs: number };
/** One stored line: a Row plus what identifies and explains the run. */
export type Stored = Row & { repeat: number; toolCalls: number; setupMs?: number; error: string | null; reply?: string };

/** Parse argv (after the command). Defaults: parallel 1, every default arm of the family, all models, all runnable tasks, 200 questions, cache beside the results. */
export function parseArgs(argv: string[]): Options {
  const get = (f: string): string | undefined => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  const family = get('--family') ?? 'coding';
  if (family !== 'graph' && family !== 'coding') throw new Error('--family must be graph or coding');
  const out = get('--out');
  if (!out) throw new Error('--out DIR is required');
  const parallel = Number(get('--parallel') ?? '1');
  if (!Number.isInteger(parallel) || parallel < 1) throw new Error('--parallel must be a positive integer');
  const list = (f: string): string[] => (get(f) ?? '').split(',').filter(Boolean);
  const arms = list('--arms');
  for (const a of arms) if (!ARMS.some((x) => x.name === a && x.family === family)) throw new Error(`unknown arm for ${family}: ${a}`);
  return { family, out: path.resolve(out), parallel, arms, models: list('--models'), tasks: list('--tasks'), questions: Number(get('--questions') ?? '200'), cache: path.resolve(get('--cache') ?? path.join(out, 'cache')), staggerMs: Number(get('--stagger-ms') ?? '1000') };
}

/** `--out` must not be inside this repository: results and transcripts are never committed. */
export function outDirOk(out: string, repo = PLUGIN_DIR): boolean {
  const rel = path.relative(repo, path.resolve(out));
  return rel.startsWith('..') || path.isAbsolute(rel);
}

/** The identity of a cell, as stored and as compared on resume. */
export const unitKey = (u: Unit): string => `${u.cell.arm}|${u.cell.model}|${u.cell.repeat}|${u.id}`;
const recordKey = (r: Stored): string => `${r.arm}|${r.model}|${r.repeat}|${r.id}`;

/** The records of a results file (a missing file is empty; a torn last line is ignored). */
export function loadRecords(file: string): Stored[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as Stored]; } catch { return []; } });
}
/** Keys of the cells that finished without a harness error. */
export function doneKeys(records: Stored[]): Set<string> {
  return new Set(records.filter((r) => r.error === null).map(recordKey));
}

/**
 * The cells to run, in order, minus `done`. Order: by item id, then repeat, then model, then arm, so the arms of one (item, model, repeat) run next to each other
 * (same time, same load) and one task's workspace cache is used by neighbours. Optional arms only when named in `arms`.
 */
export function planUnits(family: 'graph' | 'coding', ids: string[], o: { arms?: string[]; models?: string[] } = {}, done: Set<string> = new Set()): Unit[] {
  const armRank = new Map(ARMS.map((a, i) => [a.name, i])), modelRank = new Map(['sonnet', 'haiku', 'opus'].map((m, i) => [m, i]));
  const cs = cells(family, o.arms ?? []).filter((c) => (!o.arms?.length || o.arms.includes(c.arm)) && (!o.models?.length || o.models.includes(c.model)));
  const units = ids.flatMap((id) => cs.map((cell) => ({ cell, id })));
  const idRank = new Map(ids.map((id, i) => [id, i]));
  units.sort((a, b) => (idRank.get(a.id) as number) - (idRank.get(b.id) as number) || a.cell.repeat - b.cell.repeat || (modelRank.get(a.cell.model) as number) - (modelRank.get(b.cell.model) as number) || (armRank.get(a.cell.arm) as number) - (armRank.get(b.cell.arm) as number));
  return units.filter((u) => !done.has(unitKey(u)));
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/**
 * Run `fn` over `items` with at most `n` at a time. Items START in index order; the first wave is staggered by `staggerMs` (rate-limit friendly). `fn` must not
 * throw (a rejection stops the pool). Results come back in item order.
 */
export async function runPool<T, R>(items: T[], n: number, fn: (item: T, index: number) => Promise<R>, staggerMs = 0): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (w: number): Promise<void> => {
    if (staggerMs > 0 && w > 0) await sleep(staggerMs * w);
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i] as T, i);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, (_, w) => worker(w)));
  return out;
}

/** The stored form of a finished run; every text is scrubbed of home paths. */
export function recordOf(row: Row, cell: Cell, extra: { toolCalls: number; error: string | null; setupMs?: number; reply?: string }): Stored {
  const r: Stored = { ...row, repeat: cell.repeat, toolCalls: extra.toolCalls, error: extra.error === null ? null : scrubHome(extra.error).slice(0, 200) };
  if (extra.setupMs !== undefined) r.setupMs = extra.setupMs;
  if (extra.reply !== undefined) r.reply = scrubHome(extra.reply).replace(/\s+/g, ' ').slice(0, 80);
  return r;
}

/** Rows of a results file that finished cleanly, for the report. */
export const rowsOf = (records: Stored[]): Row[] => records.filter((r) => r.error === null);

async function main(): Promise<void> {
  const [cmd, ...argv] = process.argv.slice(2);
  const o = parseArgs(argv);
  const file = path.join(o.out, `${o.family}.jsonl`);
  if (cmd === 'report') { console.log(renderReport(rowsOf(loadRecords(file)))); return; }
  if (cmd !== 'run') throw new Error('usage: bench.ts run|report ...');
  requireLive();
  if (!outDirOk(o.out)) throw new Error('--out must be outside this repository');
  fs.mkdirSync(o.cache, { recursive: true });
  const append = (r: Stored): void => { fs.mkdirSync(o.out, { recursive: true }); fs.appendFileSync(file, JSON.stringify(r) + '\n'); console.log(`${r.arm} ${r.model} #${r.repeat} ${r.id} ${r.error ?? (r.correct ? 'ok' : 'wrong')} first=${r.firstIn} calls=${r.calls} $${r.cost.toFixed(4)}`); };
  const done = doneKeys(loadRecords(file));
  const pullOnly = path.join(o.cache, 'plugin-pull-only');
  const pluginDirOf = (arm: string): string | undefined => (arm === 'plugin-pull-only' ? preparePullOnlyPlugin(pullOnly) : undefined);
  const run = path.join(o.cache, 'runs');
  if (o.family === 'graph') {
    const all = graphQuestions().slice(0, o.questions), byId = new Map<string, GraphQuestion>(all.map((q) => [q.id, q]));
    buildBaselineProject(path.join(o.cache, 'graph-baseline'));
    if (!fs.existsSync(path.join(o.cache, 'graph-graph', '.plangraph'))) buildGraphProject(path.join(o.cache, 'graph-graph'));
    const units = planUnits('graph', all.map((q) => q.id), { arms: o.arms, models: o.models }, done);
    console.log(`${units.length} cells to run (${done.size} already recorded), parallel ${o.parallel}`);
    await runPool(units, o.parallel, async (u, i) => {
      const q = byId.get(u.id) as GraphQuestion, dir = path.join(run, `g${i}`);
      copyWorkspace(path.join(o.cache, u.cell.arm === 'baseline' ? 'graph-baseline' : 'graph-graph'), dir);
      try {
        const d = await runClaudeAsync(u.cell, `${q.text} Answer with the value only, lists comma separated.`, dir, 900, '', pluginDirOf(u.cell.arm));
        append(recordOf(rowOf(u.cell, u.id, d, d.error === null && grade(q, d.reply)), u.cell, { toolCalls: d.toolCalls, error: d.error, reply: d.reply }));
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }, o.staggerMs);
  } else {
    const tasks = runnableTasks(loadCodingTasks()).run.filter((t) => !o.tasks.length || o.tasks.includes(t.id)), byId = new Map<string, CodingTask>(tasks.map((t) => [t.id, t]));
    const units = planUnits('coding', tasks.map((t) => t.id), { arms: o.arms, models: o.models }, done);
    console.log(`${units.length} cells to run (${done.size} already recorded), parallel ${o.parallel}`);
    await runPool(units, o.parallel, async (u, i) => {
      const t = byId.get(u.id) as CodingTask, dir = path.join(run, `c${i}`);
      let setupMs = 0;
      try {
        const t0 = Date.now();
        workspaceFromCache(t, o.cache, dir); // sync: the first cell of a task prepares the cache, no other cell can interleave
        setupMs = Date.now() - t0;
        const d = await runCodingCellAsync(u.cell, t, dir, pluginDirOf(u.cell.arm));
        append(recordOf(rowOf(u.cell, u.id, d, d.correct), u.cell, { toolCalls: d.toolCalls, error: d.error, setupMs }));
      } catch (e) {
        append(recordOf({ arm: u.cell.arm, model: u.cell.model, id: u.id, correct: false, firstIn: 0, tokensIn: 0, tokensOut: 0, tokens: 0, calls: 0, cost: 0, ms: 0 }, u.cell, { toolCalls: 0, error: `harness: ${String((e as Error).message)}`, setupMs }));
      } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(`${dir}.bench`, { recursive: true, force: true }); }
    }, o.staggerMs);
  }
  console.log(renderReport(rowsOf(loadRecords(file))));
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(scrubHome(String((e as Error).message))); process.exitCode = 1; });
