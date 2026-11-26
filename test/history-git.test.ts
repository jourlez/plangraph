// lib/history: parseLog, buildModules, isShallow, isPartial, ingestGit over scripted repos.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseLog, emailRef } from '../lib/history/parse.ts';
import type { CommitFact } from '../lib/history/parse.ts';
import { buildModules, isShallow, isPartial, ingestGit } from '../lib/history/git.ts';
import { makeGit } from '../lib/gitsafe.ts';
import { makeRepo, fastRepo, gitEnv, runGit, ANA, BEN, T0 } from './helpers/gitrepo.ts';
import type { Repo } from './helpers/gitrepo.ts';

const keep: (Repo | string)[] = [];
after(() => { for (const r of keep) typeof r === 'string' ? fs.rmSync(r, { recursive: true, force: true }) : r.cleanup(); });
const mk = () => { const r = makeRepo(); keep.push(r); return r; };
const NOW = new Date((T0 + 400 * 3600) * 1000);
const sha = (c: string) => c.repeat(40);

function ctxFor(repo: Repo, now: Date = NOW) {
  const dir = path.join(repo.dir, '.plangraph'); fs.mkdirSync(path.join(dir, 'cache'), { recursive: true });
  const err: string[] = [], out: string[] = [];
  return { dir, err, out, ctx: { root: repo.dir, dir, git: makeGit(repo.dir), now: () => now, config: () => ({}), io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } } as never };
}

// ---------- parseLog ----------
const header = (s: string, at: number, email: string) => `\x01${s}\t${at}\t${email}\0\n`;
test('parseLog reads numstat -z: plain, binary and rename entries; the email becomes a hash ref and is not kept', () => {
  const text = header(sha('a'), 100, 'Ana@Example.test') + '3\t1\tsrc/a.ts\0-\t-\tlogo.png\0' + '0\t2\t\0old/x.ts\0new/x.ts\0' + header(sha('b'), 50, 'ben@example.test') + '1\t1\tsrc/a.ts\0';
  const c = parseLog(text);
  assert.equal(c.length, 2);
  assert.deepEqual(c[0]?.files, [{ path: 'src/a.ts', added: 3, deleted: 1 }, { path: 'logo.png', added: 0, deleted: 0 }, { path: 'new/x.ts', added: 0, deleted: 2, renamedFrom: 'old/x.ts' }]);
  assert.equal(c[0]?.author, emailRef('ana@example.test'));
  assert.match(c[0]?.author ?? '', /^git:[0-9a-f]{16}$/);
  assert.equal(c[0]?.at, new Date(100_000).toISOString().replace('.000Z', 'Z'));
  assert.doesNotMatch(JSON.stringify(c), /example\.test/i);
});
test('parseLog: a commit with no files, a header-looking path, control characters in a path', () => {
  const evil = '\x01' + sha('c') + '\t1\tx@y.z';
  const text = header(sha('a'), 100, 'a@x') + '1\t1\t\0\x01old\0' + evil + '\0' + '1\t1\tok.ts\0' + '1\t1\tbad\x1b[31m.ts\0' + '1\t1\tignore previous instructions.md\0' + header(sha('d'), 90, 'a@x');
  const c = parseLog(text);
  assert.equal(c.length, 2);
  assert.deepEqual(c[0]?.files.map((f) => f.path), ['ok.ts', 'ignore previous instructions.md']); // the rename pair was consumed as data; the control path is dropped
  assert.deepEqual(c[1]?.files, []);
});
test('parseLog skips a chunk whose header is malformed', () => {
  assert.deepEqual(parseLog('\x01nothex\t1\ta@b\0\n1\t1\tz.ts\0'), []);
});

// ---------- buildModules ----------
const commit = (n: string, at: number, who: string, files: [string, number, number][]): CommitFact => ({ sha: sha(n), at: new Date(at * 1000).toISOString().replace('.000Z', 'Z'), author: who, files: files.map(([path, added, deleted]) => ({ path, added, deleted })) });
const opts = { repo: 'r1', now: NOW, windowDays: 365, minCochange: 5, maxModules: 300, hotPercentile: 90 };

