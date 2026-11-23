// Tests for the stable-shim wiring in bin/brain (init, doctor, doctor --fix, card --heal) and hooks/hooks.json. Real git, real
// merges, temp repos, a temp CLAUDE_PLUGIN_DATA and a throwaway HOME. NOT covered: Windows (skipped: POSIX sh shim and modes),
// a symlinked parent of the data dir, concurrent heals, and the plugin-cache directory layout of a real Claude Code install
// (an update is simulated by running a COPY of the plugin from a different directory).
import baseTest, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import * as S from '../lib/store.mjs';
import { budget, scaling } from './helpers/perf.mjs';

const test = (name, fn) => baseTest(name, { skip: process.platform === 'win32' }, fn);
const PLUGIN = path.resolve(import.meta.dirname, '..');
const made = [];
const tmp = (p = 'dw-') => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p))); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const BASE_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: BASE_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
const copyPlugin = () => { const d = tmp('dw-plugin-'); for (const n of ['bin', 'lib', 'src', 'package.json', 'seed']) fs.cpSync(path.join(PLUGIN, n), path.join(d, n), { recursive: true }); return d; };
function world() {
  const dataDir = tmp('dw-data-'), home = tmp('dw-home-'), repo = tmp('dw-repo-');
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.name', 't'); git(repo, 'config', 'user.email', 't@example.invalid'); git(repo, 'config', 'commit.gpgsign', 'false');
  const env = { ...BASE_ENV, HOME: home, CLAUDE_PLUGIN_DATA: dataDir };
  const brain = (plugin, args, cwd = repo, e = env) => spawnSync(process.execPath, [path.join(plugin, 'bin/brain'), ...args], { cwd, env: e, encoding: 'utf8' });
  return { dataDir, home, repo, env, brain, shim: path.join(dataDir, 'bin', 'brain-merge'), cfg: () => git(repo, 'config', '--get', 'merge.brain-jsonl.driver').trim() };
}
const T = S.SCHEMAS['tickets.jsonl'], tk = (key, o = {}) => ({ key, summary: 's-' + key, epic: 'E', sp: 1, v2_owner: 'Ana', v2_sprint: 1, ...o });
// two branches editing different fields of the same record plus adjacent adds: plain git conflicts, the driver merges cleanly
function mergeScenario(repo) {
  const put = (recs) => fs.writeFileSync(path.join(repo, '.brain/tickets.jsonl'), S.canonFile(recs, T)), commit = (m) => { git(repo, 'add', '-A'); git(repo, 'commit', '-qm', m); };
  put([tk('T-1'), tk('T-2'), tk('T-3')]); commit('base'); git(repo, 'checkout', '-qb', 'feature');
  put([tk('T-1', { sp: 8 }), tk('T-2'), tk('T-3'), tk('T-31')]); commit('feature'); git(repo, 'checkout', '-q', 'main');
  put([tk('T-1', { summary: 'renamed' }), tk('T-2'), tk('T-3'), tk('T-32')]); commit('main');
  git(repo, 'merge', '--no-edit', 'feature');
  return fs.readFileSync(path.join(repo, '.brain/tickets.jsonl'), 'utf8');
}
const WANT = S.canonFile([tk('T-1', { sp: 8, summary: 'renamed' }), tk('T-2'), tk('T-3'), tk('T-31'), tk('T-32')], T);
const NUDGE = 'brain: plan data found in .brain but no index: run brain build\n'; // the first-use line: brain data, no index yet
const ok = (r) => { assert.equal(r.status, 0, `status ${r.status}\nstdout ${r.stdout}\nstderr ${r.stderr}`); return r; };
const snapshot = (dir) => Object.fromEntries(/** @type {string[]} */ (fs.readdirSync(dir, { recursive: true })).filter((f) => !String(f).startsWith('.git' + path.sep) && f !== '.git' && fs.statSync(path.join(dir, f)).isFile()).map((f) => { const st = fs.statSync(path.join(dir, f)); return [f, `${st.mtimeMs}:${fs.readFileSync(path.join(dir, f), 'latin1')}`]; }));

