// bin/brain turns on Node's module compile cache after the floor check and before it loads src/cli.ts, in a PRIVATE per-user directory:
// <data>/compile-cache, where <data> is CLAUDE_PLUGIN_DATA when absolute, else ~/.cache/project-brain (the rule of lib/driver.ts
// defaultDataDir). It is used only when it is a real directory (not a symlink) owned by the current user with no group or world bits:
// Node accepts a cache directory of any owner and mode and checks entries by CRC32 only, so a shared or foreign directory would let
// another local user plant code that runs as this user. When NODE_COMPILE_CACHE is set, Node's own behavior is left untouched.
// The cache is an optimization only: whatever the cache directory is (missing, read-only, refused), the CLI must print the
// same bytes, exit the same way and write NOTHING to stderr, because the SessionStart hook (`card --if-present`) must stay silent.
// Real processes: the cache is per process, so it is only observable across spawns. A temp git repository with a small built brain.
// "Owned by someone else" is simulated by an --import preload that makes process.getuid report another uid (chown needs root).
import baseTest, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { genPlan } from './fixtures/gen.ts';

// mode 0500 does not stop root, and Windows has no POSIX modes: there the unwritable case cannot be built
const posixUser = process.platform !== 'win32' && process.getuid?.() !== 0;
const test = (name: string, fn: () => void | Promise<void>) => baseTest(name, { skip: !posixUser }, fn);
const BRAIN = path.resolve(import.meta.dirname, '../bin/brain');
const made: string[] = [];
const tmp = (p: string) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p))); made.push(d); return d; };
after(() => { for (const d of made) { try { fs.chmodSync(d, 0o700); } catch { /* gone */ } fs.rmSync(d, { recursive: true, force: true }); } });

const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
const BASE_ENV: Record<string, string | undefined> = { PATH: process.env.PATH, HOME: tmp('cc-home-'), LC_ALL: 'C', TZ: 'UTC', PLANGRAPH_DIR: '', SOURCE_DATE_EPOCH: '1795305600', ...GIT_ENV };
const jl = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

/** A git repository with an initialised, built brain over a small generated plan. */
function repo(): string {
  const d = tmp('cc-repo-');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: d, env: { ...process.env, ...GIT_ENV }, stdio: 'ignore' });
  const brain = (args: string[]) => spawnSync(process.execPath, [BRAIN, ...args], { cwd: d, env: { ...BASE_ENV, CLAUDE_PLUGIN_DATA: tmp('cc-data-') }, encoding: 'utf8' });
  assert.equal(brain(['init']).status, 0);
  const p = genPlan({ n: 12, people: 3, seed: 4, cap: 40 });
  fs.writeFileSync(path.join(d, '.brain', 'tickets.jsonl'), jl(p.tickets));
  fs.writeFileSync(path.join(d, '.brain', 'edges.jsonl'), jl(p.edges));
  fs.writeFileSync(path.join(d, '.brain', 'schedule.jsonl'), jl(p.schedule));
  assert.equal(brain(['build']).status, 0);
  return d;
}
/** `brain card --if-present` (the hook's command) as a child process with the given extra environment. */
const card = (cwd: string, extra: Record<string, string>) => spawnSync(process.execPath, [BRAIN, 'card', '--if-present'], { cwd, env: { ...BASE_ENV, ...extra }, encoding: 'utf8' });
const unwritableDir = (p: string) => { const d = tmp(p); fs.chmodSync(d, 0o500); return d; };

test('an unwritable NODE_COMPILE_CACHE directory: exit 0, empty stderr and identical stdout on every run', () => {
  const d = repo(), cache = unwritableDir('cc-ro-');
  const runs = [1, 2, 3].map(() => card(d, { NODE_COMPILE_CACHE: cache }));
  for (const r of runs) assert.deepEqual([r.status, r.stderr], [0, ''], `status ${r.status}, stderr: ${r.stderr}`);
  assert.ok(runs[0]?.stdout.startsWith('brain'), `the card is printed: ${runs[0]?.stdout.slice(0, 80)}`);
  assert.deepEqual(runs.map((r) => r.stdout), [runs[0]?.stdout, runs[0]?.stdout, runs[0]?.stdout]);
  assert.deepEqual(fs.readdirSync(cache), [], 'nothing was written into the read-only directory');
});

