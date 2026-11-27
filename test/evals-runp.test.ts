// evals/run-p.ts, evals/trace.ts and the prompt styles, offline (no model call). Trace fixtures in test/fixtures/evals-p/ are pilot #1
// traces of `claude plugin eval` reduced to their event structure, with every ticket key, person, path and output replaced by invented
// text: pilot-a-plangraph-127 (plugin arm: the whatif skill fired, every plangraph call exited 127, generic Bash denied), pilot-a-overload-heredoc
// (plugin arm: a read-only python heredoc in a subagent that the native write regex flagged), pilot-b-lookup (bare arm lookup).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseTrace, pluginUsed, callInput } from '../evals/trace.ts';
import { claudeArgs, childEnv, snapshot, changedFiles, gradeRun, pool, mayLaunch, makeJobs, spentOf, parseArgs, stylesOf, ALLOWED, scaffold } from '../evals/run-p.ts';
import { loadCases } from '../evals/run.ts';
import { answerGraders, readOnlyGraders, diagGraders, validateCase, grade, WRITE_BASH, answerLine } from '../evals/schema.ts';
import { styledPrompt, buildFamilies, PROMPT_STYLES } from '../evals/families.ts';
import { summarize, render } from '../evals/report.ts';
import { copyPlugin } from '../evals/native.ts';
import type { EvalCase, Truth, TruthArgs } from '../evals/schema.ts';

/** a reassign-safe case: it carries its truth and the valid moves */
type ReassignCase = EvalCase & { truth: Truth & { args: TruthArgs & { valid: Array<{ to: string; sprint: number }> } } };

const root = path.resolve(import.meta.dirname, '..');
const fx = (n: string) => fs.readFileSync(path.join(root, 'test', 'fixtures', 'evals-p', n), 'utf8');
const cases = loadCases();
const byId = (id: string) => cases.find((c) => c.id === id) as EvalCase; // every id passed names a case in evals/cases
const tmps: string[] = [];
const tmp = (p = 'evals-runp-'): string => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p))); tmps.push(d); return d; };
after(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });

test('parseTrace: plugin arm of pilot #1 = skill fired, plangraph exited 127, a denied Bash; not counted as plugin use', () => {
  const t = parseTrace(fx('pilot-a-plangraph-127.jsonl'));
  assert.equal(t.plugin.brainCalls, 1);
  assert.equal(t.plugin.brainRan, 0);
  assert.equal(t.plugin.brainNotFound, 1);
  assert.deepEqual(t.plugin.skills, ['plangraph:whatif']);
  assert.equal(pluginUsed(t.plugin), false, 'a skill without a working plangraph is not plugin evidence');
  assert.equal(t.denials, 1);
  assert.ok(t.init && t.init.plugins.length > 0);
  assert.equal((t.result as { turns: number }).turns, 11); // the pilot trace ends with a result event
  assert.ok((t.result as { cost: number }).cost > 0 && (t.result as { tokens: number }).tokens > 0); // same result event, with cost and tokens
  assert.match(t.message, /^ANSWER: \{"ok":false/m);
  assert.ok(t.calls.every((c) => typeof c.input === 'string'));
  assert.equal((t.calls.find((c) => c.tool === 'Bash') as { input: string }).input.startsWith('plangraph ticket ZED-'), true, 'Bash input is the command (what input_match is written against)'); // the pilot trace has a Bash call
});

test('parseTrace: a plangraph call that ran counts as plugin use; denied and 127 calls do not; bad lines are skipped', () => {
  const ev = (o: unknown) => JSON.stringify(o);
  const lines = [
    'not json', '{"broken":', ev({ type: 'system', subtype: 'init', plugins: [{ name: 'plangraph' }], skills: [], tools: ['Bash'] }),
    ev({ type: 'system', subtype: 'hook_response', hook_event: 'SessionStart', exit_code: 0, stdout: 'plangraph 1a2b | 60 tickets' }),
    ev({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'cd plan && plangraph ready ZED-1' } }] } }),
    ev({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: [{ type: 'text', text: 'ZED-1 not ready: waits ZED-2' }], is_error: true }] } }),
    ev({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'plangraph chain ZED-1' } }] } }),
    ev({ type: 'system', subtype: 'permission_denied', tool_use_id: 'b' }),
    ev({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b', content: 'Tool use rejected', is_error: true }] } }), // only the permission_denied event says it was a denial
    ev({ type: 'assistant', message: { content: [{ type: 'text', text: 'ANSWER: {"blockers":["ZED-2"]}' }] } }),
  ];
  const t = parseTrace(lines.join('\n'));
  assert.deepEqual([t.plugin.brainCalls, t.plugin.brainRan, t.plugin.loaded, t.denials], [2, 1, true, 1]);
  assert.deepEqual([t.plugin.card, t.plugin.toolCalls], [true, 2]);
  assert.equal(parseTrace(fx('pilot-b-lookup.jsonl')).plugin.card, false);
  assert.equal(pluginUsed(t.plugin), true, 'exit 1 from plangraph (a verdict) still means plangraph ran');
  assert.equal(t.result, null);
  assert.equal(t.message, 'ANSWER: {"blockers":["ZED-2"]}', 'without a result event the last assistant text is the message');
  assert.equal(callInput('Skill', { skill: 'whatif' }), '{"skill":"whatif"}');
  assert.equal(parseTrace('').calls.length, 0);
});

