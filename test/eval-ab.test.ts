// Offline checks for evals/ab: question integrity and independent ground truth, Wilson bounds, summarize, report, calibration, coding task
// descriptors and the live gate. No model or API call: the live paths refuse to run without EVAL_LIVE=1.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { PROJECT, planMarkdown } from '../evals/ab/project.ts';
import { graphQuestions } from '../evals/ab/questions.ts';
import { summarize, renderReport, calibrate, wilson, ARMS } from '../evals/ab/report.ts';
import os from 'node:os';
import { loadCodingTasks, cells, argvFor, requireLive, grade, parseRun, MODELS, claudeBin, claudeEnv, runStripped, runSetup, runWithSetupEnv, runnableTasks, prepareWorkspace, runHiddenTests, PLUGIN_DIR } from '../evals/ab/run.ts';
import type { CodingTask } from '../evals/ab/run.ts';
import { buildBaselineProject, buildGraphProject } from '../evals/ab/graph.ts';
import { rule } from '../evals/graph-format/run.ts';
import { estTokens, CHARS_PER_TOKEN } from '../lib/render.ts';

const qs = graphQuestions();
const T = PROJECT.tickets;

test('at least 200 unique questions over all five topics, deterministic', () => {
  assert.ok(qs.length >= 200, String(qs.length));
  assert.equal(new Set(qs.map((q) => q.id)).size, qs.length);
  assert.equal(new Set(qs.map((q) => q.text)).size, qs.length);
  assert.deepEqual(graphQuestions(), qs);
  for (const t of ['owner', 'blocker', 'stack', 'requirement', 'history']) assert.ok(qs.some((q) => q.topic === t), t);
  for (const q of qs) assert.ok(q.text && q.answer !== '', q.id);
});

test('no question text contains its answer', () => {
  for (const q of qs) for (const part of q.answer.split(',')) {
    const re = new RegExp(`(?<![\\w-])${part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`);
    assert.ok(!re.test(q.text), `${q.id}: ${q.text} / ${q.answer}`);
  }
});

test('ground truth recomputed independently', () => {
  const byKey = new Map(T.map((t) => [t.key, t]));
  const closure = (k: string): number => { // forward walk over `deps`: count tickets whose dependency chain reaches k
    const reaches = (x: string, seen: Set<string>): boolean => x === k || (!seen.has(x) && (seen.add(x), (byKey.get(x)?.deps ?? []).some((d) => reaches(d, seen))));
    return T.filter((t) => t.key !== k && reaches(t.key, new Set())).length;
  };
  for (const q of qs) {
    const k = q.ref;
    const t = byKey.get(k);
    switch (q.kind) {
      case 'owner': assert.equal(q.answer, t?.owner); break;
      case 'sprint': assert.equal(q.answer, t?.sprint); break;
      case 'deps': assert.equal(q.answer, t?.deps.join(',')); break;
      case 'downstream': assert.equal(q.answer, String(closure(k))); break;
      case 'stack': assert.equal(q.answer, PROJECT.stack[k]); break;
      case 'stack-count': assert.equal(q.answer, String(Object.values(PROJECT.stack).filter((s) => s === k).length)); break;
      case 'trace': assert.equal(q.answer, PROJECT.requirement[k]); break;
      case 'implements': assert.equal(q.answer, Object.keys(PROJECT.requirement).filter((x) => PROJECT.requirement[x] === k).sort((a, b) => Number(a.slice(2)) - Number(b.slice(2))).join(',')); break;
      case 'sprint-count': assert.equal(q.answer, String(T.filter((x) => x.sprint === k).length)); break;
      case 'owner-count': assert.equal(q.answer, String(T.filter((x) => x.owner === k).length)); break;
      case 'prev-owner': assert.equal(q.answer, PROJECT.history.filter((h) => h.ticket === k && h.field === 'owner').at(-1)?.from); break;
      case 'closed': assert.equal(q.answer, PROJECT.history.find((h) => h.ticket === k && h.field === 'status' && h.to === 'done')?.at); break;
      default: assert.fail(q.kind);
    }
  }
  assert.ok(qs.filter((q) => q.kind === 'downstream').some((q) => Number(q.answer) > 3));
});

test('plan markdown carries every fact the questions need and no question', () => {
  const md = planMarkdown();
  for (const t of T) assert.ok(md.includes(`${t.key} `) && md.includes(t.owner));
  assert.ok(!/Who owns|Which sprint/.test(md));
  assert.equal(planMarkdown(), md);
});

