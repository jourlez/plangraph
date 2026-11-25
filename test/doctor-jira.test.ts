import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const BIN = path.resolve('bin/brain');
function run(dir: string, env: Record<string, string>, args: string[]) {
  const clean = { PATH: process.env.PATH, HOME: dir, ...env };
  return spawnSync(process.execPath, [BIN, ...args], { cwd: dir, env: clean, encoding: 'utf8' });
}
function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-doctor-jira-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  assert.equal(run(dir, {}, ['init']).status, 0);
  return dir;
}
const cfgPath = (dir: string) => path.join(dir, '.plangraph', 'config.json');
const setJira = (dir: string, jira: unknown) => { const c = JSON.parse(fs.readFileSync(cfgPath(dir), 'utf8')); c.jira = jira; fs.writeFileSync(cfgPath(dir), JSON.stringify(c)); };
const jiraLine = (r: { stdout: string }) => r.stdout.split('\n').find((l) => l.startsWith('jira:')) || '';

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
  const r = run(dir, { JIRA_EMAIL: 'a@b.co', JIRA_API_TOKEN: secret, PLANGRAPH_JIRA_SITES: 'acme.atlassian.net' }, ['doctor']);
  assert.match(jiraLine(r), /generic env JIRA_EMAIL \+ JIRA_API_TOKEN set/);
  assert.ok(!r.stdout.includes(secret) && !r.stderr.includes(secret));
});

test('doctor says an unknown auth mode makes the config invalid', () => {
  const dir = repo();
  setJira(dir, { auth: { mode: 'Site-Token' }, base_url: 'https://evil.atlassian.net', jql: 'project = ABC' });
  const line = jiraLine(run(dir, { JIRA_EMAIL: 'a@b.co', JIRA_API_TOKEN: 'tok-SECRET-123' }, ['doctor']));
  assert.match(line, /^jira: invalid config: auth\.mode must be scoped, site-token or datacenter; `brain jira-pull` refuses it/);
});

test('doctor says a multi-host Data Center tenant needs a binding; one host may use generic credentials', () => {
  const dir = repo();
  setJira(dir, { auth: { mode: 'datacenter' }, base_url: 'https://jira.beta.example', jql: 'project = ABC' });
  const gen = { JIRA_EMAIL: 'a@b.co', JIRA_API_TOKEN: 'tok-SECRET-123' };
  const two = jiraLine(run(dir, { ...gen, PLANGRAPH_JIRA_DC_HOSTS: 'jira.acme.example,jira.beta.example' }, ['doctor']));
  assert.match(two, /^jira: datacenter, tenant jira\.beta\.example, jql set, NO credential bound to jira\.beta\.example: /);
  const one = jiraLine(run(dir, { ...gen, PLANGRAPH_JIRA_DC_HOSTS: 'jira.beta.example' }, ['doctor']));
  assert.match(one, /generic env JIRA_EMAIL \+ JIRA_API_TOKEN set$/);
});
