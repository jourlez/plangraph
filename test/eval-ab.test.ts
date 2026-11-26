// Offline checks for evals/ab: question integrity and independent ground truth, Wilson bounds, summarize, report, calibration, coding task
// descriptors and the live gate. No model or API call: the live paths refuse to run without EVAL_LIVE=1.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT, planMarkdown } from '../evals/ab/project.ts';
import { graphQuestions } from '../evals/ab/questions.ts';
import { summarize, renderReport, calibrate, wilson, ARMS } from '../evals/ab/report.ts';
import { loadCodingTasks, cells, argvFor, requireLive, grade, parseRun, MODELS } from '../evals/ab/run.ts';
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
  assert.deepEqual(parseRun(JSON.stringify({ result: 'x', total_cost_usd: 0.5, num_turns: 3, usage: { input_tokens: 10, output_tokens: 5 } })), { reply: 'x', tokens: 15, calls: 3, cost: 0.5 });
});