test('safe-no-write-bash on the pilot overload trace: the read-only heredoc passes; real writes in the same trace fail', () => {
  const c = byId('m-overload'), t = parseTrace(fx('pilot-a-overload-heredoc.jsonl'));
  assert.ok(t.calls.some((x) => x.tool === 'Bash' && x.parent && /<<'E'/.test(x.input)), 'the subagent heredoc call is parsed');
  const ok = gradeRun(c, t, { arm: 'with', files: [], fileTexts: {} });
  assert.ok(!ok.failed.includes('safe-no-write-bash'));
  for (const w of ['echo x > plan.md', "python3 - <<'E'\nopen('plan.md','w').write('x')\nE", 'git commit -am x']) {
    const bad = { ...t, calls: [...t.calls, { tool: 'Bash', input: w, raw: {}, parent: null, denied: false, ran: true, error: false, notFound: false, id: 'z' } as unknown as (typeof t.calls)[number]] }; // parseTrace types a call's error as null, the fixture sets false (ripple: lib/evals trace typing)
    assert.ok(gradeRun(c, bad, { arm: 'with', files: [], fileTexts: {} }).failed.includes('safe-no-write-bash'), w);
  }
  // the native regex agrees on this trace now (it used to flag `v>c`)
  assert.ok(!grade(c, { message: t.message, calls: t.calls.map((x) => ({ tool: x.tool, input: x.input })) }).failed.includes('safe-no-write-bash'));
});

test('gradeRun: bare-arm lookup trace scores the answer; with-only diagnostics are not graded in arm B; file sentinels read fileTexts', () => {
  const c = { graders: [...answerGraders({ owner: 'Rowan Vale', sprint: 5 }), ...readOnlyGraders(), ...diagGraders()] };
  const t = parseTrace(fx('pilot-b-lookup.jsonl'));
  const g = gradeRun(c, t, { arm: 'without', files: [], fileTexts: {} });
  assert.equal(g.score, 1);
  assert.equal(g.passed, true);
  assert.ok(!g.graders.some((x) => x.name.startsWith('diag-')));
  const a = gradeRun(c, t, { arm: 'with', files: [], fileTexts: {} });
  assert.ok(a.graders.some((x) => x.name === 'diag-used-plangraph' && !x.scored), 'diagnostics are reported, not scored, in arm A');
  const wrong = gradeRun({ graders: answerGraders({ owner: 'Mira Holt', sprint: 5 }) }, t, { arm: 'without', files: [], fileTexts: {} });
  assert.ok(wrong.score < 1 && !wrong.passed);
});

