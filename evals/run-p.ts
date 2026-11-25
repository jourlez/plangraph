#!/usr/bin/env node
// Direct eval runner: every case runs through `claude -p` itself, arm A WITH the plugin (--plugin-dir <private plugin copy>) and arm B
// WITHOUT it, with the same prompt, the same freshly scaffolded workspace (a temp dir outside the repository, git-initialised), the same
// built-in tools and the same tool grant. Why not `claude plugin eval`: in that harness the plugin's bin/ is not on the Bash PATH (every
// `brain` call exited 127 in pilot #1), so its plugin arm did not measure the plugin; with `claude -p --plugin-dir` it is.
//   node evals/run-p.ts --dry-run [--real <root>] [selection]                 build the suite, print the plan and a cost range (no model call)
//   node evals/run-p.ts --run --max-cost-usd N [--real <root>] [selection]    PAID: run under the global hard cap, then print the report
//   node evals/run-p.ts --run --max-cost-usd N --resume <suite dir>           continue a suite (finished runs are kept, budget counts them)
//   node evals/run-p.ts --probe --max-cost-usd 0.3                            PAID (cents): one Bash `brain card --line` per arm; proves
//                                                                              brain runs in arm A and is absent in arm B
// Selection: --case ID, --family F, --kind K, --size S|M|L|R, --style natural|layout-told|both (default natural), --runs N (default 3).
// Tuning: --model M (default the pinned agent model), -j N parallel runs (default 3), --per-run-usd X (default: the case's max_usd),
// --claude PATH (default `claude` on PATH, or $CLAUDE_BIN), --keep-workspaces.
// Isolation (identical in both arms): --setting-sources project (no user settings, so no user plugins, hooks or permissions),
// --strict-mcp-config (no MCP servers), --tools Read,Grep,Glob,Bash,Skill,Edit,Write (no subagents, no web), --permission-mode dontAsk
// with the same --allowedTools (reads and read-style Bash; Edit/Write are visible but never granted, so an attempt is denied and graded),
// --no-session-persistence, a clean environment (the parent session's CLAUDE_* variables removed, PATH entries holding a `brain` binary
// removed so only the plugin can provide it). Auth is the operator's normal login (an isolated CLAUDE_CONFIG_DIR is not logged in).
// Graders: the case's own graders (evals/schema.ts grade) over the parsed stream-json trace, with two changes: safe-no-write-bash uses
// the structural reader (evals/bashwrite.ts), and the file list is a sha256 diff of every workspace file before and after the run
// (derived SQLite index ignored; the card and report outputs ignored only in cases that do not forbid writing), plus a moved git HEAD.
// Every suite, trace and result lives in a temp directory (real-project data never enters the repository). Exit: 0 ok, 2 usage, 3 cap hit.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { readCapped } from '../lib/jsonl.ts';
import { sourceCases, strictNumber, Usage, DEFAULT_MODEL, select } from './run.ts';
import { copyPlugin } from './native.ts';
import { grade, parseAnswer, WRITE_BASH } from './schema.ts';
import { parseTrace, pluginUsed } from './trace.ts';
import { isWriteBash } from './bashwrite.ts';
import { styledPrompt, PROMPT_STYLES } from './families.ts';
import { applyOverlayToDisk } from './overlay.ts';
import { estimate, PRICES } from './cost.ts';
import type { EvalCase, Grader } from './schema.ts';

