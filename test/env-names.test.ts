// Every runtime environment variable is read under its PLANGRAPH_ name only: the name used before the rename (BRAIN_) has no effect. One
// test per group: the plan directory (CLI and the Python solver), the user config folder, the Jira trust allowlists, the session card
// switch, the strict-output switch and the solver launcher (its script override; launch mode and parent watch are pinned with the new
// names by test/solver-launcher.test.ts and test/solver.test.ts). The old names are assembled so that a scan for them finds this file only
// through the variable name prefix.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { makeContext } from '../src/context.ts';
import { configDir } from '../src/jira-tenant.ts';
import { dcHostsFromEnv, siteHostsFromEnv, validateBase } from '../lib/jira.ts';
import { strictOutput } from '../src/cli.ts';
import { run, tmp, made } from './helpers/cli-fixture.ts';

const OLD = (s: string) => ['BRAIN', s].join('_');
const tmps: string[] = [];
after(() => { for (const d of [...tmps, ...made]) fs.rmSync(d, { recursive: true, force: true }); });
const repo = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-env-'))); tmps.push(d); execFileSync('git', ['init', '-q'], { cwd: d }); fs.mkdirSync(path.join(d, 'custom')); return d; };

test('PLANGRAPH_DIR picks the plan directory; the old variable is ignored', () => {
  const d = repo();
  assert.equal(makeContext({ cwd: d, env: { PLANGRAPH_DIR: 'custom' } }).dir, path.join(d, 'custom'));
  assert.notEqual(makeContext({ cwd: d, env: { [OLD('DIR')]: 'custom' } }).dir, path.join(d, 'custom'));
});

const HAVE_PY3 = spawnSync('python3', ['--version'], { stdio: 'ignore' }).status === 0;
test('the Python solver reads PLANGRAPH_DIR; the old variable is ignored', { skip: HAVE_PY3 ? false : 'no python3' }, () => {
  const d = repo();
  const body = "import importlib.machinery, importlib.util, sys\nl = importlib.machinery.SourceFileLoader('s', sys.argv[1]); m = importlib.util.module_from_spec(importlib.util.spec_from_loader('s', l)); l.exec_module(m)\nprint(m.brain_dir())\n";
  const dirOf = (env: Record<string, string>) => {
    const r = spawnSync('python3', ['-I', '-c', body, path.join(import.meta.dirname, '../bin/plangraph-solve')], { cwd: d, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...env }, timeout: 15000 });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  assert.equal(dirOf({ PLANGRAPH_DIR: 'custom' }), path.join(d, 'custom'));
  assert.notEqual(dirOf({ [OLD('DIR')]: 'custom' }), path.join(d, 'custom'));
});

test('PLANGRAPH_CONFIG_DIR picks the user config folder; the old variable is ignored', () => {
  assert.equal(configDir({ HOME: '/h', PLANGRAPH_CONFIG_DIR: '/c' }), path.resolve('/c'));
  assert.notEqual(configDir({ HOME: '/h', [OLD('CONFIG_DIR')]: '/c' }), path.resolve('/c'));
});

test('PLANGRAPH_JIRA_SITES and PLANGRAPH_JIRA_DC_HOSTS are the trust allowlists; the old variables allow nothing', () => {
  assert.deepEqual(siteHostsFromEnv({ PLANGRAPH_JIRA_SITES: 'a.atlassian.net' }), ['a.atlassian.net']);
  assert.deepEqual(siteHostsFromEnv({ [OLD('JIRA_SITES')]: 'a.atlassian.net' }), []);
  assert.deepEqual(dcHostsFromEnv({ PLANGRAPH_JIRA_DC_HOSTS: 'jira.example.invalid' }), ['jira.example.invalid']);
  assert.deepEqual(dcHostsFromEnv({ [OLD('JIRA_DC_HOSTS')]: 'jira.example.invalid' }), []);
  assert.throws(() => validateBase('https://jira.example.invalid', { mode: 'datacenter', dcHosts: dcHostsFromEnv({ [OLD('JIRA_DC_HOSTS')]: 'jira.example.invalid' }).join(',') }), /allowlist \(PLANGRAPH_JIRA_DC_HOSTS\)/);
});

test('PLANGRAPH_STRICT_OUT=0 turns strict output off under the test runner; the old variable does not', () => {
  assert.equal(strictOutput({ PLANGRAPH_STRICT_OUT: '0' }), false);
  assert.equal(strictOutput({ [OLD('STRICT_OUT')]: '0' }), true);
});

test('PLANGRAPH_CARD=off silences the session card; the old variable does not', async () => {
  const d = tmp(); execFileSync('git', ['init', '-q'], { cwd: d });
  assert.equal((await run(d, ['init'])).code, 0); assert.equal((await run(d, ['build'])).code, 0);
  assert.deepEqual((await run(d, ['card', '--if-present'], { PLANGRAPH_CARD: 'off' })).out, []);
  assert.notDeepEqual((await run(d, ['card', '--if-present'], { [OLD('CARD')]: 'off' })).out, []);
});

test('PLANGRAPH_SOLVE_SCRIPT overrides the solver script of the launcher; the old variable does not', { skip: process.platform === 'win32' }, () => {
  const d = repo(), bin = path.join(d, 'fakebin'), stub = path.join(d, 'stub.py'), log = path.join(d, 'uv.log');
  fs.mkdirSync(bin); fs.writeFileSync(stub, '');
  // a fake uv that records its argv, answers `uv python find` with an absolute executable and does nothing for `uv run`
  fs.writeFileSync(path.join(bin, 'uv'), `#!/bin/sh\necho "$@" >> '${log}'\n[ "$1 $2" = "python find" ] && echo /bin/sh\nexit 0\n`, { mode: 0o755 });
  for (const sh of ['dirname']) { const p = execFileSync('sh', ['-c', `command -v ${sh}`], { encoding: 'utf8' }).trim(); if (p) fs.symlinkSync(p, path.join(bin, sh)); }
  const launch = (env: Record<string, string>) => { fs.rmSync(log, { force: true }); spawnSync(path.join(import.meta.dirname, '../bin/plangraph-solve-run'), ['--out', path.join(d, 'o.json')], { cwd: d, encoding: 'utf8', env: { PATH: bin, HOME: d, CLAUDE_PLUGIN_DATA: path.join(d, 'data'), PLANGRAPH_SOLVE_LAUNCH: 'uv-run', ...env }, timeout: 30000 }); return fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''; };
  assert.match(launch({ PLANGRAPH_SOLVE_SCRIPT: stub }), /stub\.py/);
  assert.doesNotMatch(launch({ [OLD('SOLVE_SCRIPT')]: stub }), /stub\.py/);
});
