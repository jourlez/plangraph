// The SessionStart hook, run exactly as hooks/hooks.json declares it: parsed from the JSON, spawned (no shell) with `command` and
// `args`, ${CLAUDE_PLUGIN_ROOT} substituted. PATH holds only node and git (so `uv` is absent). Real git, temp repos and data dirs.
// No wall-clock limit lives here (Task 21A: the old p95 and median gates are retired); the hook's cost is checked by the work-count test
// below (size axis, no clock).
import baseTest, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { workScaling } from './helpers/perf.ts';
import { genPlan } from './fixtures/gen.ts';
import { main } from '../src/cli.ts';
import { adoptOldLayout } from '../lib/store2/adopt.ts';

const test = (name: string, fn: () => void | Promise<void>) => baseTest(name, { skip: process.platform === 'win32' }, fn);
const PLUGIN = path.resolve(import.meta.dirname, '..');
const made: string[] = [];
const tmp = (p: string) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p))); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

const which = (name: string) => { const r = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }); return r.stdout.trim(); };
const binDir = tmp('hk-bin-');
fs.symlinkSync(process.execPath, path.join(binDir, 'node'));
fs.symlinkSync(which('git'), path.join(binDir, 'git'));
const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV }, stdio: ['ignore', 'pipe', 'pipe'] });

const hook = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'hooks/hooks.json'), 'utf8')).hooks.SessionStart[0].hooks[0];
const sub = (a: string) => a.replace('${CLAUDE_PLUGIN_ROOT}', PLUGIN);
function world() {
  const dataDir = tmp('hk-data-'), home = tmp('hk-home-'), repo = tmp('hk-repo-');
  git(repo, 'init', '-q', '-b', 'main');
  const env = { PATH: binDir, HOME: home, CLAUDE_PLUGIN_DATA: dataDir, PLANGRAPH_CARD: 'auto', ...GIT_ENV };
  const run = (e = env) => spawnSync(hook.command, hook.args.map(sub), { cwd: repo, env: e, encoding: 'utf8' });
  const plangraph = (args: string[]) => spawnSync(process.execPath, [path.join(PLUGIN, 'bin/plangraph'), ...args], { cwd: repo, env: { ...process.env, ...env, PATH: `${binDir}:${path.dirname(process.execPath)}` }, encoding: 'utf8' });
  return { dataDir, repo, env, run, plangraph };
}
const ok = (r: SpawnSyncReturns<string>) => { assert.equal(r.status, 0, `status ${r.status}\n${r.stdout}\n${r.stderr}`); assert.equal(r.stderr, ''); return r; };

test('the declared hook is exec form node with the stable event, matcher and timeout', () => {
  const entry = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'hooks/hooks.json'), 'utf8')).hooks.SessionStart[0];
  assert.equal(entry.matcher, 'startup|resume|clear|compact|fork');
  assert.equal(hook.command, 'node'); assert.equal(hook.timeout, 10);
  assert.deepEqual(hook.args, ['${CLAUDE_PLUGIN_ROOT}/src/entry.js', 'card', '--if-present', '--refresh']);
});

test('hooks.json declares exactly SessionStart and UserPromptSubmit; UserPromptSubmit runs hook-prompt in exec form with timeout 5 and no matcher', () => {
  const all = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'hooks/hooks.json'), 'utf8')).hooks;
  assert.deepEqual(Object.keys(all).sort(), ['SessionStart', 'UserPromptSubmit']);
  assert.equal(all.UserPromptSubmit.length, 1);
  const entry = all.UserPromptSubmit[0]; // UserPromptSubmit takes no matcher (hooks reference)
  assert.equal('matcher' in entry, false);
  assert.deepEqual(entry.hooks, [{ type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/src/entry.js', 'hook-prompt'], timeout: 5 }]);
});

test('the UserPromptSubmit hook, run as declared, is silent with exit 0 when there is no plan directory (and in any directory)', () => {
  const w = world(); const p = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'hooks/hooks.json'), 'utf8')).hooks.UserPromptSubmit[0].hooks[0];
  const r = spawnSync(p.command, p.args.map(sub), { cwd: w.repo, env: w.env, input: JSON.stringify({ session_id: 's', prompt: 'look at ABC-1' }), encoding: 'utf8' });
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', '']);
  assert.deepEqual(fs.readdirSync(w.repo), ['.git']);
});

test('no plangraph: exit 0, stdout and stderr empty, and nothing is created (uv is not on PATH)', () => {
  const w = world(); assert.equal((spawnSync('uv', ['--version'], { env: w.env }).error as NodeJS.ErrnoException | undefined)?.code, 'ENOENT'); // fs and the readers throw errno-style errors with a code
  const r = ok(w.run()); assert.equal(r.stdout, '');
  assert.deepEqual(fs.readdirSync(w.repo), ['.git']);
  assert.deepEqual(fs.readdirSync(w.dataDir).filter((f) => f !== 'compile-cache'), [], 'only bin/plangraph\'s private compile cache (bin/plangraph) may appear');
});

