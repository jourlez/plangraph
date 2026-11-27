// `githooks-install` (Task 29) and the shipped templates.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { world, run, git, cleanup } from './helpers/hook-world.ts';

after(cleanup);
const PLUGIN = path.resolve(import.meta.dirname, '..');
const NAMES = ['post-checkout', 'post-commit', 'post-merge', 'post-rewrite'];

test('--dry-run lists the files and writes none', async () => {
  const w = world();
  const r = await run(w.root, ['githooks-install', '--dry-run', '--pre-commit']);
  assert.equal(r.code, 0);
  for (const n of [...NAMES, 'pre-commit']) assert.ok(r.out.includes(`would write .githooks/${n}`), r.out.join('\n'));
  assert.equal(fs.existsSync(path.join(w.root, '.githooks')), false);
  assert.equal(git(w.root, 'status', '--porcelain'), '');
});

test('install writes executable scripts into .githooks, no pre-commit by default, and never touches git config', async () => {
  const w = world();
  const cfg = fs.readFileSync(path.join(w.root, '.git/config'), 'utf8');
  const r = await run(w.root, ['githooks-install']);
  assert.equal(r.code, 0);
  assert.deepEqual(fs.readdirSync(path.join(w.root, '.githooks')).sort(), NAMES);
  for (const n of NAMES) assert.ok(fs.statSync(path.join(w.root, '.githooks', n)).mode & 0o100, `${n} is executable`);
  assert.equal(fs.readFileSync(path.join(w.root, '.git/config'), 'utf8'), cfg);
  const text = r.out.join('\n');
  assert.match(text, /git config core\.hooksPath \.githooks/); assert.match(text, /lefthook/); assert.match(text, /husky/);
  assert.throws(() => git(w.root, 'config', '--get', 'core.hooksPath'), 'core.hooksPath stays unset');
});

test('--pre-commit adds the check script; a rerun changes nothing; an edited script is kept', async () => {
  const w = world();
  await run(w.root, ['githooks-install', '--pre-commit']);
  assert.ok(fs.existsSync(path.join(w.root, '.githooks/pre-commit')));
  const again = await run(w.root, ['githooks-install', '--pre-commit']);
  assert.ok(again.out.every((l) => !l.startsWith('wrote ')));
  fs.appendFileSync(path.join(w.root, '.githooks/post-commit'), '# mine\n');
  const kept = await run(w.root, ['githooks-install']);
  assert.ok(kept.out.some((l) => l.startsWith('kept .githooks/post-commit')));
  assert.match(fs.readFileSync(path.join(w.root, '.githooks/post-commit'), 'utf8'), /# mine/);
});

const tpl = (n: string): string => fs.readFileSync(path.join(PLUGIN, 'templates/githooks', n), 'utf8');

test('every automatic script ends with exit 0 and runs refresh --fast --quiet || true', () => {
  for (const n of NAMES) {
    const t = tpl(n);
    assert.ok(t.startsWith('#!/bin/sh\n'), n);
    assert.ok(t.trimEnd().endsWith('exit 0'), n);
    assert.match(t, /plangraph refresh --fast --quiet \|\| true/, n);
  }
  const pc = tpl('pre-commit');
  assert.match(pc, /plangraph check --quiet/); assert.ok(pc.trimEnd().endsWith('exit 0'));
});

test('the scripts run under sh with exit 0 when plangraph is missing, fails, or stdin is empty (post-rewrite)', () => {
  const bin = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR ?? '/tmp'), 'ghb-'));
  try {
    for (const mode of ['missing', 'failing']) {
      if (mode === 'failing') { fs.writeFileSync(path.join(bin, 'plangraph'), '#!/bin/sh\nexit 7\n', { mode: 0o755 }); }
      const env = { PATH: `${bin}:/usr/bin:/bin` };
      for (const n of NAMES) for (const input of ['', 'abc def\n']) {
        const r = spawnSync('sh', [path.join(PLUGIN, 'templates/githooks', n), 'amend', '0', '1'], { env, input, encoding: 'utf8' });
        assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', ''], `${n} ${mode} ${JSON.stringify(input)}`);
      }
    }
    // a failing check fails the commit only in the pre-commit script
    const pc = spawnSync('sh', [path.join(PLUGIN, 'templates/githooks/pre-commit')], { env: { PATH: `${bin}:/usr/bin:/bin` }, encoding: 'utf8' });
    assert.equal(pc.status, 1);
    const ok = spawnSync('sh', [path.join(PLUGIN, 'templates/githooks/pre-commit')], { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
    assert.equal(ok.status, 0, 'no plangraph on PATH never blocks');
  } finally { fs.rmSync(bin, { recursive: true, force: true }); }
});

test('post-rewrite with a closed stdin exits 0', () => {
  const r = spawnSync('sh', ['-c', `sh ${JSON.stringify(path.join(PLUGIN, 'templates/githooks/post-rewrite'))} amend <&-`], { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
  assert.equal(r.status, 0);
});

test('the CI template carries the required steps', () => {
  const y = fs.readFileSync(path.join(PLUGIN, 'templates/ci/plangraph.yml'), 'utf8');
  for (const needle of ['fetch-depth: 0', 'plangraph build', 'plangraph check', 'plangraph docs-build --commit-ready', 'schedule:', 'plangraph refresh', 'commit_out', 'plangraph compact --ci', 'default_branch']) assert.ok(y.includes(needle), needle);
  assert.ok(!/https?:\/\//.test(y.replace(/^\s*#.*$/gm, '')), 'no URL or host in the template (D24)');
});
