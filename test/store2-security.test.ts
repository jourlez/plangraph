// Regression tests for the storage-integrity findings of the independent review (B1, B2, M1, M2, m1, m2, m6 and the hash length).
// Each test reproduces the exploit as it was reported.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { withTxn } from '../lib/store2/txn.ts';

const made: string[] = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (): string => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sec2-'))); made.push(d); return d; };
const git = (cwd: string, ...a: string[]): string => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });

// ---------- B1: a committed journal ----------
function plant(root: string, id: string, journal: unknown, stagedAs?: string): void {
  const dir = path.join(root, '.txn', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'journal.json'), typeof journal === 'string' ? journal : JSON.stringify(journal));
  if (stagedAs) fs.writeFileSync(path.join(dir, stagedAs), 'staged\n');
}
const quarantined = (root: string, id: string): boolean => fs.readdirSync(path.join(root, '.txn')).some((n) => n.startsWith(`${id}.bad`));

test('B1: a journal whose stage escapes the txn directory moves nothing and is quarantined', () => {
  const base = tmp(), root = path.join(base, 'plan');
  fs.mkdirSync(path.join(base, 'secret'), { recursive: true });
  fs.writeFileSync(path.join(base, 'secret', 'key'), 'PRIVATE');
  plant(root, 'evil', { id: 'evil', ops: [{ op: 'write', path: 'stolen.txt', stage: '../../../secret/key' }] });
  withTxn(root, (tx) => { tx.write('ok.txt', 'fine\n'); }); // any later write triggers recovery and must still work
  assert.equal(fs.readFileSync(path.join(base, 'secret', 'key'), 'utf8'), 'PRIVATE', 'the secret file stays where it was');
  assert.equal(fs.existsSync(path.join(root, 'stolen.txt')), false);
  assert.equal(fs.readFileSync(path.join(root, 'ok.txt'), 'utf8'), 'fine\n', 'a bad journal is not a permanent denial of service');
  assert.equal(quarantined(root, 'evil'), true);
  assert.equal(fs.existsSync(path.join(root, '.txn', 'evil')), false);
});

for (const [name, journal] of [
  ['an id that is not the directory name', { id: 'other', ops: [{ op: 'write', path: 'x.txt', stage: 'f0' }] }],
  ['an unknown op', { id: 'bad', ops: [{ op: 'chmod', path: 'x.txt', stage: 'f0' }] }],
  ['an escaping path', { id: 'bad', ops: [{ op: 'write', path: '../x.txt', stage: 'f0' }] }],
  ['a path into the staging area', { id: 'bad', ops: [{ op: 'remove', path: '.txn/lock' }] }],
  ['a stage that is not f<digits>', { id: 'bad', ops: [{ op: 'write', path: 'x.txt', stage: 'journal.json' }] }],
  ['ops that are not a list', { id: 'bad', ops: 'x' }],
  ['text that is not JSON', 'not json'],
] as const) {
  test(`B1: ${name} applies nothing, deletes nothing and is quarantined`, () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, 'keep.txt'), 'keep');
    plant(root, 'bad', journal, 'f0');
    withTxn(root, (tx) => { tx.write('ok.txt', '1'); });
    assert.equal(fs.existsSync(path.join(root, 'x.txt')), false);
    assert.equal(fs.readFileSync(path.join(root, 'keep.txt'), 'utf8'), 'keep');
    assert.equal(fs.existsSync(path.join(root, 'ok.txt')), true);
    assert.equal(quarantined(root, 'bad'), true);
    assert.equal(fs.existsSync(path.join(root, '.txn', 'bad.bad', 'f0')), true, 'the quarantined files are kept for inspection');
  });
}

test('B1: a valid journal is still rolled forward', () => {
  const root = tmp();
  plant(root, 'good', { id: 'good', ops: [{ op: 'write', path: 'a/b.txt', stage: 'f0' }] }, 'f0');
  withTxn(root, () => {});
  assert.equal(fs.readFileSync(path.join(root, 'a', 'b.txt'), 'utf8'), 'staged\n');
});

