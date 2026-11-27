// A/B runner. Offline helpers (task loading, run matrix, argv, grading) are pure; every function that spends money or touches the network
// (`runClaude`, `runCell`, `prepareWorkspace`, `runHiddenTests`, `countTokens`) calls requireLive() first and refuses without EVAL_LIVE=1.
// The model arms run the Claude Code native binary in headless print mode with the user's existing login; no API key is needed (ANTHROPIC_API_KEY is only for countTokens and is never logged or written).
// Cloned code (setup, hidden tests) runs in a stripped environment: `env -i` with PATH and a temporary HOME, nothing else.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ARMS, calibrate } from './report.ts';
import type { Row } from './report.ts';
import type { GraphQuestion } from './questions.ts';

const here = import.meta.dirname;
export const PLUGIN_DIR = path.resolve(here, '..', '..');
export const MODELS = [{ name: 'sonnet', id: 'claude-sonnet-5-5' }, { name: 'haiku', id: 'claude-haiku-5-5' }, { name: 'opus', id: 'claude-opus-5-5' }];
export const REPEATS = 3;

export type CodingTask = {
  id: string; repo: string; commit: string; task: string; language: string; validated: boolean;
  /** Why a `validated: false` task is not run. */
  reason?: string;
  /** Shell commands run in ONE `sh` session in the clone (so an `export PATH=...` persists into the hidden test command), in a stripped environment. */
  setup?: string[];
  /** Seconds the hidden test command may run; default 600. */
  timeoutSec?: number;
  hiddenTests: { fromCommit: string; files: string[]; command: string };
};
export type Cell = { arm: string; model: string; repeat: number };

export function requireLive(): void {
  if (process.env.EVAL_LIVE !== '1') throw new Error('live run refused: set EVAL_LIVE=1 to spend model or API calls');
}

export function loadCodingTasks(dir = path.join(here, 'coding')): CodingTask[] {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as CodingTask);
}

/** Every (arm, model, repeat) of a family: sonnet and haiku three times, opus once (repeat 0). */
export function cells(family: 'graph' | 'coding'): Cell[] {
  const out: Cell[] = [];
  for (const a of ARMS.filter((x) => x.family === family)) for (const m of MODELS) for (let r = 0; r < (m.name === 'opus' ? 1 : REPEATS); r++) out.push({ arm: a.name, model: m.name, repeat: r });
  return out;
}

const NATIVE = path.join(os.homedir(), '.vscode', 'extensions', 'anthropic.claude-code-2.1.332-darwin-arm64', 'resources', 'native-binary', 'claude');
/** The Claude Code binary: $PLANGRAPH_BENCH_CLAUDE, else the VS Code native binary when that file exists, else `claude` on the PATH. */
export function claudeBin(env: NodeJS.ProcessEnv = process.env): string {
  return env.PLANGRAPH_BENCH_CLAUDE || (fs.existsSync(NATIVE) ? NATIVE : 'claude');
}

const MAX_USD = process.env.PLANGRAPH_BENCH_MAX_USD || '2';
/**
 * The `claude` argv for one cell (headless print mode). Every arm: `--setting-sources project --strict-mcp-config` (no user settings, hooks, plugins, MCP servers or
 * CLAUDE.md; a separate CLAUDE_CONFIG_DIR is not logged in, so this is the clean config of the plugin-off arms), `--no-session-persistence`, `--permission-mode dontAsk`
 * with the arm's tools both offered (`--tools`) and pre-approved (`--allowed-tools`), and a per-run spend cap (this binary has no `--max-turns`). The plugin arms add
 * `--plugin-dir <this repository>` and the Skill tool. The variadic flags come last so they cannot swallow another option.
 */