test('outside any git repo: exit 0 and silent', () => {
  const w = world(); const dir = tmp('hk-plain-');
  const r = spawnSync(hook.command, hook.args.map(sub), { cwd: dir, env: w.env, encoding: 'utf8' });
  assert.equal(r.status, 0); assert.equal(r.stdout + r.stderr, '');
});

test('with a plangraph: stdout starts with the card, exit 0, stderr empty', () => {
  const w = world(); ok(w.plangraph(['init'])); ok(w.plangraph(['build']));
  const plain = ok(w.plangraph(['card', '--if-present']));
  const r = ok(w.run());
  assert.ok(r.stdout.length > 0); assert.equal(r.stdout, plain.stdout);
});

test('a plan dir with a corrupt index still exits 0 and prints nothing to stderr', () => {
  const w = world(); ok(w.plangraph(['init'])); ok(w.plangraph(['build']));
  fs.writeFileSync(path.join(w.repo, '.plangraph', 'plangraph.sqlite'), 'not a database'); // the index file (src/db.ts INDEX_FILE)
  const r = w.run(); assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', '']);
  assert.equal(w.plangraph(['card']).status, 2, 'a manual card reports the corrupt index');
});

// Every failure before or inside the command (a bad .plangraphrc, a refused plan dir from PLANGRAPH_DIR or .plangraphrc, an unknown option) is
// thrown and caught in src/cli.ts main(): the hook form returns 0 with no output from that catch; the manual form reports it.
test('the real hook command stays silent with exit 0 on a bad .plangraphrc, PLANGRAPH_DIR=/etc, PLANGRAPH_DIR=../x and a .plangraphrc escaping the repo', () => {
  const w = world(); ok(w.plangraph(['init'])); ok(w.plangraph(['build']));
  const rc = path.join(w.repo, '.plangraphrc');
  const cases = ([
    ['bad .plangraphrc', {}, '{bad json'], ['.plangraphrc dir array', {}, '{"dir": [1]}'], ['.plangraphrc escaping', {}, '{"dir": "../x"}'],
    ['PLANGRAPH_DIR=/etc', { PLANGRAPH_DIR: '/etc' }, null], ['PLANGRAPH_DIR=../x', { PLANGRAPH_DIR: '../x' }, null], ['PLANGRAPH_DIR with a space', { PLANGRAPH_DIR: 'a b' }, null],
  ] as Array<[string, Record<string, string>, string | null]>); // a literal list of these tuples
  for (const [what, extra, text] of cases) {
    if (text === null) fs.rmSync(rc, { force: true }); else fs.writeFileSync(rc, text);
    const r = w.run({ ...w.env, ...extra });
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', ''], what);
    const m = spawnSync(process.execPath, [path.join(PLUGIN, 'bin/plangraph'), 'card'], { cwd: w.repo, env: { ...w.env, ...extra }, encoding: 'utf8' });
    assert.ok(m.status === 2 || m.status === 4, `${what}: the manual card reports it (exit ${m.status})`);
    assert.match(m.stderr, /^error: /, what);
  }
  fs.rmSync(rc, { force: true });
  const u = spawnSync(hook.command, [...hook.args.map(sub), '--no-such-option'], { cwd: w.repo, env: w.env, encoding: 'utf8' });
  assert.deepEqual([u.status, u.stdout, u.stderr], [0, '', ''], 'an unknown option in hook form');
});

test('card off never silences a manual card: CLAUDE_PLUGIN_OPTION_CARD=off or PLANGRAPH_CARD=off with `plangraph card` still prints it', () => {
  const w = world(); ok(w.plangraph(['init'])); ok(w.plangraph(['build']));
  const plain = ok(w.plangraph(['card'])).stdout;
  assert.match(plain, /^plangraph [0-9a-f]{8} \| /);
  for (const key of ['CLAUDE_PLUGIN_OPTION_CARD', 'PLANGRAPH_CARD']) {
    const m = spawnSync(process.execPath, [path.join(PLUGIN, 'bin/plangraph'), 'card'], { cwd: w.repo, env: { ...w.env, [key]: 'off' }, encoding: 'utf8' });
    assert.deepEqual([m.status, m.stdout, m.stderr], [0, plain, ''], key);
    assert.equal(ok(w.run({ ...w.env, PLANGRAPH_CARD: '', [key]: 'OFF ' })).stdout, '', `${key}: case and spaces do not matter for the hook`);
  }
});