test('B1: a journal that git tracks is never applied', () => {
  const root = tmp();
  git(root, 'init', '-q');
  plant(root, 'good', { id: 'good', ops: [{ op: 'write', path: 'a.txt', stage: 'f0' }] }, 'f0');
  git(root, 'add', '-f', '.txn/good');
  withTxn(root, (tx) => { tx.write('ok.txt', '1'); });
  assert.equal(fs.existsSync(path.join(root, 'a.txt')), false, 'a tracked journal is hostile data');
  assert.equal(fs.existsSync(path.join(root, 'ok.txt')), true, 'and does not block the writer');
  assert.equal(fs.existsSync(path.join(root, '.txn', 'good', 'journal.json')), true, 'a tracked entry is not deleted either');
});

test('B1: a journal that is a symlink is never read', () => {
  const base = tmp(), root = path.join(base, 'plan');
  fs.mkdirSync(path.join(root, '.txn', 'ln'), { recursive: true });
  fs.writeFileSync(path.join(base, 'j.json'), JSON.stringify({ id: 'ln', ops: [{ op: 'write', path: 'a.txt', stage: 'f0' }] }));
  fs.symlinkSync(path.join(base, 'j.json'), path.join(root, '.txn', 'ln', 'journal.json'));
  fs.writeFileSync(path.join(root, '.txn', 'ln', 'f0'), 'x');
  withTxn(root, () => {});
  assert.equal(fs.existsSync(path.join(root, 'a.txt')), false);
  assert.equal(quarantined(root, 'ln'), true);
});

// ---------- m6: no directory is created outside the root ----------
test('m6: a symlinked directory creates nothing outside the root', () => {
  const base = tmp(), root = path.join(base, 'plan'), out = path.join(base, 'out');
  fs.mkdirSync(root); fs.mkdirSync(out);
  fs.symlinkSync(out, path.join(root, 'nodes'));
  assert.throws(() => withTxn(root, (tx) => { tx.write('nodes/ticket/ab/x.pg', 'x'); }));
  assert.deepEqual(fs.readdirSync(out), [], 'no ticket/ab directory was made through the symlink');
  // the same through a journal that was committed before the symlink appeared
  plant(root, 'late', { id: 'late', ops: [{ op: 'write', path: 'nodes/ticket/ab/y.pg', stage: 'f0' }] }, 'f0');
  assert.throws(() => withTxn(root, () => {}));
  assert.deepEqual(fs.readdirSync(out), []);
});

// ---------- B2: a node file that could not be parsed is never overwritten ----------
import { EntityStore } from '../lib/store2/entitystore.ts';
import { nodePath } from '../lib/store2/layout.ts';
import { writeNode, readNodes } from '../lib/store2/nodes.ts';
import { spawn } from 'node:child_process';

const entityDir = (): string => { const d = tmp(); fs.writeFileSync(path.join(d, 'format.json'), '{"format_version":2,"min_reader":2,"storage":"entity"}\n'); return d; };
const store = (dir: string): EntityStore => new EntityStore({ dir, root: dir });
const CONFLICT = 'id "T-1"\n<<<<<<< ours\nsummary "mine"\n=======\nsummary "theirs"\n>>>>>>> theirs\n';
function plantNode(dir: string, id: string, text: string): string {
  const f = nodePath(dir, 'ticket', id);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
  return f;
}

for (const [name, text] of [['conflict markers', CONFLICT], ['a bad line', 'id "T-1"\nthis is not a field\n'], ['an oversize file', `id "T-1"\nnote "${'x'.repeat(300 * 1024)}"\n`]] as const) {
  test(`B2: writeKind xref on a node with ${name} refuses with a DATA error and writes nothing`, () => {
    const dir = entityDir(), f = plantNode(dir, 'T-1', text);
    assert.throws(() => store(dir).writeKind('xref', [{ type: 'ticket', id: 'T-1', sys: 'jira', xid: 'X-1' }]), (e: { code?: string; message?: string }) => e.code === 'DATA' && /run plangraph resolve or check/.test(e.message ?? ''));
    assert.equal(fs.readFileSync(f, 'utf8'), text, 'both sides of the conflict are still on disk');
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n !== 'format.json' && n !== 'nodes' && n !== '.txn'), []);
  });
}