test('(a) init points git config at the stable shim under the data dir, never a plugin-cache path', () => {
  const w = world(); ok(w.brain(PLUGIN, ['init']));
  assert.equal(w.cfg(), `${w.shim} %O %A %B %P`);
  assert.ok(w.cfg().startsWith(w.dataDir) && !w.cfg().includes('/plugins/cache/'));
  assert.match(fs.readFileSync(path.join(w.repo, '.gitattributes'), 'utf8'), /^\.brain\/\*\.jsonl merge=brain-jsonl$/m);
  assert.equal(fs.readFileSync(path.join(w.dataDir, 'driver.target'), 'utf8'), path.join(PLUGIN, 'bin/brain-merge') + '\n');
});
test('(a2) init run from a copy installed under a plugins/cache path still installs the driver', () => {
  const w = world(), cache = tmp('dw-cache-'), plug = path.join(cache, 'plugins', 'cache', 'x', 'project-brain', '1.0.0');
  fs.mkdirSync(path.dirname(plug), { recursive: true }); fs.cpSync(copyPlugin(), plug, { recursive: true });
  const r = ok(w.brain(plug, ['init'])); assert.doesNotMatch(r.stderr, /not installed/);
  assert.equal(w.cfg(), `${w.shim} %O %A %B %P`);
});
test('(b) after init a real git merge of .brain/tickets.jsonl is merged cleanly by the driver', () => {
  const w = world(); ok(w.brain(PLUGIN, ['init'])); assert.equal(mergeScenario(w.repo), WANT);
});
test('(c) after the plugin moves, doctor reports it, doctor --fix repairs it, and the same git config still merges', () => {
  const w = world(), v1 = copyPlugin(), v2 = copyPlugin();
  ok(w.brain(v1, ['init'])); const cfg = w.cfg();
  fs.rmSync(v1, { recursive: true });
  const before = fs.readFileSync(path.join(w.dataDir, 'driver.target'), 'utf8');
  const d = w.brain(v2, ['doctor']); // (g) without --fix: a PROBLEM line, exit 1, nothing changed
  assert.equal(d.status, 1); assert.match(d.stdout, /^merge driver: .*driver\.target points to a missing file/m);
  assert.equal(fs.readFileSync(path.join(w.dataDir, 'driver.target'), 'utf8'), before);
  const f = ok(w.brain(v2, ['doctor', '--fix'])); assert.match(f.stdout, /^merge driver: ok$/m);
  assert.equal(w.cfg(), cfg);
  assert.equal(fs.readFileSync(path.join(w.dataDir, 'driver.target'), 'utf8'), path.join(v2, 'bin/brain-merge') + '\n');
  assert.equal(mergeScenario(w.repo), WANT);
});
test('(d) card --if-present --heal repairs a deleted shim and missing git config silently', () => {
  const w = world(); ok(w.brain(PLUGIN, ['init']));
  fs.rmSync(w.shim); git(w.repo, 'config', '--unset', 'merge.brain-jsonl.driver');
  const r = ok(w.brain(PLUGIN, ['card', '--if-present', '--heal']));
  assert.equal(r.stdout, NUDGE); assert.equal(r.stderr, ''); // no index yet, so no card, only the first-use line
  assert.equal(w.cfg(), `${w.shim} %O %A %B %P`); assert.equal(fs.statSync(w.shim).mode & 0o777, 0o755);
  assert.equal(mergeScenario(w.repo), WANT);
});
test('(d2) with an index, --heal output equals the plain card output byte for byte', () => {
  const w = world(); ok(w.brain(PLUGIN, ['init'])); ok(w.brain(PLUGIN, ['build']));
  const plain = ok(w.brain(PLUGIN, ['card', '--if-present'])); fs.rmSync(w.shim);
  const healed = ok(w.brain(PLUGIN, ['card', '--if-present', '--heal']));
  assert.equal(healed.stdout, plain.stdout); assert.equal(healed.stderr, ''); assert.ok(fs.existsSync(w.shim));
});
test('(d3) a healthy setup is left byte-identical, mtimes included (no rewrite)', () => {
  const w = world(); ok(w.brain(PLUGIN, ['init']));
  const a = snapshot(w.dataDir), b = snapshot(w.repo), cfg = fs.readFileSync(path.join(w.repo, '.git/config'));
  const r = ok(w.brain(PLUGIN, ['card', '--if-present', '--heal'])); assert.equal(r.stdout, NUDGE); assert.equal(r.stderr, '');
  assert.deepEqual(snapshot(w.dataDir), a); assert.deepEqual(snapshot(w.repo), b); assert.deepEqual(fs.readFileSync(path.join(w.repo, '.git/config')), cfg);
});
test('(e) --heal with no brain directory, or outside a git work tree, prints nothing, exits 0 and writes nothing', () => {
  const w = world(); // repo without .brain
  let r = ok(w.brain(PLUGIN, ['card', '--if-present', '--heal'])); assert.equal(r.stdout + r.stderr, '');
  assert.deepEqual(fs.readdirSync(w.dataDir), []); assert.equal(fs.existsSync(path.join(w.repo, '.gitattributes')), false);
  const plain = tmp('dw-nogit-'); fs.mkdirSync(path.join(plain, '.brain'));
  const env = { ...w.env, GIT_CEILING_DIRECTORIES: path.dirname(plain) };
  r = ok(w.brain(PLUGIN, ['card', '--if-present', '--heal'], plain, env)); assert.equal(r.stdout + r.stderr, '');
  assert.deepEqual(fs.readdirSync(w.dataDir), []); assert.deepEqual(fs.readdirSync(plain), ['.brain']);
});
test('(f) hooks.json passes --heal, keeps matcher and timeout; the declared command exits 0 under 1 s', () => {
  const entry = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'hooks/hooks.json'), 'utf8')).hooks.SessionStart[0];
  assert.equal(entry.matcher, 'startup|resume|clear|compact|fork');
  const hook = entry.hooks[0]; assert.equal(hook.timeout, 10); assert.equal(hook.command, 'node'); assert.deepEqual(hook.args, ['${CLAUDE_PLUGIN_ROOT}/bin/brain', 'card', '--if-present', '--heal']);
  const w = world(); ok(w.brain(PLUGIN, ['init'])); fs.rmSync(w.shim);
  const args = hook.args.map((a) => a.replace('${CLAUDE_PLUGIN_ROOT}', PLUGIN));
  const t0 = Date.now(); const r = spawnSync(hook.command, args, { cwd: w.repo, env: w.env, encoding: 'utf8' }); const ms = Date.now() - t0;
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout, NUDGE); assert.equal(r.stderr, ''); assert.ok(ms < budget(1000), `took ${ms} ms`);
  assert.ok(fs.existsSync(w.shim));
});
test('(g) doctor without --fix reports a missing shim as a problem and changes nothing', () => {
  const w = world(); ok(w.brain(PLUGIN, ['init'])); fs.rmSync(w.shim);
  const a = snapshot(w.dataDir), b = snapshot(w.repo);
  const r = w.brain(PLUGIN, ['doctor']); assert.equal(r.status, 1); assert.match(r.stdout, /^merge driver: .*executable not found/m);
  assert.deepEqual(snapshot(w.dataDir), a); assert.deepEqual(snapshot(w.repo), b);
  assert.match(ok(w.brain(PLUGIN, ['doctor', '--fix'])).stdout, /^merge driver: ok$/m);
});
test('(h) a non-private data dir: init and doctor print one short line without a stack, init still completes, heal is silent', () => {
  const w = world(); fs.chmodSync(w.dataDir, 0o777);
  const r = ok(w.brain(PLUGIN, ['init']));
  assert.match(r.stderr, /^merge driver not installed: data directory is not private/m); assert.doesNotMatch(r.stderr + r.stdout, /\n\s+at |Error:/);
  assert.equal(r.stderr.trim().split('\n').length, 1);
  assert.ok(fs.existsSync(path.join(w.repo, '.brain/config.json')) && fs.existsSync(path.join(w.repo, '.brain/tickets.jsonl')));
  assert.match(r.stdout, /^initialised \.brain/);
  const d = w.brain(PLUGIN, ['doctor', '--fix']); assert.equal(d.status, 1);
  assert.match(d.stdout, /^merge driver not installed: data directory is not private/m); assert.doesNotMatch(d.stdout + d.stderr, /\n\s+at /);
  assert.match(d.stdout, /^node v/m); // the rest of doctor still ran
  const bytes = fs.readdirSync(w.dataDir);
  const h = ok(w.brain(PLUGIN, ['card', '--if-present', '--heal'])); assert.equal(h.stdout, NUDGE); assert.equal(h.stderr, ''); assert.deepEqual(fs.readdirSync(w.dataDir), bytes);
});
test('(h2) a symlinked data dir is refused the same way', () => {
  const w = world(), real = tmp('dw-real-'), link = path.join(tmp('dw-link-'), 'data'); fs.symlinkSync(real, link);
  const r = ok(w.brain(PLUGIN, ['init'], w.repo, { ...w.env, CLAUDE_PLUGIN_DATA: link }));
  assert.match(r.stderr, /^merge driver not installed: data directory is not private: directory is a symlink/m); assert.deepEqual(fs.readdirSync(real), []);
});