/** The run record (rec) saved in results/run-p.json and read by evals/report.ts. */
export interface Rec {
  key: string; id: string; family: string; kind: string; tags: string[]; style: string; arm: string; run: number; score: number; passed: boolean;
  graders: Array<{ name: string; passed: boolean; role?: string; scored?: boolean }>; failed: string[]; turns: number | null; cost: number | null; tokens: number | null;
  durationS: number; error: string | null; budgetStop?: boolean; denials?: number; plugin?: ReturnType<typeof parseTrace>['plugin'] | null; pluginUsed?: boolean; init?: unknown;
  changed?: string[]; answer?: unknown; message?: string; tracePath?: string; workspace?: string;
}
export interface Job { key: string; c: EvalCase; style: string; arm: string; run: number; budget: number }
interface SuiteCtx { suite: string; rcDir: string | null | undefined; brainDir: string | undefined; model: string; claude: string; keepWorkspaces: boolean }
interface Opt { runs: number; j: number; budget: number | null; perRunUsd: number | null; model: string; styles: string[]; claude: string; keepWorkspaces: boolean }
const here = import.meta.dirname;
const root = path.resolve(here, '..');
const MAX = 64 << 20;
export const SCHEMA_P = 'brain-eval-p/1';
export const THRESHOLD = 0.8;
export const TOOLS = ['Read', 'Grep', 'Glob', 'Bash', 'Skill', 'Edit', 'Write'];
// The same grant in both arms. Bash: the plugin CLI plus the read-style commands an agent uses on a repository (python3/node so arm B
// can compute over the JSONL like a capable user would). Write-capable commands that slip through are caught by the integrity graders.
export const BASH_CMDS = ['brain', 'cd', 'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'jq', 'sort', 'uniq', 'cut', 'awk', 'tr', 'find', 'git', 'node', 'python3', 'echo', 'printf', 'sed'];
export const ALLOWED = ['Read', 'Grep', 'Glob', 'Skill', ...BASH_CMDS.map((c) => `Bash(${c}:*)`)];
export const ARMS: Array<'with' | 'without'> = ['with', 'without']; // A, B (names shared with the native aggregate and evals/report.ts)

export class CapHit extends Error {}
const usage: (m: string) => never = (m) => { throw new Usage(m); }; // an explicit type lets `usage(...)` narrow like a throw
const inside = (child: string, parent: string) => { const r = path.relative(parent, child); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };

// ---------------------------------------------------------------- args
const FLAGS = { bool: ['dry-run', 'run', 'probe', 'help', 'keep-workspaces'], val: ['case', 'kind', 'family', 'size', 'runs', 'model', 'j', 'max-cost-usd', 'real', 'out', 'resume', 'style', 'per-run-usd', 'claude'] };
export interface Args {
  'dry-run'?: boolean; run?: boolean; probe?: boolean; help?: boolean; 'keep-workspaces'?: boolean;
  case?: string; kind?: string; family?: string; size?: string; runs?: string; model?: string; j?: string; 'max-cost-usd'?: string; real?: string; out?: string; resume?: string; style?: string; 'per-run-usd'?: string; claude?: string;
}
export function parseArgs(argv: string[]): Args {
  const o: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const n = a === '-j' ? 'j' : a.startsWith('--') ? a.slice(2) : usage('unexpected argument');
    if (FLAGS.bool.includes(n)) o[n] = true;
    else if (FLAGS.val.includes(n)) { const v = argv[++i]; if (v === undefined || v.startsWith('-')) usage(`--${n} needs a value`); o[n] = v; }
    else usage('unknown option');
  }
  return o as Args; // the loop sets a boolean only for the FLAGS.bool names and a string for the FLAGS.val names
}
export const stylesOf = (s = 'natural'): string[] => (s === 'both' ? [...PROMPT_STYLES] : PROMPT_STYLES.includes(s) ? [s] : usage('--style must be natural, layout-told or both'));

// ---------------------------------------------------------------- the claude command line (pure)
export function claudeArgs({ arm, model, budget, pluginDir }: { arm: string; model: string; budget: number; pluginDir: string }): string[] {
  return ['-p', '--model', model, '--output-format', 'stream-json', '--verbose', '--include-hook-events', '--no-session-persistence', '--max-budget-usd', budget.toFixed(2),
    '--setting-sources', 'project', '--strict-mcp-config', '--tools', TOOLS.join(','), '--permission-mode', 'dontAsk', '--allowedTools', ALLOWED.join(','),
    ...(arm === 'with' ? ['--plugin-dir', pluginDir] : [])];
}
// The child environment: the operator's (auth, PATH) minus the parent session's Claude variables and brain settings, and minus PATH
// entries that hold a `brain` executable (so arm B cannot reach one and arm A gets it only from the plugin).
const KEEP_CLAUDE = new Set(['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']);
export function childEnv(env: Record<string, string | undefined> = process.env, { hasBrain = (d: string) => fs.existsSync(path.join(d, 'brain')) }: { hasBrain?: (dir: string) => boolean } = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (/^CLAUDE/.test(k) && !KEEP_CLAUDE.has(k)) continue;
    if (/^PLANGRAPH_/.test(k)) continue;
    out[k] = v;
  }
  out.PATH = String(env.PATH || '').split(path.delimiter).filter((d) => d && !hasBrain(d)).join(path.delimiter);
  out.DISABLE_AUTOUPDATER = '1';
  return out;
}

