// Tests for lib/driver.mjs and the stable-shim handling in lib/store.mjs. NOT covered: Windows (the whole suite is skipped
// there: the shim is POSIX sh and the directory-mode checks are POSIX), a data directory on a read-only filesystem, concurrent
// ensureStableDriver calls, a root-owned data directory used by a non-root caller on another account, a symlinked PARENT of
// the data directory (only the data dir and bin/ themselves are lstat-checked), and the unreadable-target case when run as root.
import baseTest, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureStableDriver, defaultDataDir } from '../lib/driver.mjs';
import * as S from '../lib/store.mjs';

const test = (name, fn) => baseTest(name, { skip: process.platform === 'win32' }, fn);
const REAL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/brain-merge');
const made = [];
const tmp = (p = 'drv-') => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const echoer = (dir, name, tag) => { const f = path.join(dir, name); fs.writeFileSync(f, `console.log(${JSON.stringify(tag)}, ...process.argv.slice(2));\n`); return f; };
const runShim = (shim, ...args) => spawnSync(shim, args, { encoding: 'utf8', env: { ...process.env, PATH: '/usr/bin:/bin' } });

test('update survival: same shim path runs the new target after the old one is deleted', () => {
  const root = tmp(), dataDir = path.join(root, 'data'); fs.mkdirSync(dataDir);
  const a = echoer(root, 'a.mjs', 'A'), b = echoer(root, 'b.mjs', 'B');
  const shim = ensureStableDriver({ dataDir, target: a });
  assert.equal(shim, path.join(dataDir, 'bin', 'brain-merge'));
  assert.equal(fs.statSync(shim).mode & 0o777, 0o755);
  let r = runShim(shim, 'x', 'y z'); assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout.trim(), 'A x y z');
  fs.rmSync(a); assert.equal(ensureStableDriver({ dataDir, target: b }), shim);
  r = runShim(shim, 'q'); assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout.trim(), 'B q');
});
const toolDir = (...names) => { // a PATH containing only symlinks to the named system tools, so `node` provably cannot be found
  const d = tmp('drv-path-');
  for (const n of names) { const src = ['/usr/bin', '/bin'].map((x) => path.join(x, n)).find((f) => fs.existsSync(f)); assert.ok(src, `system tool ${n} not found`); fs.symlinkSync(src, path.join(d, n)); }
  return d;
};
test('works with node absent from PATH (uses the recorded absolute node) and with spaces in the data directory', () => {
  const root = tmp(), dataDir = path.join(root, 'my data dir', 'x y');
  const t = echoer(root, 'tar get.mjs', 'S');
  const shim = ensureStableDriver({ dataDir, target: t });
  const bare = toolDir('cat', 'dirname');
  assert.equal(/** @type {NodeJS.ErrnoException | undefined} */ (spawnSync('node', ['-v'], { env: { PATH: bare } }).error)?.code, 'ENOENT', 'node must not be findable on this PATH');
  const r = spawnSync(shim, ['a b', '--x=$HOME', ''], { encoding: 'utf8', env: { PATH: bare } });
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout, 'S a b --x=$HOME \n');
});
test('shim passes arguments through unchanged', () => {
  const root = tmp(), dataDir = path.join(root, 'd'), t = path.join(root, 't.mjs');
  fs.writeFileSync(t, 'console.log(JSON.stringify(process.argv.slice(2)));\n');
  const shim = ensureStableDriver({ dataDir, target: t });
  const args = ['%O', 'a b', "q'uote", '$(touch pwned)', ';x', '*'];
  const r = runShim(shim, ...args); assert.equal(r.status, 0, r.stderr); assert.deepEqual(JSON.parse(r.stdout), args);
});
{
  const setup = () => { const root = tmp(), dataDir = path.join(root, 'd'), t = echoer(root, 't.mjs', 'T'); return { root, dataDir, t, shim: ensureStableDriver({ dataDir, target: t }) }; };
  const unavailable = (r) => {
    assert.equal(r.status, 2, `status ${r.status} stderr ${r.stderr}`); assert.equal(r.stdout, '');
    assert.match(r.stderr, /^open-brain: merge driver unavailable \([^)]+\): run 'brain doctor --fix'\n$/);
  };
  test('shim contract: driver.target missing or empty -> one stderr line, exit 2', () => {
    const { dataDir, shim } = setup(); const f = path.join(dataDir, 'driver.target');
    fs.rmSync(f); unavailable(runShim(shim, 'a'));
    fs.writeFileSync(f, ''); unavailable(runShim(shim, 'a'));
    fs.writeFileSync(f, '\n'); unavailable(runShim(shim, 'a'));
  });
  test('shim contract: driver.node missing or empty -> one stderr line, exit 2', () => {
    const { dataDir, shim } = setup(); const f = path.join(dataDir, 'driver.node');
    fs.rmSync(f); unavailable(runShim(shim, 'a'));
    fs.writeFileSync(f, ''); unavailable(runShim(shim, 'a'));
    fs.writeFileSync(f, '\n'); unavailable(runShim(shim, 'a'));
  });
  test('shim contract: target path unreadable -> one stderr line, exit 2', () => {
    const { t, shim } = setup(); fs.rmSync(t); unavailable(runShim(shim, 'a'));
  });
  test('shim contract: node path not executable -> one stderr line, exit 2', () => {
    const { root, dataDir, shim } = setup(); const fake = path.join(root, 'fake-node'); fs.writeFileSync(fake, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
    fs.writeFileSync(path.join(dataDir, 'driver.node'), fake + '\n'); unavailable(runShim(shim, 'a'));
    fs.writeFileSync(path.join(dataDir, 'driver.node'), path.join(root, 'absent') + '\n'); unavailable(runShim(shim, 'a'));
  });
}
test('ensureStableDriver validates its inputs', () => {
  const root = tmp(), t = echoer(root, 't.mjs', 'T');
  const bad = (o) => assert.throws(() => ensureStableDriver({ dataDir: root, target: t, ...o }), TypeError);
  bad({ dataDir: 'rel/dir' }); bad({ dataDir: undefined }); bad({ target: 'rel.mjs' }); bad({ target: path.join(root, 'nope.mjs') });
  bad({ target: root }); bad({ nodePath: 'node' }); bad({ nodePath: '' });
});
test('ensureStableDriver is idempotent (identical bytes) and records the node path', () => {
  const root = tmp(), t = echoer(root, 't.mjs', 'T'), dataDir = path.join(root, 'd'); fs.mkdirSync(dataDir);
  const files = ['bin/brain-merge', 'driver.target', 'driver.node'];
  ensureStableDriver({ dataDir, target: t }); const one = files.map((f) => fs.readFileSync(path.join(dataDir, f), 'utf8'));
  ensureStableDriver({ dataDir, target: t }); const two = files.map((f) => fs.readFileSync(path.join(dataDir, f), 'utf8'));
  assert.deepEqual(one, two); assert.equal(one[1], t + '\n'); assert.equal(one[2], process.execPath + '\n');
  assert.equal(fs.statSync(path.join(dataDir, 'driver.target')).mode & 0o777, 0o644);
});
const mode = (f) => fs.statSync(f).mode & 0o777;
test('data directory trust root: a fresh data dir and bin/ are created 0700', () => {
  const root = tmp(), dataDir = path.join(root, 'fresh'), t = echoer(root, 't.mjs', 'T');
  ensureStableDriver({ dataDir, target: t });
  assert.equal(mode(dataDir), 0o700); assert.equal(mode(path.join(dataDir, 'bin')), 0o700);
});
test('data directory trust root: refuses a group/world-writable data dir, a writable bin/, a symlinked dir; accepts 0700 and 0755 unchanged', () => {
  const root = tmp(), t = echoer(root, 't.mjs', 'T'), refuse = (dataDir) => assert.throws(() => ensureStableDriver({ dataDir, target: t }), (e) => e instanceof TypeError && /^data directory is not private: /.test(e.message));
  const open = path.join(root, 'open'); fs.mkdirSync(open); fs.chmodSync(open, 0o777); refuse(open); assert.equal(mode(open), 0o777, 'not silently chmodded'); assert.equal(fs.existsSync(path.join(open, 'bin')), false);
  const gw = path.join(root, 'gw'); fs.mkdirSync(gw); fs.chmodSync(gw, 0o775); refuse(gw);
  const bin = path.join(root, 'binw'); fs.mkdirSync(path.join(bin, 'bin'), { recursive: true, mode: 0o700 }); fs.chmodSync(path.join(bin, 'bin'), 0o770); refuse(bin); assert.equal(mode(path.join(bin, 'bin')), 0o770);
  const real = path.join(root, 'real'); fs.mkdirSync(real, { mode: 0o700 }); const link = path.join(root, 'link'); fs.symlinkSync(real, link); refuse(link);
  const binLink = path.join(root, 'bl'); fs.mkdirSync(binLink, { mode: 0o700 }); fs.symlinkSync(real, path.join(binLink, 'bin')); refuse(binLink);
  for (const m of [0o700, 0o755]) { const d = path.join(root, `ok${m.toString(8)}`); fs.mkdirSync(d); fs.chmodSync(d, m); ensureStableDriver({ dataDir: d, target: t }); assert.equal(mode(d), m); }
});
test('defaultDataDir', () => {
  assert.equal(defaultDataDir({ CLAUDE_PLUGIN_DATA: '/var/pd' }, '/h'), '/var/pd');
  assert.equal(defaultDataDir({}, '/h'), path.join('/h', '.cache', 'project-brain'));
  assert.equal(defaultDataDir({ CLAUDE_PLUGIN_DATA: '' }, '/h'), path.join('/h', '.cache', 'project-brain'));
  assert.equal(defaultDataDir({ CLAUDE_PLUGIN_DATA: 'relative' }, '/h'), path.join('/h', '.cache', 'project-brain'));
});
const gitRepo = () => { const d = tmp('drv-repo-'); execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: d }); return d; };
test('installMergeDriver refuses a versioned plugin-cache path', () => {
  const d = gitRepo();
  assert.throws(() => S.installMergeDriver(d, { driverPath: '/home/u/.claude/plugins/cache/mkt/open-brain/1.2.3/bin/brain-merge' }), (e) => e instanceof TypeError && /plugins\/cache/.test(e.message));
});
test('doctorMergeDriver reports each stale-shim problem', () => {
  const root = tmp(), dataDir = path.join(root, 'd'); fs.mkdirSync(dataDir);
  const t = echoer(root, 't.mjs', 'T'), shim = ensureStableDriver({ dataDir, target: t });
  const d = gitRepo(); S.installMergeDriver(d, { driverPath: shim });
  assert.deepEqual(S.doctorMergeDriver(d).problems.filter((p) => !/gitattributes/.test(p)), []);
  const probs = () => S.doctorMergeDriver(d).problems.filter((p) => !/gitattributes/.test(p));
  const has = (re) => probs().some((p) => re.test(p));
  fs.rmSync(t); assert.ok(has(/driver\.target/), 'target points to a missing file');
  fs.writeFileSync(t, ''); assert.deepEqual(probs(), []);
  fs.rmSync(path.join(dataDir, 'driver.target')); assert.ok(has(/driver\.target/), 'driver.target missing');
  ensureStableDriver({ dataDir, target: t }); fs.writeFileSync(path.join(dataDir, 'driver.node'), path.join(root, 'no-node') + '\n'); assert.ok(has(/driver\.node/), 'node missing');
  ensureStableDriver({ dataDir, target: t }); assert.deepEqual(probs(), []);
  execFileSync('git', ['config', 'merge.brain-jsonl.driver', '/x/plugins/cache/p/1/bin/brain-merge %O %A %B %P'], { cwd: d });
  assert.ok(has(/plugins\/cache/), 'versioned path configured');
});

