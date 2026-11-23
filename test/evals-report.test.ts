// evals/report.ts on a synthetic results tree shaped like Claude Code 2.1.329's aggregate-result.json (fields observed in a zero-cost
// run: cases[].arms.{with,without}[] with score, passed, turns, costUsd, tracePath, graders[{name, passed}]). Checks the A-vs-B table,
// injection resistance, no-write integrity, post-checked moves (applied to a copy and re-verified), trigger recall, the bootstrap,
// and that nothing but ids, families and numbers is printed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { summarize, render, postcheck, wilson, bootstrapDelta, readTrace } from '../evals/report.ts';
import { loadCases } from '../evals/run.ts';
import { answerLine } from '../evals/schema.ts';
import type { EvalCase, Truth, TruthArgs } from '../evals/schema.ts';

const root = path.resolve(import.meta.dirname, '..');
const all = loadCases();
/** a reassign-safe case: it carries its truth and the valid moves */
type ReassignCase = EvalCase & { truth: Truth & { args: TruthArgs & { valid: Array<{ to: string; sprint: number }> } } };
const pick = (['m-lookup', 'm-reassign-safe', 'm-inject-summary-override', 'm-no-write-report', 'm-trigger-brain-yes', 'm-trigger-brain-no', 'm-capacity-replan'].map((id) => all.find((c) => c.id === id))) as EvalCase[]; // every id is a case in evals/cases
let suite: string;
const fixture = () => Object.fromEntries(fs.readdirSync(path.join(root, 'evals/fixtures/M')).filter((n) => /\.jsonl$|config\.json$/.test(n)).map((n) => [n, fs.readFileSync(path.join(root, 'evals/fixtures/M', n), 'utf8')]));

const trace = (dir: string, name: string, message: string, usage: unknown) => { const p = path.join(dir, `${name}.jsonl`); fs.writeFileSync(p, [JSON.stringify({ type: 'system', subtype: 'init' }), JSON.stringify({ type: 'result', result: message, usage, num_turns: 3 })].join('\n') + '\n'); return p; };
const run = (c: EvalCase, passed: boolean, { turns = 3, cost = 0.05, tracePath = '', fail = [] }: { turns?: number; cost?: number; tracePath?: string; fail?: string[] } = {}) => ({ score: passed ? 1 : 0.4, passed, turns, costUsd: cost, judgeCostUsd: 0, durationSeconds: 10, error: null, tracePath, graders: c.graders.map((g) => ({ name: g.id, passed: !fail.includes(g.id), weight: g.weight })) });

before(() => {
  suite = fs.mkdtempSync(path.join(os.tmpdir(), 'evals-report-'));
  fs.writeFileSync(path.join(suite, 'cases.json'), JSON.stringify(pick));
  fs.mkdirSync(path.join(suite, 'pass-headline', 'evals', 'fixtures'), { recursive: true });
  fs.cpSync(path.join(root, 'evals/fixtures/M'), path.join(suite, 'pass-headline', 'evals', 'fixtures', 'M'), { recursive: true });
  const tr = path.join(suite, 'traces'); fs.mkdirSync(tr);
  const rs = pick.find((c) => c.family === 'reassign-safe') as ReassignCase, v = rs.truth.args.valid[0]; // the picked ids include the reassign-safe case, which has truth and valid moves
  const good = trace(tr, 'good', answerLine({ key: rs.truth.args.key, to: v.to, sprint: v.sprint }), { input_tokens: 100, cache_creation_input_tokens: 2000, cache_read_input_tokens: 9000, output_tokens: 400 });
  const bad = trace(tr, 'bad', answerLine({ key: rs.truth.args.key, to: rs.truth.args.from, sprint: 1 }), { input_tokens: 100, cache_creation_input_tokens: 9000, cache_read_input_tokens: 90000, output_tokens: 900 });
  const C = (id: string) => pick.find((c) => c.id === id) as EvalCase; // the ids passed are all picked above
  const head = { cases: [
    { name: 'm-lookup', arms: { with: [run(C('m-lookup'), true), run(C('m-lookup'), true)], without: [run(C('m-lookup'), true, { turns: 9, cost: 0.3 }), run(C('m-lookup'), false, { turns: 12, cost: 0.4, fail: ['ans-owner'] })] } },
    { name: 'm-reassign-safe', arms: { with: [run(rs, true, { tracePath: good })], without: [run(rs, false, { tracePath: bad, fail: ['ans-safe-move'] })] } },
    { name: 'm-inject-summary-override', arms: { with: [run(C('m-inject-summary-override'), true)], without: [run(C('m-inject-summary-override'), false, { fail: ['safe-no-apply'] })] } },
    { name: 'm-no-write-report', arms: { with: [run(C('m-no-write-report'), true)], without: [run(C('m-no-write-report'), false, { fail: ['safe-no-new-files'] })] } },
    { name: 'not-in-cases', arms: { with: [run(C('m-lookup'), true)], without: [] } },
  ] };
  const trig = { cases: [
    { name: 'm-trigger-brain-yes', arms: { with: [run(C('m-trigger-brain-yes'), true), run(C('m-trigger-brain-yes'), true, { fail: ['diag-skill-fired'] })] } },
    { name: 'm-trigger-brain-no', arms: { with: [run(C('m-trigger-brain-no'), true), run(C('m-trigger-brain-no'), false, { fail: ['neg-skill-not-fired'] })] } },
  ] };
  for (const [p, j] of (([['headline', head], ['triggers', trig]]) as Array<[string, unknown]>)) { fs.mkdirSync(path.join(suite, 'results', p), { recursive: true }); fs.writeFileSync(path.join(suite, 'results', p, 'aggregate-result.json'), JSON.stringify(j)); }
});
after(() => { if (suite) fs.rmSync(suite, { recursive: true, force: true }); });

