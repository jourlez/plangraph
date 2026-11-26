// Tests for the stable-shim wiring in bin/plangraph (init, doctor, doctor --fix, card --heal) and hooks/hooks.json. Real git, real
// merges, temp repos, a temp CLAUDE_PLUGIN_DATA and a throwaway HOME. NOT covered: Windows (skipped: POSIX sh shim and modes),
// a symlinked parent of the data dir, concurrent heals, and the plugin-cache directory layout of a real Claude Code install
// (an update is simulated by running a COPY of the plugin from a different directory).
import baseTest, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import type { TestContext } from 'node:test';
import * as S from '../lib/store.ts';
import { budget, scaling, workScaling } from './helpers/perf.ts';

const test = (name: string, fn: (t: TestContext) => void | Promise<void>) => baseTest(name, { skip: process.platform === 'win32' }, fn);
const PLUGIN = path.resolve(import.meta.dirname, '..');
const made: string[] = [];
const tmp = (p = 'dw-') => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p))); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const BASE_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', env: BASE_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
const copyPlugin = () => { const d = tmp('dw-plugin-'); for (const n of ['bin', 'lib', 'src', 'package.json', 'seed']) fs.cpSync(path.join(PLUGIN, n), path.join(d, n), { recursive: true }); return d; };
function world() {
  const dataDir = tmp('dw-data-'), home = tmp('dw-home-'), repo = tmp('dw-repo-');
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.name', 't'); git(repo, 'config', 'user.email', 't@example.invalid'); git(repo, 'config', 'commit.gpgsign', 'false');
  const env = { ...BASE_ENV, HOME: home, CLAUDE_PLUGIN_DATA: dataDir };
  const plangraph = (plugin: string, args: string[], cwd = repo, e: NodeJS.ProcessEnv = env) => spawnSync(process.execPath, [path.join(plugin, 'bin/plangraph'), ...args], { cwd, env: e, encoding: 'utf8' });
  return { dataDir, home, repo, env, plangraph, shim: path.join(dataDir, 'bin', 'plangraph-merge'), cfg: () => git(repo, 'config', '--get', 'merge.plangraph-jsonl.driver').trim() };
}
const T = S.SCHEMAS['tickets.jsonl'], tk = (key: string, o: S.Rec = {}) => ({ key, summary: 's-' + key, epic: 'E', sp: 1, v2_owner: 'Ana', v2_sprint: 1, ...o });
// two branches editing different fields of the same record plus adjacent adds: plain git conflicts, the driver merges cleanly
function mergeScenario(repo: string) {
  const put = (recs: readonly S.Rec[]) => fs.writeFileSync(path.join(repo, '.plangraph/tickets.jsonl'), S.canonFile(recs, T)), commit = (m: string) => { git(repo, 'add', '-A'); git(repo, 'commit', '-qm', m); };
  put([tk('T-1'), tk('T-2'), tk('T-3')]); commit('base'); git(repo, 'checkout', '-qb', 'feature');
  put([tk('T-1', { sp: 8 }), tk('T-2'), tk('T-3'), tk('T-31')]); commit('feature'); git(repo, 'checkout', '-q', 'main');
  put([tk('T-1', { summary: 'renamed' }), tk('T-2'), tk('T-3'), tk('T-32')]); commit('main');
  git(repo, 'merge', '--no-edit', 'feature');
  return fs.readFileSync(path.join(repo, '.plangraph/tickets.jsonl'), 'utf8');
}
const WANT = S.canonFile([tk('T-1', { sp: 8, summary: 'renamed' }), tk('T-2'), tk('T-3'), tk('T-31'), tk('T-32')], T);
const NUDGE = 'plangraph: plan data found in .plangraph but no index: run plangraph build\n'; // the first-use line: plan data, no index yet
const ok = (r: SpawnSyncReturns<string>) => { assert.equal(r.status, 0, `status ${r.status}\nstdout ${r.stdout}\nstderr ${r.stderr}`); return r; };
// bin/plangraph keeps its private compile cache in the data dir (bin/plangraph): an optimization, not a command's write, so left out
const noCache = (names: string[]) => names.filter((f) => f !== 'compile-cache' && !f.startsWith('compile-cache' + path.sep));
const snapshot = (dir: string) => Object.fromEntries(noCache(fs.readdirSync(dir, { recursive: true }) as string[]).filter((f) => !String(f).startsWith('.git' + path.sep) && f !== '.git' && fs.statSync(path.join(dir, f)).isFile()).map((f) => { const st = fs.statSync(path.join(dir, f)); return [f, `${st.mtimeMs}:${fs.readFileSync(path.join(dir, f), 'latin1')}`]; })); // without withFileTypes, readdirSync returns names