/** The same command with Node preload arguments (an --import module that runs before bin/brain). */
const cardWith = (nodeArgs: string[], cwd: string, extra: Record<string, string>) => spawnSync(process.execPath, [...nodeArgs, BRAIN, 'card', '--if-present'], { cwd, env: { ...BASE_ENV, ...extra }, encoding: 'utf8' });
const entries = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);
/** A preload that makes process.getuid report `delta` added to the real uid (0: the real one, a control run). */
const uidPreload = (delta: number) => ['--import', `data:text/javascript,const u=process.getuid();process.getuid=()=>u+${delta}`];

test('the entry point keeps the cache in CLAUDE_PLUGIN_DATA/compile-cache with mode 0700 (not os.tmpdir()/node-compile-cache), with the same output', () => {
  const d = repo(), data = tmp('cc-data-'), tmpdir = tmp('cc-tmpdir-'), plain = card(d, { NODE_DISABLE_COMPILE_CACHE: '1', CLAUDE_PLUGIN_DATA: data });
  assert.deepEqual([plain.status, plain.stderr], [0, '']);
  fs.rmSync(path.join(data, 'compile-cache'), { recursive: true, force: true });
  const first = card(d, { TMPDIR: tmpdir, CLAUDE_PLUGIN_DATA: data }), second = card(d, { TMPDIR: tmpdir, CLAUDE_PLUGIN_DATA: data });
  for (const r of [first, second]) assert.deepEqual([r.status, r.stdout, r.stderr], [0, plain.stdout, '']);
  const dir = path.join(data, 'compile-cache');
  assert.ok(entries(dir).length > 0, 'the cache lives under CLAUDE_PLUGIN_DATA/compile-cache');
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700, 'the cache directory is private');
  assert.deepEqual(entries(path.join(tmpdir, 'node-compile-cache')), [], 'nothing in the shared temp directory');
});

test('without an absolute CLAUDE_PLUGIN_DATA the cache lives under HOME/.cache/project-brain/compile-cache (mode 0700)', () => {
  const d = repo();
  for (const extra of [{}, { CLAUDE_PLUGIN_DATA: 'relative/data' }]) {
    const home = tmp('cc-home2-'), r = card(d, { ...extra, HOME: home });
    assert.deepEqual([r.status, r.stderr], [0, '']);
    const dir = path.join(home, '.cache', 'project-brain', 'compile-cache');
    assert.ok(entries(dir).length > 0, `the cache is under HOME (${JSON.stringify(extra)})`);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  }
});

test('a pre-created group- or world-writable compile-cache directory is refused: exit 0, empty stderr, identical output, nothing written', () => {
  const d = repo();
  for (const mode of [0o777, 0o770, 0o750]) {
    const data = tmp('cc-open-'), dir = path.join(data, 'compile-cache'), tmpdir = tmp('cc-opentmp-'), shared = path.join(tmpdir, 'node-compile-cache');
    const plain = card(d, { NODE_DISABLE_COMPILE_CACHE: '1', CLAUDE_PLUGIN_DATA: data });
    fs.rmSync(dir, { recursive: true, force: true });
    for (const p of [dir, shared]) { fs.mkdirSync(p); fs.chmodSync(p, mode); }
    const runs = [1, 2].map(() => card(d, { CLAUDE_PLUGIN_DATA: data, TMPDIR: tmpdir }));
    for (const r of runs) assert.deepEqual([r.status, r.stdout, r.stderr], [0, plain.stdout, ''], `mode ${mode.toString(8)}`);
    assert.deepEqual(entries(dir), [], `no cache entries were written into the mode ${mode.toString(8)} directory`);
    assert.deepEqual(entries(shared), [], `the shared TMPDIR/node-compile-cache (mode ${mode.toString(8)}, the audit's planted directory) is not used`);
    assert.equal(fs.statSync(dir).mode & 0o777, mode, 'the directory is never chmodded');
  }
});

test('a compile-cache symlink (even to a private directory) is refused: no entries written through it', () => {
  const d = repo(), data = tmp('cc-link-'), target = tmp('cc-target-');
  fs.chmodSync(target, 0o700);
  const plain = card(d, { NODE_DISABLE_COMPILE_CACHE: '1', CLAUDE_PLUGIN_DATA: data });
  fs.rmSync(path.join(data, 'compile-cache'), { recursive: true, force: true });
  fs.symlinkSync(target, path.join(data, 'compile-cache'));
  const r = card(d, { CLAUDE_PLUGIN_DATA: data });
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, plain.stdout, '']);
  assert.deepEqual(entries(target), [], 'nothing was written through the symlink');
});

