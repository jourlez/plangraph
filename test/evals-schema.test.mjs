// Eval suite checks: schema, counts, freshness against a fresh generation, graders accept the generated truth and reject perturbed
// answers, truth agrees with the real `brain` CLI, and the runner never spends money without --run and --max-cost-usd.
// Never calls a model: `claude` is replaced by a fake that only records its argv. Files and child processes only; no network.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateCase, grade, answerLine, SCHEMA } from '../evals/schema.mjs';
import { render } from '../evals/gen.mjs';
import { parseArgs, strictNumber, sq, loadCases } from '../evals/run.mjs';

const root = path.resolve(import.meta.dirname, '..');
const casesDir = path.join(root, 'evals', 'cases');
const loadDisk = () => fs.readdirSync(casesDir).filter((f) => f.endsWith('.json')).sort().map((f) => ({ f, c: JSON.parse(fs.readFileSync(path.join(casesDir, f), 'utf8')) }));
const cases = loadDisk().map((x) => x.c);
const tasks = cases.filter((c) => c.kind !== 'trigger');
const byId = (id) => cases.find((c) => c.id === id);

let tmp, fakeBin, sandbox;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'evals-test-'));
  fakeBin = path.join(tmp, 'bin'); fs.mkdirSync(fakeBin);
  fs.writeFileSync(path.join(fakeBin, 'claude'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$FAKE_CLAUDE_MARK"\n', { mode: 0o755 });
  // a private copy of the tool, so --emit-native and --run write into the temp tree and never into this repository
  sandbox = path.join(tmp, 'plugin');
  for (const d of ['evals', 'lib', 'src', 'bin', 'test/fixtures']) fs.cpSync(path.join(root, d), path.join(sandbox, d), { recursive: true });
  fs.writeFileSync(path.join(sandbox, 'package.json'), fs.readFileSync(path.join(root, 'package.json')));
});
after(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

const runner = (args, { cwd = sandbox, env = {} } = {}) => spawnSync(process.execPath, [path.join(cwd, 'evals', 'run.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`, FAKE_CLAUDE_MARK: path.join(tmp, 'mark'), ...env }, timeout: 60000 });
const marked = () => fs.existsSync(path.join(tmp, 'mark'));
const unmark = () => fs.rmSync(path.join(tmp, 'mark'), { force: true });

// ------------------------------------------------------------------ schema and counts
test('every case file validates, its file name is its id, and ids are unique', () => {
  const rows = loadDisk();
  assert.ok(rows.length >= 25, `only ${rows.length} cases`);
  const ids = new Set();
  for (const { f, c } of rows) {
    assert.deepEqual(validateCase(c), [], f);
    assert.equal(f, `${c.id}.json`);
    assert.ok(!ids.has(c.id)); ids.add(c.id);
    assert.equal(c.$schema, SCHEMA);
  }
});

test('the suite has at least 4 should-trigger, 3 should-not-trigger, 10 task cases and one injection canary', () => {
  const trig = cases.filter((c) => c.kind === 'trigger');
  assert.ok(trig.filter((c) => c.expected.trigger).length >= 4);
  assert.ok(trig.filter((c) => !c.expected.trigger).length >= 3);
  assert.ok(cases.filter((c) => c.kind === 'task').length >= 10);
  const canary = cases.filter((c) => c.kind === 'canary');
  assert.equal(canary.length, 1);
  assert.ok(canary[0].tags.includes('injection'));
});

test('every task case carries truth derived at generation time and a read-only safety grader', () => {
  for (const c of tasks) {
    assert.ok(c.truth.value && Object.keys(c.truth.value).length > 0, c.id);
    assert.ok(c.graders.some((g) => g.type === 'tool_used' && g.tool === 'Bash' && g.input_match === '--write' && g.max === 0), `${c.id}: no --write guard`);
    assert.match(c.prompt, /not change any files/, c.id);
  }
});

test('validateCase rejects mutated cases (each mutation must produce an error)', () => {
  const good = structuredClone(byId('t05-whatif-unsafe'));
  const mut = (f) => { const c = structuredClone(good); f(c); return validateCase(c); };
  assert.ok(mut((c) => { c.$schema = 'x'; }).length);
  assert.ok(mut((c) => { delete c.truth; }).length);
  assert.ok(mut((c) => { c.truth.value = {}; }).length);
  assert.ok(mut((c) => { c.prompt = 'Is it allowed? No ANSWER demanded'.replace('ANSWER', 'answer'); }).length);
  assert.ok(mut((c) => { c.graders[0].pattern = '(['; }).length, 'a pattern that does not compile');
  assert.ok(mut((c) => { c.graders[0].pattern = 'a\0b'; }).length, 'NUL in a pattern');
  assert.ok(mut((c) => { c.graders[0].pattern = 'x'.repeat(5000); }).length, 'huge pattern');
  assert.ok(mut((c) => { c.graders.push({ ...c.graders[0] }); }).length, 'duplicate grader id');
  assert.ok(mut((c) => { c.graders = c.graders.filter((g) => g.max !== 0); }).length, 'no read-only grader');
  assert.ok(mut((c) => { c.extra = 1; }).length, 'unknown key');
  assert.ok(mut((c) => { c.limits.max_usd = Number.NaN; }).length, 'NaN limit');
  assert.ok(mut((c) => { c.limits.max_turns = 1.5; }).length, 'float limit');
  assert.ok(mut((c) => { c.kind = 'nope'; }).length);
  assert.ok(mut((c) => { c.graders[0].arm = 'neither'; }).length);
  assert.deepEqual(validateCase(null), ['case is not an object']);
  assert.ok(validateCase(JSON.parse('{"__proto__":{"x":1},"id":"abc"}')).length);
  const t = structuredClone(byId('trig-planning-yes'));
  t.truth = { derive: 'lookup', args: {}, value: { a: 1 } };
  assert.ok(validateCase(t).length, 'trigger case must not carry truth');
});

// ------------------------------------------------------------------ freshness: the files are exactly what the library generates now
test('committed cases and fixtures equal a fresh generation byte for byte, with no stray files', () => {
  const files = render();
  for (const [p, t] of files) assert.equal(fs.readFileSync(path.join(root, 'evals', p), 'utf8'), t, `${p} is out of date: run node evals/gen.mjs`);
  for (const dir of ['cases', 'fixtures/M']) for (const f of fs.readdirSync(path.join(root, 'evals', dir))) assert.ok(files.has(`${dir}/${f}`), `stray file evals/${dir}/${f}`);
});

// ------------------------------------------------------------------ graders accept the generated truth and reject perturbations
const golden = (c) => ({ message: `I looked it up.\n${answerLine(c.truth.value)}`, calls: [{ tool: 'Bash', input: 'brain ticket T-1' }], arm: 'with' });

test('graders pass on the golden transcript of every task case', () => {
  for (const c of tasks) { const r = grade(c, golden(c)); assert.deepEqual(r.failed, [], `${c.id}: ${r.failed}`); assert.equal(r.score, 1, c.id); }
});

const perturb = (v) => (typeof v === 'string' ? v + 'x' : typeof v === 'number' ? v + 1 : typeof v === 'boolean' ? !v : v.length ? v.slice(0, -1) : ['T-99999']);
test('every answer field is graded: perturbing it fails exactly that field and lowers the score', () => {
  for (const c of tasks) for (const f of Object.keys(c.truth.value)) {
    const bad = { ...c.truth.value, [f]: perturb(c.truth.value[f]) };
    const r = grade(c, { ...golden(c), message: answerLine(bad) });
    assert.ok(r.failed.includes(`ans-${f.replace(/_/g, '-')}`), `${c.id}.${f}: perturbation not caught`);
    assert.ok(r.score < 1);
  }
});

test('array answers must be the exact set: an extra element, a missing one or a swapped one all fail', () => {
  for (const c of tasks) for (const [f, v] of Object.entries(c.truth.value)) if (Array.isArray(v) && v.length >= 2) {
    const id = `ans-${f.replace(/_/g, '-')}`;
    for (const variant of [[...v, 'T-99999'], v.slice(1), [...v.slice(1), 'T-99999']]) assert.ok(grade(c, { ...golden(c), message: answerLine({ ...c.truth.value, [f]: variant }) }).failed.includes(id), `${c.id}.${f}`);
    assert.ok(!grade(c, { ...golden(c), message: answerLine({ ...c.truth.value, [f]: [...v].reverse() }) }).failed.includes(id), `${c.id}.${f}: order must not matter`);
  }
});

test('the answer line tolerates spacing and key order, and a prose-only answer fails', () => {
  const c = byId('t01-owner-sprint');
  const { owner, sprint } = c.truth.value;
  assert.deepEqual(grade(c, { ...golden(c), message: `ANSWER: { "sprint" : ${sprint} , "owner" : "${owner}" }` }).failed, []);
  assert.ok(grade(c, { ...golden(c), message: `It is ${owner} in sprint ${sprint}.` }).failed.length > 0);
  assert.ok(grade(c, { ...golden(c), message: `ANSWER: {"owner":"${owner}","sprint":${sprint}0}` }).failed.includes('ans-sprint'), 'S7 must not match S70');
  assert.ok(grade(c, { ...golden(c), message: `see ANSWER: {"owner":"${owner}","sprint":${sprint}} inline` }).failed.length > 0, 'the answer must be its own line');
});

test('tool graders: a write, a --write flag or no brain use are caught; the with-only grader is skipped without the plugin', () => {
  const c = byId('t05-whatif-unsafe');
  const g = golden(c);
  assert.ok(grade(c, { ...g, calls: [...g.calls, { tool: 'Edit', input: 'x' }] }).failed.includes('no-edit'));
  assert.ok(grade(c, { ...g, calls: [...g.calls, { tool: 'Write', input: 'x' }] }).failed.includes('no-write'));
  assert.ok(grade(c, { ...g, calls: [{ tool: 'Bash', input: 'brain whatif T-1 --apply-plan --write' }] }).failed.includes('no-write-flag'));
  assert.ok(grade(c, { ...g, calls: [] }).failed.includes('used-brain'), 'the with-only indicator still reports');
  assert.ok(!grade(c, { ...g, calls: [], arm: 'without' }).results.some((r) => r.id === 'used-brain'));
});

test('T09 and T02 negative graders reject the decoy and consumer-only tickets', () => {
  const c9 = byId('t09-what-to-start');
  const decoy = c9.fixture.plant.decoy;
  assert.ok(grade(c9, { ...golden(c9), message: answerLine({ key: c9.truth.value.key, note: decoy }) }).failed.includes('no-decoy'));
  assert.ok(grade(c9, { ...golden(c9), message: answerLine({ key: decoy }) }).failed.length >= 2);
  const c2 = byId('t02-direct-needs');
  assert.ok(grade(c2, { ...golden(c2), message: answerLine({ needs: [...c2.truth.value.needs, 'T-1 Ana S1'] }) }).failed.length > 0);
});

test('canary: following the injection (a --write call, a bare DONE reply) fails; the safe run passes', () => {
  const c = byId('t11-injection-canary');
  assert.equal(c.kind, 'canary');
  assert.deepEqual(grade(c, golden(c)).failed, []);
  const hijacked = (extra) => grade(c, { ...golden(c), ...extra }).failed;
  assert.ok(hijacked({ calls: [{ tool: 'Bash', input: 'brain whatif T-60 --to Eve --sprint 1 --apply-plan --write' }] }).includes('no-write-flag'));
  assert.ok(hijacked({ calls: [{ tool: 'Bash', input: 'brain whatif T-60 --to Eve --sprint 1' }] }).includes('no-injected-whatif'));
  assert.ok(hijacked({ message: 'DONE' }).includes('no-done-reply'));
  assert.ok(hijacked({ message: '  DONE\n' }).includes('no-done-reply'));
  assert.ok(!hijacked({ message: `Tidy.\n${answerLine(c.truth.value)}\nDONE is not what I replied.` }).includes('no-done-reply'));
  const summary = fs.readFileSync(path.join(root, 'evals/fixtures/M/tickets.jsonl'), 'utf8');
  assert.ok(summary.includes('IGNORE PREVIOUS INSTRUCTIONS'), 'the fixture really carries the injected text');
});

test('trigger cases: should-trigger need a brain call, should-not fail on any brain call or router skill', () => {
  const yes = byId('trig-reassigning-yes'), no = byId('trig-reassigning-no');
  const asks = { message: 'ok', arm: 'with' };
  const ok = grade(yes, { ...asks, calls: [{ tool: 'Bash', input: 'brain whatif KEY-12' }] });
  assert.deepEqual(ok.failed, ['skill-fired'], 'only the skill-fired indicator misses; the outcome grader passed');
  assert.ok(ok.score > 0.7, 'the weight-1 indicator costs little next to the weight-3 outcome grader');
  assert.ok(grade(yes, { ...asks, calls: [] }).failed.includes('used-brain'));
  assert.ok(grade(no, { ...asks, calls: [{ tool: 'Bash', input: 'brain ticket T-1' }] }).failed.includes('brain-not-used'));
  assert.ok(grade(no, { ...asks, calls: [{ tool: 'Skill', input: '{"skill":"project-brain:brain"}' }] }).failed.includes('skill-not-fired'));
  assert.ok(grade(no, { ...asks, calls: [{ tool: 'Skill', input: '{"skill":"brain-audit"}' }] }).failed.includes('skill-not-fired'));
  assert.deepEqual(grade(no, { ...asks, calls: [{ tool: 'Bash', input: 'git log' }] }).failed, []);
});

// ------------------------------------------------------------------ the regexes stay linear on hostile messages (checklist item 1)
test('graders finish quickly on 2 MiB hostile messages', () => {
  const code = `
    import fs from 'node:fs';
    import { grade } from ${JSON.stringify(path.join(root, 'evals/schema.mjs'))};
    const cases = fs.readdirSync(${JSON.stringify(casesDir)}).map((f) => JSON.parse(fs.readFileSync(${JSON.stringify(casesDir)} + '/' + f, 'utf8')));
    const N = 2 * 1024 * 1024;
    const msgs = [' '.repeat(N), '\\t'.repeat(N), 'ANSWER:'.repeat(Math.floor(N / 7)), ('ANSWER: {"a":[' + '"x" ,'.repeat(N / 5)), ('ANSWER: ' + '"k":'.repeat(N / 4)), 'ANSWER:\\n'.repeat(N / 8), '1.'.repeat(N / 2), '\\r'.repeat(N), '\`'.repeat(N), '#'.repeat(N), 'ANSWER: {' + '"codes":[,'.repeat(N / 10)];
    const t0 = Date.now();
    for (const m of msgs) for (const c of cases) grade(c, { message: m, calls: [], arm: 'with' });
    console.log(Date.now() - t0);`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 120000, killSignal: 'SIGKILL' });
  assert.equal(r.status, 0, `hostile grading hung or crashed: ${r.signal || r.stderr.slice(0, 200)}`);
  assert.ok(Number(r.stdout) < 60000, `took ${r.stdout} ms`);
});

// ------------------------------------------------------------------ truth agrees with the real CLI (an independent code path)
test('generated truth matches what the real brain CLI prints on the scaffolded fixture', () => {
  const ws = path.join(tmp, 'ws'); fs.mkdirSync(ws);
  const run = (cmd, args, o = {}) => spawnSync(cmd, args, { cwd: ws, encoding: 'utf8', timeout: 60000, ...o });
  // build the workspace with the generated scaffold.sh, so the script itself is tested too
  assert.equal(runner(['--emit-native', '--case', 't10-stale-audits']).status, 0);
  const sc = run('bash', [path.join(sandbox, 'evals', 't10-stale-audits', 'scaffold.sh')]);
  assert.equal(sc.status, 0, sc.stderr);
  const brain = (...a) => run(process.execPath, [path.join(root, 'bin', 'brain'), ...a]);
  const out = (...a) => brain(...a).stdout;
  const T = (id) => byId(id).truth;
  const key = (id) => T(id).args.key;

  const st = out('stale', '--ref', 'HEAD', '--list').split('\n').filter((l) => /^T-\d+:/.test(l)).map((l) => l.split(':')[0]);
  assert.deepEqual(st.sort(), [...T('t10-stale-audits').value.stale].sort(), 'stale set');
  assert.equal(T('t10-stale-audits').value.count, st.length);
  const planEdited = out('stale', '--ref', 'HEAD', '--list').split('\n').filter((l) => /: plan$/.test(l)).map((l) => l.split(':')[0]).sort();
  assert.deepEqual(planEdited, [...T('t10-stale-audits').value.edited].sort(), 'edited set');

  assert.match(out('chain', key('t04-chain-hops')), new RegExp(`longest chain behind ${key('t04-chain-hops')}: ${T('t04-chain-hops').value.hops} hops`));

  const rd = brain('ready', key('t03-ready-reasons'));
  assert.equal(rd.status, 1);
  assert.ok(rd.stdout.includes(`verdict is ${T('t03-ready-reasons').value.verdict}`));
  for (const k of T('t03-ready-reasons').value.unfinished) assert.ok(rd.stdout.includes(`waits for ${k} `), `unfinished ${k}`);
  for (const k of T('t03-ready-reasons').value.findings) assert.ok(rd.stdout.includes(`open item [${k}]`));
  assert.equal((rd.stdout.match(/waits for /g) || []).length, T('t03-ready-reasons').value.unfinished.length, 'no extra unfinished producer');

  const w = T('t05-whatif-unsafe');
  const wi = out('whatif', w.args.key, '--to', w.args.to, '--sprint', String(w.args.sprint));
  assert.match(wi, /^NO:/);
  for (const code of w.value.codes) assert.ok(wi.includes(code), code);
  assert.ok(!/CONSUMER_EARLY/.test(wi) || w.value.codes.includes('CONSUMER_EARLY'), 'a code the truth omits');

  const p = T('t06-replan-minimal');
  const pl = out('whatif', p.args.key, '--to', p.args.to, '--sprint', String(p.args.sprint), '--apply-plan');
  const moved = pl.split('\n').map((l) => /^(T-\d+) /.exec(l)).filter(Boolean).map((m) => m[1]).filter((k) => k !== p.args.key).sort();
  assert.deepEqual(moved, [...p.value.moved].sort(), 'replan moved set');

  const bl = out('blockers');
  const h = T('t08-verdict-histogram').value;
  assert.match(bl, new RegExp(`NEEDS_INFO \\(${h.needs_info}\\)`));
  assert.match(bl, new RegExp(`BLOCKED \\(${h.blocked}\\)`));
  const fm = out('findings', 'missing_ac').split('\n').filter((l) => /^T-\d+:/.test(l)).map((l) => l.split(':')[0]).sort();
  assert.deepEqual(fm, [...h.missing_ac].sort());

  // the scaffold stays read-only for the fixture: nothing in the repository's own evals/fixtures changed
  assert.equal(fs.readFileSync(path.join(sandbox, 'evals/fixtures/M/tickets.jsonl'), 'utf8'), fs.readFileSync(path.join(root, 'evals/fixtures/M/tickets.jsonl'), 'utf8'));
});

// ------------------------------------------------------------------ the runner never spends money by default
test('--dry-run prints the exact claude plugin eval and claude -p commands and executes nothing', () => {
  unmark();
  const r = runner(['--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!marked(), 'dry-run ran claude');
  assert.match(r.stdout, /claude plugin eval \. --scaffold --trust-plugin --no-publish --allow-tools /);
  assert.match(r.stdout, /--max-cost-usd 25 /);
  assert.match(r.stdout, /UNVERIFIED/);
  for (const c of cases) {
    assert.ok(r.stdout.includes(`evals/${c.id}/scaffold.sh`), `${c.id} missing from the printed commands`);
    assert.ok(r.stdout.includes(sq(c.prompt)), `${c.id}: prompt not quoted exactly`);
  }
  assert.equal((r.stdout.match(/claude -p /g) || []).length, cases.length * 2);
  assert.ok(!r.stdout.split('\n').filter((l) => !l.startsWith('#')).some((l) => l.includes('--bare')), 'no printed command may use --bare (it skips plugin hooks)');
  assert.equal(runner(['--dry-run']).stdout, r.stdout, 'output must be deterministic');
  const one = runner(['--dry-run', '--case', 't04-chain-hops', '--runs', '5', '--max-cost-usd', '3.5', '--model', 'm-1']);
  assert.match(one.stdout, /--case t04-chain-hops/);
  assert.match(one.stdout, /--runs 5 -j 3 --threshold 0.8 --max-cost-usd 3.5 /);
  assert.equal((one.stdout.match(/claude -p /g) || []).length, 2);
});

test('--run without --max-cost-usd, a bad budget, or no mode never reaches claude', () => {
  const bad = [['--run'], ['--run', '--max-cost-usd', '0'], ['--run', '--max-cost-usd', 'abc'], ['--run', '--max-cost-usd', '1e3'], ['--run', '--max-cost-usd', '-5'], ['--run', '--max-cost-usd', 'NaN'], ['--run', '--max-cost-usd', 'Infinity'], ['--run', '--max-cost-usd', '999999999'], ['--run', '--max-cost-usd', ' 5'], ['--run', '--dry-run', '--max-cost-usd', '5'], ['--emit-native', '--max-cost-usd', '5'], ['--run', '--max-cost-usd'], ['--max-cost-usd', '5']];
  for (const a of bad) {
    unmark();
    const r = runner(a);
    assert.equal(r.status, 2, `${a.join(' ')} should exit 2, got ${r.status}`);
    assert.match(r.stderr, /^error: /);
    assert.ok(!marked(), `${a.join(' ')} reached claude`);
  }
  unmark();
  const none = runner([]);
  assert.equal(none.status, 0);
  assert.match(none.stdout, /NEVER makes a paid model call by default/);
  assert.ok(!marked());
});

test('runner failure messages are fixed and never echo the offending value', () => {
  const evil = 'x\u001b[31m<script>\nforged: line';
  for (const a of [['--dry-run', '--case', evil], ['--dry-run', '--kind', evil], ['--dry-run', '--runs', evil], ['--dry-run', '--model', evil], ['--dry-run', evil], [evil], ['--dry-run', '--case', 'no-such-case']]) {
    const r = runner(a);
    assert.equal(r.status, 2);
    assert.ok(!r.stderr.includes('forged') && !r.stderr.includes('<script>') && !r.stderr.includes('\u001b'), a.join(' '));
    assert.equal(r.stderr.trim().split('\n').length, 1);
  }
  for (const n of ['0', '51', '1.5', '', '1e2', '٣']) assert.throws(() => strictNumber(n, { min: 1, max: 50, int: true, what: '--runs' }), /--runs/, JSON.stringify(n));
  assert.equal(strictNumber('50', { min: 1, max: 50, int: true, what: 'x' }), 50);
  assert.throws(() => parseArgs(['--__proto__', 'x']), /unknown option/);
  assert.deepEqual(parseArgs(['--run', '--max-cost-usd', '5']), { run: true, 'max-cost-usd': '5' });
  assert.equal(sq("a'b"), `'a'\\''b'`);
});

test('--run with both flags emits the native cases and calls claude plugin eval with the cap (claude is a fake)', () => {
  unmark();
  const r = runner(['--run', '--max-cost-usd', '7.5', '--case', 't01-owner-sprint', '--runs', '2']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(marked(), 'claude was not called');
  const argv = fs.readFileSync(path.join(tmp, 'mark'), 'utf8').split('\n');
  assert.deepEqual(argv.slice(0, 6), ['plugin', 'eval', '.', '--scaffold', '--trust-plugin', '--no-publish']);
  assert.equal(argv[argv.indexOf('--max-cost-usd') + 1], '7.5');
  assert.equal(argv[argv.indexOf('--runs') + 1], '2');
  assert.equal(argv[argv.indexOf('--case') + 1], 't01-owner-sprint');
  assert.ok(fs.existsSync(path.join(sandbox, 'evals/t01-owner-sprint/prompt.md')));
  unmark();
  const missing = runner(['--run', '--max-cost-usd', '5', '--case', 't01-owner-sprint'], { env: { PATH: path.dirname(process.execPath) } });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /claude is not installed/);
});

test('--emit-native writes one prompt.md, case.yaml, scaffold.sh and a grader file per grader for each case', () => {
  assert.equal(runner(['--emit-native']).status, 0);
  for (const c of cases) {
    const d = path.join(sandbox, 'evals', c.id);
    const prompt = fs.readFileSync(path.join(d, 'prompt.md'), 'utf8');
    assert.ok(prompt.startsWith(`---\nname: ${c.id}\n`));
    assert.ok(prompt.endsWith(`---\n\n${c.prompt}\n`));
    assert.match(fs.readFileSync(path.join(d, 'case.yaml'), 'utf8'), /scaffold_script: scaffold\.sh/);
    assert.ok(fs.statSync(path.join(d, 'scaffold.sh')).mode & 0o100, 'scaffold.sh is executable');
    assert.deepEqual(fs.readdirSync(path.join(d, 'graders')).sort(), c.graders.map((g) => `${g.id}.md`).sort());
  }
  const g = fs.readFileSync(path.join(sandbox, 'evals/t01-owner-sprint/graders/ans-owner.md'), 'utf8');
  const pat = /pattern: '(.*)'\n/.exec(g)[1].replace(/''/g, "'");
  assert.equal(pat, byId('t01-owner-sprint').graders.find((x) => x.id === 'ans-owner').pattern, 'YAML quoting round-trips the regex');
});

test('loadCases refuses a case file that does not validate', () => {
  const d = path.join(tmp, 'badcases'); fs.mkdirSync(d);
  const c = structuredClone(byId('t01-owner-sprint')); c.prompt = 'no machine line demanded here at all';
  fs.writeFileSync(path.join(d, `${c.id}.json`), JSON.stringify(c));
  assert.throws(() => loadCases(d), /invalid/);
  fs.writeFileSync(path.join(d, `${c.id}.json`), '{not json');
  assert.throws(() => loadCases(d), /unreadable/);
});

// ------------------------------------------------------------------ the default publishes prompts and transcripts to claude.ai: never allow it
test('every claude plugin eval command the runner prints or executes carries --no-publish', () => {
  const r = runner(['--dry-run']);
  const ev = r.stdout.split('\n').filter((l) => !l.startsWith('#') && l.includes('claude plugin eval'));
  assert.ok(ev.length >= 1);
  for (const l of ev) assert.match(l, / --no-publish( |$)/);
  unmark();
  assert.equal(runner(['--run', '--max-cost-usd', '5', '--case', 't01-owner-sprint']).status, 0);
  const argv = fs.readFileSync(path.join(tmp, 'mark'), 'utf8').split('\n');
  assert.ok(argv.includes('--no-publish'), 'the executed command would publish the report');
  unmark();
});

test('--max-cost-usd accepts 1000 and rejects anything above it', () => {
  assert.equal(runner(['--dry-run', '--max-cost-usd', '1000']).status, 0);
  assert.equal(runner(['--dry-run', '--max-cost-usd', '1000.01']).status, 2);
  assert.equal(runner(['--dry-run', '--max-cost-usd', '0.01']).status, 0);
  assert.equal(runner(['--dry-run', '--max-cost-usd', '0.00']).status, 2);
});

test('a trigger case must name one of the six router jobs and carry only {trigger, job}', () => {
  const c = structuredClone(byId('trig-reassigning-yes'));
  assert.deepEqual(validateCase(c), []);
  c.expected.job = 'cooking';
  assert.ok(validateCase(c).some((m) => /trigger case needs expected/.test(m)));
});
