// acquireLock's retry bound for lib/store.ts, in a file of its own so that scripts/mutate.ts can run it alone: under a mutant that makes
// the lock loop endless, a test elsewhere that waits on a held lock would hang first and the kill would come only from the runner's timeout.
// NOT covered: real concurrent processes (test/store.test.ts) and the steal itself (test/mutation-kills-store.test.ts).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as S from '../lib/store.ts';

const made: string[] = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lockbound-'))); made.push(d); return d; };

// acquireLock's retry bound, proved by counting attempts instead of waiting for a hang: a spy on fs.openSync (the module's own fs object)
// counts the exclusive creates of the lock path and throws a distinct error past 50, far above the retries + 1 a bounded loop makes. A
// mutant that loops forever (the counter not advancing, the retry guard gone, a steal that never succeeds treated as a success, or a held
// guard reported as a finished steal) then fails on that error at once, the same way on every machine, instead of being killed only by
// the mutation runner's timeout.
test('lock retries are bounded: a live owner or a live stealer guard ends in "locked" after retries + 1 attempts (attempts counted, no clock)', (t) => {
  const d = tmp(), lock = path.join(d, '.lock'), old = new Date(Date.now() - 120000);
  const realOpen = fs.openSync;
  let creates = 0;
  t.mock.method(fs, 'openSync', (...a: Parameters<typeof fs.openSync>) => {
    if (a[0] === lock && a[1] === 'wx' && ++creates > 50) throw new Error('runaway lock retry loop');
    return realOpen(...a);
  });
  const locked = (e: Error) => e.message === `could not take lock .lock: locked by pid ${process.pid}`;
  // a live owner: every attempt fails, the loop must give up after retries + 1 creates
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'live' }));
  creates = 0;
  assert.throws(() => S.acquireLock(lock, { retries: 3, waitMs: 1 }), locked);
  assert.equal(creates, 4, 'retries: 3 means 4 create attempts');
  // a stale lock of a dead pid, but a live stealer guard: no steal happens, and the loop still gives up after retries + 1 creates
  fs.writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 13, token: 'stale' })); fs.utimesSync(lock, old, old);
  fs.writeFileSync(`${lock}.steal`, JSON.stringify({ pid: process.pid }));
  creates = 0;
  assert.throws(() => S.acquireLock(lock, { staleMs: 1000, retries: 3, waitMs: 1 }), (e: Error) => e.message === `could not take lock .lock: locked by pid ${2 ** 22 + 13}`);
  assert.equal(creates, 4, 'a held guard is waited on like a live owner: 4 create attempts');
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).token, 'stale', 'the stale lock is left alone while another stealer holds the guard');
});
