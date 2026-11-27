// Hardening (task 33): the Review Focus items of the 1.0 plan that are not the injection, fuzz and concurrency files, each with an explicit end-to-end test
// through the CLI. 1 shallow and blobless clones, 2 a rebased cursor, 4 conflict markers and bad lines, 5 hooks with no repo, no index, no network or an exceeded
// budget, 6 ids that differ only in case. (3 is in hardening-injection.test.ts, the two-agent half of 6 in hardening-concurrency.test.ts.)
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeRepo, gitEnv, runGit, ANA, BEN, T0 } from './helpers/gitrepo.ts';
import { world, run, cleanup } from './helpers/hook-world.ts';
import { writeNode, readNodes } from '../lib/store2/nodes.ts';
import { caseCollisions } from '../lib/store2/check.ts';
import type { Repo } from './helpers/gitrepo.ts';

const keep: string[] = [], repos: Repo[] = [];
after(() => { cleanup(); for (const r of repos) r.cleanup(); for (const d of keep) fs.rmSync(d, { recursive: true, force: true }); });
const tmpdir = (): string => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rf-'))); keep.push(d); return d; };
const env = { PLANGRAPH_STRICT_OUT: '1', PLANGRAPH_PROMPT_HOOK: 'on' };
const seed = (): Repo => { const r = makeRepo(); repos.push(r); r.commit({ files: { 'src/a.ts': 'one\n' }, who: ANA }); r.commit({ files: { 'src/a.ts': 'one\ntwo\n', 'src/b.ts': 'b\n' }, who: BEN }); r.commit({ files: { 'src/a.ts': 'one\ntwo\nthree\n' }, who: ANA }); return r; };
const withPlan = async (dir: string): Promise<void> => { assert.equal((await run(dir, ['init'], { env })).code, 0); };

test('Review Focus 1: a shallow clone is refused with exit 2 and one line, nothing is written; a blobless clone warns and proceeds', async () => {
  const r = seed(), sh = path.join(tmpdir(), 'shallow');
  execFileSync('git', ['clone', '-q', '--depth', '1', `file://${r.dir}`, sh], { env: gitEnv() });
  await withPlan(sh);
  const x = await run(sh, ['ingest', 'git'], { env });
  assert.equal(x.code, 2);
  assert.deepEqual(x.err.filter((l) => l.startsWith('error:')), ['error: shallow clone: run git fetch --unshallow']);
  assert.equal(fs.existsSync(path.join(sh, '.plangraph/cache/git.jsonl')), false);
  assert.equal(fs.existsSync(path.join(sh, '.plangraph/cache/git.cursor')), false);
  runGit(r.dir, ['config', 'uploadpack.allowFilter', 'true']);
  const bl = path.join(tmpdir(), 'blobless');
  execFileSync('git', ['clone', '-q', '--filter=blob:none', `file://${r.dir}`, bl], { env: gitEnv() });
  await withPlan(bl);
  const y = await run(bl, ['ingest', 'git'], { env });
  assert.equal(y.code, 0, y.err.join('|'));
  assert.ok(y.err.some((l) => /blob|partial/i.test(l)) || y.out.some((l) => /blob|partial/i.test(l)), `a blobless clone warns: ${y.out.join('|')} ${y.err.join('|')}`);
});

test('Review Focus 2: after the cursor commit is amended the next ingest rebuilds and equals a fresh run, with no stale fact', async () => {
  const r = seed();
  await withPlan(r.dir);
  assert.equal((await run(r.dir, ['ingest', 'git', '--since', '36500'], { env })).code, 0);
  const first = fs.readFileSync(path.join(r.dir, '.plangraph/cache/git.jsonl'), 'utf8');
  const cursor0 = fs.readFileSync(path.join(r.dir, '.plangraph/cache/git.cursor'), 'utf8');
  assert.ok(first.length > 0, 'the largest --since (36500 days) still lists the commits: git reads a time before 1970 as no time');
  r.git('rm', '-q', 'src/b.ts'); // the amended tip no longer has b.ts
  runGit(r.dir, ['commit', '-q', '--amend', '--no-edit'], gitEnv(ANA, T0 + 99999));
  const again = await run(r.dir, ['ingest', 'git', '--since', '36500'], { env });
  assert.equal(again.code, 0, again.err.join('|'));
  assert.match(again.out.join(' '), /full/, 'a cursor that is no longer an ancestor means a full rebuild');
  assert.notEqual(fs.readFileSync(path.join(r.dir, '.plangraph/cache/git.cursor'), 'utf8'), cursor0);
  const fresh = tmpdir(); fs.cpSync(r.dir, fresh, { recursive: true }); fs.rmSync(path.join(fresh, '.plangraph/cache'), { recursive: true, force: true });
  assert.equal((await run(fresh, ['ingest', 'git', '--since', '36500'], { env })).code, 0);
  assert.equal(fs.readFileSync(path.join(r.dir, '.plangraph/cache/git.jsonl'), 'utf8'), fs.readFileSync(path.join(fresh, '.plangraph/cache/git.jsonl'), 'utf8'));
});