test('B2: addRows and a primary kind write also refuse, and a write that does not touch the file still works', () => {
  const dir = entityDir(), f = plantNode(dir, 'T-1', CONFLICT);
  assert.throws(() => store(dir).addRows('xref', [{ type: 'ticket', id: 'T-1', sys: 'jira', xid: 'X-1' }]), /run plangraph resolve or check/);
  assert.throws(() => store(dir).writeKind('ticket', [{ key: 'T-1', summary: 's' }]), /run plangraph resolve or check/);
  assert.throws(() => writeNode(dir, 'ticket', { id: 'T-1', summary: 's' }), /run plangraph resolve or check/);
  store(dir).writeKind('ticket', [{ key: 'T-2', summary: 'other' }]);
  assert.equal(fs.readFileSync(f, 'utf8'), CONFLICT);
  assert.deepEqual(store(dir).readKind('ticket', { defaults: false }).map((r) => r.key), ['T-2']);
});

// ---------- m1: a file that holds another id is never replaced ----------
test('m1: a file at the computed path that holds a different id is refused by writeNode and by the store', () => {
  const dir = entityDir(), f = plantNode(dir, 'A', 'id "B"\nsummary "victim"\n'); // what a crafted colliding id would leave at A\'s path
  assert.throws(() => writeNode(dir, 'ticket', { id: 'A', summary: 'new' }), /run plangraph resolve or check|different id/);
  assert.throws(() => store(dir).writeKind('ticket', [{ key: 'A', summary: 'new' }]), /run plangraph resolve or check|different id/);
  assert.equal(fs.readFileSync(f, 'utf8'), 'id "B"\nsummary "victim"\n');
});

// ---------- M2: no lost update between processes ----------
const SCRIPT = (op: string): string => `
import { EntityStore } from ${JSON.stringify(path.resolve(import.meta.dirname, '../lib/store2/entitystore.ts'))};
import { withNodes, renameNode } from ${JSON.stringify(path.resolve(import.meta.dirname, '../lib/store2/nodes.ts'))};
const [dir, n] = process.argv.slice(1);
const s = new EntityStore({ dir, root: dir });
${op}
`;
const spawnNode = (script: string, ...args: string[]): Promise<{ code: number | null; err: string }> => new Promise((resolve) => {
  const c = spawn(process.execPath, ['--input-type=module', '-e', script, ...args], { env: { PATH: process.env.PATH ?? '' } });
  let err = ''; c.stderr.on('data', (d) => { err += d; });
  c.on('close', (code) => resolve({ code, err }));
});
const N = 10;

test('M2: concurrent addRows of xref and link rows from separate processes lose nothing', async () => {
  const dir = entityDir();
  store(dir).writeKind('ticket', Array.from({ length: N }, (_, i) => ({ key: `T-${i}`, summary: 's' })));
  const op = "s.addRows('xref', [{ type: 'ticket', id: 'T-' + n, sys: 'jira', xid: 'X-' + n }]); s.addRows('link', [{ from: 'T-' + n, from_type: 'ticket', rel: 'touches', to: 'repo:r', to_type: 'repo' }]);";
  const rs = await Promise.all(Array.from({ length: N }, (_, i) => spawnNode(SCRIPT(op), dir, String(i))));
  for (const r of rs) assert.equal(r.code, 0, r.err);
  assert.equal(store(dir).readKind('xref', { defaults: false }).length, N);
  assert.equal(store(dir).readKind('link', { defaults: false }).length, N);
  assert.equal(store(dir).readKind('ticket', { defaults: false }).length, N, 'no ticket was lost');
});