// ---------------------------------------------------------------- workspace integrity (hash diff)
const DERIVED = /(?:^|\/)[^/]*\.sqlite(?:-wal|-shm|-journal)?$/;
/** sha256 of every regular file under ws (no .git; symlinks recorded by target), plus the git HEAD as '.git/HEAD'. */
export function snapshot(ws: string, { headOf = gitHead }: { headOf?: (ws: string) => string | null } = {}): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string, rel: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name, full = path.join(d, e.name);
      if (!rel && e.name === '.git') continue;
      if (e.isSymbolicLink()) out.set(r, `link:${fs.readlinkSync(full)}`);
      else if (e.isDirectory()) walk(full, r);
      else if (e.isFile()) out.set(r, crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex'));
    }
  };
  walk(ws, '');
  const h = headOf(ws); if (h) out.set('.git/HEAD', h);
  return out;
}
function gitHead(ws: string): string | null { const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ws, encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null; }
// Files the agent created, changed or deleted, minus what is not the agent's write: the derived index always; the session card and the
// report outputs only when the case does not forbid writing (tag no-write).
export function changedFiles(before: Map<string, string>, after: Map<string, string>, { brainDir = '.plangraph', forbidAll = false }: { brainDir?: string; forbidAll?: boolean } = {}): string[] {
  const outputs = new Set([`${brainDir}/CARD.md`, `${brainDir}/report.md`, `${brainDir}/report.html`]);
  const keys = new Set([...before.keys(), ...after.keys()]);
  return [...keys].filter((k) => before.get(k) !== after.get(k)).filter((k) => !DERIVED.test(k) && (forbidAll || !outputs.has(k))).sort();
}

// ---------------------------------------------------------------- grading (pure over a parsed trace)
export function gradeRun(c: { graders: Grader[] }, t: ReturnType<typeof parseTrace>, { arm, files, fileTexts }: { arm: string; files: string[]; fileTexts: Record<string, string> }) {
  const g = grade(c, { message: t.message, calls: t.calls.map((x) => ({ tool: x.tool, input: x.input })), files, fileTexts, trace: '' }, { arm, ablation: 'with-without', matchers: { [WRITE_BASH]: isWriteBash } });
  return { score: g.score, passed: g.score >= THRESHOLD, graders: g.results.map((r) => ({ name: r.id, passed: r.pass === true, role: r.role, scored: r.scored })), failed: g.failed };
}

// ---------------------------------------------------------------- suite and scaffold
// Fixture files per size: a directory to copy (synthetic) or { name: text } (real, from gen-real). Writes suite/fixtures/<size>/.
function writeFixtures(suite: string, fixtures: Record<string, string | Record<string, string>>, sizes: string[]) {
  for (const size of sizes) {
    const to = path.join(suite, 'fixtures', size), src = fixtures[size];
    fs.mkdirSync(to, { recursive: true, mode: 0o700 });
    if (typeof src === 'string') fs.cpSync(src, to, { recursive: true });
    else for (const [n, t] of Object.entries(src)) fs.writeFileSync(path.join(to, n), t);
  }
}
const git = (ws: string, args: string[], env: Record<string, string>) => spawnSync('git', ['-c', 'user.name=eval', '-c', 'user.email=eval@example.invalid', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd: ws, encoding: 'utf8', env });
/** Build a case workspace (same steps as the native scaffold.sh, plus the merge driver wired before the commit so the plugin's session
 * hook finds nothing to heal, and a .gitignore for the derived index as a real project has). Returns the brain dir relative to ws. */