test('(a) init points git config at the stable shim under the data dir, never a plugin-cache path', () => {
  const w = world(); ok(w.plangraph(PLUGIN, ['init']));
  assert.equal(w.cfg(), `${w.shim} %O %A %B %P`);
  assert.ok(w.cfg().startsWith(w.dataDir) && !w.cfg().includes('/plugins/cache/'));
  assert.match(fs.readFileSync(path.join(w.repo, '.gitattributes'), 'utf8'), /^\.plangraph\/\*\.jsonl merge=plangraph-jsonl$/m);
  assert.equal(fs.readFileSync(path.join(w.dataDir, 'driver.target'), 'utf8'), path.join(PLUGIN, 'bin/plangraph-merge') + '\n');
});
test('(a2) init run from a copy installed under a plugins/cache path still installs the driver', () => {
  const w = world(), cache = tmp('dw-cache-'), plug = path.join(cache, 'plugins', 'cache', 'x', 'plangraph', '1.0.0');
  fs.mkdirSync(path.dirname(plug), { recursive: true }); fs.cpSync(copyPlugin(), plug, { recursive: true });
  const r = ok(w.plangraph(plug, ['init'])); assert.doesNotMatch(r.stderr, /not installed/);
  assert.equal(w.cfg(), `${w.shim} %O %A %B %P`);
});
test('(b) after init a real git merge of .plangraph/tickets.jsonl is merged cleanly by the driver', () => {
  const w = world(); ok(w.plangraph(PLUGIN, ['init'])); assert.equal(mergeScenario(w.repo), WANT);
});
test('(c) after the plugin moves, doctor reports it, doctor --fix repairs it, and the same git config still merges', () => {
  const w = world(), v1 = copyPlugin(), v2 = copyPlugin();
  ok(w.plangraph(v1, ['init'])); const cfg = w.cfg();
  fs.rmSync(v1, { recursive: true });
  const before = fs.readFileSync(path.join(w.dataDir, 'driver.target'), 'utf8');
  const d = w.plangraph(v2, ['doctor']); // (g) without --fix: a PROBLEM line, exit 1, nothing changed
  assert.equal(d.status, 1); assert.match(d.stdout, /^merge driver: .*driver\.target points to a missing file/m);
  assert.equal(fs.readFileSync(path.join(w.dataDir, 'driver.target'), 'utf8'), before);
  const f = ok(w.plangraph(v2, ['doctor', '--fix'])); assert.match(f.stdout, /^merge driver: ok$/m);
  assert.equal(w.cfg(), cfg);
  assert.equal(fs.readFileSync(path.join(w.dataDir, 'driver.target'), 'utf8'), path.join(v2, 'bin/plangraph-merge') + '\n');
  assert.equal(mergeScenario(w.repo), WANT);
});
test('(d) card --if-present --heal repairs a deleted shim and missing git config silently', () => {
  const w = world(); ok(w.plangraph(PLUGIN, ['init']));
  fs.rmSync(w.shim); git(w.repo, 'config', '--unset', 'merge.plangraph-jsonl.driver');
  const r = ok(w.plangraph(PLUGIN, ['card', '--if-present', '--heal']));
  assert.equal(r.stdout, NUDGE); assert.equal(r.stderr, ''); // no index yet, so no card, only the first-use line
  assert.equal(w.cfg(), `${w.shim} %O %A %B %P`); assert.equal(fs.statSync(w.shim).mode & 0o777, 0o755);
  assert.equal(mergeScenario(w.repo), WANT);
});
test('(d2) with an index, --heal output equals the plain card output byte for byte', () => {
  const w = world(); ok(w.plangraph(PLUGIN, ['init'])); ok(w.plangraph(PLUGIN, ['build']));
  const plain = ok(w.plangraph(PLUGIN, ['card', '--if-present'])); fs.rmSync(w.shim);
  const healed = ok(w.plangraph(PLUGIN, ['card', '--if-present', '--heal']));
  assert.equal(healed.stdout, plain.stdout); assert.equal(healed.stderr, ''); assert.ok(fs.existsSync(w.shim));
});
test('(d3) a healthy setup is left byte-identical, mtimes included (no rewrite)', () => {
  const w = world(); ok(w.plangraph(PLUGIN, ['init']));
  const a = snapshot(w.dataDir), b = snapshot(w.repo), cfg = fs.readFileSync(path.join(w.repo, '.git/config'));
  const r = ok(w.plangraph(PLUGIN, ['card', '--if-present', '--heal'])); assert.equal(r.stdout, NUDGE); assert.equal(r.stderr, '');
  assert.deepEqual(snapshot(w.dataDir), a); assert.deepEqual(snapshot(w.repo), b); assert.deepEqual(fs.readFileSync(path.join(w.repo, '.git/config')), cfg);
});
test('(e) --heal with no plan directory, or outside a git work tree, prints nothing, exits 0 and writes nothing', () => {
  const w = world(); // repo without .plangraph
  let r = ok(w.plangraph(PLUGIN, ['card', '--if-present', '--heal'])); assert.equal(r.stdout + r.stderr, '');
  assert.deepEqual(noCache(fs.readdirSync(w.dataDir)), []); assert.equal(fs.existsSync(path.join(w.repo, '.gitattributes')), false);
  const plain = tmp('dw-nogit-'); fs.mkdirSync(path.join(plain, '.plangraph'));
  const env = { ...w.env, GIT_CEILING_DIRECTORIES: path.dirname(plain) };
  r = ok(w.plangraph(PLUGIN, ['card', '--if-present', '--heal'], plain, env)); assert.equal(r.stdout + r.stderr, '');
  assert.deepEqual(noCache(fs.readdirSync(w.dataDir)), []); assert.deepEqual(fs.readdirSync(plain), ['.plangraph']);
});
test('(f) hooks.json passes --heal, keeps matcher and timeout; the declared command exits 0 under 1 s', () => {
  const entry = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'hooks/hooks.json'), 'utf8')).hooks.SessionStart[0];
  assert.equal(entry.matcher, 'startup|resume|clear|compact|fork');
  const hook = entry.hooks[0]; assert.equal(hook.timeout, 10); assert.equal(hook.command, 'node'); assert.deepEqual(hook.args, ['${CLAUDE_PLUGIN_ROOT}/src/entry.js', 'card', '--if-present', '--heal']);
  const w = world(); ok(w.plangraph(PLUGIN, ['init'])); fs.rmSync(w.shim);
  const args = hook.args.map((a: string) => a.replace('${CLAUDE_PLUGIN_ROOT}', PLUGIN));
  const t0 = Date.now(); const r = spawnSync(hook.command, args, { cwd: w.repo, env: w.env, encoding: 'utf8' }); const ms = Date.now() - t0;
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout, NUDGE); assert.equal(r.stderr, ''); assert.ok(ms < budget(1000), `took ${ms} ms`);
  assert.ok(fs.existsSync(w.shim));
});
test('(g) doctor without --fix reports a missing shim as a problem and changes nothing', () => {
  const w = world(); ok(w.plangraph(PLUGIN, ['init'])); fs.rmSync(w.shim);
  const a = snapshot(w.dataDir), b = snapshot(w.repo);
  const r = w.plangraph(PLUGIN, ['doctor']); assert.equal(r.status, 1); assert.match(r.stdout, /^merge driver: .*executable not found/m);
  assert.deepEqual(snapshot(w.dataDir), a); assert.deepEqual(snapshot(w.repo), b);
  assert.match(ok(w.plangraph(PLUGIN, ['doctor', '--fix'])).stdout, /^merge driver: ok$/m);
});
test('(h) a group- or world-writable CLAUDE_PLUGIN_DATA: init prints one line and installs the shim under ~/.cache/plangraph instead; the directory is never changed (D19)', () => {
  const w = world(); fs.chmodSync(w.dataDir, 0o777);
  const fb = path.join(w.home, '.cache', 'plangraph'), bytes = fs.readdirSync(w.dataDir);
  const r = ok(w.plangraph(PLUGIN, ['init']));
  assert.equal(r.stderr, `plangraph: CLAUDE_PLUGIN_DATA (${w.dataDir}) is group or world writable; using ${fb} instead\n`);
  assert.ok(fs.existsSync(path.join(w.repo, '.plangraph/config.json')) && fs.existsSync(path.join(w.repo, '.plangraph/tickets.jsonl')));
  assert.match(r.stdout, /^initialised \.plangraph/);
  assert.equal(w.cfg().split(' ')[0].replace(/^'|'$/g, '').startsWith(fb), true, w.cfg()); assert.equal(fs.statSync(fb).mode & 0o777, 0o700);
  assert.equal(fs.statSync(w.dataDir).mode & 0o777, 0o777); assert.deepEqual(fs.readdirSync(w.dataDir), bytes);
  assert.match(ok(w.plangraph(PLUGIN, ['doctor', '--fix'])).stdout, /^merge driver: ok$/m);
  const h = ok(w.plangraph(PLUGIN, ['card', '--if-present', '--heal'])); assert.equal(h.stdout, NUDGE); assert.equal(h.stderr, ''); assert.deepEqual(fs.readdirSync(w.dataDir), bytes);
});
test('(h2) a symlinked data dir is refused the same way', () => {
  const w = world(), real = tmp('dw-real-'), link = path.join(tmp('dw-link-'), 'data'); fs.symlinkSync(real, link);
  const r = ok(w.plangraph(PLUGIN, ['init'], w.repo, { ...w.env, CLAUDE_PLUGIN_DATA: link }));
  assert.match(r.stderr, /^merge driver not installed: data directory is not private: directory is a symlink/m); assert.deepEqual(fs.readdirSync(real), []);
});

