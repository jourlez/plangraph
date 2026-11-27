// m7: the index build runs in a child process with a hard deadline, so the budget holds for a synchronous step: the child is killed at the
// deadline, its temp files are removed and the old index is still valid.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { world, run, cleanup } from './helpers/hook-world.ts';
import { openIndex, INDEX_FILE } from '../src/db.ts';

after(cleanup);
const openable = (dir: string): boolean => { try { using h = openIndex(path.join(dir, INDEX_FILE), { readOnly: true, dir }); return h !== null; } catch { return false; } };
const editTicket = (dir: string, from: string, to: string): void => {
  const tdir = path.join(dir, 'nodes', 'ticket'), f = path.join(tdir, fs.readdirSync(tdir, { recursive: true, encoding: 'utf8' }).find((x) => x.endsWith('.pg')) as string);
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(from, to));
};
// a stand-in for the build: makes its own temp file like buildIndex does, then spins synchronously for 8 s
const SLOW = (dir: string): string[] => [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(path.join(dir, `${INDEX_FILE}.tmp-`))}+process.pid,'x');require('node:fs').writeFileSync(${JSON.stringify(path.join(dir, `${INDEX_FILE}.tmp-`))}+process.pid+'-journal','x');const t=Date.now();while(Date.now()-t<8000);`];

test('a synchronous build that outlives the budget is killed at the deadline: exit 0, temp files gone, old index still valid', async () => {
  const w = world();
  await run(w.root, ['refresh', '--fast', '--quiet']);
  const file = path.join(w.dir, INDEX_FILE), old = fs.readFileSync(file);
  editTicket(w.dir, 'summary "ticket 1"', 'summary "renamed"'); // stale again
  const t0 = Date.now();
  const r = await run(w.root, ['refresh', '--quiet', '--budget', '1'], { deps: { buildCommand: SLOW(w.dir) } });
  assert.deepEqual([r.code, r.out, r.err], [0, [], []]);
  assert.ok(Date.now() - t0 < 4000, `returned at the budget (${Date.now() - t0} ms), not after the 8 s build`);
  assert.deepEqual(fs.readdirSync(w.dir).filter((f) => f.includes('.tmp-')), [], 'the killed build left no temp file');
  assert.ok(fs.readFileSync(file).equals(old), 'the old index is untouched');
  assert.ok(openable(w.dir));
});

test('a build that fails is not a crash: --quiet exits 0 and the old index stays', async () => {
  const w = world();
  await run(w.root, ['refresh', '--fast', '--quiet']);
  editTicket(w.dir, 'summary "ticket 1"', 'summary "renamed"');
  const r = await run(w.root, ['refresh', '--quiet'], { deps: { buildCommand: [process.execPath, '-e', 'process.exit(3)'] } });
  assert.equal(r.code, 0);
  assert.ok(openable(w.dir));
});

test('the real build runs in a child: a stale index is rebuilt within the budget', async () => {
  const w = world();
  const r = await run(w.root, ['refresh', '--fast', '--quiet', '--budget', '30']);
  assert.deepEqual([r.code, r.out, r.err], [0, [], []]);
  assert.ok(openable(w.dir));
});