test('wilson interval: 9 of 10 within known bounds', () => {
  const [lo, hi] = wilson(9, 10);
  assert.ok(Math.abs(lo - 0.5958) < 1e-3 && Math.abs(hi - 0.9821) < 1e-3, `${lo} ${hi}`);
  assert.deepEqual(wilson(0, 0), [0, 1]);
});

const rows = [
  ...[1, 1, 1, 1, 1, 1, 1, 1, 1, 0].map((c, i) => ({ arm: 'baseline', model: 'sonnet', id: `q${i}`, correct: c === 1, tokens: 100 + i * 10, calls: 2 + (i % 3), cost: 0.01 * (i + 1) })),
  { arm: 'graph', model: 'sonnet', id: 'q0', correct: true, tokens: 40, calls: 1, cost: 0.002 },
];

test('summarize: accuracy interval, medians and p90 per arm', () => {
  const s = summarize(rows);
  const b = s.find((x) => x.arm === 'baseline');
  assert.ok(b);
  assert.equal(b.n, 10);
  assert.equal(b.accuracy.p, 0.9);
  assert.ok(Math.abs(b.accuracy.lo - 0.5958) < 1e-3 && Math.abs(b.accuracy.hi - 0.9821) < 1e-3);
  assert.equal(b.tokens.median, 145);
  assert.equal(b.tokens.p90, 180);
  assert.equal(b.calls.median, 3);
  assert.equal(s.find((x) => x.arm === 'graph')?.n, 1);
  assert.deepEqual(summarize([]), []);
});

test('report prints every arm, including an arm with no rows', () => {
  const out = renderReport(rows);
  for (const a of ARMS) assert.ok(out.includes(a.name), a.name);
  assert.match(out, /baseline .*n=10/);
  assert.match(out, /plugin-default .*n=0/);
});

test('calibrate: characters per token from count_tokens samples, and estTokens uses the constant', () => {
  assert.equal(calibrate([{ text: 'a'.repeat(300), tokens: 100 }, { text: 'b'.repeat(100), tokens: 50 }]), 2.67);
  assert.throws(() => calibrate([]));
  assert.throws(() => calibrate([{ text: 'x', tokens: 0 }]));
  assert.equal(estTokens('a'.repeat(1000)), Math.ceil(1000 / CHARS_PER_TOKEN));
});

test('coding tasks: at least 20, pinned by URL and 40-hex commit, paragraph task, hidden test command', () => {
  const tasks = loadCodingTasks();
  assert.ok(tasks.length >= 20, String(tasks.length));
  assert.equal(new Set(tasks.map((t) => t.id)).size, tasks.length);
  assert.ok(new Set(tasks.map((t) => t.repo)).size >= 10);
  for (const t of tasks) {
    assert.match(t.repo, /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/, t.id);
    assert.match(t.commit, /^[0-9a-f]{40}$/, t.id);
    assert.match(t.hiddenTests.fromCommit, /^[0-9a-f]{40}$/, t.id);
    assert.notEqual(t.commit, t.hiddenTests.fromCommit);
    assert.ok(t.task.length > 80 && t.task.length < 700 && !t.task.includes('\n'), t.id);
    assert.ok(t.hiddenTests.command.length > 5 && t.hiddenTests.files.length >= 1, t.id);
    assert.ok(!t.task.includes(t.hiddenTests.fromCommit.slice(0, 7)), t.id);
  }
  const dir = path.join(import.meta.dirname, '..', 'evals', 'ab', 'coding');
  assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length, tasks.length);
});

test('run matrix: arms, two models plus one opus pass, three repeats; argv is built without spawning', () => {
  assert.deepEqual(MODELS.map((m) => m.name).sort(), ['haiku', 'opus', 'sonnet']);
  const graphCells = cells('graph');
  assert.ok(graphCells.every((c) => ['baseline', 'graph'].includes(c.arm)));
  assert.ok(graphCells.some((c) => c.model === 'opus' && c.repeat === 0));
  assert.ok(!graphCells.some((c) => c.model === 'opus' && c.repeat > 0));
  assert.equal(Math.max(...graphCells.map((c) => c.repeat)), 2);
  const coding = cells('coding');
  assert.ok(coding.every((c) => ['plugin-off', 'plugin-default'].includes(c.arm)));
  const a = argvFor({ arm: 'baseline', model: 'haiku', repeat: 0 }, 'Who owns T-1?');
  assert.ok(a.includes('-p') && a.includes('--allowed-tools'));
  assert.ok(!a.some((x) => x.includes('plugin-dir')));
  assert.ok(argvFor({ arm: 'graph', model: 'haiku', repeat: 0 }, 'q').some((x) => x === '--plugin-dir'));
});