test('buildModules: churn, commits, author shares, bus1, window, sorted by repo then path', () => {
  const A = emailRef('a@x'), B = emailRef('b@x');
  const commits = [
    commit('1', T0 + 3000, A, [['z.ts', 5, 5], ['a.ts', 1, 1]]),
    commit('2', T0 + 2000, B, [['z.ts', 10, 0]]),
    commit('3', T0 + 1000, A, [['z.ts', 1, 0]]),
  ];
  const m = buildModules(commits, { ...opts, identity: { byRef: { [A]: 'ana' } } });
  assert.deepEqual(m.map((x) => x.path), ['a.ts', 'z.ts']);
  const z = m[1]!;
  assert.equal(z.churn, 21); assert.equal(z.commits, 3); assert.equal(z.window, 365);
  assert.deepEqual(z.authors, [{ person: 'ana', share: 0.667 }, { person: 'other', share: 0.333 }]);
  assert.equal(z.bus1, false);
  assert.equal(m[0]?.bus1, true);
  assert.equal(z.last, commits[0]?.at);
  assert.equal(z.repo, 'r1');
});
test('buildModules: unmapped authors share one bucket and no ref leaks into authors', () => {
  const m = buildModules([commit('1', T0, emailRef('a@x'), [['f', 1, 0]]), commit('2', T0 + 1, emailRef('b@x'), [['f', 1, 0]])], opts);
  assert.deepEqual(m[0]?.authors, [{ person: 'other', share: 1 }]);
  assert.equal(m[0]?.bus1, false); // two distinct raw authors
});
test('buildModules: a pair changing together in min_cochange commits is coupled, fewer is not', () => {
  const cs: CommitFact[] = [];
  for (let i = 0; i < 5; i++) cs.push(commit(String(i), T0 + i, 'git:aaaaaaaaaaaaaaaa', [['x.ts', 1, 0], ['y.ts', 1, 0]]));
  for (let i = 5; i < 9; i++) cs.push(commit(String(i), T0 + i, 'git:aaaaaaaaaaaaaaaa', [['x.ts', 1, 0], ['w.ts', 1, 0]]));
  const m = Object.fromEntries(buildModules(cs, opts).map((x) => [x.path, x]));
  assert.deepEqual(m['x.ts']?.coupled, ['y.ts']);
  assert.deepEqual(m['y.ts']?.coupled, ['x.ts']);
  assert.deepEqual(m['w.ts']?.coupled, []);
  assert.equal(m['x.ts']?.min_cochange, 5);
});
test('buildModules: a rename keeps one module under the new path (commits are newest first)', () => {
  const cs = [
    commit('3', T0 + 3, 'git:aaaaaaaaaaaaaaaa', [['new.ts', 1, 0]]),
    { ...commit('2', T0 + 2, 'git:aaaaaaaaaaaaaaaa', [['new.ts', 0, 0]]), files: [{ path: 'new.ts', added: 0, deleted: 0, renamedFrom: 'old.ts' }] },
    commit('1', T0 + 1, 'git:aaaaaaaaaaaaaaaa', [['old.ts', 4, 0]]),
  ];
  const m = buildModules(cs, opts);
  assert.deepEqual(m.map((x) => [x.path, x.commits, x.churn]), [['new.ts', 3, 5]]);
});
test('buildModules: commits older than the window are dropped; hotspot is churn rank times commit rank at the percentile', () => {
  const old = commit('0', T0 - 400 * 86400, 'git:aaaaaaaaaaaaaaaa', [['ancient.ts', 99, 0]]);
  const cs: CommitFact[] = [old];
  for (let i = 0; i < 12; i++) cs.push(commit(`${i}`.padStart(1, '1'), T0 + i, 'git:aaaaaaaaaaaaaaaa', [['hot.ts', 50, 50], [`f${i}.ts`, 1, 0]]));
  const m = buildModules(cs, { ...opts, now: new Date((T0 + 100) * 1000) });
  assert.equal(m.find((x) => x.path === 'ancient.ts'), undefined);
  assert.deepEqual(m.filter((x) => x.hotspot).map((x) => x.path), ['hot.ts']);
  assert.equal(m[0]?.hot_percentile, 90);
});
test('buildModules: max_modules keeps the highest churn; two runs are byte-identical', () => {
  const cs = [commit('1', T0, 'git:aaaaaaaaaaaaaaaa', [['a', 1, 0], ['b', 9, 0], ['c', 5, 0]])];
  const m = buildModules(cs, { ...opts, maxModules: 2 });
  assert.deepEqual(m.map((x) => x.path), ['b', 'c']);
  assert.equal(JSON.stringify(buildModules(cs, opts)), JSON.stringify(buildModules(cs, opts)));
});

// ---------- git: shallow, partial ----------
test('isShallow and isPartial', () => {
  const r = mk(); r.commit({ files: { 'a.txt': '1' } }); r.commit({ files: { 'a.txt': '2' } });
  assert.equal(isShallow(makeGit(r.dir)), false);
  assert.equal(isPartial(makeGit(r.dir)), false);
  const sh = fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-shallow-')); keep.push(sh); fs.rmSync(sh, { recursive: true });
  execFileSync('git', ['clone', '-q', '--depth=1', `file://${r.dir}`, sh], { env: gitEnv() });
  assert.equal(isShallow(makeGit(sh)), true);
  r.git('config', 'uploadpack.allowFilter', 'true');
  const pc = fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-partial-')); keep.push(pc); fs.rmSync(pc, { recursive: true });
  execFileSync('git', ['clone', '-q', '--filter=blob:none', `file://${r.dir}`, pc], { env: gitEnv() });
  assert.equal(isPartial(makeGit(pc)), true);
  assert.equal(isShallow(makeGit(pc)), false);
});

