// `plangraph repo scan [--check]` end to end on throwaway git repositories: rows written, only git spawned, determinism across paths,
// --check drift, rename keeps hand-written fields, branch merge order. Not covered: GitHub linking and `touches` (0.5.0).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { canonFile, SCHEMAS } from '../lib/store.ts';

const BRAIN = path.join(import.meta.dirname, '../bin/plangraph'), FX = path.join(import.meta.dirname, 'fixtures/repo-scan');
const fx = (n: string) => fs.readFileSync(path.join(FX, n), 'utf8');
const GIT = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
let BASE = '', n = 0, PATHVAR = process.env.PATH as string;
const env = () => ({ PATH: PATHVAR, HOME: path.join(BASE, 'home'), CLAUDE_PLUGIN_DATA: path.join(BASE, 'data'), LC_ALL: 'C', TZ: 'UTC', PLANGRAPH_DIR: '', SOURCE_DATE_EPOCH: '1795305600', ...GIT });
const run = (cwd: string, args: string[]) => spawnSync(process.execPath, [BRAIN, ...args], { cwd, env: env(), encoding: 'utf8', timeout: 60000 });
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env: env(), stdio: 'ignore' });
const put = (root: string, rel: string, text: string) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
/** A plan repository (initialised) holding the .plangraph directory. */
const plan = (): string => { const d = path.join(BASE, `plan-${n++}`); fs.mkdirSync(d); git(d, 'init', '-q'); assert.equal(run(d, ['init']).status, 0); return d; };
/** A committed repository `name` under a fresh parent directory. */
const repo = (name: string, files: Record<string, string>, parent = path.join(BASE, `p-${n++}`)): string => {
  const d = path.join(parent, name); fs.mkdirSync(d, { recursive: true }); git(d, 'init', '-q');
  for (const [k, v] of Object.entries(files)) put(d, k, v);
  git(d, 'add', '-A'); git(d, 'commit', '-qm', 'c'); return d;
};
const rows = (p: string) => fs.readFileSync(path.join(p, '.plangraph/repos.jsonl'), 'utf8');
const PKG = '{"name":"web","scripts":{"build":"tsc","test":"node --test"},"dependencies":{"react":"1"}}';

