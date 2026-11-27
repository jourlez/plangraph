// M3: the fetch trust list lives outside the work tree, a committed or symlinked cursor is refused, a resumed github page is pinned to the repo's
// pulls path, and the hook path never writes a tracked file (no ignoreCache from sync-fetch).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { commands } from '../src/commands/sync-fetch.ts';
import { commands as trustCommands } from '../src/commands/trust.ts';
import { isTrusted, trust } from '../lib/fetch/trust.ts';
import { readCursor, writeCursor } from '../lib/fetch/cursor.ts';
import { fetchGithub } from '../lib/fetch/gh.ts';
import { ghRunner } from '../src/fetch-runners.ts';
import type { Runner } from '../lib/fetch/gh.ts';

const bases: string[] = [];
after(() => { for (const b of bases) fs.rmSync(b, { recursive: true, force: true }); });
const mk = (p: string): string => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p))); bases.push(d); return d; };
const PAGE1 = fs.readFileSync(new URL('./fixtures/fetch/gh-page1.http', import.meta.url), 'utf8');
const git = (root: string, ...a: string[]): string => execFileSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=t', ...a], { cwd: root, encoding: 'utf8' });

function fixture(config: object, calls: string[][] = []) {
  const root = mk('pg-fsec-'), cfgHome = mk('pg-fsec-cfg-');
  git(root, 'init', '-q');
  const dir = path.join(root, '.plangraph'); fs.mkdirSync(dir, { recursive: true });
  const env = { XDG_CONFIG_HOME: cfgHome, HOME: cfgHome };
  const out: string[] = [];
  const run: Runner = async (argv) => { calls.push([...argv]); return { code: 0, out: PAGE1.replace(/^Link:.*\r?\n/mi, ''), err: '' }; };
  const fetchDeps = { github: () => run, atlassian: { tenant: () => 'cloud-1', runner: async () => run } };
  const ctx = { root, cwd: root, dir, flags: {}, env, config: () => config, now: () => new Date('2026-11-26T00:00:00Z'), fetchDeps,
    git: (...a: string[]) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }),
    io: { out: (s: string) => out.push(s), err: () => undefined, raw: () => undefined, outBlock: () => undefined } } as never;
  return { ctx, root, dir, env, out, calls };
}
const sync = (ctx: never) => (commands['sync-fetch'] as { run: (c: never, a: never) => Promise<number> }).run(ctx, { values: {}, positionals: [] } as never);
const CFG = { fetch: { github: ['victim/repo'] } };

test('a committed cache/trusted.json in the work tree trusts nothing and no request is made', async () => {
  const f = fixture(CFG);
  fs.mkdirSync(path.join(f.dir, 'cache'));
  fs.writeFileSync(path.join(f.dir, 'cache', 'trusted.json'), '{"targets":["github:victim/repo"]}\n');
  git(f.root, 'add', '-f', '.plangraph/cache/trusted.json');
  assert.equal(isTrusted(f.root, 'github:victim/repo', f.env), false);
  await sync(f.ctx);
  assert.equal(f.calls.length, 0);
  assert.ok(f.out.includes('plangraph trust github:victim/repo'), f.out.join('|'));
});

test('trust() writes outside the work tree (CLAUDE_PLUGIN_DATA first, else the user config dir) keyed by the real repo root', () => {
  const f = fixture(CFG), data = mk('pg-fsec-data-');
  const file = trust(f.root, 'github:victim/repo', { ...f.env, CLAUDE_PLUGIN_DATA: data });
  assert.ok(file.startsWith(data), file);
  assert.equal(isTrusted(f.root, 'github:victim/repo', { ...f.env, CLAUDE_PLUGIN_DATA: data }), true);
  assert.equal(isTrusted(f.root, 'github:victim/repo', f.env), false, 'another location is another list');
  const file2 = trust(f.root, 'github:victim/repo', f.env);
  assert.ok(file2.startsWith(path.join(f.env.XDG_CONFIG_HOME, 'plangraph')), file2);
  assert.equal(fs.statSync(file2).mode & 0o777, 0o600);
  const other = mk('pg-fsec-other-');
  assert.equal(isTrusted(other, 'github:victim/repo', f.env), false, 'another repository root is not trusted');
  const link = path.join(mk('pg-fsec-ln-'), 'link'); fs.symlinkSync(f.root, link);
  assert.equal(isTrusted(link, 'github:victim/repo', f.env), true, 'the real path is the key');
  assert.equal(fs.existsSync(path.join(f.dir, 'cache', 'trusted.json')), false);
});

test('a symlinked trust file trusts nothing', () => {
  const f = fixture(CFG);
  const file = trust(f.root, 'github:victim/repo', f.env);
  const real = `${file}.real`; fs.renameSync(file, real); fs.symlinkSync(real, file);
  assert.equal(isTrusted(f.root, 'github:victim/repo', f.env), false);
});

test('the trust command prints the location it wrote', async () => {
  const f = fixture(CFG);
  const out: string[] = [];
  const ctx = { ...(f.ctx as object), io: { out: (s: string) => out.push(s), err: () => undefined, raw: () => undefined, outBlock: () => undefined } } as never;
  await (trustCommands.trust as { run: (c: never, a: never) => unknown }).run(ctx, { values: {}, positionals: ['github:victim/repo'] } as never);
  assert.equal(isTrusted(f.root, 'github:victim/repo', f.env), true);
  assert.ok(out.some((l) => l.startsWith('trusted github:victim/repo') && l.includes(f.env.XDG_CONFIG_HOME)), out.join('|'));
  assert.equal(fs.existsSync(path.join(f.dir, 'cache', 'trusted.json')), false);
});