export function scaffold(ws: string, c: Pick<EvalCase, 'fixture'>, { suite, rcDir = null, brainDir = '.plangraph' }: { suite: string; rcDir?: string | null | undefined; brainDir?: string | undefined }): string {
  const fx = path.join(suite, 'fixtures', c.fixture.size), dir = rcDir || brainDir, brainBin = path.join(suite, 'plugin', 'bin', 'brain');
  const env = { ...childEnv(), CLAUDE_PLUGIN_DATA: path.join(suite, 'plugin-data'), HOME: process.env.HOME || os.homedir() };
  fs.copyFileSync(path.join(fx, 'plan.md'), path.join(ws, 'plan.md'));
  if (c.fixture.brain) {
    fs.mkdirSync(path.join(ws, dir), { recursive: true });
    for (const n of fs.readdirSync(fx)) if (/\.jsonl$/.test(n) || n === 'config.json' || n === 'format.json') fs.copyFileSync(path.join(fx, n), path.join(ws, dir, n));
    if (rcDir) fs.writeFileSync(path.join(ws, '.plangraphrc'), `${JSON.stringify({ dir: rcDir })}\n`);
    if (c.fixture.overlay.length) applyOverlayToDisk(c.fixture.overlay, dir, ws);
    fs.writeFileSync(path.join(ws, '.gitignore'), '*.sqlite\n*.sqlite-*\n');
  }
  if (git(ws, ['init', '-q'], env).status !== 0) throw new Error('git init failed in the workspace');
  if (c.fixture.brain) spawnSync(process.execPath, [brainBin, 'doctor', '--fix'], { cwd: ws, env, encoding: 'utf8', timeout: 60000 });
  git(ws, ['add', '-A'], env);
  if (git(ws, ['commit', '-qm', 'fixture'], env).status !== 0) throw new Error('git commit failed in the workspace');
  if (c.fixture.brain && spawnSync(process.execPath, [brainBin, 'build'], { cwd: ws, env, encoding: 'utf8', timeout: 300000 }).status !== 0) throw new Error('brain build failed in the workspace');
  return dir;
}

// ---------------------------------------------------------------- one run
export interface ClaudeResult { code: number | null; timedOut: boolean; spawnError: boolean }
function runClaude(bin: string, args: string[], { cwd, prompt, env, timeoutS, tracePath }: { cwd: string; prompt: string; env: Record<string, string>; timeoutS: number; tracePath: string }): Promise<ClaudeResult> {
  return new Promise((resolve) => {
    const out = fs.openSync(tracePath, 'w'), err = fs.openSync(`${tracePath}.stderr`, 'w');
    let child: ChildProcess;
    try { child = spawn(bin, args, { cwd, env, stdio: ['pipe', out, err], detached: true }); } catch { fs.closeSync(out); fs.closeSync(err); resolve({ code: null, timedOut: false, spawnError: true }); return; }
    let timedOut = false, done = false;
    const kill = (sig: NodeJS.Signals) => { try { process.kill(-(child.pid as number), sig); } catch { /* gone */ } }; // as number: a spawned child has a pid
    const t = setTimeout(() => { timedOut = true; kill('SIGTERM'); setTimeout(() => kill('SIGKILL'), 5000).unref(); }, timeoutS * 1000);
    const finish = (r: ClaudeResult) => { if (done) return; done = true; clearTimeout(t); fs.closeSync(out); fs.closeSync(err); resolve(r); };
    child.on('error', () => finish({ code: null, timedOut, spawnError: true }));
    child.on('close', (code) => finish({ code, timedOut, spawnError: false }));
    (child.stdin as NodeJS.WritableStream).on('error', () => {}); // stdio[0] is 'pipe'
    (child.stdin as NodeJS.WritableStream).end(prompt); // as: stdio[0] is 'pipe', so stdin is a stream
  });
}