test('Review Focus 4: a file with conflict markers or a bad line never takes the tool down; check names it in one line and resolve fixes the mechanical case', async () => {
  const w = world();
  assert.equal((await run(w.root, ['build'], { env })).code, 0);
  const t = fs.readdirSync(path.join(w.dir, 'nodes/ticket')).flatMap((h) => fs.readdirSync(path.join(w.dir, 'nodes/ticket', h)).map((f) => path.join(w.dir, 'nodes/ticket', h, f)))[0] as string;
  const text = fs.readFileSync(t, 'utf8');
  fs.writeFileSync(t, `${text}<<<<<<< ours\nlinks {"rel":"a","to":"b"}\n=======\nlinks {"rel":"c","to":"d"}\n>>>>>>> theirs\n`);
  const c = await run(w.root, ['check'], { env });
  assert.equal(c.code, 1);
  assert.equal(c.out.filter((l) => l.includes('CONFLICT_MARKERS') && l.includes(path.basename(t))).length, 1, 'one line names the file and the code');
  assert.equal((await run(w.root, ['map'], { env })).code, 0, 'a read command goes on');
  const r = await run(w.root, ['resolve'], { env });
  assert.equal(r.code, 0, r.out.join('|'));
  assert.doesNotMatch((await run(w.root, ['check'], { env })).out.join('\n'), /CONFLICT_MARKERS/);
  fs.writeFileSync(t, `${fs.readFileSync(t, 'utf8')}<<<<<<< ours\nsp 3\n=======\nsp 5\n>>>>>>> theirs\n`);
  assert.equal((await run(w.root, ['resolve'], { env })).code, 1, 'a scalar conflict is left for a person');
  const ev = path.join(w.dir, 'events/2026-11'); fs.mkdirSync(ev, { recursive: true });
  fs.writeFileSync(path.join(ev, 'ana.aaaaaaaa.01.jsonl'), 'not json\n');
  const b = await run(w.root, ['check'], { env });
  assert.ok(b.out.some((l) => l.includes('BAD_LINE') && l.includes('ana.aaaaaaaa.01.jsonl')), b.out.join('|'));
});

test('Review Focus 5: a hook with no repository, no plan, no index, no network or an exceeded budget prints nothing, exits 0 and is quick', async () => {
  const empty = tmpdir();
  for (const argv of [['refresh', '--quiet'], ['refresh', '--fast', '--quiet'], ['hook-prompt'], ['card', '--if-present', '--refresh']]) {
    const t = performance.now();
    const r = await run(empty, argv, { env, stdin: '{"session_id":"s","prompt":"look at ABC-1"}' });
    assert.deepEqual([r.code, r.out, r.err], [0, [], []], `${argv.join(' ')} in an empty directory`);
    assert.ok(performance.now() - t < 200, `${argv.join(' ')} took ${performance.now() - t} ms`);
  }
  const w = world(); // a plan and a repository, no index yet
  assert.deepEqual(await run(w.root, ['hook-prompt'], { env, stdin: '{"session_id":"s","prompt":"look at ABC-1"}' }), { code: 0, out: [], err: [] });
  const noNet = await run(w.root, ['refresh', '--quiet'], { env, deps: { syncFetch: async () => { throw new Error('getaddrinfo ENOTFOUND'); } } });
  assert.deepEqual([noNet.code, noNet.out, noNet.err], [0, [], []]);
  assert.ok(fs.existsSync(path.join(w.dir, 'plangraph.sqlite')), 'the index is valid after a failed fetch');
  const slow = await run(w.root, ['refresh', '--quiet', '--budget', '1'], { env, deps: { beforeStep: async (n: string) => { if (n === 'fetch') await new Promise((ok) => setTimeout(ok, 3000).unref()); } } });
  assert.deepEqual([slow.code, slow.out, slow.err], [0, [], []]);
});

test('Review Focus 6: two ids that differ only in case are two nodes with two files, neither merged nor lost; check reports a colliding pair of names', () => {
  const root = tmpdir();
  assert.equal(writeNode(root, 'requirement', { id: 'R-ab12', text: 'lower' }), 'created');
  assert.equal(writeNode(root, 'requirement', { id: 'R-AB12', text: 'upper' }), 'created');
  const got = readNodes(root, 'requirement').nodes;
  assert.deepEqual(got.map((n) => [n.id, n.text]).sort(), [['R-AB12', 'upper'], ['R-ab12', 'lower']]);
  const names = fs.readdirSync(path.join(root, 'nodes/requirement')).flatMap((h) => fs.readdirSync(path.join(root, 'nodes/requirement', h)));
  assert.equal(new Set(names.map((n) => n.toLowerCase())).size, 2, 'the file names differ beyond case (the hash of the exact id)');
  assert.deepEqual(caseCollisions(['nodes/x/aa/R-1~aaaaaaaa.pg', 'nodes/x/aa/r-1~aaaaaaaa.PG', 'nodes/x/bb/other.pg']).length, 1);
});
