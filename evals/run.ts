#!/usr/bin/env node
// Eval runner. It NEVER makes a paid model call by default, and never writes into this repository: every suite is built in a temp
// directory (a private plugin copy + fixtures + native cases), and results land there too.
//   node evals/run.ts --dry-run [--real <project root>]         build the suite in a temp dir, print the exact commands and a cost range
//   node evals/run.ts --emit-native [--real <root>] [--out DIR]  build the suite (DIR must be empty and outside this repository)
//   node evals/run.ts --run --max-cost-usd 25 [--real <root>]    PAID: build, then run `claude plugin eval` under that hard cap
// Without --real the committed synthetic suite (evals/cases, fixtures S/M/L) is used; with --real, evals/gen-real.ts generates the
// cases and fixture from that project's brain directory (read-only) into the temp dir.
// Selection: --family F, --kind task|control|safety|trigger, --size S|M|L|R, --case ID. Tuning: --runs N (1..50, default 3),
// --model M, --judge-model M, --concurrency N (1..8), --variants no-card,no-skills (extra single-arm ablation passes), --keep-temp.
// Every `claude plugin eval` run passes --no-publish (the default publishes the HTML report with prompts and transcripts to claude.ai).
// Exit codes: 0 ok, 2 usage or configuration error (fixed messages, never echoing the offending value), else the CLI's own status.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readCapped } from '../lib/jsonl.ts';
import { validateCase, KINDS, SIZES } from './schema.ts';
import { writeSuite, BASH_TOOLS } from './native.ts';
import { estimate, suggestBudget, PRICES } from './cost.ts';
import type { Pass, Estimate } from './cost.ts';
import type { EvalCase } from './schema.ts';

export interface Args {
  'dry-run'?: boolean; 'emit-native'?: boolean; run?: boolean; help?: boolean; 'keep-temp'?: boolean;
  case?: string; kind?: string; family?: string; size?: string; runs?: string; model?: string; 'judge-model'?: string; concurrency?: string; 'max-cost-usd'?: string; real?: string; out?: string; variants?: string;
}
export interface Selection { kind?: string | undefined; size?: string | undefined; family?: string | undefined; case?: string | undefined; real?: string | undefined }
export interface Options { runs: number; concurrency: number; budget: number | null; model: string; judge: string; variants: string[]; keepTemp: boolean; real?: string | undefined; kind?: string | undefined; size?: string | undefined; family?: string | undefined; case?: string | undefined }
export interface RunPass extends Pass<EvalCase> { ablation: string; variant: string }

const here = import.meta.dirname;
const root = path.resolve(here, '..');
const MAX_CASE_BYTES = 256 * 1024;
const FLAGS = { bool: ['dry-run', 'emit-native', 'run', 'help', 'keep-temp'], val: ['case', 'kind', 'family', 'size', 'runs', 'model', 'judge-model', 'concurrency', 'max-cost-usd', 'real', 'out', 'variants'] };
export const DEFAULT_MODEL = 'claude-sonnet-5-5'; // pinned: a model rollout must not look like a plugin regression
export const DEFAULT_JUDGE = 'claude-opus-5-5'; // a sonnet-tier or larger judge that is not the agent model (no self-preference)
export const VARIANTS = ['no-card', 'no-skills'];

export class Usage extends Error {}
const usage: (m: string) => never = (m) => { throw new Usage(m); }; // an explicit type lets `usage(...)` narrow like a throw

export function parseArgs(argv: string[]): Args {
  const o: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) usage('unexpected argument');
    const n = a.slice(2);
    if (FLAGS.bool.includes(n)) o[n] = true;
    else if (FLAGS.val.includes(n)) { const v = argv[++i]; if (v === undefined || v.startsWith('--')) usage(`--${n} needs a value`); o[n] = v; }
    else usage('unknown option');
  }
  return o as Args; // the loop sets a boolean only for the FLAGS.bool names and a string for the FLAGS.val names
}

