// The plugin as Claude Code installs it: copied (no node_modules, no .git) under a path with a space and a non-ASCII letter, run with the
// real node from a working directory that declares "type": "commonjs" and holds a stray tsconfig.json.
// Covered: `brain doctor` and `brain card --if-present` exit 0 with EMPTY stderr (any Node warning would break the SessionStart hook output),
// the working directory's package.json and tsconfig.json do not change how the plugin loads, and a Node older than the floor gets exit 3 with
// the floor message (exit 0 and silent with --if-present) because the guard is plain JavaScript.
// NOT covered: a real old Node binary (the version is overridden by an --import preload, as in test/floor.test.ts).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { floorMessage, floorTry } from '../src/floor.js';

const ROOT = path.join(import.meta.dirname, '..');
const SKIP_DIRS = /^(test|docs|evals|\.git|\.baseline|node_modules|\.superpowers|\.claude)(\/|$)/;

let base: string, plugin: string, work: string, home: string;

const env = () => ({ ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'), PLANGRAPH_DIR: '', NODE_OPTIONS: '' });
const run = (args: string[], nodeArgs: string[] = []) => spawnSync(process.execPath, [...nodeArgs, path.join(plugin, 'bin', 'brain'), ...args], { cwd: work, encoding: 'utf8', env: env() });

before(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-install-')));
  plugin = path.join(base, 'with space é', 'plangraph', '0.0.0');
  const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter((f) => f && !SKIP_DIRS.test(f) && fs.existsSync(path.join(ROOT, f)));
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(plugin, f)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, f), path.join(plugin, f));
    fs.chmodSync(path.join(plugin, f), fs.statSync(path.join(ROOT, f)).mode);
  }
  work = path.join(base, 'work');
  home = path.join(base, 'home');
  fs.mkdirSync(work); fs.mkdirSync(home);
  fs.writeFileSync(path.join(work, 'package.json'), '{ "name": "stray", "type": "commonjs" }\n');
  fs.writeFileSync(path.join(work, 'tsconfig.json'), '{ "compilerOptions": { "module": "commonjs", "strict": true } }\n');
  execFileSync('git', ['init', '-q'], { cwd: work }); // a healthy brain for doctor: `brain init` from the copy
  const r = run(['init']);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.equal(r.stderr, '');
});
after(() => fs.rmSync(base, { recursive: true, force: true }));

test('the copy sits under a path with a space and a non-ASCII letter and has no node_modules segment', () => {
  assert.match(plugin, / é\//);
  assert.ok(!plugin.split(path.sep).includes('node_modules'));
  assert.ok(fs.existsSync(path.join(plugin, 'bin', 'brain')) && fs.existsSync(path.join(plugin, 'package.json')));
  assert.ok(!fs.existsSync(path.join(plugin, 'node_modules')) && !fs.existsSync(path.join(plugin, '.git')));
});

test('brain doctor runs from the copy: exit 0, empty stderr (cwd package.json says commonjs)', () => {
  const r = run(['doctor']);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.equal(r.stderr, '');
  assert.match(r.stdout, /node v\d+\.\d+\.\d+: ok/);
});

test('brain card --if-present runs from the copy: exit 0, empty stderr', () => {
  const r = run(['card', '--if-present']);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.equal(r.stderr, '');
});

test('too-old Node via an --import stub: exit 3 with the floor message; exit 0 and silent with --if-present', () => {
  const stub = path.join(base, 'old node.mjs');
  fs.writeFileSync(stub, 'Object.defineProperty(process.versions, "node", { value: "22.0.0" });\nObject.defineProperty(process, "version", { value: "v22.0.0" });\n');
  const pre = ['--import', pathToFileURL(stub).href];
  let r = run(['doctor'], pre);
  assert.equal(r.status, 3, `${r.stdout}\n${r.stderr}`);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, `${floorMessage('v22.0.0')}\n${floorTry}\n`);
  r = run(['card', '--if-present'], pre);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
});