async function runJob(job: Job, S: SuiteCtx): Promise<Rec> {
  const { c, style, arm, run } = job;
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-p-ws-')));
  if (inside(ws, root)) throw new Error('refusing a workspace inside the repository');
  const tracePath = path.join(S.suite, 'traces', `${job.key}.jsonl`);
  const t0 = Date.now();
  let rec: Rec;
  try {
    const dir = scaffold(ws, c, { suite: S.suite, rcDir: S.rcDir, brainDir: S.brainDir });
    const before = snapshot(ws);
    const prompt = styledPrompt(c, style, dir);
    const r = await runClaude(S.claude, claudeArgs({ arm, model: S.model, budget: job.budget, pluginDir: path.join(S.suite, 'plugin') }), { cwd: ws, prompt, env: childEnv(), timeoutS: c.limits.timeout_s, tracePath });
    const t = parseTrace(readCapped(tracePath, MAX));
    const after = snapshot(ws);
    const files = changedFiles(before, after, { brainDir: dir, forbidAll: c.tags.includes('no-write') });
    const fileTexts: Record<string, string> = {};
    for (const g of c.graders) if (g.type === 'regex' && typeof g.target === 'object') { const f = path.join(ws, g.target.file); try { fileTexts[g.target.file] = readCapped(f, MAX); } catch { /* absent: the grader fails */ } }
    const gr = gradeRun(c, t, { arm, files, fileTexts });
    const error = r.spawnError ? 'spawn' : r.timedOut ? 'timeout' : !t.result ? `no result (exit ${r.code})` : t.result.isError && !t.message ? `error ${t.result.subtype}` : null;
    rec = { key: job.key, id: c.id, family: c.family, kind: c.kind, tags: c.tags, style, arm, run, ...gr, turns: t.result?.turns ?? null, cost: t.result?.cost ?? null, tokens: t.result?.tokens ?? null,
      durationS: Math.round((Date.now() - t0) / 1000), error, budgetStop: t.result?.subtype === 'error_max_budget_usd', denials: t.denials, plugin: t.plugin, pluginUsed: pluginUsed(t.plugin), init: t.init && { plugins: t.init.plugins, mcp: t.init.mcp, model: t.init.model, version: t.init.version },
      changed: files, answer: parseAnswer(t.message), message: t.message, tracePath };
  } catch (e) {
    rec = { key: job.key, id: c.id, family: c.family, kind: c.kind, tags: c.tags, style, arm, run, score: 0, passed: false, graders: [], failed: [], turns: null, cost: null, tokens: null, durationS: Math.round((Date.now() - t0) / 1000), error: `harness: ${String((e as Error)?.message || e).slice(0, 120)}`, plugin: null, pluginUsed: false, changed: [], tracePath }; // as Error: whatever was thrown, `?.` tests it
  } finally {
    if (!S.keepWorkspaces) fs.rmSync(ws, { recursive: true, force: true });
  }
  if (S.keepWorkspaces) rec.workspace = ws;
  return rec;
}

// ---------------------------------------------------------------- results store and budget
export function loadResults(file: string): { schema: string; model?: string; records: Rec[] } | null {
  try { const j = JSON.parse(readCapped(file, MAX)); if (j && j.schema === SCHEMA_P && Array.isArray(j.records)) return j; } catch { /* none yet */ }
  return null;
}
function saveResults(file: string, j: unknown) { const tmp = `${file}.tmp-${process.pid}`; fs.writeFileSync(tmp, `${JSON.stringify(j)}\n`); fs.renameSync(tmp, file); }
export const spentOf = (records: Array<{ cost: number | null }>) => records.reduce((s: number, r) => s + (Number.isFinite(r.cost) ? r.cost as number : 0), 0); // as number: Number.isFinite is the check
// May a run with this reservation start now? spent + in-flight reservations + this one must stay within the cap.
export const mayLaunch = ({ spent, inflight, reserve, cap }: { spent: number; inflight: number; reserve: number; cap: number }) => spent + inflight + reserve <= cap + 1e-9;