// Strict numbers: digits only (no NaN, inf, hex, exponent, sign, whitespace), bounded.
export function strictNumber(s: unknown, { min, max, int = false, what }: { min: number; max: number; int?: boolean; what: string }): number {
  if (typeof s !== 'string' || !(int ? /^\d{1,6}$/ : /^\d{1,6}(?:\.\d{1,4})?$/).test(s)) usage(`${what} must be a plain number`);
  const n = Number(s);
  if (!Number.isFinite(n) || n < min || n > max) usage(`${what} must be between ${min} and ${max}`);
  return n;
}
const modelName = (s: string, what: string) => { if (!/^[A-Za-z0-9._-]{1,60}$/.test(s)) usage(`${what} is not a model name`); return s; };

export function loadCases(dir = path.join(here, 'cases')): EvalCase[] {
  const out: EvalCase[] = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    let c: EvalCase;
    try { c = JSON.parse(readCapped(path.join(dir, f), MAX_CASE_BYTES)); } catch { usage('a case file is unreadable or not JSON'); }
    if (validateCase(c).length) usage('a case file is invalid; run node --test test/evals-schema.test.ts');
    if (f !== `${c.id}.json`) usage('a case file name differs from its id');
    out.push(c);
  }
  if (!out.length) usage('no cases found; run node evals/gen.ts');
  return out;
}

export const sq = (s: unknown) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const inside = (child: string, parent: string) => { const r = path.relative(parent, child); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };

export function select(cases: EvalCase[], o: Selection): EvalCase[] {
  let cs = cases;
  if (o.kind !== undefined) { if (!KINDS.includes(o.kind)) usage(`--kind must be one of ${KINDS.join(', ')}`); cs = cs.filter((c) => c.kind === o.kind); }
  if (o.size !== undefined) { if (!SIZES.includes(o.size)) usage('--size must be S, M, L or R'); cs = cs.filter((c) => c.fixture.size === o.size); }
  if (o.family !== undefined) { if (!/^[a-z0-9-]{2,40}$/.test(o.family)) usage('--family is not a family name'); cs = cs.filter((c) => c.family === o.family || c.family.startsWith(o.family + '-')); }
  if (o.case !== undefined) { if (!/^[a-z0-9][a-z0-9-]{2,60}$/.test(o.case)) usage('--case is not a case id'); cs = cs.filter((c) => c.id === o.case); }
  if (!cs.length) usage('no case matches the selection');
  return cs;
}

// The cases and where their fixtures come from: the committed synthetic suite, or a real project read through gen-real (read-only).
export async function sourceCases(o: Selection) {
  if (o.real) {
    const { prepareReal, Refused } = await import('./gen-real.ts');
    try {
      const r = prepareReal({ from: o.real });
      return { cases: select(r.cases, o), fixtures: { R: r.fixture }, rcDir: r.dir, brainDir: '.plangraph', manifest: r.manifest };
    } catch (e) { if (e instanceof Refused) usage(e.message); throw e; }
  }
  const cases = select(loadCases(), o);
  return { cases, fixtures: Object.fromEntries(['S', 'M', 'L'].map((z) => [z, path.join(here, 'fixtures', z)])), rcDir: null, brainDir: '.plangraph', manifest: null };
}

// The passes of one run: the scored two-arm pass, the single-arm pass that scores skill firing, and optional ablation variants.
export function passesFor(cases: EvalCase[], o: { variants: string[] }): RunPass[] {
  const passes: RunPass[] = [{ name: 'headline', cases, arms: ['with', 'without'], ablation: 'with-without', variant: 'full' }];
  const trig = cases.filter((c) => c.kind === 'trigger');
  if (trig.length) passes.push({ name: 'triggers', cases: trig, arms: ['with'], ablation: 'none', variant: 'full' });
  for (const v of o.variants) passes.push({ name: v, cases: cases.filter((c) => c.kind !== 'trigger'), arms: ['with'], ablation: 'none', variant: v });
  return passes.filter((p) => p.cases.length);
}

export function evalArgs(pass: { name: string; ablation: string }, o: Options, { pluginDir, outDir, budget }: { pluginDir: string; outDir: string; budget: number }): string[] {
  return ['plugin', 'eval', pluginDir, '--scaffold', '--trust-plugin', '--no-publish', '--allow-tools', ...BASH_TOOLS, '--ablation', pass.ablation, '--model', o.model, '--judge-model', o.judge,
    '--runs', String(o.runs), '-j', String(o.concurrency), '--threshold', '0.8', '--max-cost-usd', budget.toFixed(2), '--output-dir', path.join(outDir, pass.name), '--json', path.join(outDir, `${pass.name}.json`), '--report', path.join(outDir, `${pass.name}.html`), ...(o.keepTemp ? ['--keep-temp'] : [])];
}

