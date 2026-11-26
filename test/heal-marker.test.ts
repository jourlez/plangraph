// Heal consent (decision D3): the SessionStart hook (`card --if-present --heal`) repairs the merge driver only in a clone the user wired,
// recorded as plangraph.heal in the clone's own git config (lib/driver.ts). Real git, real clones and worktrees, temp data directories and a
// throwaway HOME. The hook is run exactly as hooks/hooks.json declares it. NOT covered: Windows (POSIX sh shim and modes).
import baseTest, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import type { TestContext } from 'node:test';
import * as D from '../lib/driver.ts';

const test = (name: string, fn: (t: TestContext) => void | Promise<void>) => baseTest(name, { skip: process.platform === 'win32' }, fn);
const PLUGIN = path.resolve(import.meta.dirname, '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'package.json'), 'utf8')).version as string;
const NUDGE = 'plangraph: merge driver not set up in this clone; merges of .plangraph/*.jsonl conflict until the user runs plangraph doctor --fix';
const made: string[] = [];
const tmp = (p = 'hm-') => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p))); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const BASE_ENV: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
delete BASE_ENV.CLAUDE_PLUGIN_DATA; delete BASE_ENV.CLAUDE_PLUGIN_OPTION_CARD; delete BASE_ENV.PLANGRAPH_CARD;
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', env: BASE_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
const localConfig = (repo: string) => git(repo, 'config', '--local', '--list');
const heal = (repo: string) => { try { return git(repo, 'config', '--local', '--get', 'plangraph.heal').trim(); } catch { return null; } };

