#!/usr/bin/env node
// Real-project eval generator. Reads a project's brain directory (READ-ONLY; found through its .plangraphrc, else .plangraph) and writes, into a
// TEMP directory only, a self-contained suite: a private copy of the plugin, the copied plan as fixture R, the native case directories
// and cases.json (the case objects with ground truth, for evals/report.ts). Real people, ticket keys and summaries therefore exist only
// in that temp directory: nothing is ever written into this repository or into the source project.
//   node evals/gen-real.ts --from <project root> [--out <empty dir outside both trees>] [--runs N] [--verify]
// --verify cross-checks every derivable answer against the real `brain` CLI on scaffolded workspaces (zero model calls).
// Output: one line per fact (out dir, counts), never ticket text, keys or names. Exit 0 ok, 1 truth mismatch (--verify), 2 refused.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readCapped } from '../lib/jsonl.ts';
import { resolveBrainDir, writeAtomicSafe } from '../lib/fsafe.ts';
import { validateCase } from './schema.ts';
import type { EvalCase } from './schema.ts';
import { buildFamilies, buildSafety, makeStale, modelFromFiles } from './families.ts';
import type { Deps } from './families.ts';
import { writeSuite } from './native.ts';
import { checkTruth } from './truthcheck.ts';

const here = import.meta.dirname;
export const REPO_ROOT = path.resolve(here, '..');
// Copied: what any case needs. Not copied: evidence.jsonl (large audit evidence no case asks about), the SQLite index (rebuilt by each
// scaffold), CARD.md, meta.jsonl, refs.jsonl (replaced: real refs point at plan files that are not in the copy).
export const COPY = ['tickets.jsonl', 'edges.jsonl', 'schedule.jsonl', 'findings.jsonl', 'open-items.jsonl', 'learnings.jsonl', 'config.json'];
const MAX_FILE = 64 << 20;

export class Refused extends Error {}
const refuse: (m: string) => never = (m) => { throw new Refused(m); }; // an explicit type lets `refuse(...)` narrow like a throw

const realOrParent = (p: string) => { let cur = path.resolve(p); const tail: string[] = []; while (!fs.existsSync(cur)) { tail.unshift(path.basename(cur)); const up = path.dirname(cur); if (up === cur) break; cur = up; } return path.join(fs.realpathSync(cur), ...tail); };
const inside = (child: string, parent: string) => { const r = path.relative(parent, child); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };

// The output directory must be outside this repository and outside the source project, and empty (or not yet existing).
export function checkOut(out: string, { from, repo = REPO_ROOT }: { from: string; repo?: string }): string {
  const o = realOrParent(out);
  if (inside(o, fs.realpathSync(repo))) refuse('refusing to write real-project data inside the plangraph repository; choose a temp directory');
  if (inside(o, fs.realpathSync(from))) refuse('refusing to write inside the source project; choose a temp directory');
  if (fs.existsSync(o)) {
    const st = fs.lstatSync(o);
    if (st.isSymbolicLink() || !st.isDirectory()) refuse('--out must be a directory');
    if (fs.readdirSync(o).length) refuse('--out must be empty');
  }
  return o;
}

export function readBrain(from: string): { dir: string; files: Record<string, string> } {
  const root = fs.realpathSync(from);
  let dir = '.plangraph';
  const rc = path.join(root, '.plangraphrc');
  if (fs.existsSync(rc)) {
    if (fs.lstatSync(rc).isSymbolicLink()) refuse('.plangraphrc is a symlink');
    let j: { dir?: unknown } | null; try { j = JSON.parse(readCapped(rc, 64 * 1024)); } catch { refuse('.plangraphrc is not valid JSON'); }
    if (!j || typeof j.dir !== 'string' || !j.dir) refuse('.plangraphrc needs a "dir" string');
    dir = j.dir;
  }
  let abs: string | undefined; try { abs = resolveBrainDir(root, dir); } catch { refuse('the brain directory is not usable'); }
  if (!fs.existsSync(path.join(abs, 'tickets.jsonl'))) refuse('no tickets.jsonl in the brain directory');
  const files: Record<string, string> = {};
  for (const n of COPY) {
    const f = path.join(abs, n);
    if (!fs.existsSync(f)) { files[n] = n === 'config.json' ? '{}\n' : ''; continue; }
    if (fs.lstatSync(f).isSymbolicLink()) refuse('a brain data file is a symlink');
    files[n] = readCapped(f, MAX_FILE);
  }
  return { dir: path.posix.normalize(dir.split(path.sep).join('/')).replace(/\/$/, ''), files };
}