test('live paths refuse without EVAL_LIVE=1', () => {
  const saved = process.env.EVAL_LIVE;
  delete process.env.EVAL_LIVE;
  try { assert.throws(() => requireLive(), /EVAL_LIVE=1/); process.env.EVAL_LIVE = '1'; requireLive(); } finally { if (saved === undefined) delete process.env.EVAL_LIVE; else process.env.EVAL_LIVE = saved; }
});

test('graph-format ruling: best lower bound wins, fewer tokens break a tie, empty is undecided', () => {
  const mk = (format: string, ok: number, n: number, tokens: number) => Array.from({ length: n }, (_, i) => ({ id: `q${i}`, format, correct: i < ok, tokens, toolCalls: 1 }));
  assert.equal(rule([...mk('text', 90, 100, 50), ...mk('json', 80, 100, 20)]).winner, 'text');
  assert.equal(rule([...mk('text', 50, 50, 60), ...mk('json', 50, 50, 30)]).winner, 'json');
  assert.equal(rule([]).winner, null);
});

test('grading and run output parsing', () => {
  assert.ok(grade({ answer: 'T-3,T-5' }, 'T-5, T-3.'));
  assert.ok(!grade({ answer: 'T-3,T-5' }, 'T-3'));
  assert.ok(grade({ answer: 'Ana' }, 'The owner is `Ana`.'));
  assert.ok(!grade({ answer: '6' }, 'T-6'));
  assert.deepEqual(parseRun(JSON.stringify({ result: 'x', total_cost_usd: 0.5, num_turns: 3, usage: { input_tokens: 10, output_tokens: 5 } })), { reply: 'x', tokens: 15, tokensIn: 10, tokensOut: 5, calls: 3, toolCalls: 2, cost: 0.5, error: null });
});

const tmp = (): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ab-test-')));

test('cloned code runs in a stripped environment: a host sentinel never reaches it', () => {
  process.env.PG_BENCH_SENTINEL = 'secret-value';
  const dir = tmp();
  try {
    const r = runStripped(dir, 'env', 10);
    assert.equal(r.status, 0);
    assert.ok(!r.stdout.includes('PG_BENCH_SENTINEL') && !r.stdout.includes('secret-value'));
    const names = r.stdout.split('\n').map((l) => l.split('=')[0]).filter((n) => n && !['PATH', 'HOME', 'PWD', 'SHLVL', '_', 'OLDPWD'].includes(n));
    assert.deepEqual(names, []);
    assert.ok(r.stdout.includes(`HOME=${path.join(dir + '.bench', 'home')}`));
    const t = runWithSetupEnv(dir, 'echo "[${PG_BENCH_SENTINEL-unset}]"', 10);
    assert.equal(t.stdout.trim(), '[unset]');
  } finally { delete process.env.PG_BENCH_SENTINEL; fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(dir + '.bench', { recursive: true, force: true }); }
});