test('integrity: the hash diff sees edits, creations and deletions, ignores the derived index, and ignores card/report outputs only when writing is allowed', () => {
  const ws = tmp();
  fs.mkdirSync(path.join(ws, 'plan', 'graph'), { recursive: true });
  fs.mkdirSync(path.join(ws, '.git'));
  fs.writeFileSync(path.join(ws, 'plan.md'), '# Plan\n');
  fs.writeFileSync(path.join(ws, 'plan', 'graph', 'schedule.jsonl'), '{"key":"ZED-1"}\n');
  fs.writeFileSync(path.join(ws, 'gone.txt'), 'x');
  let head = 'aaa';
  const snap = () => snapshot(ws, { headOf: () => head });
  const before = snap();
  fs.writeFileSync(path.join(ws, 'plan', 'graph', 'schedule.jsonl'), '{"key":"ZED-1","sprint":2}\n'); // same size class, new content
  fs.writeFileSync(path.join(ws, 'plan', 'graph', 'plangraph.sqlite'), 'db');
  fs.writeFileSync(path.join(ws, 'plan', 'graph', 'plangraph.sqlite-wal'), 'db');
  fs.writeFileSync(path.join(ws, 'plan', 'graph', 'CARD.md'), 'card');
  fs.writeFileSync(path.join(ws, 'notes.md'), 'n');
  fs.rmSync(path.join(ws, 'gone.txt'));
  fs.writeFileSync(path.join(ws, '.git', 'index'), 'ignored: git internals are not workspace files');
  const after = snap();
  assert.deepEqual(changedFiles(before, after, { brainDir: 'plan/graph' }), ['gone.txt', 'notes.md', 'plan/graph/schedule.jsonl']);
  assert.deepEqual(changedFiles(before, after, { brainDir: 'plan/graph', forbidAll: true }), ['gone.txt', 'notes.md', 'plan/graph/CARD.md', 'plan/graph/schedule.jsonl']);
  head = 'bbb';
  assert.ok(changedFiles(before, snap(), { brainDir: 'plan/graph' }).includes('.git/HEAD'), 'a commit (moved HEAD) is a write');
  // an identical rewrite is not a change
  const b2 = snap(); fs.writeFileSync(path.join(ws, 'plan.md'), '# Plan\n'); assert.deepEqual(changedFiles(b2, snap()), []);
  // the no-write grader over the hash list
  const c = byId('m-no-write-report');
  assert.ok(grade(c, { message: '', files: changedFiles(before, after, { brainDir: 'plan/graph', forbidAll: true }) }).failed.includes('safe-no-new-files'));
  assert.ok(!grade(c, { message: '', files: ['plan/graph/plangraph.sqlite'] }).failed.includes('safe-no-new-files'));
});

test('claude command line: both arms identical except --plugin-dir; isolation flags present; plangraph is granted', () => {
  const a = claudeArgs({ arm: 'with', model: 'claude-sonnet-5-5', budget: 0.8, pluginDir: '/tmp/p' }), b = claudeArgs({ arm: 'without', model: 'claude-sonnet-5-5', budget: 0.8, pluginDir: '/tmp/p' });
  assert.deepEqual(a.slice(0, b.length), b);
  assert.deepEqual(a.slice(b.length), ['--plugin-dir', '/tmp/p']);
  for (const f of ['-p', '--no-session-persistence', '--strict-mcp-config', '--verbose', '--include-hook-events']) assert.ok(b.includes(f), f);
  const v = (k: string) => b[b.indexOf(k) + 1];
  assert.equal(v('--setting-sources'), 'project');
  assert.equal(v('--permission-mode'), 'dontAsk');
  assert.equal(v('--output-format'), 'stream-json');
  assert.equal(v('--max-budget-usd'), '0.80');
  assert.equal(v('--tools'), 'Read,Grep,Glob,Bash,Skill,Edit,Write');
  assert.ok(v('--allowedTools').split(',').includes('Bash(plangraph:*)'));
  assert.ok(!ALLOWED.includes('Edit') && !ALLOWED.includes('Write'), 'Edit and Write are visible but never granted');
});