// plugin.json userConfig.card is what Claude Code exports as CLAUDE_PLUGIN_OPTION_CARD: a string with the options the hook understands
// ("off" silences it, anything else prints) and the default that keeps the card on.
test('plugin.json userConfig.card: string, options auto and off, default off (opt-in; auto turns the card on)', () => {
  const pj = JSON.parse(fs.readFileSync(path.join(PLUGIN, '.claude-plugin/plugin.json'), 'utf8'));
  const c = pj.userConfig?.card;
  assert.equal(c?.type, 'string');
  assert.deepEqual(c.options, ['auto', 'off']);
  assert.equal(c.default, 'off');
  assert.ok(c.options.includes(c.default));
  assert.ok(typeof c.title === 'string' && c.title && typeof c.description === 'string' && /auto/.test(c.description) && /off/.test(c.description));
  assert.deepEqual(Object.keys(pj.userConfig), ['card', 'mcp', 'prompt_hook'], 'no other option: card and prompt_hook are read by the hooks, mcp by the MCP server (docs/MCP.md)');
  const m = pj.userConfig.mcp;
  assert.equal(m?.type, 'string'); assert.deepEqual(m.options, ['on', 'off']); assert.equal(m.default, 'off');
  const ph = pj.userConfig.prompt_hook;
  assert.equal(ph?.type, 'string'); assert.deepEqual(ph.options, ['on', 'off']); assert.equal(ph.default, 'off');
});

test('running the hook writes nothing: no git config, no .gitattributes, no plan file, and a second run prints the same card', () => {
  const w = world(); ok(w.plangraph(['init'])); ok(w.plangraph(['build']));
  const cfg = fs.readFileSync(path.join(w.repo, '.git/config'), 'utf8');
  const first = ok(w.run()).stdout; assert.ok(first.length > 0);
  assert.equal(ok(w.run()).stdout, first);
  assert.equal(fs.readFileSync(path.join(w.repo, '.git/config'), 'utf8'), cfg); assert.equal(fs.existsSync(path.join(w.repo, '.gitattributes')), false);
});

test('card is off: CLAUDE_PLUGIN_OPTION_CARD=off and PLANGRAPH_CARD=off silence the hook only', () => {
  const w = world(); ok(w.plangraph(['init'])); ok(w.plangraph(['build']));
  for (const key of ['CLAUDE_PLUGIN_OPTION_CARD', 'PLANGRAPH_CARD']) {
    const r = ok(w.run({ ...w.env, PLANGRAPH_CARD: '', [key]: 'off' })); assert.equal(r.stdout, '');
    assert.ok(ok(w.run({ ...w.env, PLANGRAPH_CARD: '', [key]: 'auto' })).stdout.length > 0);
  }
  assert.ok(ok(w.run({ ...w.env, PLANGRAPH_CARD: 'on' })).stdout.length > 0, 'on is accepted too');
  assert.ok(ok(w.plangraph(['card'])).stdout.length > 0); // a manual card is unaffected
});

// Size axis: the hook path (card --if-present --refresh: index open with its source fingerprint, the store scan, model, card) on a plan of n and
// 4n tickets, run in process (no node start-up in the numbers), min of 3 each: linear gives about 2.5-4x (a constant git check is part of
// it), quadratic about 16x. Proved by a deliberately quadratic verdict count in lib/render.ts renderCard, which scripts/mutate.ts keeps
// applying (ratio about 26 there).
test('timing: the hook path scales linearly with the plan size (n vs 4n tickets, in process, min of 3)', async () => {
  const jl = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const planned = (n: number) => {
    const w = world(); ok(w.plangraph(['init']));
    const p = genPlan({ n, people: 5, seed: 3 });
    for (const [f, rows] of ([['tickets', p.tickets], ['edges', p.edges], ['schedule', p.schedule]] as Array<[string, object[]]>)) fs.writeFileSync(path.join(w.repo, '.plangraph', `${f}.jsonl`), jl(rows)); // a literal list of these tuples
    adoptOldLayout(path.join(w.repo, '.plangraph'));
    ok(w.plangraph(['build']));
    return w;
  };
  const once = async (w: ReturnType<typeof world>) => {
    const out = ([] as string[]), t = performance.now(); // an empty list of this element type
    const code = await main(['card', '--if-present', '--refresh'], { env: { ...w.env, PLANGRAPH_DIR: '' }, cwd: w.repo, io: { out: (l) => out.push(l), err: (l) => out.push(`stderr: ${l}`) } });
    const ms = performance.now() - t;
    assert.equal(code, 0); assert.match(out[0] ?? '', /^plangraph [0-9a-f]{8} \| \d+ tickets/);
    return ms;
  };
  const min3 = async (w: ReturnType<typeof world>) => { let best = Infinity; for (let k = 0; k < 3; k++) best = Math.min(best, await once(w)); return best; };
  const n = 500, small = planned(n), large = planned(4 * n);
  await once(small); await once(large); // warm-up: module loads, file cache
  const a = await min3(small), b = await min3(large), ratio = b / Math.max(a, 0.05);
  console.log(`# hook path ms: ${a.toFixed(1)} at ${n} tickets, ${b.toFixed(1)} at ${4 * n} (ratio ${ratio.toFixed(1)})`);
  assert.ok(ratio < 9, `hook path scaling ratio ${ratio.toFixed(1)} (${a.toFixed(1)} ms at ${n} tickets, ${b.toFixed(1)} ms at ${4 * n}; linear ~4, quadratic ~16)`);
});

