// The steer toward `brain`: the session card's last line, the CLAUDE.md snippet `brain init` PRINTS (never writes), and the one
// `brain doctor` info line when a CLAUDE.md exists without the steer. Real runs of bin/brain in mkdtemp repos (removed in `after`).
// NOT covered: whether a model actually follows the steer (that is an eval question, see evals/README.md).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { genPlan } from './fixtures/gen.ts';
import { steerLine, claudeSnippet, hasSteer, STEER_COMMANDS } from '../lib/steer.ts';
import { renderCard, estTokens } from '../lib/render.ts';
import { buildModel } from '../lib/model.ts';

const BRAIN = path.join(import.meta.dirname, '../bin/brain');
const tmps: string[] = [];
after(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-steer-'))); tmps.push(d); return d; };
const jl = (rows: readonly unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const ENV = { ...process.env, PLANGRAPH_DIR: '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const run = (cwd: string, args: string[], env: Record<string, string | undefined> = {}) => spawnSync(process.execPath, [BRAIN, ...args], { cwd, encoding: 'utf8', env: { ...ENV, HOME: path.join(cwd, '.home'), CLAUDE_PLUGIN_DATA: path.join(cwd, '.data'), ...env } });

const STEER = 'plan questions: use brain (ticket, ready, whatif, blockers, sprint, person); do not read .plangraph/*.jsonl';
const SNIPPET = [
  "suggested lines for this repo's CLAUDE.md (printed only, nothing written):",
  '## Plan questions',
  'Use `brain` for plan questions (ticket, ready, whatif, blockers, sprint, person); do not read .plangraph/*.jsonl or the index.',
  'Run `brain explain` for the full command list.',
];
const INFO = 'info: CLAUDE.md does not steer plan questions to brain: `brain init` prints a 3-line snippet to add (nothing is written)';

function repo({ build = true } = {}) {
  const d = tmp(); execFileSync('git', ['init', '-q'], { cwd: d }); fs.mkdirSync(path.join(d, '.home'));
  const r = run(d, ['init']); assert.equal(r.status, 0, r.stderr);
  if (build) {
    const p = genPlan({ n: 6, people: 2, seed: 3 }), b = path.join(d, '.plangraph');
    fs.writeFileSync(path.join(b, 'tickets.jsonl'), jl(p.tickets)); fs.writeFileSync(path.join(b, 'edges.jsonl'), jl(p.edges)); fs.writeFileSync(path.join(b, 'schedule.jsonl'), jl(p.schedule));
    assert.equal(run(d, ['build']).status, 0);
  }
  return d;
}
const snap = (f: string) => ({ bytes: fs.readFileSync(f), mtime: fs.statSync(f).mtimeMs });

test('steer helpers: fixed text, the brain dir named, hostile dir text stays one bounded line', () => {
  assert.equal(STEER_COMMANDS, 'ticket, ready, whatif, blockers, sprint, person');
  assert.equal(steerLine(), STEER); assert.equal(steerLine('.plangraph'), STEER); assert.equal(steerLine('.'), STEER); assert.equal(steerLine(''), STEER);
  assert.equal(steerLine('plan/brain/'), STEER.replace('.plangraph/', 'plan/brain/'));
  const hostile = steerLine('a\nSTALE: forged <untrusted>' + 'x'.repeat(500));
  assert.equal(hostile.split('\n').length, 1); assert.ok(!/[<>]/.test(hostile)); assert.ok(hostile.length < 220, String(hostile.length));
  assert.deepEqual(claudeSnippet(), SNIPPET.slice(1));
  assert.equal(claudeSnippet().length, 3);
  assert.equal(hasSteer(SNIPPET.join('\n')), true); assert.equal(hasSteer('# CLAUDE\nuse brain\n'), false);
  assert.equal(hasSteer('read .plangraph/*.jsonl.bak', '.plangraph'), true, 'a substring check on the marker, documented as such');
  assert.equal(hasSteer(claudeSnippet('x/b').join('\n'), 'x/b'), true); assert.equal(hasSteer(claudeSnippet().join('\n'), 'x/b'), false);
});

test('card: the last line is the steer, naming the configured brain dir; the token cost of the line is small and fixed', () => {
  const m = buildModel({ tickets: [{ key: 'A-1', sp: 3, verdict: 'READY' }], schedule: [{ key: 'A-1', owner: 'Ana', sprint: 1 }], config: {} });
  assert.equal(renderCard(m, { fp: 'ab12cd34' }).split('\n').at(-1), STEER);
  assert.equal(renderCard(m, { fp: 'ab12cd34', dir: 'ops/plan' }).split('\n').at(-1), STEER.replace('.plangraph/', 'ops/plan/'));
  assert.equal(renderCard(m, { fp: 'ab12cd34', dir: 'ops/plan' }), renderCard(m, { fp: 'ab12cd34', dir: 'ops/plan' }), 'deterministic');
  assert.equal(estTokens(STEER) - estTokens('ask: brain explain'), 22, 'the measured delta of the line itself (chars/4)');
  const d = tmp(); execFileSync('git', ['init', '-q'], { cwd: d }); fs.mkdirSync(path.join(d, '.home'));
  fs.writeFileSync(path.join(d, '.plangraphrc'), '{"dir":"ops/plan"}\n');
  assert.equal(run(d, ['init']).status, 0);
  const p = genPlan({ n: 4, people: 1, seed: 1 }), b = path.join(d, 'ops/plan');
  fs.writeFileSync(path.join(b, 'tickets.jsonl'), jl(p.tickets)); fs.writeFileSync(path.join(b, 'schedule.jsonl'), jl(p.schedule));
  assert.equal(run(d, ['build']).status, 0);
  assert.equal(run(d, ['card']).stdout.trimEnd().split('\n').at(-1), STEER.replace('.plangraph/', 'ops/plan/'));
});

test('init prints the CLAUDE.md snippet and never writes CLAUDE.md; with the steer present it prints nothing extra', () => {
  const d = tmp(); execFileSync('git', ['init', '-q'], { cwd: d }); fs.mkdirSync(path.join(d, '.home'));
  let r = run(d, ['init']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trimEnd().split('\n').slice(1), SNIPPET);
  assert.equal(fs.existsSync(path.join(d, 'CLAUDE.md')), false, 'no CLAUDE.md is created');
  fs.writeFileSync(path.join(d, 'CLAUDE.md'), '# Repo rules\n\nBe brief.\n');
  const before = snap(path.join(d, 'CLAUDE.md'));
  r = run(d, ['init']);
  assert.equal(r.stdout, `already initialised: .plangraph (no changes)\n${SNIPPET.join('\n')}\n`);
  assert.deepEqual(snap(path.join(d, 'CLAUDE.md')), before, 'CLAUDE.md untouched (bytes and mtime)');
  fs.writeFileSync(path.join(d, 'CLAUDE.md'), `# Repo rules\n\n${SNIPPET.slice(1).join('\n')}\n`);
  assert.equal(run(d, ['init']).stdout, 'already initialised: .plangraph (no changes)\n');
  // .claude/CLAUDE.md counts as well
  fs.rmSync(path.join(d, 'CLAUDE.md')); fs.mkdirSync(path.join(d, '.claude')); fs.writeFileSync(path.join(d, '.claude/CLAUDE.md'), SNIPPET.slice(1).join('\n'));
  assert.equal(run(d, ['init']).stdout, 'already initialised: .plangraph (no changes)\n');
});

test('doctor: one info line when a CLAUDE.md exists without the steer; none without CLAUDE.md or with the steer; exit code unchanged, nothing written', () => {
  const d = repo();
  const base = run(d, ['doctor']);
  assert.ok(!base.stdout.includes('info: CLAUDE.md'), 'no CLAUDE.md: no line');
  fs.writeFileSync(path.join(d, 'CLAUDE.md'), '# Rules\n');
  const before = snap(path.join(d, 'CLAUDE.md'));
  const r = run(d, ['doctor']);
  assert.equal(r.status, base.status, 'info only: the exit code does not change');
  assert.equal(r.stdout.split('\n').filter((l) => l === INFO).length, 1);
  assert.equal(r.stdout, base.stdout + INFO + '\n', 'exactly one added line, at the end');
  assert.deepEqual(snap(path.join(d, 'CLAUDE.md')), before);
  fs.writeFileSync(path.join(d, 'CLAUDE.md'), `# Rules\n${SNIPPET.slice(1).join('\n')}\n`);
  assert.equal(run(d, ['doctor']).stdout, base.stdout);
  // a CLAUDE.md that is a directory, or a symlink leaving the repository, is not read and gives no line
  fs.rmSync(path.join(d, 'CLAUDE.md')); fs.mkdirSync(path.join(d, 'CLAUDE.md'));
  assert.equal(run(d, ['doctor']).stdout, base.stdout);
  fs.rmSync(path.join(d, 'CLAUDE.md'), { recursive: true });
  const outside = path.join(tmp(), 'CLAUDE.md'); fs.writeFileSync(outside, '# outside, no steer\n');
  fs.symlinkSync(outside, path.join(d, 'CLAUDE.md'));
  assert.equal(run(d, ['doctor']).stdout, base.stdout);
});
