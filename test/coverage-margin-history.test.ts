// Coverage margin for lib/history/git.ts: the git probes that throw, the settings that are not numbers, the cursor files that are damaged or carry
// renames, ties in the author and coupling order, and the commit reader outside a repository, over scripted repositories.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emailRef } from '../lib/history/parse.ts';
import type { CommitFact } from '../lib/history/parse.ts';
import { buildModules, isShallow, isPartial, ingestGit, readLinkCommits } from '../lib/history/git.ts';
import { makeGit } from '../lib/gitsafe.ts';
import { makeRepo, T0 } from './helpers/gitrepo.ts';
import type { Repo } from './helpers/gitrepo.ts';

const keep: (Repo | string)[] = [];
after(() => { for (const r of keep) typeof r === 'string' ? fs.rmSync(r, { recursive: true, force: true }) : r.cleanup(); });
const mk = () => { const r = makeRepo(); keep.push(r); return r; };
const NOW = new Date((T0 + 400 * 3600) * 1000);
const sha = (c: string) => c.repeat(40);
const commit = (n: string, at: number, who: string, files: [string, number, number][]): CommitFact => ({ sha: sha(n), at: new Date(at * 1000).toISOString().replace('.000Z', 'Z'), author: who, files: files.map(([p, added, deleted]) => ({ path: p, added, deleted })) });
const opts = { repo: 'r1', now: NOW, windowDays: 365, minCochange: 1, maxModules: 300, hotPercentile: 90 };

function ctxFor(repo: Repo, config: unknown = {}, now: Date = NOW) {
  const dir = path.join(repo.dir, '.plangraph'); fs.mkdirSync(path.join(dir, 'cache'), { recursive: true });
  const err: string[] = [];
  return { dir, err, ctx: { root: repo.dir, dir, git: makeGit(repo.dir), now: () => now, config: () => config, io: { out: () => undefined, err: (s: string) => err.push(s) } } as never };
}
const facts = (dir: string) => fs.readFileSync(path.join(dir, 'cache/git.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('isShallow and isPartial answer from scripted git output, whichever probe throws or says what', () => {
  const git = (table: Record<string, string | Error>) => (...a: string[]): string => { const v = table[a.join(' ')]; if (v === undefined || v instanceof Error) throw v ?? new Error('unset'); return v; };
  assert.equal(isShallow(git({ 'rev-parse --is-shallow-repository': 'true\n' })), true);
  assert.equal(isShallow(git({ 'rev-parse --is-shallow-repository': 'false\n' })), false);
  assert.equal(isShallow(git({})), false);
  assert.equal(isPartial(git({ 'config --get extensions.partialclone': 'origin\n' })), true);
  assert.equal(isPartial(git({ 'config --get extensions.partialclone': '\n', 'config --get-regexp ^remote\\..*\\.promisor$': 'remote.origin.promisor true\n' })), true);
  assert.equal(isPartial(git({ 'config --get-regexp ^remote\\..*\\.promisor$': 'remote.origin.promisor false\n' })), false);
  assert.equal(isPartial(git({})), false);
});

test('buildModules of no commits is empty, and equal shares and equal co-change counts are ordered by name', () => {
  assert.deepEqual(buildModules([], opts), []);
  const A = emailRef('a@x'), B = emailRef('b@x'), C = emailRef('c@x');
  const m = buildModules([
    commit('1', T0 + 3000, A, [['m.ts', 1, 1], ['p.ts', 1, 1], ['q.ts', 1, 1], ['r.ts', 1, 1]]),
    commit('2', T0 + 2000, B, [['m.ts', 1, 1], ['r.ts', 1, 1], ['q.ts', 1, 1]]),
    commit('3', T0 + 1000, C, [['m.ts', 1, 1]]),
  ], { ...opts, identity: { byRef: { [A]: 'zed', [B]: 'amy', [C]: 'kim' } } });
  const mod = m.find((x) => x.path === 'm.ts');
  assert.deepEqual(mod?.authors.map((a) => a.person), ['amy', 'kim', 'zed']);
  assert.deepEqual(mod?.coupled, ['q.ts', 'r.ts', 'p.ts'], 'by count, then by name');
  assert.equal(mod?.bus1, false);
});