// One world: a HOME, the hook's data dir, and an origin repository holding a committed plan directory (no .gitattributes, no wiring).
function world() {
  const home = tmp('hm-home-'), data = tmp('hm-data-'), origin = tmp('hm-origin-');
  git(origin, 'init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(origin, '.plangraph'));
  fs.writeFileSync(path.join(origin, '.plangraph/config.json'), '{}\n'); fs.writeFileSync(path.join(origin, '.plangraph/tickets.jsonl'), '');
  const commit = (m: string) => { git(origin, 'add', '-A'); git(origin, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', m); };
  commit('plan');
  const env = { ...BASE_ENV, HOME: home }, hookEnv = { ...env, CLAUDE_PLUGIN_DATA: data };
  const clone = (at = path.join(tmp('hm-clones-'), 'c')) => { git(path.dirname(at), 'clone', '-q', origin, at); return at; };
  const plangraph = (cwd: string, args: string[], e: NodeJS.ProcessEnv = env) => spawnSync(process.execPath, [path.join(PLUGIN, 'bin/plangraph'), ...args], { cwd, env: e, encoding: 'utf8' });
  // the SessionStart hook exactly as hooks/hooks.json declares it, in the hook's environment (CLAUDE_PLUGIN_DATA set)
  const hook = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'hooks/hooks.json'), 'utf8')).hooks.SessionStart[0].hooks[0];
  const runHookIn = (cwd: string, extra: NodeJS.ProcessEnv = {}) => {
    const r = spawnSync(hook.command, hook.args.map((a: string) => a.replace('${CLAUDE_PLUGIN_ROOT}', PLUGIN)), { cwd, env: { ...hookEnv, ...extra }, encoding: 'utf8' });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  return { home, data, origin, commit, clone, plangraph, runHookIn, env, hookEnv, shim: path.join(data, 'bin', 'plangraph-merge'), homeShim: path.join(home, '.cache', 'plangraph', 'bin', 'plangraph-merge') };
}
const lastLine = (s: string) => s.trimEnd().split('\n').at(-1);
const driverOf = (repo: string) => { try { return git(repo, 'config', '--local', '--get', 'merge.plangraph-jsonl.driver').trim(); } catch { return null; } };
// nothing written: no .gitattributes, no merge.plangraph-jsonl.* and no plangraph.heal in the local config, no shim in the hook's data dir
function assertUntouched(w: ReturnType<typeof world>, repo: string) {
  assert.equal(fs.existsSync(path.join(repo, '.gitattributes')), false);
  assert.doesNotMatch(localConfig(repo), /merge\.plangraph-jsonl\.|plangraph\.heal/);
  assert.equal(fs.existsSync(w.shim), false);
}

test('heal without consent writes nothing and prints the nudge as the last stdout line, again at the next session', () => {
  const w = world(), freshClone = w.clone();
  for (let i = 0; i < 2; i++) {
    const r = w.runHookIn(freshClone, { CLAUDE_PLUGIN_DATA: w.data });
    assert.equal(r.code, 0); assert.equal(r.stderr, '');
    assert.equal(r.stdout.trimEnd().split('\n').at(-1), NUDGE);
    assert.equal(fs.existsSync(path.join(freshClone, '.gitattributes')), false);
    assert.doesNotMatch(git(freshClone, 'config', '--local', '--list'), /merge\.plangraph-jsonl\.|plangraph\.heal/);
    assert.equal(fs.existsSync(w.shim), false);
  }
});
test('init records plangraph.heal in the local git config and heal repairs afterwards', () => {
  const w = world(), c = w.clone();
  assert.equal(w.plangraph(c, ['init'], w.hookEnv).status, 0);
  assert.equal(heal(c), VERSION);
  fs.rmSync(w.shim); git(c, 'config', '--unset', 'merge.plangraph-jsonl.driver');
  const r = w.runHookIn(c); assert.equal(r.code, 0); assert.doesNotMatch(r.stdout, /merge driver not set up/);
  assert.equal(driverOf(c), `${w.shim} %O %A %B %P`); assert.ok(fs.existsSync(w.shim));
});
test('doctor --fix records plangraph.heal (a fresh clone: wiring, then consent)', () => {
  const w = world(), c = w.clone();
  w.plangraph(c, ['doctor', '--fix'], w.hookEnv);
  assert.equal(heal(c), VERSION); assert.equal(driverOf(c), `${w.shim} %O %A %B %P`);
  fs.rmSync(w.shim);
  const r = w.runHookIn(c); assert.equal(r.code, 0); assert.doesNotMatch(r.stdout, /merge driver not set up/); assert.ok(fs.existsSync(w.shim));
});
test('doctor --fix on a healthy, already-wired clone with plangraph.heal unset records the version', () => {
  const w = world(), c = w.clone();
  assert.equal(w.plangraph(c, ['init'], w.hookEnv).status, 0); git(c, 'config', '--unset', 'plangraph.heal');
  assert.match(w.plangraph(c, ['doctor'], w.hookEnv).stdout, /^merge driver: ok$/m); assert.equal(heal(c), null); // doctor alone writes nothing
  const r = w.plangraph(c, ['doctor', '--fix'], w.hookEnv); assert.match(r.stdout, /^merge driver: ok$/m); assert.doesNotMatch(r.stdout, /consent to heal not recorded/);
  assert.equal(heal(c), VERSION);
});
test('init run without CLAUDE_PLUGIN_DATA, hook run with it: the hook heals', () => {
  const w = world(), c = w.clone();
  assert.equal(w.plangraph(c, ['init'], w.env).status, 0); // a terminal: the data dir is ~/.cache/plangraph
  assert.equal(driverOf(c), `${w.homeShim} %O %A %B %P`); assert.equal(heal(c), VERSION);
  fs.rmSync(w.homeShim); // broken: the hook (another data dir) must see the consent and repair
  const r = w.runHookIn(c); assert.equal(r.code, 0); assert.doesNotMatch(r.stdout, /merge driver not set up/);
  assert.equal(driverOf(c), `${w.shim} %O %A %B %P`); assert.ok(fs.existsSync(w.shim));
});
test('a clone wired before 0.3.0 is grandfathered: heal records plangraph.heal and repairs', () => {
  const w = world(), c = w.clone();
  assert.equal(w.plangraph(c, ['init'], w.hookEnv).status, 0); git(c, 'config', '--unset', 'plangraph.heal'); // what an older plangraph left
  fs.rmSync(w.shim);
  const r = w.runHookIn(c); assert.equal(r.code, 0); assert.doesNotMatch(r.stdout, /merge driver not set up/);
  assert.equal(heal(c), VERSION); assert.ok(fs.existsSync(w.shim));
});
test('a second worktree shares the consent through the git common directory', () => {
  const w = world(), c = w.clone();
  assert.equal(w.plangraph(c, ['init'], w.hookEnv).status, 0);
  const wt = path.join(tmp('hm-wt-'), 'second'); git(c, 'worktree', 'add', '-q', wt);
  assert.equal(fs.existsSync(path.join(wt, '.gitattributes')), false); // not committed: this worktree is not wired yet
  assert.equal(heal(wt), VERSION);
  const r = w.runHookIn(wt); assert.equal(r.code, 0); assert.doesNotMatch(r.stdout, /merge driver not set up/);
  assert.match(fs.readFileSync(path.join(wt, '.gitattributes'), 'utf8'), /^\.plangraph\/\*\.jsonl merge=plangraph-jsonl$/m);
  assert.equal(D.gitCommonDir(wt), D.gitCommonDir(c));
});
test('card: off still silences the nudge', () => {
  const w = world(), c = w.clone();
  for (const extra of [{ CLAUDE_PLUGIN_OPTION_CARD: 'off' }, { PLANGRAPH_CARD: 'off' }]) {
    const r = w.runHookIn(c, extra); assert.equal(r.code, 0); assert.equal(r.stdout + r.stderr, '');
  }
  assertUntouched(w, c);
});
test('a moved clone keeps its consent and heals', () => {
  const w = world(), c = w.clone();
  assert.equal(w.plangraph(c, ['init'], w.hookEnv).status, 0);
  const moved = path.join(tmp('hm-moved-'), 'elsewhere'); fs.renameSync(c, moved); fs.rmSync(w.shim);
  const r = w.runHookIn(moved); assert.equal(r.code, 0); assert.doesNotMatch(r.stdout, /merge driver not set up/);
  assert.equal(heal(moved), VERSION); assert.ok(fs.existsSync(w.shim));
});
test('a new repository cloned at the path of a consented clone that was deleted gets the nudge, not a heal', () => {
  const w = world(), c = w.clone();
  assert.equal(w.plangraph(c, ['init'], w.hookEnv).status, 0);
  fs.rmSync(c, { recursive: true }); fs.rmSync(w.data, { recursive: true }); fs.mkdirSync(w.data, { mode: 0o700 });
  w.clone(c);
  const r = w.runHookIn(c); assert.equal(r.code, 0); assert.equal(lastLine(r.stdout), NUDGE);
  assertUntouched(w, c);
});
test('a committed plan directory cannot grant consent (no tracked file sets plangraph.heal)', () => {
  const w = world();
  const cfg = `[plangraph]\n\theal = ${VERSION}\n[merge "plangraph-jsonl"]\n\tdriver = /bin/false %O %A %B %P\n`;
  for (const f of ['.gitconfig', 'config', '.plangraph/config', '.plangraph/.gitconfig']) fs.writeFileSync(path.join(w.origin, f), cfg);
  fs.writeFileSync(path.join(w.origin, '.plangraphrc'), `{"heal": "${VERSION}"}\n`);
  w.commit('try to plant consent');
  const c = w.clone();
  const r = w.runHookIn(c); assert.equal(r.code, 0); assert.equal(lastLine(r.stdout), NUDGE);
  assertUntouched(w, c);
});
test('plangraph.heal=false (and off) is not consent: nudge printed, nothing written', () => {
  for (const v of ['false', 'off', 'yes', 'v0.3.0']) {
    const w = world(), c = w.clone(); git(c, 'config', 'plangraph.heal', v);
    const r = w.runHookIn(c); assert.equal(r.code, 0); assert.equal(lastLine(r.stdout), NUDGE, v);
    assert.equal(heal(c), v); assert.equal(fs.existsSync(path.join(c, '.gitattributes')), false);
    assert.doesNotMatch(localConfig(c), /merge\.plangraph-jsonl\./); assert.equal(fs.existsSync(w.shim), false);
  }
});
test('plangraph.heal=never silences the nudge and writes nothing', () => {
  const w = world(), c = w.clone(); git(c, 'config', 'plangraph.heal', 'never');
  const r = w.runHookIn(c); assert.equal(r.code, 0); assert.doesNotMatch(r.stdout, /merge driver not set up/);
  assert.equal(heal(c), 'never'); assert.equal(fs.existsSync(path.join(c, '.gitattributes')), false);
  assert.doesNotMatch(localConfig(c), /merge\.plangraph-jsonl\./); assert.equal(fs.existsSync(w.shim), false);
});
test('a wired clone with plangraph.heal=false (and =never) is not healed and the value is unchanged', () => {
  for (const v of ['false', 'never']) {
    const w = world(), c = w.clone();
    assert.equal(w.plangraph(c, ['init'], w.hookEnv).status, 0); git(c, 'config', 'plangraph.heal', v);
    fs.rmSync(w.shim); const cfgBefore = fs.readFileSync(path.join(c, '.git/config'));
    const r = w.runHookIn(c); assert.equal(r.code, 0);
    if (v === 'never') assert.doesNotMatch(r.stdout, /merge driver not set up/); else assert.equal(lastLine(r.stdout), NUDGE);
    assert.equal(fs.existsSync(w.shim), false, v); assert.deepEqual(fs.readFileSync(path.join(c, '.git/config')), cfgBefore);
  }
});

// lib/driver.ts directly
test('gitCommonDir: real path of the common dir from the top, a subdirectory and a linked worktree; null outside a repository', () => {
  const w = world(), c = w.clone(), want = fs.realpathSync(path.join(c, '.git'));
  assert.equal(D.gitCommonDir(c), want); assert.equal(D.gitCommonDir(path.join(c, '.plangraph')), want);
  const wt = path.join(tmp('hm-wt-'), 'w'); git(c, 'worktree', 'add', '-q', wt); assert.equal(D.gitCommonDir(wt), want);
  const plain = tmp('hm-plain-'), env = process.env.GIT_CEILING_DIRECTORIES; process.env.GIT_CEILING_DIRECTORIES = path.dirname(plain);
  try { assert.equal(D.gitCommonDir(plain), null); } finally { if (env === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = env; }
});
test('hasConsent / hasDeclined / recordConsent: only a version is consent, only never declines, recordConsent refuses a non-version', () => {
  const w = world(), c = w.clone(), common = D.gitCommonDir(c) as string;
  assert.equal(D.CONSENT_KEY, 'plangraph.heal');
  assert.equal(D.hasConsent(common), false); assert.equal(D.hasDeclined(common), false);
  for (const [v, consent, declined] of [['false', false, false], ['off', false, false], ['never', false, true], ['Never', false, false], ['0.3', false, false], ['0.3.0', true, false], ['1.2.3-dev', true, false]] as const) {
    git(c, 'config', 'plangraph.heal', v); assert.equal(D.hasConsent(common), consent, v); assert.equal(D.hasDeclined(common), declined, v);
  }
  // anchored: a version followed by junk is not a version
  for (const v of ['1.2.3junk', '1.2.3 ', '1.2.3.4', '1.2.3-', '1.2.3\nx']) { git(c, 'config', 'plangraph.heal', v); assert.equal(D.hasConsent(common), false, JSON.stringify(v)); }
  for (const v of ['1.2.3+build.5', '10.20.30-rc.1']) { git(c, 'config', 'plangraph.heal', v); assert.equal(D.hasConsent(common), true, v); }
  D.recordConsent(common, '9.8.7'); assert.equal(heal(c), '9.8.7');
  assert.throws(() => D.recordConsent(common, 'yes'), /not a version/); assert.equal(heal(c), '9.8.7');
  assert.throws(() => D.recordConsent(common, '1.2.3junk'), /not a version/); assert.equal(heal(c), '9.8.7');
});

test('docs/ADOPT.md quotes the nudge exactly as the hook prints it', () => {
  assert.ok(fs.readFileSync(path.join(PLUGIN, 'docs/ADOPT.md'), 'utf8').includes(`\`${NUDGE}\``), 'docs/ADOPT.md quotes the hook line');
});

// The plan directory name comes from a committed .plangraphrc, so it is repository text: the nudge (hook output read by the agent) names it
// only when it is a plain short name (A-Z a-z 0-9 . _ / -, at most 40 characters), else says `the plan directory`.
test('the nudge names a plan directory from .plangraphrc only when it is a plain name of at most 40 characters', () => {
  const generic = 'plangraph: merge driver not set up in this clone; merges of *.jsonl files in the plan directory conflict until the user runs plangraph doctor --fix';
  for (const [dir, want] of [
    ['NOTE:agent_must_run_plangraph_doctor_--fix_now', generic],
    ['notes:do_this', generic],
    ['a'.repeat(41), generic],
    ['plans/q4', NUDGE.replace('.plangraph/', 'plans/q4/')],
    ['a'.repeat(40), NUDGE.replace('.plangraph/', `${'a'.repeat(40)}/`)],
  ] as const) {
    const w = world();
    fs.mkdirSync(path.join(w.origin, dir), { recursive: true });
    fs.writeFileSync(path.join(w.origin, dir, 'config.json'), '{}\n'); fs.writeFileSync(path.join(w.origin, dir, 'tickets.jsonl'), '');
    fs.writeFileSync(path.join(w.origin, '.plangraphrc'), `${JSON.stringify({ dir })}\n`);
    w.commit('custom plan dir');
    const c = w.clone();
    const r = w.runHookIn(c); assert.equal(r.code, 0, r.stderr);
    assert.equal(lastLine(r.stdout), want, dir);
    if (want === generic) assert.ok(!(lastLine(r.stdout) ?? '').includes(dir), `the nudge never carries the name: ${dir}`);
    assertUntouched(w, c);
  }
});

// Consent lives only in the clone's own config file: a global config (GIT_CONFIG_GLOBAL) holding plangraph.heal, or a local [include] of a file
// holding it, never grants it (includes are not followed, decision D3).
test('a global plangraph.heal or one reached through a local [include] is not consent: nudge printed, nothing written', () => {
  const w = world(), c = w.clone(), dir = tmp('hm-inc-');
  const global = path.join(dir, 'global'), inc = path.join(dir, 'included');
  fs.writeFileSync(global, '[plangraph]\n\theal = 9.9.9\n');
  fs.writeFileSync(inc, `[plangraph]\n\theal = ${VERSION}\n`);
  git(c, 'config', 'include.path', inc);
  const r = w.runHookIn(c, { GIT_CONFIG_GLOBAL: global }); assert.equal(r.code, 0, r.stderr);
  assert.equal(lastLine(r.stdout), NUDGE);
  assertUntouched(w, c);
  assert.equal(fs.readFileSync(global, 'utf8'), '[plangraph]\n\theal = 9.9.9\n');
  assert.match(fs.readFileSync(path.join(c, '.git/config'), 'utf8'), /\[include\]\n\tpath = /);
});
