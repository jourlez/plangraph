// `refresh` (Task 29): rebuilds a stale index, fetches trusted targets, regenerates the git-ignored live documents; silent, bounded, never fails the session.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { world, run, git, tmp, cleanup } from './helpers/hook-world.ts';
import { openIndex, INDEX_FILE } from '../src/db.ts';

after(cleanup);
const PLUGIN = path.resolve(import.meta.dirname, '..');
const validIndex = (dir: string): boolean => { try { using h = openIndex(path.join(dir, INDEX_FILE), { readOnly: true, dir }); return !h.stale; } catch { return false; } };

test('no index: refresh builds it and prints nothing', async () => {
  const w = world();
  assert.equal(fs.existsSync(path.join(w.dir, INDEX_FILE)), false);
  const r = await run(w.root, ['refresh', '--quiet']);
  assert.deepEqual([r.code, r.out, r.err], [0, [], []]);
  assert.ok(validIndex(w.dir));
});

test('a fresh index: refresh does nothing (the index file is not touched)', async () => {
  const w = world();
  await run(w.root, ['refresh', '--fast', '--quiet']);
  const file = path.join(w.dir, INDEX_FILE), before = fs.statSync(file);
  fs.utimesSync(file, new Date(1_600_000_000_000), new Date(1_600_000_000_000)); // an old, fixed mtime: any rewrite would change it
  const r = await run(w.root, ['refresh', '--fast', '--quiet']);
  assert.deepEqual([r.code, r.out, r.err], [0, [], []]);
  assert.equal(fs.statSync(file).mtimeMs, 1_600_000_000_000);
  assert.equal(fs.statSync(file).ino, before.ino);
});

const editTicket = (dir: string, from: string, to: string): void => {
  const tdir = path.join(dir, 'nodes', 'ticket'), f = path.join(tdir, fs.readdirSync(tdir, { recursive: true, encoding: 'utf8' }).find((x) => x.endsWith('.pg')) as string);
  const text = fs.readFileSync(f, 'utf8');
  assert.ok(text.includes(from)); fs.writeFileSync(f, text.replace(from, to));
};

test('a stale index is rebuilt', async () => {
  const w = world();
  await run(w.root, ['refresh', '--fast', '--quiet']);
  editTicket(w.dir, 'summary "ticket 1"', 'summary "renamed"');
  assert.equal(validIndex(w.dir), false);
  const r = await run(w.root, ['refresh', '--fast', '--quiet']);
  assert.deepEqual([r.code, r.out, r.err], [0, [], []]);
  assert.ok(validIndex(w.dir));
});

test('a fetch failure exits 0 and leaves a valid index', async () => {
  const w = world({ fetch: { github: ['o/r'] } });
  const r = await run(w.root, ['refresh', '--quiet'], { deps: { syncFetch: async () => { throw new Error('network down'); } } });
  assert.deepEqual([r.code, r.out, r.err], [0, [], []]);
  assert.ok(validIndex(w.dir));
});

test('an untrusted fetch target is refused quietly and the index is valid', async () => {
  const w = world({ fetch: { github: ['o/r'] } });
  const r = await run(w.root, ['refresh', '--quiet']);
  assert.deepEqual([r.code, r.out, r.err], [0, [], []]);
  assert.ok(validIndex(w.dir));
});

test('--fast never runs the fetch step', async () => {
  const w = world();
  let fetched = 0;
  await run(w.root, ['refresh', '--fast', '--quiet'], { deps: { syncFetch: async () => { fetched++; } } });
  await run(w.root, ['refresh', '--quiet'], { deps: { syncFetch: async () => { fetched++; } } });
  assert.equal(fetched, 1);
});

test('a step that outlives the budget stops the refresh: exit 0, valid index, the later step never runs', async () => {
  const w = world();
  const ran: string[] = [];
  const t0 = Date.now();
  const r = await run(w.root, ['refresh', '--quiet', '--budget', '1'], { deps: { beforeStep: async (n) => { ran.push(n); if (n === 'fetch') await new Promise((ok) => setTimeout(ok, 4000).unref()); } } });
  assert.deepEqual([r.code, r.out, r.err], [0, [], []]);
  assert.ok(Date.now() - t0 < 3500, 'returned at the budget, not after the slow step');
  assert.ok(validIndex(w.dir));
  assert.ok(!ran.includes('docs'), `ran ${ran.join(',')}`);
});