/** jobs: [{key, budget, ...}]; runOne(job) -> record. Runs up to `j` at once; never launches past the cap; returns { records, skipped }. */
export async function pool<J extends { key: string; budget: number }, R extends { cost: number | null }>(jobs: J[], { j, cap, spent0 = 0, runOne, onRecord = () => {} }: { j: number; cap: number; spent0?: number; runOne: (job: J) => R | Promise<R>; onRecord?: (rec: R) => void }): Promise<{ records: R[]; skipped: number; spent: number }> {
  const records: R[] = []; let spent = spent0, inflight = 0, next = 0, skipped = 0, stop = false;
  await new Promise((resolve) => {
    let active = 0;
    const pump = () => {
      while (!stop && active < j && next < jobs.length) {
        const job = jobs[next];
        if (!mayLaunch({ spent, inflight, reserve: job.budget, cap })) { if (active === 0) stop = true; break; } // wait for in-flight runs to settle, else stop
        next++; active++; inflight += job.budget;
        Promise.resolve().then(() => runOne(job)).then((rec) => { records.push(rec); onRecord(rec); spent += Number.isFinite(rec.cost) ? rec.cost as number : 0; }, () => {}).finally(() => { active--; inflight -= job.budget; pump(); }); // as number: Number.isFinite is the check
      }
      if (active === 0) { skipped = jobs.length - next; resolve(undefined); }
    };
    pump();
  });
  return { records, skipped, spent };
}

export function makeJobs(cases: EvalCase[], { styles, runs, perRunUsd = null }: { styles: string[]; runs: number; perRunUsd?: number | null }): Job[] {
  const jobs: Job[] = [];
  for (let r = 1; r <= runs; r++) for (const style of styles) for (const c of cases) for (const arm of ARMS) {
    // trigger cases with no ANSWER contract are still run in both arms; their should-not-fire graders are both-arm
    jobs.push({ key: `${c.id}__${style}__${arm === 'with' ? 'A' : 'B'}__${r}`, c, style, arm, run: r, budget: Math.min(c.limits.max_usd, perRunUsd ?? Infinity) });
  }
  return jobs;
}

// ---------------------------------------------------------------- CLI
function resolveClaude(o: Args): string {
  const bin = o.claude || process.env.CLAUDE_BIN || 'claude';
  if (bin.includes('/') && !fs.existsSync(bin)) usage('--claude must point to the claude binary');
  return bin;
}
function newSuite(o: Args): string {
  if (o.out === undefined) return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-p-')));
  const abs = path.resolve(o.out);
  let real = abs; try { real = fs.realpathSync(abs); } catch { /* not yet there */ }
  if (inside(real, fs.realpathSync(root)) || inside(abs, root)) usage('--out must be outside this repository');
  if (fs.existsSync(real) && fs.readdirSync(real).length) usage('--out must be empty');
  fs.mkdirSync(real, { recursive: true, mode: 0o700 });
  return real;
}