// The same size axis without a clock (test/helpers/perf.ts workScaling): the elements the Array and String built-ins touch on the hook
// path, n vs 4n tickets. Deterministic on every machine; the deliberately quadratic verdict count in lib/render.ts renderCard
// (scripts/mutate.ts) filters every ticket once per ticket, which this counts.
test('work: the hook path touches linearly many elements in the plan size (n vs 4n tickets, built-in work count, no clock)', async () => {
  const jl = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const worlds = new Map<number, ReturnType<typeof world>>();
  for (const m of [500, 2000]) {
    const w = world(); ok(w.plangraph(['init']));
    const p = genPlan({ n: m, people: 5, seed: 3 });
    for (const [f, rows] of ([['tickets', p.tickets], ['edges', p.edges], ['schedule', p.schedule]] as Array<[string, object[]]>)) fs.writeFileSync(path.join(w.repo, '.plangraph', `${f}.jsonl`), jl(rows)); // a literal list of these tuples
    adoptOldLayout(path.join(w.repo, '.plangraph'));
    ok(w.plangraph(['build']));
    worlds.set(m, w);
  }
  const once = async (m: number) => {
    const w = worlds.get(m) as ReturnType<typeof world>, out: string[] = []; // both sizes were built above
    const code = await main(['card', '--if-present', '--refresh'], { env: { ...w.env, PLANGRAPH_DIR: '' }, cwd: w.repo, io: { out: (l) => out.push(l), err: (l) => out.push(`stderr: ${l}`) } });
    assert.equal(code, 0); assert.match(out[0] ?? '', /^plangraph [0-9a-f]{8} \| \d+ tickets/);
  };
  const s = await workScaling(once, 500);
  console.log(`# hook path work: ${s.small} at 500 tickets, ${s.large} at 2000 (ratio ${s.ratio.toFixed(2)})`);
  assert.ok(s.ratio < s.maxRatio, `hook path work ratio ${s.ratio.toFixed(2)} (${s.small} at 500 tickets, ${s.large} at 2000; linear ~4, quadratic ~16)`);
});

test('prompt_hook is opt-in: the registered hook, run as declared with the option off or unset, is a silent fast exit 0 even in a repo with a plan; on, it answers', () => {
  const w = world(); ok(w.plangraph(['init'])); ok(w.plangraph(['build']));
  const p = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'hooks/hooks.json'), 'utf8')).hooks.UserPromptSubmit[0].hooks[0];
  const input = JSON.stringify({ session_id: 's', prompt: 'look at ABC-1 T-1' });
  const go = (extra: Record<string, string>) => { const t = performance.now(); const r = spawnSync(p.command, p.args.map(sub), { cwd: w.repo, env: { ...w.env, ...extra }, input, encoding: 'utf8' }); return { r, ms: performance.now() - t }; };
  for (const extra of [{}, { CLAUDE_PLUGIN_OPTION_PROMPT_HOOK: 'off' }, { PLANGRAPH_PROMPT_HOOK: 'off' }]) {
    const { r, ms } = go(extra); assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', ''], JSON.stringify(extra)); assert.ok(ms < 300, `${ms} ms`);
  }
  assert.equal(go({ CLAUDE_PLUGIN_OPTION_PROMPT_HOOK: 'on' }).r.status, 0);
});

test('card is opt-in: with the variable unset, empty or anything but auto/on, the registered hook is a silent fast exit 0 even with an index', () => {
  const w = world(); ok(w.plangraph(['init'])); ok(w.plangraph(['build']));
  const { PLANGRAPH_CARD: _c, ...rest } = w.env, unset = rest as typeof w.env;
  for (const e of [unset, { ...unset, PLANGRAPH_CARD: '' }, { ...unset, CLAUDE_PLUGIN_OPTION_CARD: 'yes' }, { ...unset, CLAUDE_PLUGIN_OPTION_CARD: 'off' }] as Array<typeof w.env>) {
    const t = performance.now(); const r = ok(w.run(e)); assert.equal(r.stdout, ''); assert.ok(performance.now() - t < 300, 'quick');
  }
  assert.ok(ok(w.run({ ...unset, CLAUDE_PLUGIN_OPTION_CARD: 'auto' } as typeof w.env)).stdout.length > 0);
});