test('M2: addRows is idempotent and removeRows removes only the named rows', () => {
  const dir = entityDir(), s = store(dir);
  s.writeKind('ticket', [{ key: 'T-1', summary: 'a' }, { key: 'T-2', summary: 'b' }]);
  const x = { type: 'ticket', id: 'T-1', sys: 'jira', xid: 'X-1' }, y = { type: 'ticket', id: 'T-2', sys: 'jira', xid: 'X-2' };
  assert.equal(s.addRows('xref', [x, y]), 2);
  assert.equal(s.addRows('xref', [x]), 0, 'the same row again changes no file');
  assert.equal(s.removeRows('xref', [{ type: 'ticket', id: 'T-1', sys: 'jira', xid: 'X-1' }]), 1);
  assert.deepEqual(s.readKind('xref', { defaults: false }).map((r) => r.xid), ['X-2']);
  s.addRows('xref', [x]);
  assert.equal(s.removeRows('ticket', [{ key: 'T-2' }]), 1);
  assert.deepEqual(s.readKind('ticket', { defaults: false }).map((r) => r.key), ['T-1']);
  const x2 = { type: 'ticket', id: 'T-1', sys: 'jira', xid: 'X-9' };
  assert.equal(s.addRows('xref', [x2, { ...x, note: 'n' }]), 1);
  assert.deepEqual(s.readKind('xref', { defaults: false }).map((r) => r.xid).sort(), ['X-1', 'X-2', 'X-9'].sort(), 'rows of one ticket are kept side by side; the same identity is replaced, not duplicated');
  assert.equal(s.removeRows('xref', [x2]), 1);
  assert.deepEqual(s.readKind('xref', { defaults: false }).map((r) => r.xid).sort(), ['X-1', 'X-2']);
  assert.throws(() => s.addRows('meta', [{ k: 'a', v: 'b' }]), TypeError);
});

test('M2: removeRows does not touch a ticket another writer created in between', async () => {
  const dir = entityDir(), s = store(dir);
  s.writeKind('ticket', [{ key: 'T-1', summary: 'a' }]);
  // removeRows is the delta: it cannot touch T-9, which another process created
  const make = await spawnNode(SCRIPT("s.addRows('ticket', [{ key: 'T-9', summary: 'new' }]);"), dir, '0');
  assert.equal(make.code, 0, make.err);
  s.removeRows('ticket', [{ key: 'T-1' }]);
  assert.deepEqual(s.readKind('ticket', { defaults: false }).map((r) => r.key), ['T-9']);
});

test('M2: withNodes runs a read-modify-write under the lock: concurrent increments of one node all count', async () => {
  const dir = entityDir();
  writeNode(dir, 'decision', { id: 'D-1', count: 0 });
  const op = "withNodes(dir, (t) => { const d = t.read('decision').find((x) => x.id === 'D-1'); t.write('decision', { ...d, count: d.count + 1 }); });";
  const rs = await Promise.all(Array.from({ length: N }, (_, i) => spawnNode(SCRIPT(op), dir, String(i))));
  for (const r of rs) assert.equal(r.code, 0, r.err);
  assert.equal(readNodes(dir, 'decision').nodes[0]?.count, N);
});

test('M2: renameNode checks the target under the lock, in one transaction', async () => {
  const dir = entityDir();
  writeNode(dir, 'decision', { id: 'D-1' });
  writeNode(dir, 'decision', { id: 'D-2' });
  const rs = await Promise.all([spawnNode(SCRIPT("renameNode(dir, 'decision', 'D-1', 'D-9');"), dir, '0'), spawnNode(SCRIPT("renameNode(dir, 'decision', 'D-2', 'D-9');"), dir, '1')]);
  assert.equal(rs.filter((r) => r.code === 0).length, 1, 'exactly one rename wins');
  const ids = readNodes(dir, 'decision').nodes.map((n) => n.id).sort();
  assert.equal(ids.length, 2, 'the loser is still there under its own id');
  assert.ok(ids.includes('D-9'));
});