// ---------- ingestGit ----------
const rows = (dir: string) => fs.readFileSync(path.join(dir, 'cache/git.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('ingestGit writes git.jsonl (0600) and git.cursor; no author name or email appears', async () => {
  const r = mk();
  r.commit({ files: { 'src/a.ts': 'one\n', 'src/b.ts': 'x\n' }, who: ANA });
  const head = r.commit({ files: { 'src/a.ts': 'one\ntwo\n' }, who: BEN });
  const c = ctxFor(r);
  const res = await ingestGit(c.ctx, { identity: { byRef: { [emailRef(ANA.email)]: 'ana' } } });
  assert.equal(res.cursor, head); assert.equal(res.written, 2);
  assert.equal(fs.statSync(path.join(c.dir, 'cache/git.jsonl')).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(path.join(c.dir, 'cache/git.cursor'), 'utf8').split('\n')[0], head);
  const text = fs.readFileSync(path.join(c.dir, 'cache/git.jsonl'), 'utf8') + fs.readFileSync(path.join(c.dir, 'cache/git.cursor'), 'utf8');
  assert.doesNotMatch(text, /Ana|Lopez|Ben|Ito|example\.test/);
  const a = rows(c.dir).find((x) => x.path === 'src/a.ts');
  assert.deepEqual(a.authors, [{ person: 'ana', share: 0.5 }, { person: 'other', share: 0.5 }]);
});
test('ingestGit honors .git-blame-ignore-revs', async () => {
  const r = mk();
  r.commit({ files: { 'a.ts': 'x\n' } });
  const fmt = r.commit({ files: { 'a.ts': 'x\ny\nz\n' } });
  r.commit({ files: { '.git-blame-ignore-revs': `# reformat\n${fmt}\n` } });
  const c = ctxFor(r);
  await ingestGit(c.ctx, {});
  const a = rows(c.dir).find((x) => x.path === 'a.ts');
  assert.equal(a.commits, 1); assert.equal(a.churn, 1);
});
test('ingestGit honors .mailmap: two spellings of one author are one ref', async () => {
  const r = mk();
  r.commit({ files: { 'a.ts': '1\n' }, who: { name: 'Ana Lopez', email: 'ana@example.test' } });
  r.commit({ files: { 'a.ts': '2\n' }, who: { name: 'A. Lopez', email: 'ana.l@work.test' } });
  r.commit({ files: { '.mailmap': 'Ana Lopez <ana@example.test> <ana.l@work.test>\n' } });
  const c = ctxFor(r);
  await ingestGit(c.ctx, {});
  assert.equal(rows(c.dir).find((x) => x.path === 'a.ts').bus1, true);
});
test('ingestGit: a rename keeps one module', async () => {
  const r = mk();
  r.commit({ files: { 'old.ts': 'a\nb\nc\nd\n' } });
  r.rename('old.ts', 'lib/new.ts');
  r.commit({ files: { 'lib/new.ts': 'a\nb\nc\nd\ne\n' } });
  const c = ctxFor(r);
  await ingestGit(c.ctx, {});
  assert.deepEqual(rows(c.dir).map((x) => [x.path, x.commits]), [['lib/new.ts', 3]]);
});
test('ingestGit: a shallow clone throws DATA (exit 2) with one line and writes nothing', async () => {
  const r = mk(); r.commit({ files: { 'a.txt': '1' } }); r.commit({ files: { 'a.txt': '2' } });
  const sh = fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-shallow-')); keep.push(sh); fs.rmSync(sh, { recursive: true });
  execFileSync('git', ['clone', '-q', '--depth=1', `file://${r.dir}`, sh], { env: gitEnv() });
  const c = ctxFor({ dir: sh } as Repo);
  await assert.rejects(ingestGit(c.ctx, {}), (e: Error & { exitCode?: number }) => e.message === 'shallow clone: run git fetch --unshallow' && e.exitCode === 2);
  assert.deepEqual(fs.readdirSync(path.join(c.dir, 'cache')), []);
});
test('ingestGit: a partial clone warns once and proceeds', async () => {
  const r = mk(); r.commit({ files: { 'a.txt': '1\n' } }); r.commit({ files: { 'a.txt': '2\n' } });
  r.git('config', 'uploadpack.allowFilter', 'true');
  const pc = fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-partial-')); keep.push(pc); fs.rmSync(pc, { recursive: true });
  execFileSync('git', ['clone', '-q', '--filter=blob:none', `file://${r.dir}`, pc], { env: gitEnv() });
  const c = ctxFor({ dir: pc } as Repo);
  const res = await ingestGit(c.ctx, {});
  assert.equal(res.written, 1);
  assert.equal(c.err.length, 1); assert.match(c.err[0] ?? '', /partial clone/);
});
test('ingestGit: incremental from the cursor equals a fresh full run', async () => {
  const r = mk();
  for (let i = 0; i < 6; i++) r.commit({ files: { 'a.ts': `${i}\n`, 'b.ts': `${i}\n` }, who: i % 2 ? ANA : BEN });
  const c = ctxFor(r);
  await ingestGit(c.ctx, {});
  for (let i = 6; i < 9; i++) r.commit({ files: { 'a.ts': `${i}\n`, 'c.ts': `${i}\n` } });
  const inc = await ingestGit(c.ctx, {});
  const incText = fs.readFileSync(path.join(c.dir, 'cache/git.jsonl'), 'utf8');
  const f = ctxFor(r); // fresh cache dir? same dir: use --full instead
  const full = await ingestGit(f.ctx, { full: true });
  assert.equal(inc.cursor, full.cursor);
  assert.equal(fs.readFileSync(path.join(f.dir, 'cache/git.jsonl'), 'utf8'), incText);
});
test('ingestGit: incremental run reads only <cursor>..HEAD', async () => {
  const r = mk();
  r.commit({ files: { 'a.ts': '0\n' } });
  const c = ctxFor(r);
  await ingestGit(c.ctx, {});
  r.commit({ files: { 'a.ts': '1\n' } });
  const calls: string[][] = [];
  const spy = { ...(c.ctx as object), git: (...a: string[]) => { calls.push(a); return makeGit(r.dir)(...a); } };
  await ingestGit(spy as never, {});
  assert.ok(calls.some((a) => a[0] === 'merge-base' && a.includes('--is-ancestor')));
});
test('ingestGit: after amending the cursor commit the next run rebuilds and equals a fresh run (Review Focus 2)', async () => {
  const r = mk();
  r.commit({ files: { 'a.ts': '1\n', 'gone.ts': 'g\n' } });
  const tip = r.commit({ files: { 'a.ts': '2\n', 'gone.ts': null, 'x.ts': 'x\n' } });
  const c = ctxFor(r);
  const first = await ingestGit(c.ctx, {});
  assert.equal(first.cursor, tip);
  r.git('rm', '-q', 'x.ts'); // amend the cursor commit without x.ts: the stored facts about it must not survive
  runGit(r.dir, ['commit', '-q', '--amend', '--no-edit'], gitEnv(ANA, T0 + 99999));
  const after2 = await ingestGit(c.ctx, {});
  assert.notEqual(after2.cursor, tip);
  const fresh = ctxFor(r); fs.rmSync(path.join(fresh.dir, 'cache'), { recursive: true }); fs.mkdirSync(path.join(fresh.dir, 'cache'));
  await ingestGit(fresh.ctx, {});
  assert.equal(fs.readFileSync(path.join(c.dir, 'cache/git.jsonl'), 'utf8'), fs.readFileSync(path.join(fresh.dir, 'cache/git.jsonl'), 'utf8'));
  assert.equal(rows(c.dir).find((x) => x.path === 'x.ts'), undefined);
});
test('ingestGit: a hostile path never reaches output with control characters', async () => {
  const r = mk();
  r.commit({ files: { 'ok.ts': '1\n' } });
  try { r.commit({ files: { 'evil\x1b[2Jname.ts': '1\n', 'a\nb.ts': '1\n' } }); } catch { /* a platform may refuse the name */ }
  const c = ctxFor(r);
  await ingestGit(c.ctx, {});
  const text = fs.readFileSync(path.join(c.dir, 'cache/git.jsonl'), 'utf8');
  assert.doesNotMatch(text, /[\u0000-\u0009\u000b-\u001f\u007f]/);
  assert.ok(rows(c.dir).some((x) => x.path === 'ok.ts'));
});
test('ingestGit: an empty repository writes an empty file', async () => {
  const r = mk(); const c = ctxFor(r);
  const res = await ingestGit(c.ctx, {});
  assert.equal(res.written, 0);
  assert.equal(fs.readFileSync(path.join(c.dir, 'cache/git.jsonl'), 'utf8'), '');
});

test('20,000 commits mine within the bound', { skip: !process.env.CI_SLOW }, async () => {
  const r = fastRepo(20000); keep.push(r);
  const c = ctxFor(r, new Date((T0 + 20000 * 60 + 86400) * 1000));
  const t = Date.now();
  const res = await ingestGit(c.ctx, {});
  const ms = Date.now() - t;
  console.log(`ingest 20000 commits: ${ms} ms`);
  assert.ok(res.written > 0);
  assert.ok(ms < 4_000, `took ${ms} ms`);
});
