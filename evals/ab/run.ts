// A/B runner. Offline helpers (task loading, run matrix, argv, grading) are pure; every function that spends money or touches the network
// (`runCell`, `prepareWorkspace`, `runHiddenTests`, `countTokens`) calls requireLive() first and refuses without EVAL_LIVE=1.
// The API key is read from ANTHROPIC_API_KEY at call time and is never logged or written.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ARMS, calibrate } from './report.ts';
import type { Row } from './report.ts';
import type { GraphQuestion } from './questions.ts';

const here = import.meta.dirname;
export const PLUGIN_DIR = path.resolve(here, '..', '..');
export const MODELS = [{ name: 'sonnet', id: 'claude-sonnet-5-5' }, { name: 'haiku', id: 'claude-haiku-5-5' }, { name: 'opus', id: 'claude-opus-5-5' }];
export const REPEATS = 3;

export type CodingTask = { id: string; repo: string; commit: string; task: string; language: string; validated: boolean; hiddenTests: { fromCommit: string; files: string[]; command: string } };
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

/** The `claude` argv for one cell. The plugin arms load this repository as the plugin; the others load nothing and are meant to run with a clean user config. */
export function argvFor(cell: Cell, prompt: string): string[] {
  const arm = ARMS.find((a) => a.name === cell.arm), model = MODELS.find((m) => m.name === cell.model);
  if (!arm || !model) throw new Error('unknown arm or model');
  const argv = ['-p', prompt, '--model', model.id, '--output-format', 'json', '--allowed-tools', arm.tools.join(',')];
  if (arm.plugin) argv.push('--plugin-dir', PLUGIN_DIR);
  return argv;
}

const norm = (s: string): string[] => s.toLowerCase().replace(/[`*]/g, '').split(/[\s,;]+/).map((x) => x.replace(/^[.:()]+|[.:()]+$/g, '')).filter(Boolean);
/** Offline grading of a graph answer: list answers compare as sets of tokens found in the reply; a single answer must appear as a whole token. */
export function grade(q: Pick<GraphQuestion, 'answer'>, reply: string): boolean {
  const want = q.answer.split(',').map((x) => x.toLowerCase()), have = new Set(norm(reply));
  return want.every((w) => have.has(w));
}

type ClaudeJson = { result?: string; total_cost_usd?: number; num_turns?: number; usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } };
export function parseRun(stdout: string): { reply: string; tokens: number; calls: number; cost: number } {
  const j = JSON.parse(stdout) as ClaudeJson, u = j.usage ?? {};
  return { reply: j.result ?? '', tokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), calls: j.num_turns ?? 0, cost: j.total_cost_usd ?? 0 };
}

/** LIVE. One graph question in one cell, run in `cwd` (the folder holding plan.md written from planMarkdown(), plus the ingested plan for the graph arm). */
export function runCell(cell: Cell, q: GraphQuestion, cwd: string): Row {
  requireLive();
  const p = spawnSync('claude', argvFor(cell, `${q.text} Answer with the value only, lists comma separated.`), { cwd, encoding: 'utf8', maxBuffer: 1 << 26 });
  if (p.status !== 0) throw new Error(`claude exited ${p.status}`);
  const r = parseRun(p.stdout);
  return { arm: cell.arm, model: cell.model, id: q.id, correct: grade(q, r.reply), tokens: r.tokens, calls: r.calls, cost: r.cost };
}

/** LIVE (network). Clone the repository into an empty `dir` at the pinned commit. The hidden test files are not present until runHiddenTests. */
export function prepareWorkspace(t: CodingTask, dir: string): void {
  requireLive();
  const git = (...a: string[]): void => { const p = spawnSync('git', a, { cwd: dir, encoding: 'utf8' }); if (p.status !== 0) throw new Error(`git ${a[0]} failed`); };
  fs.mkdirSync(dir, { recursive: true });
  git('init', '-q'); git('remote', 'add', 'origin', t.repo); git('fetch', '-q', '--depth', '1', 'origin', t.commit); git('checkout', '-q', 'FETCH_HEAD');
}

/** LIVE. Fetch the fix commit, copy only its test files over the agent's work, run the hidden test command, and report pass or fail. */
export function runHiddenTests(t: CodingTask, dir: string): boolean {
  requireLive();
  const git = (...a: string[]): void => { const p = spawnSync('git', a, { cwd: dir, encoding: 'utf8' }); if (p.status !== 0) throw new Error(`git ${a[0]} failed`); };
  git('fetch', '-q', '--depth', '1', 'origin', t.hiddenTests.fromCommit);
  git('checkout', '-q', t.hiddenTests.fromCommit, '--', ...t.hiddenTests.files);
  return spawnSync('sh', ['-c', t.hiddenTests.command], { cwd: dir, encoding: 'utf8', timeout: 600_000 }).status === 0;
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
