import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const BIN = path.resolve('bin/brain');
function run(dir, env, args) {
  const clean = { PATH: process.env.PATH, HOME: dir, ...env };
  return spawnSync(process.execPath, [BIN, ...args], { cwd: dir, env: clean, encoding: 'utf8' });
}
function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-doctor-jira-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  assert.equal(run(dir, {}, ['init']).status, 0);
  return dir;
}
const cfgPath = (dir) => path.join(dir, '.brain', 'config.json');
const setJira = (dir, jira) => { const c = JSON.parse(fs.readFileSync(cfgPath(dir), 'utf8')); c.jira = jira; fs.writeFileSync(cfgPath(dir), JSON.stringify(c)); };
const jiraLine = (r) => r.stdout.split('\n').find((l) => l.startsWith('jira:')) || '';

test('doctor says jira is not configured when the config is empty', () => {
  const dir = repo();
  assert.match(jiraLine(run(dir, {}, ['doctor'])), /^jira: not configured/);
});

test('doctor reports credential presence without printing any secret', () => {
  const dir = repo();
  setJira(dir, { auth: { mode: 'site-token' }, base_url: 'https://acme.atlassian.net', jql: 'project = ABC' });
  const none = jiraLine(run(dir, {}, ['doctor']));
  assert.match(none, /NO credential bound to acme\.atlassian\.net/);
  const secret = 'tok-SECRET-123';
  const r = run(dir, { JIRA_EMAIL: 'a@b.co', JIRA_API_TOKEN: secret, BRAIN_JIRA_SITES: 'acme.atlassian.net' }, ['doctor']);
  assert.match(jiraLine(r), /generic env JIRA_EMAIL \+ JIRA_API_TOKEN set/);
  assert.ok(!r.stdout.includes(secret) && !r.stderr.includes(secret));
});