// Size axis: the wiring path (installMergeDriver, then doctorMergeDriver) over a .gitattributes of n and 4n lines (4n stays under the
// 256 KiB cap), in process, min of 3 each (test/helpers/perf.ts scaling): the git config calls are a constant part, so linear stays
// near 1x and quadratic heads for 16x. The plangraph line is last (both scans read every line) and already present (nothing is written).
// Proved by a deliberately quadratic line scan in doctorMergeDriver (ratio about 12), which scripts/mutate.ts keeps applying.
test('timing: merge-driver wiring scales linearly with the .gitattributes size (n vs 4n lines, in process, min of 3)', () => {
  const n = 3500, repos = new Map();
  for (const m of [n >> 2, n, 4 * n]) {
    const d = tmp('dw-attr-'); git(d, 'init', '-q');
    fs.writeFileSync(path.join(d, '.gitattributes'), `${Array.from({ length: m }, (_, i) => `d${i} -text`).join('\n')}\n.plangraph/*.jsonl merge=plangraph-jsonl\n`);
    repos.set(m, d);
  }
  assert.ok(fs.statSync(path.join(repos.get(4 * n), '.gitattributes')).size < S.GITATTRIBUTES_MAX);
  const wire = (m: number) => {
    const d = repos.get(m);
    S.installMergeDriver(d, { dir: '.plangraph', driverPath: '/opt/plangraph/plangraph-merge' });
    assert.equal(S.doctorMergeDriver(d, { dir: '.plangraph' }).attributes, true);
  };
  const s = scaling(wire, n) as { small: number; large: number; ratio: number; maxRatio: number }; // attempts >= 1, so a result is always set
  console.log(`# wiring ms: ${s.small.toFixed(1)} at ${n} lines, ${s.large.toFixed(1)} at ${4 * n} (ratio ${s.ratio.toFixed(1)})`);
  assert.ok(s.ratio < s.maxRatio, `wiring scaling ratio ${s.ratio.toFixed(1)} (${s.small.toFixed(1)} ms at ${n} lines, ${s.large.toFixed(1)} ms at ${4 * n}; linear ~1-4, quadratic ~16)`);
});