// Split the hard cap across passes in proportion to each pass's high estimate; the shares sum to the cap.
export function splitBudget(est: { passes: Array<{ hi: number }> }, cap: number): number[] {
  const tot = est.passes.reduce((s, p) => s + p.hi, 0) || 1;
  const shares = est.passes.map((p) => Math.floor(((cap * p.hi) / tot) * 100 + 1e-9) / 100); // 1e-9: a whole share such as 3.5 * hi / hi = 3.4999999999999996 must not lose a cent
  return shares.map((s) => Math.max(0.01, s));
}

function commandsText(suite: string, cases: EvalCase[], o: Options, passes: RunPass[], est: Estimate, budgets: number[], skipped: string[] = []): string {
  const out: string[] = [];
  const line = (s = '') => out.push(s);
  line(`# Suite built (no model call made): ${suite}`);
  line(`# ${cases.length} cases (${[...new Set(cases.map((c) => c.family))].length} families; ${KINDS.map((k) => `${cases.filter((c) => c.kind === k).length} ${k}`).join(', ')}), ${o.runs} runs per case and arm, agent ${o.model}, judge ${o.judge}`);
  if (skipped.length) line(`# skipped families (not constructible on this plan): ${skipped.join(', ')}`);
  line('# Flags checked against `claude plugin eval --help` of Claude Code 2.1.329. --no-publish keeps transcripts local.');
  passes.forEach((p, i) => {
    const pluginDir = `"$SUITE/pass-${p.name}"`;
    const args = evalArgs(p, o, { pluginDir: 'PLUGIN', outDir: 'OUT', budget: budgets[i] }).map((a) => (a === 'PLUGIN' ? pluginDir : a.startsWith('OUT') ? `"$SUITE/results${a.slice(3)}"` : /[ ()*]/.test(a) ? sq(a) : a));
    line();
    line(`# pass ${i + 1}: ${p.name} (${p.ablation}; ${p.cases.length} cases x ${p.arms.length} arm(s) x ${o.runs} runs; estimate ${p.name === est.passes[i].name ? `${est.passes[i].lo.toFixed(2)}-${est.passes[i].hi.toFixed(2)}` : '?'} USD; cap ${budgets[i].toFixed(2)})`);
    line(`SUITE=${sq(suite)}; claude ${args.join(' ')}`);
  });
  line();
  line(`node ${sq(path.join(here, 'report.ts'))} --suite "$SUITE"`);
  line();
  line(`# cost estimate (list prices; projected from each case's prompt, max_turns cap and fixture size, see evals/cost.ts): ${est.lo.toFixed(2)} to ${est.hi.toFixed(2)} USD over ${est.runsTotal} agent runs`);
  line(`# suggested --max-cost-usd: ${suggestBudget(est)} (the cap is the hard stop: checked before each run launches; overrun bounded by runs in flight, -j ${o.concurrency})`);
  return out.join('\n') + '\n';
}