export function argvFor(cell: Cell, prompt: string): string[] {
  const arm = ARMS.find((a) => a.name === cell.arm), model = MODELS.find((m) => m.name === cell.model);
  if (!arm || !model) throw new Error('unknown arm or model');
  const tools = (arm.plugin ? [...arm.tools, 'Skill'] : arm.tools).join(',');
  const argv = ['-p', prompt, '--model', model.id, '--output-format', 'stream-json', '--verbose', '--setting-sources', 'project', '--strict-mcp-config', '--no-session-persistence', '--permission-mode', 'dontAsk', '--max-budget-usd', MAX_USD];
  if (arm.plugin) argv.push('--plugin-dir', PLUGIN_DIR);
  argv.push('--tools', tools, '--allowed-tools', tools);
  return argv;
}

/** The environment of a model run: the host's, minus the parent session's Claude variables (except the login token), anything named like a secret, and PATH entries that hold a `plangraph` binary (only the plugin may provide it). */
export function claudeEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || k === 'EVAL_LIVE') continue;
    if (k === 'CLAUDE_CODE_OAUTH_TOKEN') { out[k] = v; continue; }
    if (/^CLAUDE/i.test(k) || /TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL/i.test(k)) continue;
    out[k] = v;
  }
  out.PATH = (env.PATH ?? '').split(path.delimiter).filter((d) => d && !fs.existsSync(path.join(d, 'plangraph'))).join(path.delimiter);
  return out;
}

