// m5: who an event belongs to. A plain event file is named for its actor, and every row in it must be by that actor; a task held by one actor
// (claimed, in_progress, in_review) is not moved by another unless the flow command passes --force, which the event records.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { commands as claim } from '../src/commands/flow-claim.ts';
import { commands as progress } from '../src/commands/flow-progress.ts';
import { commands as done } from '../src/commands/flow-done.ts';
import { appendEvent, readEvents, branchHash } from '../lib/store2/batches.ts';
import { checkBatches } from '../lib/store2/check-batches.ts';
import { deriveState } from '../lib/flow/state.ts';
import { flowFixture, run, cleanup } from './helpers/flow-ctx.ts';

after(cleanup);
const NO_DEPS = { openDeps: (): string[] => [], gated: (): boolean => false };
const ev = (task: string, to: string, by: string, n: number, extra: object = {}) => ({ at: `2026-11-01T00:00:0${n}Z`, seq: 0, actor: by, task, to, by, evidence: [] as string[], ...extra });

test('m5: a row in a plain event file whose by is not the file actor is not an event, and check reports it', () => {
  const f = flowFixture({ n: 3 });
  const bh = branchHash(f.dir, 'main');
  const rel = `events/2026-11/alice.${bh}.01.jsonl`;
  fs.mkdirSync(path.dirname(path.join(f.dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(f.dir, rel), `${JSON.stringify({ at: '2026-11-01T00:00:00Z', seq: 0, task: 'T-1', to: 'done', by: 'bob', evidence: ['test:x'] })}\n${JSON.stringify({ at: '2026-11-01T00:00:01Z', seq: 0, task: 'T-1', to: 'claimed', by: 'alice' })}\n`);
  assert.deepEqual(readEvents(f.dir).map((e) => [e.by, e.to]), [['alice', 'claimed']]);
  const v = checkBatches(f.dir).filter((x) => x.path === rel);
  assert.deepEqual(v.map((x) => [x.code, x.line]), [['BAD_LINE', 1]]);
});

test('m5: a row of a compact file keeps its own actor and is read as before', () => {
  const f = flowFixture({ n: 3 });
  const rel = 'events/2026-10/_compact.00000000.jsonl';
  fs.mkdirSync(path.dirname(path.join(f.dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(f.dir, rel), `${JSON.stringify({ at: '2026-10-01T00:00:00Z', seq: 0, task: 'T-1', to: 'claimed', by: 'bob', actor: 'bob', bh8: 'aaaaaaaa' })}\n`);
  assert.equal(readEvents(f.dir).length, 1);
});

test('m5: deriveState refuses a move out of a held state by another actor, and honours force', () => {
  const held = (to: string, by: string, extra: object = {}) => deriveState('T-1', [ev('T-1', 'claimed', 'ana', 0), ev('T-1', to, by, 1, extra)], NO_DEPS);
  for (const to of ['ready', 'in_progress', 'in_review', 'needs_input', 'failed', 'skipped', 'removed']) {
    const d = held(to, 'ben');
    assert.equal(d.state, 'claimed', `${to} by ben is refused`);
    assert.equal(d.findings.some((x) => x.code === 'BAD_TRANSITION' && /held by ana/.test(x.detail)), true);
  }
  assert.equal(held('in_progress', 'ana').state, 'in_progress', 'the holder moves it');
  assert.equal(held('in_progress', 'ben', { force: true }).state, 'in_progress', 'force moves it');
  // the holder after a forced move is the forcing actor
  const after = deriveState('T-1', [ev('T-1', 'claimed', 'ana', 0), ev('T-1', 'in_progress', 'ben', 1, { force: true }), ev('T-1', 'in_review', 'ana', 2)], NO_DEPS);
  assert.equal(after.state, 'in_progress', 'ana no longer holds it');
  // a task entered at in_progress by one actor is held by that actor
  const direct = deriveState('T-1', [ev('T-1', 'in_progress', 'ana', 0), ev('T-1', 'in_review', 'ben', 1)], NO_DEPS);
  assert.equal(direct.state, 'in_progress');
  const rel = deriveState('T-1', [ev('T-1', 'claimed', 'ana', 0), ev('T-1', 'ready', 'ana', 1), ev('T-1', 'in_progress', 'ben', 2)], NO_DEPS);
  assert.equal(rel.state, 'in_progress', 'once released, anyone may take it');
});

test('m5: done by a non-holder is refused too; a non-held state is open to everyone', () => {
  const d = deriveState('T-1', [ev('T-1', 'claimed', 'ana', 0), ev('T-1', 'done', 'ben', 1, { evidence: ['test:x'] })], NO_DEPS);
  assert.equal(d.state, 'claimed');
  const open = deriveState('T-1', [ev('T-1', 'needs_input', 'ana', 0), ev('T-1', 'ready', 'ben', 1)], NO_DEPS);
  assert.equal(open.state, 'ready');
});

test('m5: flow-progress, flow-done and flow-claim by another actor exit 2 naming the holder; --force goes through and is recorded', async () => {
  const f = flowFixture({ n: 3 });
  assert.equal(await run(f, claim, 'flow-claim', ['T-1'], { by: 'ana' }), 0);
  assert.equal(await run(f, progress, 'flow-progress', ['T-1'], { to: 'in_progress', by: 'ben' }), 2);
  assert.match(f.err.join('\n'), /held by ana/);
  assert.equal(await run(f, done, 'flow-done', ['T-1'], { by: 'ben', evidence: ['test:x'] }), 2);
  assert.equal(await run(f, progress, 'flow-progress', ['T-1'], { to: 'ready', by: 'ben' }), 2);
  assert.equal(readEvents(f.dir).filter((e) => e.by === 'ben').length, 0, 'the refused moves wrote nothing');
  assert.equal(await run(f, progress, 'flow-progress', ['T-1'], { to: 'in_progress', by: 'ana' }), 0);
  assert.equal(await run(f, progress, 'flow-progress', ['T-1'], { to: 'in_progress', by: 'ben', force: true }), 0);
  const last = readEvents(f.dir).filter((e) => e.by === 'ben');
  assert.equal(last.length, 1);
  assert.equal(last[0]?.force, true, 'the forced event says so');
  assert.equal(await run(f, progress, 'flow-progress', ['T-1'], { to: 'in_review', by: 'ana' }), 2, 'ana no longer holds it');
  assert.equal(await run(f, claim, 'flow-claim', ['T-2'], { by: 'ana' }), 0);
  assert.equal(await run(f, claim, 'flow-claim', ['T-2'], { by: 'cy' }), 2, 'DOUBLE_CLAIM without force');
  assert.equal(await run(f, claim, 'flow-claim', ['T-2'], { by: 'cy', force: true }), 0, 'force takes a claim over');
  assert.equal(await run(f, done, 'flow-done', ['T-2'], { by: 'cy', evidence: ['test:x'] }), 0, 'the new holder finishes it');
});

test('m5: an event written without force carries no force field', async () => {
  const f = flowFixture({ n: 3 });
  assert.equal(await run(f, claim, 'flow-claim', ['T-2'], { by: 'ana' }), 0);
  assert.equal(Object.hasOwn(readEvents(f.dir)[0] as object, 'force'), false);
  void appendEvent;
});