// Size axis: the wiring path (installMergeDriver, then doctorMergeDriver) over a .gitattributes of n and 4n lines (4n stays under the
// 256 KiB cap), in process, min of 3 each (test/helpers/perf.mjs scaling): the git config calls are a constant part, so linear stays
// near 1x and quadratic heads for 16x. The brain line is last (both scans read every line) and already present (nothing is written).
// Proved by a deliberately quadratic line scan in doctorMergeDriver (ratio about 12), which scripts/mutate.mjs keeps applying.
test('timing: merge-driver wiring scales linearly with the .gitattributes size (n vs 4n lines, in process, min of 3)', () => {
  const n = 3500, repos = new Map();
  for (const m of [n >> 2, n, 4 * n]) {
    const d = tmp('dw-attr-'); git(d, 'init', '-q');
    fs.writeFileSync(path.join(d, '.gitattributes'), `${Array.from({ length: m }, (_, i) => `d${i} -text`).join('\n')}\n.brain/*.jsonl merge=brain-jsonl\n`);
    repos.set(m, d);
  }
  assert.ok(fs.statSync(path.join(repos.get(4 * n), '.gitattributes')).size < S.GITATTRIBUTES_MAX);
  const wire = (/** @type {number} */ m) => {
    const d = repos.get(m);
    S.installMergeDriver(d, { dir: '.brain', driverPath: '/opt/brain/brain-merge' });
    assert.equal(S.doctorMergeDriver(d, { dir: '.brain' }).attributes, true);
  };
  const s = scaling(wire, n);
  console.log(`# wiring ms: ${s.small.toFixed(1)} at ${n} lines, ${s.large.toFixed(1)} at ${4 * n} (ratio ${s.ratio.toFixed(1)})`);
  assert.ok(s.ratio < s.maxRatio, `wiring scaling ratio ${s.ratio.toFixed(1)} (${s.small.toFixed(1)} ms at ${n} lines, ${s.large.toFixed(1)} ms at ${4 * n}; linear ~1-4, quadratic ~16)`);
});