// ---- REAL git merge through the shim, surviving a target move ----
const GENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: GENV, stdio: ['ignore', 'pipe', 'pipe'] });
const T = S.SCHEMAS['tickets.jsonl'], tk = (key, o = {}) => ({ key, summary: 's-' + key, epic: 'E', sp: 1, v2_owner: 'Ana', v2_sprint: 1, ...o });
function scenario(shim, tag) {
  const d = tmp('drv-git-'); git(d, 'init', '-q', '-b', 'main'); git(d, 'config', 'user.name', 't'); git(d, 'config', 'user.email', 't@example.invalid'); git(d, 'config', 'commit.gpgsign', 'false');
  fs.mkdirSync(path.join(d, '.brain')); S.installMergeDriver(d, { driverPath: shim });
  const put = (recs) => fs.writeFileSync(path.join(d, '.brain/tickets.jsonl'), S.canonFile(recs, T)), commit = (m) => { git(d, 'add', '-A'); git(d, 'commit', '-qm', m); };
  put([tk('T-1'), tk('T-2'), tk('T-3')]); commit('base'); git(d, 'checkout', '-qb', 'feature');
  put([tk('T-1', { sp: 8 }), tk('T-2'), tk('T-3'), tk('T-31' + tag)]); commit('feature'); git(d, 'checkout', '-q', 'main');
  put([tk('T-1', { summary: 'renamed' }), tk('T-2'), tk('T-3'), tk('T-32' + tag)]); commit('main');
  return d;
}
test('real git merge via the shim keeps working after the target moves (same git config)', () => {
  const root = tmp(), dataDir = path.join(root, 'data dir'); fs.mkdirSync(dataDir);
  const v1 = path.join(root, 'v1'), v2 = path.join(root, 'v2');
  for (const v of [v1, v2]) { fs.mkdirSync(path.join(v, 'bin'), { recursive: true }); fs.symlinkSync(path.resolve(REAL, '..', '..', 'lib'), path.join(v, 'lib')); }
  fs.copyFileSync(REAL, path.join(v1, 'bin/brain-merge')); fs.copyFileSync(REAL, path.join(v2, 'bin/brain-merge'));
  const shim = ensureStableDriver({ dataDir, target: path.join(v1, 'bin/brain-merge') });
  const want = (tag) => S.canonFile([tk('T-1', { sp: 8, summary: 'renamed' }), tk('T-2'), tk('T-3'), tk('T-31' + tag), tk('T-32' + tag)], T);
  let d = scenario(shim, 'a'); git(d, 'merge', '--no-edit', 'feature'); assert.equal(fs.readFileSync(path.join(d, '.brain/tickets.jsonl'), 'utf8'), want('a'));
  const cfg = git(d, 'config', '--get', 'merge.brain-jsonl.driver');
  fs.rmSync(v1, { recursive: true }); ensureStableDriver({ dataDir, target: path.join(v2, 'bin/brain-merge') });
  d = scenario(shim, 'b'); assert.equal(git(d, 'config', '--get', 'merge.brain-jsonl.driver'), cfg);
  git(d, 'merge', '--no-edit', 'feature'); assert.equal(fs.readFileSync(path.join(d, '.brain/tickets.jsonl'), 'utf8'), want('b'));
});