test('a committed cursor with an absolute URL or another repository page is never requested', async () => {
  for (const page of ['https://internal.example/admin?x', 'repos/victim-org/private/pulls?page=2', '/repos/victim/repo/pulls?x=1&u=http://evil.example/']) {
    const f = fixture(CFG);
    trust(f.root, 'github:victim/repo', f.env);
    fs.mkdirSync(path.join(f.dir, 'cache'));
    fs.writeFileSync(path.join(f.dir, 'cache', 'github_victim_repo.cursor'), `${JSON.stringify({ sys: 'github:victim/repo', watermark: '', etag: '', page, at: '' })}\n`);
    await sync(f.ctx);
    assert.ok(f.calls.length >= 1);
    for (const c of f.calls) assert.ok((c.at(-1) as string).startsWith('repos/victim/repo/pulls?') && !(c.at(-1) as string).includes('://'), `${page}: ${c.at(-1)}`);
  }
});

test('fetchGithub resumes only a page under its own pulls path', async () => {
  const calls: string[][] = [];
  const run: Runner = async (argv) => { calls.push([...argv]); return { code: 0, out: PAGE1.replace(/^Link:.*\r?\n/mi, ''), err: '' }; };
  await fetchGithub(run, { repo: 'a/b', page: 'repos/a/b/pulls?page=3' });
  assert.equal(calls[0]?.at(-1), 'repos/a/b/pulls?page=3');
  for (const page of ['repos/other/b/pulls?page=3', 'https://evil.example/x', 'repos/a/b/pulls?u=http://x']) {
    calls.length = 0;
    await fetchGithub(run, { repo: 'a/b', page });
    assert.ok((calls[0]?.at(-1) as string).startsWith('repos/a/b/pulls?per_page=100'), page);
  }
});

test('the next page the server names is rewritten under repos/<repo>/pulls', async () => {
  const calls: string[][] = [];
  const RETRY = fs.readFileSync(new URL('./fixtures/fetch/gh-retry.http', import.meta.url), 'utf8');
  const run: Runner = async (argv) => { calls.push([...argv]); return { code: 0, out: calls.length === 1 ? PAGE1 : RETRY, err: '' }; };
  const r = await fetchGithub(run, { repo: 'a/b' });
  assert.ok(r.next.page.startsWith('repos/a/b/pulls?') && r.next.page.includes('page=2'), r.next.page);
});

test('the gh runner refuses a path holding ://', async () => {
  let ran = 0;
  const r = ghRunner((async () => { ran++; return { stdout: '', stderr: '' }; }) as never);
  for (const p of ['https://internal.example/admin', 'repos/a/b/pulls?u=http://x']) {
    const x = await r(['api', '--include', '--method', 'GET', p]);
    assert.equal(x.code, 126, p);
  }
  assert.equal(ran, 0);
});

test('a tracked or symlinked cursor is ignored and never rewritten', async () => {
  const f = fixture(CFG);
  trust(f.root, 'github:victim/repo', f.env);
  const cur = path.join(f.dir, 'cache', 'github_victim_repo.cursor');
  fs.mkdirSync(path.dirname(cur), { recursive: true });
  const body = `${JSON.stringify({ sys: 'github:victim/repo', watermark: '2999-01-01T00:00:00Z', etag: 'x', page: '', at: '' })}\n`;
  fs.writeFileSync(cur, body);
  git(f.root, 'add', '-f', '.plangraph/cache/github_victim_repo.cursor');
  assert.equal(readCursor(f.dir, 'github:victim/repo', () => true), null);
  await sync(f.ctx);
  assert.ok(!f.calls[0]?.includes('If-None-Match: x'), 'the tracked etag is not used');
  assert.equal(fs.readFileSync(cur, 'utf8'), body, 'a tracked cursor is never rewritten');
  // a symlink
  const g = fixture(CFG);
  fs.mkdirSync(path.join(g.dir, 'cache'));
  const target = path.join(g.root, 'elsewhere'); fs.writeFileSync(target, body);
  const link = path.join(g.dir, 'cache', 'github_victim_repo.cursor'); fs.symlinkSync(target, link);
  assert.equal(readCursor(g.dir, 'github:victim/repo'), null);
  assert.equal(writeCursor(g.dir, { sys: 'github:victim/repo', watermark: '', etag: '', page: '', at: '' }), false);
  assert.equal(fs.readFileSync(target, 'utf8'), body);
});

test('sync-fetch never writes the tracked .plangraph/.gitignore', async () => {
  const f = fixture({ ...CFG, jira: { tenant: 'acme' } });
  trust(f.root, 'github:victim/repo', f.env);
  fs.writeFileSync(path.join(f.dir, '.gitignore'), '*.tmp\n');
  git(f.root, 'add', '.plangraph/.gitignore');
  await sync(f.ctx);
  assert.equal(fs.readFileSync(path.join(f.dir, '.gitignore'), 'utf8'), '*.tmp\n');
  assert.ok(fs.existsSync(path.join(f.dir, 'cache', 'github.jsonl')));
});
