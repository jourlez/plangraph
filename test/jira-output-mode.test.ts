// Jira outputs (snapshots, issue text) carry tenant data: they are written 0600 so other users on a shared host cannot read them. Other
// writers keep 0644 (minus the umask). Runs the CLI offline: jira-text --from-json and jira-import never touch the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const BIN = path.resolve('bin/brain'), ISSUE = path.resolve('test/fixtures/jira-connector-issue.json');
const run = (dir: string, args: string[]) => spawnSync(process.execPath, [BIN, ...args], { cwd: dir, env: { PATH: process.env.PATH, HOME: dir }, encoding: 'utf8' });
const modeOf = (f: string) => fs.statSync(f).mode & 0o777;

test('jira-text and jira-import write their outputs 0600; init writes config.json 0644', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-jira-mode-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  assert.equal(run(dir, ['init']).status, 0);
  assert.equal(modeOf(path.join(dir, '.plangraph', 'config.json')), 0o644 & ~process.umask()); // init writes through writeState (the same helper, default mode)
  fs.copyFileSync(ISSUE, path.join(dir, 'issue.json'));
  const text = run(dir, ['jira-text', 'DEMO-1', '--out', 'jt', '--from-json', 'issue.json']);
  assert.equal(text.status, 0, text.stderr);
  assert.equal(modeOf(path.join(dir, 'jt', 'DEMO-1.txt')), 0o600 & ~process.umask());
  const imp = run(dir, ['jira-import', 'issue.json', '--out', 'snap.jsonl']);
  assert.equal(imp.status, 0, imp.stderr);
  assert.equal(modeOf(path.join(dir, 'snap.jsonl')), 0o600 & ~process.umask());
});