// ---------- m2: a duplicate per-element key is a scalar conflict ----------
import { resolveConflicts } from '../lib/store2/resolve.ts';
const hunk = (ours: string, theirs: string): string => `<<<<<<< ours\n${ours}\n=======\n${theirs}\n>>>>>>> theirs\n`;
for (const [name, field, id, ours, theirs] of [
  ['capacity', 'capacity', 'Ana', 'capacity {"sp":5,"sprint":3}', 'capacity {"sp":8,"sprint":3}'],
  ['links', 'links', 'T-1', 'links {"attrs":{"conf":1},"rel":"touches","to":"repo:a"}', 'links {"attrs":{"conf":2},"rel":"touches","to":"repo:a"}'],
  ['xrefs', 'xrefs', 'T-1', 'xrefs {"sys":"jira","xid":"A-1","note":"x"}', 'xrefs {"sys":"jira","xid":"A-1","note":"y"}'],
] as const) {
  test(`m2: two ${name} elements with one key are left as a conflict, not unioned`, () => {
    const dir = entityDir(), kind = name === 'capacity' ? 'person' : 'ticket', f = nodePath(dir, kind, id), text = `id "${id}"\n${hunk(ours, theirs)}`;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
    const r = resolveConflicts(dir);
    assert.deepEqual(r.resolved, []);
    assert.equal(r.left.length, 1);
    assert.equal(r.left[0]?.field, field);
    assert.equal(fs.readFileSync(f, 'utf8'), text, 'the file is untouched');
  });
}

test('m2: different keys are still unioned, and the write goes through withTxn (it finishes an interrupted transaction first)', () => {
  const dir = entityDir(), f = nodePath(dir, 'person', 'Ana');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, `id "Ana"\n${hunk('capacity {"sp":5,"sprint":3}', 'capacity {"sp":8,"sprint":4}')}`);
  plant(dir, 'pending', { id: 'pending', ops: [{ op: 'write', path: 'marker.txt', stage: 'f0' }] }, 'f0');
  const r = resolveConflicts(dir);
  assert.equal(r.resolved.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, 'marker.txt'), 'utf8'), 'staged\n', 'the store lock and recovery ran before the write');
  assert.match(fs.readFileSync(f, 'utf8'), /capacity \{"sp":5,"sprint":3\}\ncapacity \{"sp":8,"sprint":4\}\n/);
  assert.deepEqual(fs.readdirSync(path.join(dir, '.txn')).filter((n) => n !== 'lock'), []);
});

// ---------- M1: one hostile or odd `at` must not move every later event ----------
import { appendEvent, readEvents } from '../lib/store2/batches.ts';
import { checkBatches } from '../lib/store2/check-batches.ts';
import { commands as claimCmd } from '../src/commands/flow-claim.ts';
import { flowFixture, run as runCmd, cleanup as cleanupFlow } from './helpers/flow-ctx.ts';

after(cleanupFlow);
const putEvents = (root: string, rel: string, rows: object[]): void => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), rows.map((r) => `${JSON.stringify(r)}\n`).join('')); };
const NOW = new Date('2026-11-27T10:00:00Z');

test('M1: a row with at "Z" is not an event, is reported by check, and later appends land in the month directory', () => {
  const root = tmp();
  putEvents(root, 'events/2026-11/mallory.00000000.01.jsonl', [{ at: 'Z', by: 'mallory', seq: 0, task: 'T-1', to: 'done' }]);
  const e = appendEvent(root, 'alice', { task: 'T-2', to: 'claimed', by: 'alice' }, { now: NOW, branch: 'main' });
  assert.equal(e.at, '2026-11-27T10:00:00Z');
  assert.ok(fs.existsSync(path.join(root, 'events', '2026-11')) && fs.readdirSync(path.join(root, 'events', '2026-11')).some((n) => n.startsWith('alice.')));
  assert.equal(fs.existsSync(path.join(root, 'events', 'Z')), false);
  assert.deepEqual(readEvents(root).map((x) => x.task), ['T-2'], 'the odd row is not an event, the real one is read back');
  const v = checkBatches(root);
  assert.equal(v.some((x) => x.path === 'events/2026-11/mallory.00000000.01.jsonl' && x.code === 'BAD_LINE' && x.line === 1), true);
});