test('child environment: parent-session Claude variables and plangraph settings are dropped, auth kept, PATH entries with a plangraph binary removed', () => {
  const e = childEnv({ PATH: '/usr/bin:/opt/brainbin:/bin', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'x', CLAUDE_PLUGIN_ROOT: '/p', CLAUDE_CONFIG_DIR: '/c', CLAUDE_CODE_OAUTH_TOKEN: 't', ANTHROPIC_API_KEY: 'k', PLANGRAPH_CARD: 'off', HOME: '/h' }, { hasBrain: (d) => d === '/opt/brainbin' });
  assert.equal(e.PATH, '/usr/bin:/bin');
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_PLUGIN_ROOT', 'PLANGRAPH_CARD']) assert.equal(e[k], undefined, k);
  for (const k of ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'HOME']) assert.ok(e[k], k);
});

test('budget: never launches past the cap (spent + in-flight reservations); waits for in-flight runs before giving up', async () => {
  assert.equal(mayLaunch({ spent: 1, inflight: 1, reserve: 1, cap: 3 }), true);
  assert.equal(mayLaunch({ spent: 1, inflight: 1, reserve: 1.01, cap: 3 }), false);
  const jobs = Array.from({ length: 6 }, (_, i) => ({ key: `j${i}`, budget: 1 }));
  const seen: string[] = [];
  const r1 = await pool(jobs, { j: 1, cap: 2.5, runOne: async (job: { key: string }) => { seen.push(job.key); return { cost: 1 } } });
  assert.deepEqual(seen, ['j0', 'j1']);
  assert.equal(r1.skipped, 4);
  // parallel: reservations block the third launch until the first two finish with a small real cost
  let peak = 0, live = 0;
  const r2 = await pool(jobs, { j: 3, cap: 2.5, runOne: async () => { live++; peak = Math.max(peak, live); await new Promise((res) => setTimeout(res, 5)); live--; return { cost: 0.1 }; } });
  assert.equal(peak, 2, 'two reservations of 1 fit under 2.5, a third does not');
  assert.equal(r2.records.length, 6, 'cheap runs free their reservations and the rest still run');
  assert.ok(Math.abs(r2.spent - 0.6) < 1e-9);
  const r3 = await pool(jobs, { j: 2, cap: 5, spent0: 4.5, runOne: async () => ({ cost: 1 }) });
  assert.equal(r3.records.length, 0, 'a resumed suite counts what it already spent');
  assert.equal(spentOf([{ cost: 0.5 }, { cost: null }, { cost: 0.25 }]), 0.75);
  const failing = await pool(jobs.slice(0, 2), { j: 2, cap: 10, runOne: async () => { throw new Error('x'); } });
  assert.equal(failing.records.length, 0, 'a crashed run neither hangs the pool nor counts');
});

test('jobs: one per case x style x arm x run, unique keys, per-run budget clamped', () => {
  const cs = [byId('m-lookup'), byId('m-chain')];
  const jobs = makeJobs(cs, { styles: ['natural', 'layout-told'], runs: 2, perRunUsd: 0.5 });
  assert.equal(jobs.length, 2 * 2 * 2 * 2);
  assert.equal(new Set(jobs.map((j) => j.key)).size, jobs.length);
  assert.ok(jobs.every((j) => j.budget === 0.5));
  assert.deepEqual(stylesOf('both'), PROMPT_STYLES);
  assert.deepEqual(stylesOf(), ['natural']);
  assert.throws(() => stylesOf('shouty'));
  assert.deepEqual(parseArgs(['--run', '-j', '2', '--max-cost-usd', '3']), { run: true, j: '2', 'max-cost-usd': '3' });
  assert.throws(() => parseArgs(['--nope']));
});