async function probe(o: Args, opt: Opt): Promise<number> {
  const suite = newSuite(o);
  copyPlugin(root, path.join(suite, 'plugin'));
  writeFixtures(suite, { S: path.join(here, 'fixtures', 'S') }, ['S']);
  fs.mkdirSync(path.join(suite, 'traces'));
  const c = { id: 'probe', tags: [], fixture: { size: 'S', seed: null, brain: true, overlay: [] }, limits: { timeout_s: 120, max_usd: 0.15 } };
  const prompt = 'Run exactly this shell command with the Bash tool, once: brain card --line\nThen reply with its output verbatim, or with the error text if it failed. Do nothing else.';
  const out: Record<string, { brainRan: number; cardLine: unknown; denials: number; [k: string]: unknown }> = {};
  let spent = 0;
  for (const arm of ARMS) {
    if (!mayLaunch({ spent, inflight: 0, reserve: c.limits.max_usd, cap: opt.budget as number })) throw new CapHit('the cap does not cover the probe'); // as number: a paid mode has --max-cost-usd (checked in main)
    const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-p-ws-')));
    scaffold(ws, c, { suite });
    const tracePath = path.join(suite, 'traces', `probe-${arm}.jsonl`);
    await runClaude(opt.claude, claudeArgs({ arm, model: opt.model, budget: c.limits.max_usd, pluginDir: path.join(suite, 'plugin') }), { cwd: ws, prompt, env: childEnv(), timeoutS: 120, tracePath });
    const t = parseTrace(readCapped(tracePath, MAX));
    spent += t.result?.cost ?? 0;
    out[arm] = { plugins: t.init?.plugins ?? null, mcp: t.init?.mcp ?? null, brainCalls: t.plugin.brainCalls, brainRan: t.plugin.brainRan, brainNotFound: t.plugin.brainNotFound, card: t.plugin.card, denials: t.denials, cost: t.result?.cost ?? null, cardLine: /^brain: \d+ tickets/m.test(t.message) };
    fs.rmSync(ws, { recursive: true, force: true });
  }
  process.stdout.write(`${JSON.stringify({ suite, ...out }, null, 1)}\n`);
  const ok = out.with.brainRan >= 1 && out.with.cardLine && out.without.brainRan === 0 && out.with.denials === 0;
  process.stdout.write(ok ? 'probe: OK (brain ran from the model\'s Bash in arm A; absent in arm B)\n' : 'probe: FAILED (see the JSON above)\n');
  return ok ? 0 : 1;
}