for (const at of ['2026-11-27', '2026-11-27T10:00:00.5Z', '2026-11-27T10:00:00+01:00', '2026-11-27 10:00:00Z', '20261127T100000Z', 'x'.repeat(30)]) {
  test(`M1: at ${JSON.stringify(at)} is not an event`, () => {
    const root = tmp();
    putEvents(root, 'events/2026-11/m.00000000.01.jsonl', [{ at, by: 'm', seq: 0, task: 'T-1', to: 'done' }]);
    assert.deepEqual(readEvents(root), []);
  });
}

test('M1: a latest at more than 24 hours ahead of the wall clock is ignored; one inside the skew still wins', () => {
  const root = tmp();
  putEvents(root, 'events/2099-01/m.00000000.01.jsonl', [{ at: '2099-01-01T00:00:00Z', by: 'm', seq: 0, task: 'T-1', to: 'claimed' }]);
  const e = appendEvent(root, 'alice', { task: 'T-2', to: 'claimed', by: 'alice' }, { now: NOW, branch: 'main' });
  assert.equal(e.at, '2026-11-27T10:00:00Z', 'a laptop set to 2099 does not pin everyone to that month');
  assert.equal(e.seq, 0);
  const root2 = tmp();
  putEvents(root2, 'events/2026-11/m.00000000.01.jsonl', [{ at: '2026-11-28T09:00:00Z', by: 'm', seq: 3, task: 'T-1', to: 'claimed' }]); // 23 hours ahead
  const e2 = appendEvent(root2, 'alice', { task: 'T-2', to: 'claimed', by: 'alice' }, { now: NOW, branch: 'main' });
  assert.deepEqual([e2.at, e2.seq], ['2026-11-28T09:00:00Z', 4]);
});

test('M1: an actor or time that would build a path outside events/<yyyy-mm>/<actor>.<bh8>.<dd>.jsonl is refused before anything is written', () => {
  const root = tmp();
  assert.throws(() => appendEvent(root, 'alice', { task: 'T-1', to: 'claimed', by: 'alice' }, { now: new Date('+010000-01-01T00:00:00Z'), branch: 'main' }), /BAD_PATH|path/);
  assert.equal(fs.existsSync(path.join(root, 'events')), false);
});

test('M1: the guard probes at the real append position, not at the end of time (a future-dated event is replayed after the new one)', async () => {
  const f = flowFixture({ n: 3 });
  putEvents(f.dir, 'events/2099-01/bo.00000000.01.jsonl', [{ at: '2099-01-01T00:00:00Z', by: 'bo', seq: 0, task: 'T-1', to: 'claimed' }]);
  const code = await runCmd(f, claimCmd, 'flow-claim', ['T-1'], { by: 'ana' });
  assert.equal(code, 0, f.err.join('\n'));
  const mine = readEvents(f.dir).filter((e) => e.by === 'ana');
  assert.equal(mine.length, 1);
  assert.match(mine[0]?.at as string, /^2026-11-26T/);
});

test('m5: appendEvent refuses an event whose by is not its actor (a reader would not count it)', () => {
  const root = tmp();
  assert.throws(() => appendEvent(root, 'alice', { task: 'T-1', to: 'claimed', by: 'bob' }, { now: NOW, branch: 'main' }), /own actor/);
  assert.equal(fs.existsSync(path.join(root, 'events')), false);
});

test('m1: a node read at the path of another id is refused with the different-id reason; the same id is returned; a symlink is left to the transaction', async () => {
  const { ownedNode } = await import('../lib/store2/nodes.ts');
  const dir = tmp(), f = path.join(dir, 'nodes/ticket/aa/a~000000000000.pg');
  assert.throws(() => ownedNode(dir, f, 'A', { node: { id: 'B' }, text: '' } as never), /\(it holds a different id\)/);
  const same = { id: 'A', summary: 's' };
  assert.equal(ownedNode(dir, f, 'A', { node: same, text: '' } as never), same);
  assert.equal(ownedNode(dir, f, 'A', { problem: { code: 'SYMLINK' } } as never), null);
  assert.throws(() => ownedNode(dir, f, 'A', { problem: { code: 'BAD_LINE' } } as never), /\(BAD_LINE\)/);
});