test('natural prompts: no file layout or rule text, same ANSWER contract and truth, valid cases; layout-told is the committed prompt', () => {
  for (const c of cases) {
    assert.equal(styledPrompt(c, 'layout-told', '.plangraph'), c.prompt);
    const p = styledPrompt(c, 'natural', '.plangraph');
    assert.ok(!/\.jsonl\b|config\.json\b|\.plangraph\//.test(p), c.id);
    assert.ok(!p.includes('Rules: a consumer') && !p.includes('A ticket may start now when'), c.id);
    assert.equal(p.includes('ANSWER:'), c.prompt.includes('ANSWER:'), c.id);
    assert.deepEqual(validateCase({ ...c, prompt: p }), [], c.id);
    if (c.prompt.startsWith('The sprint plan for this repository')) assert.ok(p.startsWith('About the sprint plan in this repo: '), c.id);
    if (/"codes"/.test(c.prompt) && c.prompt.includes('Rules: a consumer')) assert.match(p, /PRODUCER_LATE, CONSUMER_EARLY, CAPACITY, OUT_OF_RANGE, STARTED/);
  }
  assert.throws(() => styledPrompt(cases[0], 'other', '.plangraph'));
  // a real project's plan dir (any path) is stripped the same way
  const files = Object.fromEntries(fs.readdirSync(path.join(root, 'evals/fixtures/M')).filter((n) => /\.jsonl$|config\.json$/.test(n)).map((n) => [n, fs.readFileSync(path.join(root, 'evals/fixtures/M', n), 'utf8')]));
  const built = buildFamilies({ prefix: 'x', size: 'R', seed: null, dir: 'docs/plan/graph', files, stale: null }, ['lookup', 'forecast-thin', 'whatif-yes', 'ready-no']).cases;
  assert.ok(built.length >= 3);
  for (const c of built) { const p = styledPrompt(c, 'natural', 'docs/plan/graph'); assert.ok(!p.includes('docs/plan/graph') && !/\.jsonl/.test(p), c.id); }
});

test('report over run-p results: natural is the headline block, plugin use is shown, a plugin arm that never ran plangraph is visible, a B leak is flagged', () => {
  const suite = tmp('evals-runp-report-');
  const pick = [byId('m-lookup'), byId('m-reassign-safe')];
  fs.writeFileSync(path.join(suite, 'cases.json'), JSON.stringify(pick));
  fs.cpSync(path.join(root, 'evals/fixtures/M'), path.join(suite, 'fixtures', 'M'), { recursive: true });
  const rs = pick[1] as ReassignCase, v = rs.truth.args.valid[0]; // m-reassign-safe is a reassign-safe case with valid moves
  const rec = (c: EvalCase, style: string, arm: string, score: number, { used = false, brainB = false, message = '' }: { used?: boolean; brainB?: boolean; message?: string } = {}) => ({ key: `${c.id}__${style}__${arm}`, id: c.id, style, arm, score, passed: score >= 0.8, graders: c.graders.map((g) => ({ name: g.id, passed: true })), turns: 4, cost: 0.1, tokens: 1000, error: null,
    plugin: { brainCalls: used ? 1 : 0, brainRan: (arm === 'with' && used) || brainB ? 1 : 0, brainNotFound: 0, skills: [] }, pluginUsed: arm === 'with' && used, message });
  const records = [
    rec(pick[0], 'natural', 'with', 1, { used: true }), rec(pick[0], 'natural', 'without', 0.5),
    rec(rs, 'natural', 'with', 1, { used: false, message: answerLine({ key: rs.truth.args.key, to: v.to, sprint: v.sprint }) }), rec(rs, 'natural', 'without', 1, { brainB: true }),
    rec(pick[0], 'layout-told', 'with', 1, { used: true }), rec(pick[0], 'layout-told', 'without', 1),
  ];
  fs.mkdirSync(path.join(suite, 'results'));
  fs.writeFileSync(path.join(suite, 'results', 'run-p.json'), JSON.stringify({ schema: 'plangraph-eval-p/1', records }));
  const s = summarize(suite);
  assert.deepEqual(s.styles.map((b) => b.style), ['natural', 'layout-told']);
  assert.equal(s.overall.A.n, 2, 'top-level numbers are the natural block');
  assert.deepEqual([s.pluginUse.used.k, s.pluginUse.used.n], [1, 2]);
  assert.equal(s.pluginUse.brainInB, 1);
  assert.deepEqual([s.postcheck.A.k, s.postcheck.A.n], [1, 1], 'post-checks read the stored message and suite/fixtures');
  const txt = render(s);
  assert.match(txt, /== prompt style: natural \(headline\) ==/);
  assert.match(txt, /plugin used in arm A \(a plangraph call ran\): 1\/2 50%/);
  assert.match(txt, /not plugin evidence/);
  assert.match(txt, /LEAK/);
  assert.match(txt, /^family +n .* A used$/m);
  assert.ok(!txt.includes('ANSWER'), 'no answer text is printed');
});

test('scaffold: a git workspace with the plan converted to entity files and committed, the index built and ignored', { timeout: 120000 }, () => {
  const suite = tmp('evals-runp-suite-'), ws = tmp('evals-runp-ws-');
  copyPlugin(root, path.join(suite, 'plugin'));
  fs.cpSync(path.join(root, 'evals/fixtures/S'), path.join(suite, 'fixtures', 'S'), { recursive: true });
  const c = byId('s-lookup');
  const dir = scaffold(ws, c, { suite });
  assert.equal(dir, '.plangraph');
  assert.ok(fs.existsSync(path.join(ws, '.plangraph', 'plangraph.sqlite')));
  const st = spawnSync('git', ['status', '--porcelain'], { cwd: ws, encoding: 'utf8' });
  assert.equal(st.stdout, '', 'the workspace is clean after the scaffold (index ignored, everything committed)');
  assert.ok(!fs.existsSync(path.join(ws, '.gitattributes')), 'no merge attribute is written'); assert.ok(fs.existsSync(path.join(ws, '.plangraph', 'nodes', 'ticket')));
  const card = spawnSync(process.execPath, [path.join(suite, 'plugin', 'bin', 'plangraph'), 'card', '--if-present', '--refresh'], { cwd: ws, encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_DATA: path.join(suite, 'plugin-data') } });
  assert.equal(card.status, 0);
  assert.equal(spawnSync('git', ['status', '--porcelain'], { cwd: ws, encoding: 'utf8' }).stdout, '', 'the session hook writes nothing in arm A');
});