test('refresh writes no tracked file and the live documents go to the ignored docs.out', async () => {
  const w = world();
  const before = git(w.root, 'status', '--porcelain');
  const r = await run(w.root, ['refresh', '--quiet']);
  assert.deepEqual([r.code, r.out, r.err], [0, [], []]);
  assert.equal(git(w.root, 'status', '--porcelain'), before);
  assert.ok(fs.existsSync(path.join(w.root, 'docs/plangraph/roadmap.md')), 'live copy written');
  git(w.root, 'check-ignore', '-q', 'docs/plangraph/roadmap.md');
});

test('docs.out that git does not ignore is never written', async () => {
  const w = world();
  fs.writeFileSync(path.join(w.root, '.gitignore'), '');
  git(w.root, 'commit', '-qam', 'unignore');
  await run(w.root, ['refresh', '--quiet']);
  assert.equal(fs.existsSync(path.join(w.root, 'docs/plangraph')), false);
});

test('a hand-edited region is reported on one line and kept', async () => {
  const w = world();
  await run(w.root, ['refresh', '--quiet']);
  const f = path.join(w.root, 'docs/plangraph/roadmap.md'), text = fs.readFileSync(f, 'utf8');
  const edited = text.replace(/(<!-- plangraph:begin[^\n]*-->\n)/, '$1HAND EDIT\n');
  assert.notEqual(edited, text, 'the region marker was found');
  fs.writeFileSync(f, edited);
  const r = await run(w.root, ['refresh', '--quiet']);
  assert.equal(r.code, 0); assert.equal(r.err.length, 1); assert.match(r.err[0] as string, /^docs: hand edit in roadmap\.md kept/);
  assert.equal(fs.readFileSync(f, 'utf8'), edited);
});

test('no plan directory: refresh exits 0 and prints nothing', async () => {
  const d = tmp(); git(d, 'init', '-q', '-b', 'main');
  const r = await run(d, ['refresh', '--quiet']);
  assert.deepEqual([r.code, r.out, r.err], [0, [], []]);
  assert.deepEqual(fs.readdirSync(d), ['.git']);
});

test('the real entry with no git repo and no plan directory: silent, exit 0, within 200 ms', () => {
  const d = tmp(), env = { PATH: path.dirname(process.execPath), HOME: d };
  for (const cmd of [['refresh', '--quiet'], ['hook-prompt']]) {
    const t0 = performance.now();
    const r = spawnSync(process.execPath, [path.join(PLUGIN, 'src/entry.js'), ...cmd], { cwd: d, env, input: '{"prompt":"look at ABC-1"}', encoding: 'utf8' });
    const ms = performance.now() - t0;
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', ''], cmd.join(' '));
    assert.ok(ms < 200, `${cmd.join(' ')} took ${ms.toFixed(0)} ms`);
  }
  assert.deepEqual(fs.readdirSync(d), [], 'nothing created, not even a compile cache');
});

test('card --refresh prints the card first, then refreshes a stale index; the card is the one a plain card prints', async () => {
  const w = world();
  assert.equal((await run(w.root, ['build'])).code, 0);
  editTicket(w.dir, 'summary "ticket 1"', 'summary "renamed"');
  const plain = await run(w.root, ['card', '--if-present']);
  assert.equal(validIndex(w.dir), false);
  const r = await run(w.root, ['card', '--if-present', '--refresh']);
  assert.equal(r.code, 0);
  assert.deepEqual(r.out, plain.out, 'the card prints before the refresh, from the index as it was');
  assert.ok(validIndex(w.dir), 'the refresh ran after the card');
});

test('card --refresh with no plan directory prints nothing and exits 0', async () => {
  const d = tmp(); git(d, 'init', '-q', '-b', 'main');
  const r = await run(d, ['card', '--if-present', '--refresh']);
  assert.deepEqual([r.code, r.out, r.err], [0, [], []]);
});