before(() => { BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-reposcan-'))); for (const d of ['home', 'data']) fs.mkdirSync(path.join(BASE, d)); });
after(() => { if (BASE) fs.rmSync(BASE, { recursive: true, force: true }); });

test('scan writes one canonical row; a second scan is byte-identical', () => {
  const p = plan(), r = repo('web', { 'package.json': PKG, 'src/a.ts': 'x', 'README.md': 'hi' });
  const s = run(p, ['repo', 'scan', r]);
  assert.equal(s.status, 0, s.stderr);
  const row = JSON.parse(rows(p));
  assert.deepEqual([row.id, row.name, row.src, row.pm, row.runtime, row.frameworks, row.langs, row.scanned_at, row.scanner], ['repo:web', 'web', 'scan', 'npm', 'node', ['react'], ['typescript'], '2026-11-22', 'plangraph-scan/1']);
  const first = rows(p); run(p, ['repo', 'scan', r]);
  assert.equal(rows(p), first);
});

test('two scans of the same content on different paths are byte-identical', () => {
  const [p1, p2] = [plan(), plan()], files = { 'package.json': PKG, 'a.ts': 'x' };
  assert.equal(run(p1, ['repo', 'scan', repo('svc', files)]).status, 0);
  assert.equal(run(p2, ['repo', 'scan', repo('svc', files)]).status, 0);
  assert.equal(rows(p1), rows(p2));
});

test('--check: a script or dependency change fails it, a README change does not, nothing is written', () => {
  const p = plan(), r = repo('web', { 'package.json': PKG, 'README.md': 'a' });
  const miss = run(p, ['repo', 'scan', r, '--check']);
  assert.equal(miss.status, 1); assert.match(miss.stdout, /repo:web: missing/);
  assert.equal(fs.existsSync(path.join(p, '.plangraph/repos.jsonl')), false);
  run(p, ['repo', 'scan', r]);
  put(r, 'README.md', 'changed'); git(r, 'commit', '-qam', 'readme');
  assert.equal(run(p, ['repo', 'scan', r, '--check']).status, 0);
  put(r, 'package.json', PKG.replace('tsc', 'tsc -b')); git(r, 'commit', '-qam', 'script');
  const d = run(p, ['repo', 'scan', r, '--check']);
  assert.equal(d.status, 1); assert.match(d.stdout, /repo:web: drift/);
});

test('only git is spawned: a planted postinstall and Makefile run nothing', () => {
  const shims = path.join(BASE, 'shims'), log = path.join(BASE, 'spawn.log'); fs.mkdirSync(shims);
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(shims, 'git'), `#!/bin/sh\necho git >> '${log}'\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
  for (const t of ['npm', 'npx', 'node-gyp', 'make', 'sh-planted', 'python3', 'pnpm', 'yarn']) fs.writeFileSync(path.join(shims, t), `#!/bin/sh\necho ${t} >> '${log}'\n`, { mode: 0o755 });
  const p = plan(), r = repo('hostile', { 'package.json': fx('hostile-package.json.txt'), Makefile: fx('Makefile.txt'), CODEOWNERS: fx('hostile-CODEOWNERS.txt') });
  PATHVAR = `${shims}:${process.env.PATH}`;
  try { const s = run(p, ['repo', 'scan', r]); assert.equal(s.status, 0, s.stderr); } finally { PATHVAR = process.env.PATH as string; }
  const seen = new Set(fs.readFileSync(log, 'utf8').split('\n').filter(Boolean));
  assert.deepEqual([...seen], ['git']);
  assert.equal(fs.existsSync(path.join(r, 'PLANTED')), false);
  assert.ok(!rows(p).includes('PLANTED'));
});

test('CODEOWNERS owners resolve against people.jsonl; the rest is dropped; an oversized manifest is refused', () => {
  const p = plan(); put(p, '.plangraph/people.jsonl', '{"id":"alice"}\n');
  const r = repo('svc', { CODEOWNERS: '* @alice @ghost\n', 'package.json': ' '.repeat(300 * 1024) + '{}' });
  const s = run(p, ['repo', 'scan', r]);
  assert.equal(s.status, 0, s.stderr); assert.match(s.stderr, /package\.json: over 256 KB/);
  const row = JSON.parse(rows(p));
  assert.deepEqual([row.owners, row.pm], [['alice'], undefined]);
});

test('a tracked symlink manifest is never read', () => {
  const p = plan(), outside = path.join(BASE, 'outside.json'); fs.writeFileSync(outside, '{"name":"leak","dependencies":{"react":"1"}}');
  const d = path.join(BASE, `p-${n++}`, 'lnk'); fs.mkdirSync(d, { recursive: true }); git(d, 'init', '-q'); fs.symlinkSync(outside, path.join(d, 'package.json'));
  git(d, 'add', '-A'); git(d, 'commit', '-qm', 'c');
  assert.equal(run(p, ['repo', 'scan', d]).status, 0);
  const row = JSON.parse(rows(p)); assert.deepEqual([row.name, row.frameworks], ['lnk', undefined]);
});

test('a rescan keeps the id and hand-written fields; --all scans each child repository', () => {
  const p = plan(); put(p, '.plangraph/repos.jsonl', '{"id":"repo:web","name":"old","paths":[{"glob":"a/**","sub":"a"}],"role":"app"}\n');
  const parent = path.join(BASE, `p-${n++}`); repo('web', { 'package.json': '{"name":"renamed"}' }, parent); repo('lib', { 'go.mod': 'module x/lib\n' }, parent);
  const s = run(p, ['repo', 'scan', parent, '--all']);
  assert.equal(s.status, 0, s.stderr);
  const all = rows(p).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(all.map((r) => r.id), ['repo:lib', 'repo:web']);
  const web = all[1];
  assert.deepEqual([web.name, web.role, web.paths], ['renamed', 'app', [{ glob: 'a/**', sub: 'a' }]]);
});

test('one alias for three repos and one repo with two aliases collide nowhere; branch-added repos merge in any order', () => {
  const x = (id: string, sys: string, xid: string) => ({ type: 'repo', id, sys, xid });
  const xs = [x('repo:a', 'jira:ABC', 'ABC'), x('repo:b', 'jira:ABC', 'ABC'), x('repo:c', 'jira:ABC', 'ABC'), x('repo:a', 'jira:XYZ', 'XYZ')];
  assert.equal(canonFile(xs, SCHEMAS['xrefs.jsonl']).trim().split('\n').length, 4);
  const a = { id: 'repo:a', langs: ['go', 'c'], src: 'scan' }, b = { id: 'repo:b', langs: ['rust', 'c'], src: 'scan' };
  assert.equal(canonFile([a, b], SCHEMAS['repos.jsonl']), canonFile([b, a], SCHEMAS['repos.jsonl']));
  assert.match(canonFile([a], SCHEMAS['repos.jsonl']), /"langs":\["c","go"\]/);
});

test('usage errors: no subcommand, not a repository', () => {
  const p = plan();
  assert.equal(run(p, ['repo']).status, 2);
  assert.equal(run(p, ['repo', 'scan', path.join(BASE, 'home')]).status, 2);
});

test('usage errors: --all with an unreadable path or no repository; a bare scan uses the plan root; two repos with one id', () => {
  const p = plan();
  assert.equal(run(p, ['repo', 'scan', path.join(BASE, 'missing'), '--all']).status, 2);
  assert.equal(run(p, ['repo', 'scan', path.join(BASE, 'home'), '--all']).status, 2);
  assert.equal(run(p, ['repo', 'scan', '--check']).status, 1);
  const parent = path.join(BASE, `p-${n++}`); repo('web-', { 'go.mod': 'module x\n' }, parent); repo('web_', { 'go.mod': 'module x\n' }, parent);
  assert.equal(run(p, ['repo', 'scan', parent, '--all']).status, 2);
});
