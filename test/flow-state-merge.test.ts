// Tests for event merging into task state: shuffled order, two simulated branches through the real appendEvent, clock rule, and speed (CI_SLOW=1).
// NOT covered: real git merges (test/store2-batches.test.ts does that).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendEvent, readEvents } from '../lib/store2/batches.ts';
import { deriveAll, deriveState, type Deps } from '../lib/flow/state.ts';

const made: string[] = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'flowstate-'))); made.push(d); return d; };
const NONE: Deps = { openDeps: () => [], gated: () => false };
const T = (s: string) => new Date(s);
const copy = (from: string, to: string) => fs.cpSync(from, to, { recursive: true });
const rng = (seed: number) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
const shuffle = <T>(a: T[], r: () => number): T[] => { const o = [...a]; for (let i = o.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [o[i], o[j]] = [o[j]!, o[i]!]; } return o; };

test('events from two branches derive the same state regardless of order (20 shuffles)', () => {
  const base = tmp(), a = tmp(), b = tmp(), out = tmp();
  appendEvent(base, 'ann', { task: 't1', to: 'claimed', by: 'ann' }, { now: T('2026-03-01T10:00:00Z'), branch: 'main' });
  copy(base, a); copy(base, b);
  appendEvent(a, 'ann', { task: 't1', to: 'in_progress', by: 'ann' }, { now: T('2026-03-01T10:05:00Z'), branch: 'feat-a' });
  appendEvent(a, 'ann', { task: 't1', to: 'in_review', by: 'ann', evidence: ['pr:o/r#1'] }, { now: T('2026-03-01T10:06:00Z'), branch: 'feat-a' });
  appendEvent(a, 'ann', { task: 't2', to: 'claimed', by: 'ann' }, { now: T('2026-03-01T10:06:00Z'), branch: 'feat-a' });
  appendEvent(b, 'bob', { task: 't1', to: 'claimed', by: 'bob' }, { now: T('2026-03-01T10:02:00Z'), branch: 'feat-b' });
  appendEvent(b, 'bob', { task: 't3', to: 'skipped', by: 'bob' }, { now: T('2026-03-01T10:03:00Z'), branch: 'feat-b' });
  copy(a, out); copy(b, out); // merged tree: union of the files (names carry actor and branch hash, so nothing collides)
  const evs = readEvents(out);
  assert.equal(evs.length, 6);
  const keys = ['t1', 't2', 't3'];
  const want = JSON.stringify([...deriveAll(keys, evs, NONE)]);
  const r = rng(7);
  for (let i = 0; i < 20; i++) {
    const files = readEvents(out, { fileOrder: (fs2) => shuffle(fs2, r) });
    assert.equal(JSON.stringify([...deriveAll(keys, files, NONE)]), want);
    assert.equal(JSON.stringify([...deriveAll(keys, shuffle(evs, r), NONE)]), want);
  }
  const m = deriveAll(keys, evs, NONE);
  assert.equal(m.get('t1')?.state, 'in_review'); // bob's claim at 10:02 is a DOUBLE_CLAIM and ignored; ann's later events stand
  assert.ok(m.get('t1')?.findings.some((f) => f.code === 'DOUBLE_CLAIM'));
  assert.equal(m.get('t3')?.state, 'skipped');
});

test('a fast-clock clone cannot outrank an event it has already read', () => {
  const root = tmp();
  appendEvent(root, 'ann', { task: 't', to: 'claimed', by: 'ann' }, { now: T('2026-03-01T10:00:00Z'), branch: 'fast' });
  const fast = appendEvent(root, 'ann', { task: 't', to: 'in_progress', by: 'ann' }, { now: T('2026-03-01T12:00:00Z'), branch: 'fast' }); // clock two hours ahead
  const slow = appendEvent(root, 'ann', { task: 't', to: 'in_review', by: 'ann' }, { now: T('2026-03-01T10:30:00Z'), branch: 'slow' }); // wall clock behind, but read the fast one
  assert.ok(slow.at >= fast.at && (slow.at > fast.at || slow.seq > fast.seq));
  assert.equal(deriveState('t', readEvents(root), NONE).state, 'in_review');
});

test('perf: 5,000 tasks with 20,000 events', { skip: process.env.CI_SLOW !== '1' }, () => {
  const MEDIAN_MS = 6; // measured median of deriveAll over this fixture (5.8 to 6.2 ms over three runs, Node 24, macOS)
  const keys: string[] = [], evs: ReturnType<typeof mk>[] = [];
  function mk(task: string, to: string, i: number, evidence: string[] = []) { return { at: `2026-03-${String(1 + (i % 28)).padStart(2, '0')}T10:00:00Z`, seq: i, actor: `a${i % 7}`, task, to, by: `u${i % 7}`, evidence }; }
  let i = 0;
  for (let t = 0; t < 5000; t++) { const k = `t${t}`; keys.push(k); evs.push(mk(k, 'claimed', i++), mk(k, 'in_progress', i++), mk(k, 'in_review', i++), mk(k, 'done', i++, ['pr:o/r#1'])); }
  const deps: Deps = { openDeps: (k) => { const n = Number(k.slice(1)); return n > 0 ? [`t${n - 1}`] : []; }, gated: () => false };
  const run = () => { const t0 = performance.now(); const m = deriveAll(keys, evs, deps, { merged: () => true }); const ms = performance.now() - t0; assert.equal(m.size, 5000); return ms; };
  run();
  const times = [run(), run(), run(), run(), run()].sort((x, y) => x - y), median = times[2]!;
  console.log(`flow-state perf median ${median.toFixed(1)} ms`);
  assert.ok(median < 10 * MEDIAN_MS, `median ${median} ms, limit ${10 * MEDIAN_MS} ms`);
});