test('setup runs in one shell session: an export persists into the hidden test command; a failing setup line stops', () => {
  const dir = tmp();
  try {
    assert.equal(runSetup(dir, ['mkdir -p bin', 'printf "#!/bin/sh\\necho from-setup\\n" > bin/tool', 'chmod +x bin/tool', 'export PATH="$PWD/bin:$PATH"', 'export MARK=kept']).ok, true);
    const r = runWithSetupEnv(dir, 'tool; echo "$MARK"', 10);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'from-setup\nkept');
    assert.equal(runSetup(dir, ['false', 'touch after-false']).ok, false);
    assert.ok(!fs.existsSync(path.join(dir, 'after-false')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(dir + '.bench', { recursive: true, force: true }); }
});

test('timeoutSec bounds a command; a missing setup leaves the plain environment', () => {
  const dir = tmp();
  try {
    const t0 = Date.now();
    assert.notEqual(runWithSetupEnv(dir, 'sleep 5', 1).status, 0);
    assert.ok(Date.now() - t0 < 4000);
    assert.equal(runWithSetupEnv(dir, 'true', 10).status, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(dir + '.bench', { recursive: true, force: true }); }
});

test('descriptors: setup and timeoutSec are typed and a validated:false task is skipped with its reason', () => {
  const all = loadCodingTasks();
  const { run, skipped } = runnableTasks(all);
  assert.equal(run.length + skipped.length, all.length);
  assert.ok(skipped.length >= 1 && skipped.every((s) => s.reason.length > 10));
  assert.ok(run.every((t) => t.validated && Array.isArray(t.setup) && (t.timeoutSec ?? 600) > 0));
  const t = all.find((x) => !x.validated) as CodingTask;
  const saved = process.env.EVAL_LIVE;
  process.env.EVAL_LIVE = '1';
  try {
    assert.throws(() => prepareWorkspace(t, '/nonexistent/never-created'), /skipped: .+/);
    assert.throws(() => runHiddenTests(t, '/nonexistent/never-created'), /skipped/);
  } finally { if (saved === undefined) delete process.env.EVAL_LIVE; else process.env.EVAL_LIVE = saved; }
  const bare: CodingTask = { ...t };
  delete bare.reason;
  assert.equal(runnableTasks([bare]).skipped[0]?.reason, 'not validated');
});

test('native binary: env var wins, argv carries the headless flags and an isolated config, plugin arms add --plugin-dir', () => {
  assert.equal(claudeBin({ PLANGRAPH_BENCH_CLAUDE: '/x/claude' }), '/x/claude');
  assert.ok(claudeBin({}).endsWith('claude'));
  const off = argvFor({ arm: 'plugin-off', model: 'sonnet', repeat: 0 }, 'fix it');
  for (const f of ['-p', '--model', '--output-format', '--setting-sources', '--strict-mcp-config', '--permission-mode', '--max-budget-usd', '--tools', '--allowed-tools']) assert.ok(off.includes(f), f);
  assert.equal(off[off.indexOf('--setting-sources') + 1], 'project');
  assert.ok(!off.includes('--plugin-dir'));
  const on = argvFor({ arm: 'plugin-default', model: 'sonnet', repeat: 0 }, 'fix it');
  assert.equal(on[on.indexOf('--plugin-dir') + 1], PLUGIN_DIR);
  assert.ok(on.at(-1)?.split(',').includes('Skill'));
  assert.ok(off.indexOf('--tools') > off.indexOf('--model'));
});

test('model run environment drops secrets, Claude session variables and PATH entries with a plangraph binary', () => {
  const bin = tmp();
  fs.writeFileSync(path.join(bin, 'plangraph'), '');
  try {
    const e = claudeEnv({ PATH: `${bin}:/usr/bin`, HOME: '/h', ANTHROPIC_API_KEY: 'k', GITHUB_TOKEN: 't', AWS_SECRET_ACCESS_KEY: 's', CLAUDECODE: '1', CLAUDE_CODE_OAUTH_TOKEN: 'login', LANG: 'C', EVAL_LIVE: '1' });
    assert.deepEqual(Object.keys(e).sort(), ['CLAUDE_CODE_OAUTH_TOKEN', 'HOME', 'LANG', 'PATH']);
    assert.equal(e.PATH, '/usr/bin');
  } finally { fs.rmSync(bin, { recursive: true, force: true }); }
});

test('stream-json output: tool calls are the tool_use blocks', () => {
  const lines = [{ type: 'system' }, { type: 'assistant', message: { content: [{ type: 'tool_use' }, { type: 'tool_use' }] } }, { type: 'assistant', message: { content: [{ type: 'text' }] } }, { type: 'result', result: 'Ana', num_turns: 3, total_cost_usd: 0.1, usage: { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 5, cache_creation_input_tokens: 7 } }];
  const r = parseRun(lines.map((l) => JSON.stringify(l)).join('\n'));
  assert.deepEqual([r.toolCalls, r.tokensIn, r.tokensOut, r.error], [2, 14, 3, null]);
  assert.equal(parseRun(JSON.stringify({ result: '', is_error: true, subtype: 'error_max_turns' })).error, 'error_max_turns');
});

test('workspaces: baseline has only plan.md; graph arm has a built plan with the questions answerable by the plangraph CLI', () => {
  const b = tmp(), g = tmp();
  try {
    buildBaselineProject(b);
    assert.deepEqual(fs.readdirSync(b), ['plan.md']);
    buildGraphProject(g);
    assert.ok(!fs.existsSync(path.join(g, 'plan.md')) && fs.existsSync(path.join(g, '.plangraph', 'plangraph.sqlite')));
    const out = spawnSync(process.execPath, [path.join(PLUGIN_DIR, 'bin', 'plangraph'), 'ticket', 'T-4', '-v'], { cwd: g, encoding: 'utf8' }).stdout;
    const t = T.find((x) => x.key === 'T-4');
    assert.ok(out.includes(`${t?.sprint} ${t?.owner}`) && out.includes(`stack=${PROJECT.stack['T-4']}`) && out.includes(`requirement=${PROJECT.requirement['T-4']}`), out);
  } finally { fs.rmSync(b, { recursive: true, force: true }); fs.rmSync(g, { recursive: true, force: true }); }
});