test('CLI: paid modes need a cap; --out inside the repository is refused; --dry-run builds a suite outside the repo and prints the command', { timeout: 120000 }, () => {
  const cli = (...a: string[]) => spawnSync(process.execPath, [path.join(root, 'evals', 'run-p.ts'), ...a], { encoding: 'utf8' });
  assert.equal(cli('--run', '--case', 'm-lookup').status, 2);
  assert.equal(cli('--probe').status, 2);
  assert.equal(cli('--dry-run', '--case', 'm-lookup', '--out', path.join(root, 'evals', 'x')).status, 2);
  assert.ok(!fs.existsSync(path.join(root, 'evals', 'x')));
  const r = cli('--dry-run', '--case', 'm-lookup', '--style', 'both', '--runs', '1');
  assert.equal(r.status, 0, r.stderr);
  const suite = (/^suite: (.+)$/m.exec(r.stdout) as RegExpExecArray)[1]; tmps.push(suite); // the dry-run output has a suite line
  assert.ok(!suite.startsWith(root));
  assert.match(r.stdout, /1 cases x 2 style\(s\) \[natural, layout-told\] x 2 arms x 1 runs = 4 runs/);
  assert.match(r.stdout, /--plugin-dir/);
  assert.ok(fs.existsSync(path.join(suite, 'plugin', 'bin', 'plangraph')) && fs.existsSync(path.join(suite, 'fixtures', 'M', 'tickets.jsonl')));
  assert.equal(WRITE_BASH.length > 0, true);
});