test('a compile-cache directory owned by another uid (simulated: process.getuid reports another uid) is refused; the same preload with the real uid uses it', () => {
  const d = repo();
  const control = tmp('cc-own0-'), rc = cardWith(uidPreload(0), d, { CLAUDE_PLUGIN_DATA: control });
  assert.deepEqual([rc.status, rc.stderr], [0, '']);
  assert.ok(entries(path.join(control, 'compile-cache')).length > 0, 'control: with the real uid the preload does not stop the cache (the refusal below is not vacuous)');
  const data = tmp('cc-own1-'), plain = cardWith(uidPreload(1), d, { NODE_DISABLE_COMPILE_CACHE: '1', CLAUDE_PLUGIN_DATA: data });
  const dir = path.join(data, 'compile-cache');
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { mode: 0o700 });
  const r = cardWith(uidPreload(1), d, { CLAUDE_PLUGIN_DATA: data });
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, plain.stdout, '']);
  assert.deepEqual(entries(dir), [], 'no entries in a directory owned by another uid');
});

test('a data directory that is not private (a symlink, or group/world-writable) is refused like lib/driver.ts refuses it: nothing written into it', () => {
  const d = repo();
  const real = tmp('cc-realdata-'), link = path.join(tmp('cc-linkdata-'), 'data'); fs.chmodSync(real, 0o700); fs.symlinkSync(real, link);
  const open = tmp('cc-opendata-'); fs.chmodSync(open, 0o777);
  for (const [data, inspect] of [[link, real], [open, open]] as const) {
    const plain = card(d, { NODE_DISABLE_COMPILE_CACHE: '1', CLAUDE_PLUGIN_DATA: data });
    fs.rmSync(path.join(inspect, 'compile-cache'), { recursive: true, force: true });
    const r = card(d, { CLAUDE_PLUGIN_DATA: data });
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, plain.stdout, ''], data);
    assert.equal(fs.existsSync(path.join(inspect, 'compile-cache')), false, `no compile-cache created in ${data}`);
  }
});

test('NODE_COMPILE_CACHE set: Node\'s own behavior is untouched (its directory holds the cache; the data directory gets none)', () => {
  const d = repo(), data = tmp('cc-env-data-'), cache = tmp('cc-env-cache-');
  fs.rmSync(path.join(data, 'compile-cache'), { recursive: true, force: true });
  const r = card(d, { NODE_COMPILE_CACHE: cache, CLAUDE_PLUGIN_DATA: data });
  assert.deepEqual([r.status, r.stderr], [0, '']);
  assert.ok(entries(cache).length > 0, 'Node used NODE_COMPILE_CACHE');
  assert.equal(fs.existsSync(path.join(data, 'compile-cache')), false, 'bin/brain did not create its own directory');
});

test('an unwritable default directory (TMPDIR read-only): exit 0, empty stderr and identical stdout on every run', () => {
  const d = repo(), ro = unwritableDir('cc-rotmp-');
  const runs = [1, 2, 3].map(() => card(d, { TMPDIR: ro }));
  for (const r of runs) assert.deepEqual([r.status, r.stderr], [0, ''], `status ${r.status}, stderr: ${r.stderr}`);
  assert.ok(runs[0]?.stdout.startsWith('brain'));
  assert.deepEqual(runs.map((r) => r.stdout), [runs[0]?.stdout, runs[0]?.stdout, runs[0]?.stdout]);
});

test('an unwritable data directory (CLAUDE_PLUGIN_DATA read-only, no compile-cache yet): exit 0, empty stderr and identical stdout on every run', () => {
  const d = repo(), ro = unwritableDir('cc-rodata-');
  const runs = [1, 2, 3].map(() => card(d, { CLAUDE_PLUGIN_DATA: ro }));
  for (const r of runs) assert.deepEqual([r.status, r.stderr], [0, ''], `status ${r.status}, stderr: ${r.stderr}`);
  assert.ok(runs[0]?.stdout.startsWith('brain'));
  assert.deepEqual(runs.map((r) => r.stdout), [runs[0]?.stdout, runs[0]?.stdout, runs[0]?.stdout]);
  assert.deepEqual(entries(ro), [], 'nothing was created in the read-only data directory');
});
