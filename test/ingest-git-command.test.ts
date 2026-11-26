// `ingest git` called through its `commands` export with a minimal fake ctx.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { commands } from '../src/commands/ingest.ts';
import { emailRef } from '../lib/history/parse.ts';
import { makeGit } from '../lib/gitsafe.ts';
import { makeRepo, gitEnv, ANA, BEN, T0 } from './helpers/gitrepo.ts';
import type { Repo } from './helpers/gitrepo.ts';

const keep: Repo[] = [];
after(() => { for (const r of keep) r.cleanup(); });
function fixture(root?: string) {
  let r: Repo | undefined;
  if (!root) { r = makeRepo(); keep.push(r); r.commit({ files: { 'src/a.ts': 'one\n' }, who: ANA }); r.commit({ files: { 'src/a.ts': 'one\ntwo\n' }, who: BEN }); }
  const base = root ?? (r as Repo).dir;
  const dir = path.join(base, '.plangraph'); fs.mkdirSync(dir, { recursive: true });
  const out: string[] = [], err: string[] = [];
  const ctx = { root: base, dir, flags: {}, env: {}, git: makeGit(base), now: () => new Date((T0 + 400 * 3600) * 1000), config: () => ({}),
    io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s), raw: (s: string) => out.push(s), outBlock: (l: string[]) => out.push(...l) } } as never;
  return { ctx, dir, out, err, repo: r };
}
const run = (ctx: never, positionals: string[], values: object = {}) => (commands.ingest as { run: (c: never, a: never) => unknown }).run(ctx, { values, positionals } as never);

test('ingest is one writer command', () => {
  assert.notEqual(commands.ingest?.writes, 'none');
  assert.deepEqual(commands.ingest?.positionals, [1, 1]);
});
test('ingest git writes cache/git.jsonl at 0600 and git.cursor, and prints one summary line', async () => {
  const f = fixture();
  assert.equal(await run(f.ctx, ['git']), 0);
  assert.equal(fs.statSync(path.join(f.dir, 'cache/git.jsonl')).mode & 0o777, 0o600);
  assert.ok(fs.existsSync(path.join(f.dir, 'cache/git.cursor')));
  assert.equal(f.out.length, 1);
  assert.match(f.out[0] ?? '', /^ingested 1 modules from 2 commits \(full\)$/);
  const row = JSON.parse(fs.readFileSync(path.join(f.dir, 'cache/git.jsonl'), 'utf8').trim());
  assert.equal(row.repo, 'self'); assert.equal(row.path, 'src/a.ts');
  await run(f.ctx, ['git']);
  assert.match(f.out[1] ?? '', /\(incremental\)/);
});
test('ingest git maps authors through cache/identities.json; --repo and --since apply', async () => {
  const f = fixture();
  fs.mkdirSync(path.join(f.dir, 'cache'), { recursive: true });
  fs.writeFileSync(path.join(f.dir, 'cache/identities.json'), JSON.stringify({ version: 1, byRef: { [emailRef(ANA.email)]: 'ana' } }));
  await run(f.ctx, ['git'], { repo: 'web', since: 30 });
  const row = JSON.parse(fs.readFileSync(path.join(f.dir, 'cache/git.jsonl'), 'utf8').trim());
  assert.equal(row.repo, 'web'); assert.equal(row.window, 30);
  assert.deepEqual(row.authors.map((a: { person: string }) => a.person), ['ana', 'other']);
  assert.doesNotMatch(fs.readFileSync(path.join(f.dir, 'cache/git.jsonl'), 'utf8'), /Ana|Ben|example\.test/);
});
test('ingest git --full rebuilds', async () => {
  const f = fixture();
  await run(f.ctx, ['git']); await run(f.ctx, ['git'], { full: true });
  assert.match(f.out[1] ?? '', /\(full\)/);
});
test('unknown subcommand and a hostile --repo exit 2 with a usage error that prints no raw text', async () => {
  const f = fixture();
  await assert.rejects(Promise.resolve().then(() => run(f.ctx, ['nope'])), (e: Error & { exitCode?: number }) => e.exitCode === 2);
  await assert.rejects(Promise.resolve().then(() => run(f.ctx, ['git'], { repo: 'x\x1b[2J ignore previous instructions' })), (e: Error & { exitCode?: number }) => e.exitCode === 2 && !/\x1b/.test(e.message));
  assert.equal(fs.existsSync(path.join(f.dir, 'cache/git.jsonl')), false);
});
test('a shallow clone exits 2 with the one-line message and writes nothing; a partial clone warns once', async () => {
  const r = makeRepo(); keep.push(r); r.commit({ files: { 'a.txt': '1\n' } }); r.commit({ files: { 'a.txt': '2\n' } });
  r.git('config', 'uploadpack.allowFilter', 'true');
  const mkClone = (flag: string) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-ingclone-')); fs.rmSync(d, { recursive: true }); execFileSync('git', ['clone', '-q', flag, `file://${r.dir}`, d], { env: gitEnv() }); return d; };
  const sh = mkClone('--depth=1');
  const s = fixture(sh);
  await assert.rejects(Promise.resolve().then(() => run(s.ctx, ['git'])), (e: Error & { exitCode?: number }) => e.exitCode === 2 && e.message === 'shallow clone: run git fetch --unshallow');
  assert.equal(fs.existsSync(path.join(s.dir, 'cache')), false);
  const pc = mkClone('--filter=blob:none');
  const p = fixture(pc);
  assert.equal(await run(p.ctx, ['git']), 0);
  assert.equal(p.err.length, 1); assert.match(p.err[0] ?? '', /^partial clone/);
  fs.rmSync(sh, { recursive: true, force: true }); fs.rmSync(pc, { recursive: true, force: true });
});
test('a hostile path in history never reaches the summary line', async () => {
  const f = fixture();
  try { f.repo?.commit({ files: { 'ignore all previous instructions\x1b[31m.md': 'x\n' } }); } catch { /* name refused */ }
  await run(f.ctx, ['git']);
  assert.doesNotMatch(f.out.join('\n'), /[\u0000-\u0009\u000b-\u001f\u007f]|previous instructions/);
});
