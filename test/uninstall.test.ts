// plangraph uninstall: removes what init, githooks-install and docs-build added (unmodified .githooks scripts, the .gitignore lines plangraph
// wrote, and after confirmation the cache, the index and the staging directory) and never touches nodes/, events/, runs/, schedules/,
// config.json or format.json. Runs the real CLI in a throwaway git repository with a private HOME.
// NOT covered: the interactive "y" answer (a test has no terminal; --yes is the same code path after confirmation).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { genPlan } from './fixtures/gen.ts';
import { writePlanDir, readTree } from './helpers/plan-dir.ts';

const BIN = path.join(import.meta.dirname, '../bin/plangraph');
const made: string[] = [];
test.after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

function world(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-uninstall-'))); made.push(root);
  const home = path.join(root, 'home'); fs.mkdirSync(home);
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n*.log\n');
  assert.equal(cli(repo, ['init']).status, 0);
  writePlanDir(path.join(repo, '.plangraph'), genPlan({ n: 6, people: 2, seed: 3, cap: 8 }));
  assert.equal(cli(repo, ['githooks-install']).status, 0);
  assert.equal(cli(repo, ['build']).status, 0);
  fs.mkdirSync(path.join(repo, '.plangraph/cache'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.plangraph/cache/git.jsonl'), '{}\n');
  return repo;
}
function cli(cwd: string, args: string[]) {
  const home = path.join(path.dirname(cwd), 'home');
  return spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', stdin: 'ignore', env: { PATH: process.env.PATH, HOME: home, CLAUDE_PLUGIN_DATA: path.join(home, 'data'), LC_ALL: 'C', PLANGRAPH_DIR: '', PLANGRAPH_STRICT_OUT: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } } as never);
}
const committed = (repo: string): Record<string, string> => {
  const all = readTree(path.join(repo, '.plangraph'));
  return Object.fromEntries(Object.entries(all).filter(([k]) => !/^(cache|\.txn)\//.test(k) && k !== '.gitignore'));
};

test('uninstall without --yes removes the hooks and keeps the cache, the index and their ignore lines', () => {
  const repo = world(), before = committed(repo);
  const r = cli(repo, ['uninstall']);
  assert.equal(r.status, 0, r.stderr);
  for (const h of ['post-commit', 'post-merge', 'post-checkout', 'post-rewrite']) assert.equal(fs.existsSync(path.join(repo, '.githooks', h)), false, h);
  assert.equal(fs.existsSync(path.join(repo, '.githooks')), false, 'the empty hooks directory goes too');
  assert.ok(fs.existsSync(path.join(repo, '.plangraph/plangraph.sqlite')));
  assert.ok(fs.existsSync(path.join(repo, '.plangraph/cache/git.jsonl')));
  assert.match(fs.readFileSync(path.join(repo, '.plangraph/.gitignore'), 'utf8'), /cache\/[\s\S]*plangraph\.sqlite\*/);
  assert.match(r.stdout, /kept cache\/, plangraph\.sqlite\*.* \(pass --yes/);
  assert.deepEqual(committed(repo), before);
});

test('uninstall --yes removes the cache, the index and the plangraph ignore lines, keeps user lines, and leaves the plan data byte for byte', () => {
  const repo = world(), before = committed(repo);
  assert.ok(Object.keys(before).some((k) => k.startsWith('nodes/')) && 'config.json' in before && 'format.json' in before);
  const r = cli(repo, ['uninstall', '--yes']);
  assert.equal(r.status, 0, r.stderr);
  for (const f of ['cache', 'plangraph.sqlite', '.gitignore']) assert.equal(fs.existsSync(path.join(repo, '.plangraph', f)), false, f);
  assert.equal(fs.readFileSync(path.join(repo, '.gitignore'), 'utf8'), 'node_modules/\n*.log\n', 'only the lines plangraph wrote are gone');
  assert.deepEqual(committed(repo), before);
  assert.match(r.stdout, /kept nodes\/ events\/ runs\/ schedules\/ config\.json format\.json/);
  // idempotent: a second run changes nothing and still exits 0
  const again = cli(repo, ['uninstall', '--yes']);
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(committed(repo), before);
});

test('a hook script you edited is kept, and so is a script plangraph never wrote', () => {
  const repo = world();
  fs.appendFileSync(path.join(repo, '.githooks/post-merge'), 'echo mine\n');
  fs.writeFileSync(path.join(repo, '.githooks/commit-msg'), '#!/bin/sh\nexit 0\n');
  const r = cli(repo, ['uninstall']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /kept \.githooks\/post-merge/);
  assert.ok(fs.existsSync(path.join(repo, '.githooks/post-merge')));
  assert.ok(fs.existsSync(path.join(repo, '.githooks/commit-msg')));
  assert.equal(fs.existsSync(path.join(repo, '.githooks/post-commit')), false);
});

test('a user line added to the plan directory .gitignore survives, and a directory with no plangraph setup is not an error', () => {
  const repo = world();
  fs.appendFileSync(path.join(repo, '.plangraph/.gitignore'), 'scratch/\n');
  assert.equal(cli(repo, ['uninstall', '--yes']).status, 0);
  assert.equal(fs.readFileSync(path.join(repo, '.plangraph/.gitignore'), 'utf8'), 'scratch/\n');
  const bare = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-uninstall-bare-'))); made.push(bare);
  fs.mkdirSync(path.join(bare, 'home'));
  execFileSync('git', ['init', '-q', path.join(bare, 'r')], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
  const r = cli(path.join(bare, 'r'), ['uninstall', '--yes']);
  assert.equal(r.status, 0, r.stderr);
});

test('a symlinked cache is unlinked, never followed', () => {
  const repo = world(), outside = path.join(path.dirname(repo), 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'keep.txt'), 'x');
  fs.rmSync(path.join(repo, '.plangraph/cache'), { recursive: true }); fs.symlinkSync(outside, path.join(repo, '.plangraph/cache'));
  assert.equal(cli(repo, ['uninstall', '--yes']).status, 0);
  assert.ok(fs.existsSync(path.join(outside, 'keep.txt')), 'the target of the link stays');
  assert.equal(fs.existsSync(path.join(repo, '.plangraph/cache')), false);
});