// Read the project (read-only) and build the cases with ground truth. Writes nothing.
export function prepareReal({ from, deps }: { from?: string | undefined; deps?: Deps | undefined } = {}) {
  if (!from) refuse('--from is required');
  const { dir, files: src } = readBrain(from);
  const m0 = modelFromFiles(src).m;
  // plan.md + refs for the stale family: sections built from the ticket summaries, refs fingerprinted on the original text
  let st = null;
  for (const p of [{ leaves: 3, maxClosure: 3, maxStale: 12 }, { leaves: 2, maxClosure: 6, maxStale: 15 }, { leaves: 1, maxClosure: 10, maxStale: 20 }]) { st = makeStale(m0, { ...p, deps }); if (st) break; }
  const jl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
  const files = { ...src, 'refs.jsonl': st ? jl(st.refs) : '' };
  const env = { prefix: 'r', size: 'R', seed: null, dir, files, stale: st ? { stale: st.stale, edited: st.edited } : null, deps };
  const f = buildFamilies(env), s = buildSafety(env);
  const cases = [...f.cases, ...s.cases];
  for (const c of cases) { const e = validateCase(c); if (e.length) throw new Error(`generator invariant: case ${c.id} invalid: ${e.join('; ')}`); }
  const fixture = { ...files, 'format.json': '{"format_version":1,"min_reader":1}\n', 'plan.md': st ? st.planText : '# Plan\n' };
  const manifest = { schema: 'brain-real-eval/1', cases: cases.length, families: [...new Set(cases.map((c) => c.family))].length, skipped: [...f.skipped, ...s.skipped], tickets: m0.tickets.size, people: new Set([...m0.sched.values()].map((x) => x.owner)).size };
  return { dir, cases, fixture, manifest };
}

export function generateReal({ from, out, runs = 3, verify = false, deps, filter = null }: { from?: string | undefined; out?: string | undefined; runs?: number; verify?: boolean; deps?: Deps | undefined; filter?: ((cs: EvalCase[]) => EvalCase[]) | null } = {}) {
  const o = out ? checkOut(out, { from: from as string }) : fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-real-eval-'))); // as string: a missing `from` fails inside checkOut as before (prepareReal refuses it)
  const r = prepareReal({ from, deps });
  const cases = filter ? filter(r.cases) : r.cases;
  fs.mkdirSync(o, { recursive: true, mode: 0o700 });
  const plug = writeSuite(path.join(o, 'plugin'), { srcRoot: REPO_ROOT, cases, fixtures: { R: r.fixture }, runs, rcDir: r.dir, root: o });
  writeAtomicSafe(path.join(o, 'cases.json'), JSON.stringify(cases) + '\n', { root: o });
  writeAtomicSafe(path.join(o, 'manifest.json'), JSON.stringify(r.manifest, null, 1) + '\n', { root: o });
  let truth = null;
  if (verify) { const tmp = fs.mkdtempSync(path.join(o, 'verify-')); truth = checkTruth(cases, { evalDir: path.join(plug, 'evals'), tmp }); fs.rmSync(tmp, { recursive: true, force: true }); }
  return { out: o, plugin: plug, cases, manifest: r.manifest, truth, prepared: r };
}

const FLAGS = { bool: ['verify', 'help'], val: ['from', 'out', 'runs'] };
export interface Args { verify?: boolean; help?: boolean; from?: string; out?: string; runs?: string }
export function parseArgs(argv: string[]): Args {
  const o: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) refuse('unexpected argument');
    const n = a.slice(2);
    if (FLAGS.bool.includes(n)) o[n] = true;
    else if (FLAGS.val.includes(n)) { const v = argv[++i]; if (v === undefined || v.startsWith('--')) refuse(`--${n} needs a value`); o[n] = v; }
    else refuse('unknown option');
  }
  return o;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try {
    const o = parseArgs(process.argv.slice(2));
    if (o.help || !o.from) { process.stdout.write('usage: node evals/gen-real.ts --from <project root> [--out <empty temp dir>] [--runs N] [--verify]\n'); process.exitCode = o.help ? 0 : 2; }
    else {
      const runs = o.runs === undefined ? 3 : /^\d{1,2}$/.test(o.runs) && Number(o.runs) >= 1 && Number(o.runs) <= 50 ? Number(o.runs) : refuse('--runs must be 1..50');
      const r = generateReal({ from: o.from, out: o.out, runs, verify: !!o.verify });
      process.stdout.write(`out: ${r.out}\ncases: ${r.manifest.cases} (${r.manifest.families} families) on ${r.manifest.tickets} tickets, ${r.manifest.people} people\nskipped families: ${r.manifest.skipped.length ? r.manifest.skipped.join(', ') : 'none'}\n`);
      if (r.truth) {
        process.stdout.write(`truth vs brain CLI: ${r.truth.checked.length} cases checked, ${r.truth.mismatches.length} mismatches, ${r.truth.unchecked.length} not CLI-derivable\n`);
        for (const x of r.truth.mismatches.slice(0, 20)) process.stdout.write(`  mismatch: ${x.id} ${x.what}\n`);
        if (r.truth.mismatches.length) process.exitCode = 1;
      }
    }
  } catch (e) {
    if (e instanceof Refused) { process.stderr.write(`error: ${e.message}\n`); process.exitCode = 2; } else throw e;
  }
}