const norm = (s: string): string[] => s.toLowerCase().replace(/[`*]/g, '').split(/[\s,;]+/).map((x) => x.replace(/^[.:()]+|[.:()]+$/g, '')).filter(Boolean);
/** Offline grading of a graph answer: list answers compare as sets of tokens found in the reply; a single answer must appear as a whole token. */
export function grade(q: Pick<GraphQuestion, 'answer'>, reply: string): boolean {
  const want = q.answer.split(',').map((x) => x.toLowerCase()), have = new Set(norm(reply));
  return want.every((w) => have.has(w));
}

type Usage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
type ClaudeJson = { type?: string; result?: string; is_error?: boolean; subtype?: string; total_cost_usd?: number; num_turns?: number; usage?: Usage; message?: { content?: { type?: string }[] } };
export type Parsed = { reply: string; tokens: number; tokensIn: number; tokensOut: number; calls: number; toolCalls: number; cost: number; error: string | null };
/** Parse the output of one run: one `--output-format json` object, or the `stream-json` lines (then tool calls are the tool_use blocks; with one object they are the turns minus one). */
export function parseRun(stdout: string): Parsed {
  const lines = stdout.split('\n').filter((l) => l.trim().startsWith('{')).map((l) => JSON.parse(l) as ClaudeJson);
  const j = lines.find((l) => l.type === 'result') ?? lines.at(-1);
  if (!j) throw new Error('no result in the output');
  const u = j.usage ?? {}, tokensOut = u.output_tokens ?? 0, tokensIn = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  const streamed = lines.length > 1;
  const toolCalls = streamed ? lines.filter((l) => l.type === 'assistant').reduce((n, l) => n + (l.message?.content ?? []).filter((c) => c.type === 'tool_use').length, 0) : Math.max(0, (j.num_turns ?? 0) - 1);
  return { reply: j.result ?? '', tokens: tokensIn + tokensOut, tokensIn, tokensOut, calls: j.num_turns ?? 0, toolCalls, cost: j.total_cost_usd ?? 0, error: j.is_error ? (j.subtype ?? 'error') : null };
}

const withPrefix = (e: Record<string, string>, prefix: string): Record<string, string> => (prefix ? { ...e, PATH: `${prefix}${path.delimiter}${e.PATH ?? ''}` } : e);
export type Detail = Parsed & { ms: number };
/** LIVE. One headless `claude` run in `cwd`. A harness failure (spawn error, timeout, no result, is_error) comes back in `error`; nothing throws after the spawn. */
export function runClaude(cell: Cell, prompt: string, cwd: string, timeoutSec = 900, pathPrefix = ''): Detail {
  requireLive();
  const t0 = Date.now(), p = spawnSync(claudeBin(), argvFor(cell, prompt), { cwd, env: withPrefix(claudeEnv(), pathPrefix), encoding: 'utf8', maxBuffer: 1 << 28, timeout: timeoutSec * 1000, stdio: ['ignore', 'pipe', 'pipe'] });
  const ms = Date.now() - t0, none: Parsed = { reply: '', tokens: 0, tokensIn: 0, tokensOut: 0, calls: 0, toolCalls: 0, cost: 0, error: null };
  if (p.error) return { ...none, error: `spawn: ${(p.error as NodeJS.ErrnoException).code ?? 'error'}`, ms };
  try { const r = parseRun(p.stdout); return { ...r, error: r.error ?? (p.status === 0 ? null : `exit ${p.status}`), ms }; } catch { return { ...none, error: `no result (exit ${p.status})`, ms }; }
}

/** LIVE. One graph question in one cell, run in `cwd` (a workspace from buildBaselineProject or buildGraphProject). */
export function runCell(cell: Cell, q: GraphQuestion, cwd: string): Row {
  const d = runClaude(cell, `${q.text} Answer with the value only, lists comma separated.`, cwd);
  if (d.error) throw new Error(d.error);
  return { arm: cell.arm, model: cell.model, id: q.id, correct: grade(q, d.reply), tokens: d.tokens, calls: d.calls, cost: d.cost };
}

/** The reason a task is not run (`validated: false`), or null when it runs. */
export function skipReason(t: CodingTask): string | null {
  return t.validated ? null : (t.reason ?? 'not validated');
}
/** The tasks that run, and the skipped ones with their reason. */
export function runnableTasks(tasks: CodingTask[]): { run: CodingTask[]; skipped: { id: string; reason: string }[] } {
  return { run: tasks.filter((t) => skipReason(t) === null), skipped: tasks.flatMap((t) => { const r = skipReason(t); return r === null ? [] : [{ id: t.id, reason: r }]; }) };
}

const sq = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;
const SETUP_MIN_SEC = 600;
/** Where a workspace keeps its temporary HOME and the environment its setup exported (beside the clone, never inside it). */
export const stateDir = (dir: string): string => `${dir}.bench`;

/**
 * Run `script` with `sh -c` in `dir` in a STRIPPED environment: `env -i` with PATH (the host's) and HOME (a temporary directory) and nothing else, so no token or
 * credential of the host reaches cloned code. Not gated: it runs local commands only; the live wrappers below decide what to run.
 */
export function runStripped(dir: string, script: string, timeoutSec: number): { status: number | null; stdout: string; stderr: string } {
  const home = path.join(stateDir(dir), 'home');
  fs.mkdirSync(home, { recursive: true });
  const p = spawnSync('/usr/bin/env', ['-i', `PATH=${process.env.PATH ?? '/usr/bin:/bin'}`, `HOME=${home}`, '/bin/sh', '-c', script], { cwd: dir, encoding: 'utf8', timeout: timeoutSec * 1000, maxBuffer: 1 << 26 });
  return { status: p.status, stdout: p.stdout ?? '', stderr: p.stderr ?? '' };
}

/** Run the setup commands in ONE shell session (stopping at the first failure) and keep what they exported, so the hidden test command sees it (a `PATH=...` from the setup persists). */
export function runSetup(dir: string, setup: string[], timeoutSec = SETUP_MIN_SEC): { ok: boolean; stderr: string } {
  fs.mkdirSync(stateDir(dir), { recursive: true });
  const envFile = path.join(stateDir(dir), 'env.sh');
  fs.rmSync(envFile, { force: true });
  // a virtual environment the setup created in the clone is activated for the later commands even when the descriptor does not export it (several only run `uv venv`)
  const activate = 'if [ -d "$PWD/.venv/bin" ]; then export VIRTUAL_ENV="$PWD/.venv" PATH="$PWD/.venv/bin:$PATH"; fi';
  const r = runStripped(dir, `set -e\n${setup.join('\n')}\n${activate}\nexport -p > ${sq(envFile)}`, timeoutSec);
  return { ok: r.status === 0, stderr: r.stderr.slice(-400) };
}

/** Run a command after the exports of runSetup, in the same stripped environment. The status and output are returned whole. */
export function runWithSetupEnv(dir: string, command: string, timeoutSec = 600): { status: number | null; stdout: string; stderr: string } {
  const envFile = path.join(stateDir(dir), 'env.sh');
  return runStripped(dir, `if [ -f ${sq(envFile)} ]; then . ${sq(envFile)}; fi\n${command}`, timeoutSec);
}

/** LIVE (network). Clone the repository into an empty `dir` at the pinned commit, then run the task's `setup` (one shell session, stripped environment). The hidden test files are not present until runHiddenTests. */
export function prepareWorkspace(t: CodingTask, dir: string): void {
  requireLive();
  const skip = skipReason(t);
  if (skip !== null) throw new Error(`${t.id} is skipped: ${skip}`);
  fs.mkdirSync(dir, { recursive: true });
  const git = runStripped(dir, ['git init -q', `git remote add origin ${sq(t.repo)}`, `git fetch -q --depth 1 origin ${sq(t.commit)}`, 'git checkout -q FETCH_HEAD'].join(' && '), SETUP_MIN_SEC);
  if (git.status !== 0) throw new Error(`git clone of ${t.id} failed: ${git.stderr.slice(-200)}`);
  const s = runSetup(dir, t.setup ?? [], Math.max(t.timeoutSec ?? 600, SETUP_MIN_SEC));
  if (!s.ok) throw new Error(`setup of ${t.id} failed: ${s.stderr}`);
}

/** LIVE. Fetch the fix commit, copy only its test files over the agent's work, run the hidden test command (in the setup's environment, within `timeoutSec`, default 600), and report pass or fail. */
export function runHiddenTests(t: CodingTask, dir: string): boolean {
  requireLive();
  const skip = skipReason(t);
  if (skip !== null) throw new Error(`${t.id} is skipped: ${skip}`);
  const fetch = runStripped(dir, `git fetch -q --depth 1 origin ${sq(t.hiddenTests.fromCommit)} && git checkout -q ${sq(t.hiddenTests.fromCommit)} -- ${t.hiddenTests.files.map(sq).join(' ')}`, SETUP_MIN_SEC);
  if (fetch.status !== 0) throw new Error(`fetching the hidden tests of ${t.id} failed: ${fetch.stderr.slice(-200)}`);
  return runWithSetupEnv(dir, t.hiddenTests.command, t.timeoutSec ?? 600).status === 0;
}

/** LIVE. One coding task in one cell: the agent works in `dir` (a prepared workspace), then the hidden tests decide. */
export function runCodingCell(cell: Cell, t: CodingTask, dir: string): Detail & { correct: boolean } {
  const d = runClaude(cell, `${t.task} Fix the bug in the code of this repository. Do not ask questions; stop when the fix is in place.`, dir, 900, fs.existsSync(path.join(dir, '.venv', 'bin')) ? path.join(dir, '.venv', 'bin') : '');
  return { ...d, correct: d.error === null && runHiddenTests(t, dir) };
}

/** LIVE (API). Measure each text with POST /v1/messages/count_tokens and return the calibrated characters per token. The key is never written anywhere. */
export async function countTokens(texts: string[], model = MODELS[0]?.id ?? ''): Promise<number> {
  requireLive();
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set');
  const samples: { text: string; tokens: number }[] = [];
  for (const text of texts) {
    const res = await fetch('https://api.anthropic.com/v1/messages/count_tokens', { method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: text }] }) });
    if (!res.ok) throw new Error(`count_tokens failed with status ${res.status}`);
    samples.push({ text, tokens: ((await res.json()) as { input_tokens: number }).input_tokens });
  }
  return calibrate(samples);
}