test('ingestGit falls back to the defaults for settings that are not positive numbers and caps hot_percentile at 100', async () => {
  const r = mk();
  for (let i = 0; i < 3; i++) r.commit({ files: { 'a.ts': `${i}\n`, 'b.ts': `${i}\n` } });
  for (const bad of ['x', 0, -5, null, [], {}, true]) {
    const c = ctxFor(r, { history: { window_days: bad, min_cochange: bad, max_modules: bad, hot_percentile: bad } });
    const res = await ingestGit(c.ctx, {});
    assert.equal(res.written, 2, JSON.stringify(bad));
    assert.deepEqual([facts(c.dir)[0]?.window, facts(c.dir)[0]?.min_cochange, facts(c.dir)[0]?.hot_percentile], [365, 5, 90], JSON.stringify(bad));
  }
  const odd = ctxFor(r, { history: { window_days: 30.9, min_cochange: 2.5, max_modules: 1.2, hot_percentile: 250 } });
  assert.equal((await ingestGit(odd.ctx, {})).written, 1);
  assert.deepEqual([facts(odd.dir)[0]?.window, facts(odd.dir)[0]?.min_cochange, facts(odd.dir)[0]?.hot_percentile], [30, 2, 100]);
  const none = ctxFor(r, { history: 'text' });
  assert.equal((await ingestGit(none.ctx, {})).written, 2);
});

test('ingestGit rebuilds from the log when the cursor file is damaged in any way, and reads renames back from a good one', async () => {
  const r = mk();
  r.commit({ files: { 'old/x.ts': '1\n', 'keep.ts': '1\n' } });
  r.rename('old/x.ts', 'new/x.ts');
  const c = ctxFor(r);
  const first = await ingestGit(c.ctx, {});
  const cursor = path.join(c.dir, 'cache/git.cursor');
  const good = fs.readFileSync(cursor, 'utf8');
  assert.match(good, /"old\/x\.ts"\]/, 'the rename is stored with its old path');
  const expected = fs.readFileSync(path.join(c.dir, 'cache/git.jsonl'), 'utf8');
  const [head, meta, ...rest] = good.split('\n');
  const damaged = ['', 'nothex\nmeta\n', `${head}\n`, `${head}\n${meta}\nnot json\n`, `${head}\n${meta}\n${JSON.stringify([1, 'a', 'b', []])}\n`, `${head}\n${meta}\n${JSON.stringify(['x'.repeat(40), 'a', 'b', 'no'])}\n`, `${head}\n${meta}\n${JSON.stringify([sha('a'), 'a', 5, []])}\n`, `${head}\n${meta}\n${rest.join('\n')}null\n`];
  for (const text of damaged) {
    fs.writeFileSync(cursor, text);
    const res = await ingestGit(c.ctx, {});
    assert.equal(res.incremental, false, JSON.stringify(text.slice(0, 40)));
    assert.equal(fs.readFileSync(path.join(c.dir, 'cache/git.jsonl'), 'utf8'), expected);
    assert.equal(res.cursor, first.cursor);
  }
  fs.writeFileSync(cursor, good);
  const again = await ingestGit(c.ctx, {});
  assert.equal(again.incremental, true);
  assert.equal(fs.readFileSync(path.join(c.dir, 'cache/git.jsonl'), 'utf8'), expected);
  fs.rmSync(cursor);
  assert.equal((await ingestGit(c.ctx, {})).incremental, false);
});

test('readLinkCommits lists commit messages newest first, with or without a since date, and nothing outside a repository', async () => {
  const r = mk();
  const a = r.commit({ files: { 'a.txt': '1' }, message: 'first PROJ-1' }), b = r.commit({ files: { 'a.txt': '2' }, message: 'second PROJ-2' });
  const recent = await readLinkCommits({ root: r.dir }, { since: new Date(0) });
  assert.deepEqual(recent.map((x) => x.sha), [b, a]);
  assert.match(recent[0]?.message ?? '', /second PROJ-2/);
  assert.deepEqual(recent[0]?.files, []);
  const dated = await readLinkCommits({ root: r.dir }, { since: new Date((T0 - 86400) * 1000), max: 1 });
  assert.deepEqual(dated.map((x) => x.sha), [b]);
  assert.deepEqual(await readLinkCommits({ root: r.dir }, { since: new Date((T0 + 10 ** 9) * 1000) }), []);
  const bare = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-margin-nogit-'))); keep.push(bare);
  assert.deepEqual(await readLinkCommits({ root: bare }, { since: new Date(0) }), []);
});
