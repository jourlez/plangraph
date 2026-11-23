// Stale install repair: after a plugin update the old versioned install dir may still exist, so the recorded driver.target (a readable
// file) kept pointing at the OLD plugin's brain-merge and doctor saw no problem. Doctor now reports a driver.target that is not the running
// plugin's brain-merge (real paths compared), `doctor --fix` and the session hook's `card --heal` repair it (the hook silently).
// A version bump is simulated by running a COPY of the plugin from another directory; Windows is skipped (POSIX sh shim).
import baseTest, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const test = (name, fn) => baseTest(name, { skip: process.platform === 'win32' }, fn);
const PLUGIN = path.resolve(import.meta.dirname, '..');
const made = [];
const tmp = (p) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p))); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const BASE_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: BASE_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
const copyPlugin = () => { const d = tmp('ds-plugin-'); for (const n of ['bin', 'lib', 'src', 'package.json', 'seed']) fs.cpSync(path.join(PLUGIN, n), path.join(d, n), { recursive: true }); return d; };
function world() {
  const dataDir = tmp('ds-data-'), home = tmp('ds-home-'), repo = tmp('ds-repo-');
  git(repo, 'init', '-q', '-b', 'main');
  const env = { ...BASE_ENV, HOME: home, CLAUDE_PLUGIN_DATA: dataDir };
  const brain = (plugin, args) => spawnSync(process.execPath, [path.join(plugin, 'bin/brain'), ...args], { cwd: repo, env, encoding: 'utf8' });
  return { dataDir, repo, brain, target: () => fs.readFileSync(path.join(dataDir, 'driver.target'), 'utf8') };
}
const ok = (r) => { assert.equal(r.status, 0, `status ${r.status}\nstdout ${r.stdout}\nstderr ${r.stderr}`); return r; };
const want = (plugin) => path.join(plugin, 'bin/brain-merge') + '\n';

test('version bump with the old install still present: doctor reports the other install (exit 1, nothing changed), --fix repoints it', () => {
  const w = world(), v1 = copyPlugin(), v2 = copyPlugin();
  ok(w.brain(v1, ['init']));
  assert.equal(w.target(), want(v1));
  const d = w.brain(v2, ['doctor']);
  assert.equal(d.status, 1, d.stdout);
  const line = d.stdout.split('\n').find((l) => l.startsWith('merge driver:'));
  assert.equal(line, `merge driver: merge driver.target points to another plugin install, not the running one: ${path.join(v1, 'bin/brain-merge')}: run \`brain doctor --fix\``);
  assert.equal(w.target(), want(v1)); // a report only
  assert.match(ok(w.brain(v2, ['doctor', '--fix'])).stdout, /^merge driver: ok$/m);
  assert.equal(w.target(), want(v2));
  assert.match(ok(w.brain(v2, ['doctor'])).stdout, /^merge driver: ok$/m);
});

test('version bump with the old install still present: card --if-present --heal repoints driver.target silently', () => {
  const w = world(), v1 = copyPlugin(), v2 = copyPlugin();
  ok(w.brain(v1, ['init']));
  const r = ok(w.brain(v2, ['card', '--if-present', '--heal']));
  assert.equal(r.stdout + r.stderr, '');
  assert.equal(w.target(), want(v2));
});

test('the old install removed: heal repoints driver.target at the running plugin', () => {
  const w = world(), v1 = copyPlugin(), v2 = copyPlugin();
  ok(w.brain(v1, ['init']));
  fs.rmSync(v1, { recursive: true });
  const r = ok(w.brain(v2, ['card', '--if-present', '--heal']));
  assert.equal(r.stdout + r.stderr, '');
  assert.equal(w.target(), want(v2));
});

test('the same install reached through a symlinked path is not "another install" (no repair loop)', () => {
  const w = world(), v1 = copyPlugin(), link = path.join(tmp('ds-link-'), 'current');
  fs.symlinkSync(v1, link);
  ok(w.brain(link, ['init']));
  assert.match(ok(w.brain(v1, ['doctor'])).stdout, /^merge driver: ok$/m);
  assert.match(ok(w.brain(link, ['doctor'])).stdout, /^merge driver: ok$/m);
});