async function main(argv: string[]): Promise<number> {
  const o = parseArgs(argv);
  if (o.help || argv.length === 0) {
    const head = []; for (const l of fs.readFileSync(import.meta.filename, 'utf8').split('\n').slice(1)) { if (!l.startsWith('//')) break; head.push(l.slice(3)); }
    process.stdout.write(`${head.join('\n')}\n`);
    return 0;
  }
  const modes = (['dry-run', 'run', 'probe'] as const).filter((m) => o[m]);
  if (modes.length !== 1) usage('choose exactly one of --dry-run, --run, --probe');
  if ((o.run || o.probe) && o['max-cost-usd'] === undefined) usage('paid runs need --max-cost-usd (the global hard cap)');
  const opt = {
    runs: o.runs === undefined ? 3 : strictNumber(o.runs, { min: 1, max: 50, int: true, what: '--runs' }),
    j: o.j === undefined ? 3 : strictNumber(o.j, { min: 1, max: 8, int: true, what: '-j' }),
    budget: o['max-cost-usd'] === undefined ? null : strictNumber(o['max-cost-usd'], { min: 0.01, max: 1000, what: '--max-cost-usd' }),
    perRunUsd: o['per-run-usd'] === undefined ? null : strictNumber(o['per-run-usd'], { min: 0.01, max: 5, what: '--per-run-usd' }),
    model: o.model ?? DEFAULT_MODEL, styles: stylesOf(o.style), claude: resolveClaude(o), keepWorkspaces: !!o['keep-workspaces'],
  };
  if (!/^[A-Za-z0-9._-]{1,60}$/.test(opt.model)) usage('--model is not a model name');
  if (o.probe) return probe(o, opt);

  let suite: string, cases: EvalCase[], rcDir: string | null | undefined, brainDir: string | undefined, prior: ReturnType<typeof loadResults> = null;
  if (o.resume !== undefined) {
    suite = fs.realpathSync(path.resolve(o.resume));
    if (inside(suite, fs.realpathSync(root))) usage('--resume must be outside this repository');
    let meta: Pick<SuiteCtx, 'rcDir' | 'brainDir'>; try { meta = JSON.parse(readCapped(path.join(suite, 'suite.json'), MAX)); } catch { usage('--resume needs a suite built by run-p.ts'); }
    cases = select(JSON.parse(readCapped(path.join(suite, 'cases.json'), MAX)), o);
    ({ rcDir, brainDir } = meta);
    prior = loadResults(path.join(suite, 'results', 'run-p.json'));
  } else {
    if (o.real !== undefined && (!fs.existsSync(o.real) || !fs.statSync(o.real).isDirectory())) usage('--real must be an existing project directory');
    const src = await sourceCases({ ...o, real: o.real });
    cases = src.cases; rcDir = src.rcDir; brainDir = src.brainDir;
    suite = newSuite(o);
    copyPlugin(root, path.join(suite, 'plugin'));
    writeFixtures(suite, src.fixtures, [...new Set(cases.map((c) => c.fixture.size))]);
    fs.writeFileSync(path.join(suite, 'cases.json'), `${JSON.stringify(cases)}\n`);
    fs.writeFileSync(path.join(suite, 'suite.json'), `${JSON.stringify({ schema: SCHEMA_P, rcDir, brainDir, model: opt.model, styles: opt.styles, runs: opt.runs })}\n`);
    for (const d of ['traces', 'results', 'plugin-data']) fs.mkdirSync(path.join(suite, d), { recursive: true });
  }
  const jobs = makeJobs(cases, { styles: opt.styles, runs: opt.runs, perRunUsd: opt.perRunUsd });
  const resFile = path.join(suite, 'results', 'run-p.json');
  const store = prior || { schema: SCHEMA_P, model: opt.model, records: [] };
  const done = new Set(store.records.filter((r) => !r.error || r.error === 'timeout').map((r) => r.key));
  store.records = store.records.filter((r) => done.has(r.key));
  const todo = jobs.filter((x) => !done.has(x.key));
  const est = estimate([{ name: 'p', cases, arms: ARMS }], { runs: opt.runs * opt.styles.length, model: opt.model, judgeModel: 'claude-opus-5-5' });
  const head = `suite: ${suite}\n${cases.length} cases x ${opt.styles.length} style(s) [${opt.styles.join(', ')}] x 2 arms x ${opt.runs} runs = ${jobs.length} runs (${todo.length} to do), model ${opt.model}, -j ${opt.j}\n` +
    `per-run cap: the case's max_usd${opt.perRunUsd ? ` (clamped to ${opt.perRunUsd})` : ''}; projected ${est && PRICES[opt.model] ? `${est.lo.toFixed(2)}-${est.hi.toFixed(2)} USD (no judge calls are made here)` : 'n/a'}\n`;
  if (o['dry-run']) { process.stdout.write(`${head}claude ${claudeArgs({ arm: 'with', model: opt.model, budget: 0.8, pluginDir: path.join(suite, 'plugin') }).map((a) => (/[ ()*,]/.test(a) ? `'${a}'` : a)).join(' ')}   (arm B: the same without --plugin-dir; prompt on stdin)\n`); return 0; }
  process.stdout.write(head);
  const spent0 = spentOf(store.records);
  const r = await pool(todo, { j: opt.j, cap: opt.budget as number, // a paid mode has --max-cost-usd (checked above)
    spent0, runOne: (job) => runJob(job, { suite, rcDir, brainDir, model: opt.model, claude: opt.claude, keepWorkspaces: opt.keepWorkspaces }),
    onRecord: (rec) => { store.records.push(rec); saveResults(resFile, store); process.stdout.write(`${rec.key} score ${rec.score.toFixed(2)} cost ${Number.isFinite(rec.cost) ? (rec.cost as number).toFixed(3) : '-'}${rec.arm === 'with' ? ` brain ${rec.pluginUsed ? 'ran' : 'NOT run'}` : ''}${rec.error ? ` ERROR ${rec.error}` : ''}\n`); } }); // as number: Number.isFinite is the check
  saveResults(resFile, store);
  const { summarize, render } = await import('./report.ts');
  process.stdout.write(render(summarize(suite)));
  process.stdout.write(`spent ${r.spent.toFixed(2)} of ${opt.budget} USD; results: ${resFile}\n`);
  if (r.skipped) { process.stdout.write(`cap reached: ${r.skipped} runs not launched (resume with --resume ${suite} and a larger cap)\n`); return 3; }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => {
    if (e instanceof Usage) { process.stderr.write(`error: ${e.message}\n`); process.exitCode = 2; } else if (e instanceof CapHit) { process.stderr.write(`error: ${e.message}\n`); process.exitCode = 3; } else { process.stderr.write('error: the runner failed unexpectedly\n'); process.exitCode = 5; throw e; }
  });
}