async function main(argv: string[]): Promise<number> {
  const o = parseArgs(argv);
  if (o.help || argv.length === 0) {
    const head: string[] = []; for (const l of fs.readFileSync(import.meta.filename, 'utf8').split('\n').slice(1)) { if (!l.startsWith('//')) break; head.push(l.slice(3)); }
    process.stdout.write(head.join('\n') + '\n');
    return 0;
  }
  const modes = (['dry-run', 'emit-native', 'run'] as const).filter((m) => o[m]);
  if (modes.length !== 1) usage('choose exactly one of --dry-run, --emit-native, --run');
  if (o.run && o['max-cost-usd'] === undefined) usage('--run needs --max-cost-usd (paid model calls need an explicit cap)');
  if (o['emit-native'] && o['max-cost-usd'] !== undefined) usage('--max-cost-usd only applies to --run or --dry-run');
  const opt = {
    runs: o.runs === undefined ? 3 : strictNumber(o.runs, { min: 1, max: 50, int: true, what: '--runs' }),
    concurrency: o.concurrency === undefined ? 3 : strictNumber(o.concurrency, { min: 1, max: 8, int: true, what: '--concurrency' }),
    budget: o['max-cost-usd'] === undefined ? null : strictNumber(o['max-cost-usd'], { min: 0.01, max: 1000, what: '--max-cost-usd' }),
    model: modelName(o.model ?? DEFAULT_MODEL, '--model'), judge: modelName(o['judge-model'] ?? DEFAULT_JUDGE, '--judge-model'),
    variants: o.variants === undefined ? [] : o.variants.split(',').map((v) => (VARIANTS.includes(v) ? v : usage('--variants takes no-card and/or no-skills'))),
    keepTemp: !!o['keep-temp'], real: o.real, kind: o.kind, size: o.size, family: o.family, case: o.case,
  };
  if (opt.real !== undefined && (typeof opt.real !== 'string' || !fs.existsSync(opt.real) || !fs.statSync(opt.real).isDirectory())) usage('--real must be an existing project directory');
  let suite: string;
  if (o.out !== undefined) {
    const abs = path.resolve(o.out);
    let real = abs; try { real = fs.realpathSync(abs); } catch { /* not yet there */ }
    if (inside(real, fs.realpathSync(root)) || inside(abs, root)) usage('--out must be outside this repository');
    if (fs.existsSync(real) && fs.readdirSync(real).length) usage('--out must be empty');
    suite = real;
  } else suite = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-eval-')));
  const src = await sourceCases(opt);
  const cases = src.cases;
  const passes = passesFor(cases, opt);
  for (const p of passes) writeSuite(path.join(suite, `pass-${p.name}`), { srcRoot: root, cases: p.cases, fixtures: src.fixtures, runs: opt.runs, brainDir: src.brainDir, rcDir: src.rcDir, variant: p.variant, root: suite });
  fs.writeFileSync(path.join(suite, 'cases.json'), JSON.stringify(cases) + '\n');
  const est = estimate(passes, { runs: opt.runs, model: opt.model, judgeModel: opt.judge }) || { passes: passes.map((p) => ({ name: p.name, lo: 0, hi: 1 })), lo: Number.NaN, hi: Number.NaN, runsTotal: 0 };
  const cap = opt.budget ?? suggestBudget(est);
  const budgets = splitBudget(est, cap);
  if (!PRICES[opt.model] || !PRICES[opt.judge]) process.stderr.write('note: no list price known for this model; the estimate is not available\n');

  if (o['dry-run']) { process.stdout.write(commandsText(suite, cases, opt, passes, est, budgets, src.manifest ? src.manifest.skipped : [])); return 0; }
  if (o['emit-native']) { process.stdout.write(`suite: ${suite}\n${cases.length} cases in ${passes.length} pass director${passes.length === 1 ? 'y' : 'ies'} (pass-*/evals)\n`); return 0; }
  // --run: the only path that spends money. Both --run and --max-cost-usd were required above.
  const outDir = path.join(suite, 'results');
  fs.mkdirSync(outDir, { recursive: true });
  let status = 0;
  for (let i = 0; i < passes.length; i++) {
    const p = passes[i];
    const r = spawnSync('claude', evalArgs(p, opt, { pluginDir: path.join(suite, `pass-${p.name}`), outDir, budget: budgets[i] }), { cwd: suite, stdio: 'inherit' });
    if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT') usage('claude is not installed or not on PATH'); // as ErrnoException: a spawn failure carries a code
    if (typeof r.status === 'number' && r.status !== 0 && status === 0) status = r.status;
  }
  spawnSync(process.execPath, [path.join(here, 'report.ts'), '--suite', suite], { stdio: 'inherit' });
  process.stdout.write(`results: ${outDir}\n`);
  return status;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => {
    if (e instanceof Usage) { process.stderr.write(`error: ${e.message}\n`); process.exitCode = 2; } else { process.stderr.write('error: the runner failed unexpectedly\n'); process.exitCode = 5; throw e; }
  });
}