test('summarize: per-arm pass rates, turns, cost, tokens from kept traces, injection resistance, no-write integrity, post-checks and triggers', () => {
  const s = summarize(suite);
  const lk = s.rows.find((r) => r.family === 'lookup') as (typeof s.rows)[number]; // the picked lookup case has a row
  assert.equal(lk.A.pass, 1); assert.equal(lk.B.pass, 0.5); assert.equal(lk.B.turns, 10.5); assert.ok(Math.abs(lk.B.cost - 0.35) < 1e-9);
  const rs = s.rows.find((r) => r.family === 'reassign-safe') as (typeof s.rows)[number]; // the picked reassign-safe case has a row
  assert.equal(rs.A.tokens, 11500); assert.equal(rs.B.tokens, 100000);
  assert.deepEqual([s.injection.A.k, s.injection.A.n, s.injection.B.k, s.injection.B.n], [1, 1, 0, 1]);
  assert.deepEqual([s.noWrite.A.k, s.noWrite.B.k], [1, 0]);
  assert.deepEqual([s.postcheck.A.k, s.postcheck.A.n, s.postcheck.B.k, s.postcheck.B.n], [1, 1, 0, 1], 'the safe move verifies, the current-owner move does not');
  assert.deepEqual([s.triggers.recall.k, s.triggers.recall.n, s.triggers.falseFire.k, s.triggers.falseFire.n], [1, 2, 1, 2]);
  assert.ok(s.overall.delta > 0);
  assert.equal(s.runs, 14, 'a result row for a case not in cases.json is ignored');
});

test('render prints ids, families and numbers only (no prompt or answer text)', () => {
  const txt = render(summarize(suite));
  assert.match(txt, /^family +n +A pass/m);
  assert.match(txt, /^ALL /m);
  assert.match(txt, /injection resistance .*A 1\/1 100%/);
  for (const c of pick) assert.ok(!txt.includes(c.prompt.slice(0, 40)), 'a prompt leaked');
  assert.ok(!txt.includes('ANSWER'), 'an answer leaked');
  const cli = spawnSync(process.execPath, [path.join(root, 'evals', 'report.ts'), '--suite', suite], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stdout, txt);
  const bad = spawnSync(process.execPath, [path.join(root, 'evals', 'report.ts'), '--suite', suite, '--json', path.join(root, 'evals', 'x.json')], { encoding: 'utf8' });
  assert.equal(bad.status, 2, 'the JSON summary is never written into the repository');
  assert.ok(!fs.existsSync(path.join(root, 'evals', 'x.json')));
  assert.equal(spawnSync(process.execPath, [path.join(root, 'evals', 'report.ts')], { encoding: 'utf8' }).status, 2);
});

test('postcheck re-verifies the proposed move on a copy: unknown keys, people, out-of-range sprints and new violations fail', () => {
  const rs = pick.find((c) => c.family === 'reassign-safe') as ReassignCase, f = fixture(), k = rs.truth.args.key, v = rs.truth.args.valid[0]; // the picked ids include the reassign-safe case, which has truth and valid moves
  assert.equal(postcheck(rs, answerLine({ key: k, to: v.to, sprint: v.sprint }), f), true);
  assert.equal(postcheck(rs, answerLine({ key: k, to: rs.truth.args.from, sprint: v.sprint }), f), false, 'staying with the current owner fails');
  assert.equal(postcheck(rs, answerLine({ key: 'T-99999', to: v.to, sprint: v.sprint }), f), false);
  assert.equal(postcheck(rs, answerLine({ key: k, to: 'Nobody', sprint: v.sprint }), f), false);
  assert.equal(postcheck(rs, answerLine({ key: k, to: v.to, sprint: 999 }), f), false);
  assert.equal(postcheck(rs, 'no answer line', f), false);
  assert.equal(postcheck(pick.find((c) => c.id === 'm-lookup') as EvalCase, 'x', f), null, 'cases without a post-check report null'); // m-lookup is one of the picked ids
  const cr = pick.find((c) => c.family === 'capacity-replan') as EvalCase & { truth: Truth }; // the picked capacity-replan case has truth
  assert.equal(postcheck(cr, answerLine({ cell: cr.truth.value.cell, moves: [] }), f), false, 'an empty repair does not clear the cell');
});

test('statistics helpers are deterministic and sane', () => {
  const [lo, hi] = wilson(8, 10);
  assert.ok(lo > 0.4 && lo < 0.5 && hi > 0.9 && hi < 0.98);
  assert.deepEqual(wilson(0, 0).map(Number.isNaN), [true, true]);
  assert.deepEqual(bootstrapDelta([0.5, 0.2, 0.3]), bootstrapDelta([0.5, 0.2, 0.3]));
  const ci = bootstrapDelta([0.5, 0.2, 0.3, 0.4]);
  assert.ok(ci[0] >= 0.2 && ci[1] <= 0.5 && ci[0] <= ci[1]);
  assert.deepEqual(readTrace(path.join(suite, 'missing.jsonl')), { tokens: null, message: null });
});
