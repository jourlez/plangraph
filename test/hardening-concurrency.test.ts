// Hardening (task 33, Review Focus 6): two agents in one clone. Real processes run flow-claim on the same task, ingest writes, and `refresh --quiet`
// beside `build`, all at once. Nothing is lost (every accepted write is on disk), nothing is half written (every file parses, `check` finds no bad
// line), the index is not corrupted (it opens and answers), and exactly one of two claims on one task wins (all through the store lock and withTxn).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { world, run, cleanup } from './helpers/hook-world.ts';
import { readEvents } from '../lib/store2/batches.ts';
import { readNodeKind } from '../lib/ingest/write.ts';
import { readStoreAt } from '../lib/planstore.ts';

const BIN = path.join(import.meta.dirname, '../bin/plangraph');
let W: { root: string; dir: string };
type Done = { code: number | null; out: string; err: string };
const child = (argv: string[], cwd = W.root): Promise<Done> => new Promise((resolve) => {
  const c = spawn(process.execPath, [BIN, ...argv], { cwd, env: { PATH: process.env.PATH, HOME: path.join(cwd, '..'), LC_ALL: 'C', TZ: 'UTC', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = ''; const timer = setTimeout(() => c.kill('SIGKILL'), 90000);
  c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; });
  c.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
});
const leftovers = (dir: string): string[] => { const t = path.join(dir, '.txn'); return fs.existsSync(t) ? fs.readdirSync(t).filter((n) => n !== 'lock') : []; };

before(async () => {
  W = world();
  fs.mkdirSync(path.join(W.root, 'docs'), { recursive: true });
  for (const n of ['a', 'b', 'c', 'd']) fs.writeFileSync(path.join(W.root, `docs/req-${n}.md`), `# R\n\nThe system shall do thing ${n} one.\n\nThe system shall do thing ${n} two.\n\nThe system shall do thing ${n} three.\n`);
  assert.equal((await run(W.root, ['build'])).code, 0);
});
after(cleanup);

test('Review Focus 6: two processes claiming the same task: exactly one wins, the loser exits 2, one claimed event is stored', async () => {
  const tasks = ['ABC-1', 'ABC-2', 'ABC-3', 'ABC-4', 'ABC-5', 'ABC-6'];
  const rounds = await Promise.all(tasks.flatMap((t) => [child(['flow-claim', t, '--by', 'ana']), child(['flow-claim', t, '--by', 'bo'])]));
  tasks.forEach((t, i) => {
    const [a, b] = [rounds[2 * i] as Done, rounds[2 * i + 1] as Done];
    const wins = [a, b].filter((r) => r.code === 0).length;
    assert.equal(wins, 1, `${t}: ${wins} winners: ${JSON.stringify([a, b])}`);
    const loser = a.code === 0 ? b : a;
    assert.equal(loser.code, 2, `${t}: the loser exits 2: ${loser.err}`);
    assert.match(loser.err, /DOUBLE_CLAIM/);
    assert.equal(loser.err.trim().split('\n').filter((l) => l.startsWith('error:')).length, 1, 'one error line');
  });
  const claims = readEvents(W.dir).filter((e) => e.to === 'claimed');
  for (const t of tasks) assert.equal(claims.filter((e) => e.task === t).length, 1, `${t}: one claim on disk`);
  assert.deepEqual(leftovers(W.dir), []);
});

test('ingest writers in parallel with flow-claim and each other: every node and event is on disk, every file parses, check finds no bad line', async () => {
  const before = readEvents(W.dir).length;
  const jobs = await Promise.all([
    ...['a', 'b', 'c', 'd'].map((n) => child(['ingest', 'requirements', `docs/req-${n}.md`])),
    child(['ingest', 'requirements', 'docs/req-a.md']), child(['ingest', 'requirements', 'docs/req-a.md']), // the same document twice at once
    child(['flow-progress', 'ABC-1', '--to', 'in_progress', '--by', 'ana']), ...['ABC-1', 'ABC-2', 'ABC-3', 'ABC-4', 'ABC-5', 'ABC-6', 'ABC-3'].map((t) => child(['flow-link', t, 'jira', t])),
  ]);
  for (const j of jobs) assert.equal(j.code, 0, `${j.err} ${j.out}`);
  assert.equal(readNodeKind({ dir: W.dir }, 'requirement').length, 12, '4 documents of 3 requirements, nothing lost, no duplicate');
  assert.equal(readEvents(W.dir).length, before + 1, 'the progress event is stored once');
  const xr = readStoreAt(W.dir).readKind('xref', { defaults: false });
  for (const t of ['ABC-1', 'ABC-2', 'ABC-3', 'ABC-4', 'ABC-5', 'ABC-6']) assert.equal(xr.filter((r) => r.id === t && r.sys === 'jira').length, 1, `${t}: one xref row, none lost, none doubled`);
  const c = await child(['check']);
  assert.doesNotMatch(c.out + c.err, /BAD_LINE|CONFLICT_MARKERS|ID_MISMATCH|DUPLICATE_ID|NOT_CANONICAL|OVERSIZE/);
  assert.deepEqual(leftovers(W.dir), []);
});

test('refresh --quiet beside build, claims and ingest: nothing printed, exit 0, a valid index, no lost write', async () => {
  const claims0 = readEvents(W.dir).filter((e) => e.to === 'claimed').length;
  for (let round = 0; round < 3; round++) {
    const jobs = await Promise.all([
      child(['refresh', '--quiet']), child(['build']), child(['refresh', '--fast', '--quiet']), child(['build']), child(['refresh', '--quiet']),
      child(['ingest', 'requirements', 'docs/req-b.md']), child(['flow-claim', `ABC-${round + 1}`, '--by', `late${round}`]),
    ]);
    for (const [i, j] of jobs.entries()) {
      if (i === 6) { assert.equal(j.code, 2, 'the task was claimed above: refused, not lost or crashed'); continue; }
      assert.equal(j.code, 0, `job ${i}: ${j.err} ${j.out}`);
      if (i === 0 || i === 2 || i === 4) { assert.equal(j.out, ''); assert.equal(j.err, ''); }
    }
    const m = await child(['map']);
    assert.equal(m.code, 0, m.err); assert.match(m.out, /^plangraph map/);
    const c = await child(['check']);
    assert.ok(c.code === 0 || c.code === 1, c.err);
    assert.doesNotMatch(c.out + c.err, /BAD_LINE|CONFLICT_MARKERS|corrupt|malformed|not a database/i);
  }
  assert.equal(readEvents(W.dir).filter((e) => e.to === 'claimed').length, claims0, 'the refused claims wrote nothing');
  assert.equal(fs.statSync(path.join(W.dir, 'plangraph.sqlite')).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(W.dir).filter((n) => /tmp|\.new|\.part/.test(n)), []);
  assert.deepEqual(leftovers(W.dir), []);
});

test('a free task claimed by two processes while refresh and build run: one winner, the index agrees', async () => {
  const w2 = world();
  assert.equal((await run(w2.root, ['build'])).code, 0);
  const rs = await Promise.all([child(['flow-claim', 'ABC-5', '--by', 'x1'], w2.root), child(['flow-claim', 'ABC-5', '--by', 'x2'], w2.root), child(['flow-claim', 'ABC-5', '--by', 'x3'], w2.root), child(['refresh', '--quiet'], w2.root), child(['build'], w2.root)]);
  assert.equal(rs.slice(0, 3).filter((r) => r.code === 0).length, 1, JSON.stringify(rs.slice(0, 3)));
  assert.equal(readEvents(w2.dir).filter((e) => e.to === 'claimed' && e.task === 'ABC-5').length, 1);
});