// The same size axis without a clock (test/helpers/perf.ts workScaling): the elements the Array and String built-ins touch on the wiring
// path, n vs 4n lines. Deterministic, so it fails the same way on every machine; the deliberately quadratic line scan in doctorMergeDriver
// (scripts/mutate.ts) re-joins every prefix of the lines, which this counts (ratio about 16), while the real scan stays near 4.
test('work: merge-driver wiring touches linearly many elements in the .gitattributes size (n vs 4n lines, built-in work count, no clock)', async () => {
  const n = 2000, repos = new Map<number, string>();
  for (const m of [n, 4 * n]) {
    const d = tmp('dw-work-'); git(d, 'init', '-q');
    fs.writeFileSync(path.join(d, '.gitattributes'), `${Array.from({ length: m }, (_, i) => `d${i} -text`).join('\n')}\n.plangraph/*.jsonl merge=plangraph-jsonl\n`);
    repos.set(m, d);
  }
  const wire = (m: number) => {
    const d = repos.get(m) as string; // both sizes were created above
    S.installMergeDriver(d, { dir: '.plangraph', driverPath: '/opt/plangraph/plangraph-merge' });
    assert.equal(S.doctorMergeDriver(d, { dir: '.plangraph' }).attributes, true);
  };
  const s = await workScaling(wire, n);
  console.log(`# wiring work: ${s.small} at ${n} lines, ${s.large} at ${4 * n} (ratio ${s.ratio.toFixed(2)})`);
  assert.ok(s.small >= n, `the count sees the line scan (${s.small} elements at ${n} lines)`);
  assert.ok(s.ratio < s.maxRatio, `wiring work ratio ${s.ratio.toFixed(2)} (${s.small} at ${n} lines, ${s.large} at ${4 * n}; linear ~4, quadratic ~16)`);
});
