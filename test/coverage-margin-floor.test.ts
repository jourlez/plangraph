// Coverage margin for src/floor.js (the hook fast path and the opt-in table) and lib/store2/layout.ts (newId): every branch, with the process
// state (cwd, env, argv) set by the test and restored after it, so the result does not depend on where or how the runner started.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nodeSupported, floorMessage, floorHookLine, floorTry, noPlanDir, hookOptedIn, NODE_FLOOR } from '../src/floor.js';
import { newId, assertKind, idHash, slug } from '../lib/store2/layout.ts';

const KEYS = ['PLANGRAPH_DIR', 'GIT_DIR', 'GIT_WORK_TREE'] as const;
/** Runs fn with a clean plan-directory environment, the given cwd and argv, then puts everything back. */
async function within<T>(cwd: string, argv: string[], env: Partial<Record<(typeof KEYS)[number], string>>, fn: () => Promise<T>): Promise<T> {
  const saved = { cwd: process.cwd(), argv: process.argv, env: Object.fromEntries(KEYS.map((k) => [k, process.env[k]])) };
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  process.argv = ['node', 'entry', ...argv];
  process.chdir(cwd);
  try { return await fn(); } finally {
    process.chdir(saved.cwd); process.argv = saved.argv;
    for (const k of KEYS) { if (saved.env[k] === undefined) delete process.env[k]; else process.env[k] = saved.env[k]; }
  }
}
const tmp = (): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-margin-floor-')));

test('nodeSupported compares major and minor against the floor and refuses anything unparsable', () => {
  const [major, minor] = NODE_FLOOR.split('.').map(Number) as [number, number];
  assert.equal(nodeSupported(`${major}.${minor}.0`), true);
  assert.equal(nodeSupported(`v${major}.${minor + 1}.3`), true);
  assert.equal(nodeSupported(`${major}.${minor - 1}.9`), false);
  assert.equal(nodeSupported(`${major + 1}.0.0`), true);
  assert.equal(nodeSupported(`${major - 1}.99.0`), false);
  for (const bad of ['', 'abc', undefined, null, 24]) assert.equal(nodeSupported(bad), false);
  assert.match(floorMessage('1.2.3'), /needs Node >= .* \(found 1\.2\.3\)/);
  assert.ok(floorMessage('9'.repeat(50)).includes(`found ${'9'.repeat(20)})`));
  assert.ok(floorHookLine('v1'.repeat(30)).includes(`found ${'v1'.repeat(10)};`));
  assert.match(floorTry, /^try: install Node /);
});

test('noPlanDir is false for every switch that can name a plan directory, from the environment or the command line', async () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, '.git'));
  try {
    assert.equal(await within(d, [], {}, noPlanDir), true);
    for (const k of KEYS) assert.equal(await within(d, [], { [k]: '/somewhere' }, noPlanDir), false, k);
    assert.equal(await within(d, ['card', '--dir', 'x'], {}, noPlanDir), false);
    assert.equal(await within(d, ['card', '--dir=x'], {}, noPlanDir), false);
    assert.equal(await within(d, ['card', '--directory'], {}, noPlanDir), true);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('noPlanDir looks in the repository root: .plangraph or .plangraphrc there means a plan, from any subdirectory', async () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, '.git')); fs.mkdirSync(path.join(d, 'a/b'), { recursive: true });
  try {
    assert.equal(await within(path.join(d, 'a/b'), [], {}, noPlanDir), true);
    fs.mkdirSync(path.join(d, '.plangraph'));
    assert.equal(await within(path.join(d, 'a/b'), [], {}, noPlanDir), false);
    fs.rmSync(path.join(d, '.plangraph'), { recursive: true });
    fs.writeFileSync(path.join(d, '.plangraphrc'), '{}');
    assert.equal(await within(d, [], {}, noPlanDir), false);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('noPlanDir with no repository above the working directory uses the working directory itself', async () => {
  // the file system root has no .git in any normal environment; the answer follows what is there, whichever way that is
  const expected = !fs.existsSync('/.git') ? !fs.existsSync('/.plangraph') && !fs.existsSync('/.plangraphrc') : null;
  if (expected === null) return;
  assert.equal(await within('/', [], {}, noPlanDir), expected);
});

test('noPlanDir errs towards false when the working directory cannot be read', async () => {
  const d = tmp();
  const real = process.cwd;
  try {
    assert.equal(await within(d, [], {}, async () => { process.cwd = () => { throw new Error('gone'); }; try { return await noPlanDir(); } finally { process.cwd = real; } }), false);
  } finally { process.cwd = real; fs.rmSync(d, { recursive: true, force: true }); }
});

test('hookOptedIn: card needs auto or on, hook-prompt needs on, other commands always run', () => {
  const card = ['node', 'entry', 'card', '--if-present'];
  assert.equal(hookOptedIn(card, {}), false);
  assert.equal(hookOptedIn(card, { CLAUDE_PLUGIN_OPTION_CARD: ' AUTO ' }), true);
  assert.equal(hookOptedIn(card, { PLANGRAPH_CARD: 'on' }), true);
  assert.equal(hookOptedIn(card, { PLANGRAPH_CARD: 'off', CLAUDE_PLUGIN_OPTION_CARD: '' }), false);
  assert.equal(hookOptedIn(['node', 'entry', 'card'], {}), true, 'card without --if-present is not a hook');
  assert.equal(hookOptedIn(['node', 'entry', 'hook-prompt'], {}), false);
  assert.equal(hookOptedIn(['node', 'entry', 'hook-prompt'], { PLANGRAPH_PROMPT_HOOK: 'auto' }), false);
  assert.equal(hookOptedIn(['node', 'entry', 'hook-prompt'], { CLAUDE_PLUGIN_OPTION_PROMPT_HOOK: 'On' }), true);
  assert.equal(hookOptedIn(['node', 'entry', 'hook-prompt'], { PLANGRAPH_PROMPT_HOOK: 'on' }), true);
  assert.equal(hookOptedIn(['node', 'entry', 'refresh', '--quiet'], {}), true);
});

test('newId prefixes by kind, is stable per seed, extends by two hex per taken id and gives up after the full hash', () => {
  const a = newId('requirement', 'seed-1');
  assert.match(a, /^R-[0-9a-f]{6}$/);
  assert.equal(newId('requirement', 'seed-1'), a);
  assert.match(newId('decision', 'seed-1'), /^D-[0-9a-f]{6}$/);
  assert.match(newId('team', 'seed-1'), /^TEAM-[0-9a-f]{6}$/);
  assert.match(newId('widget', 'seed-1'), /^W-[0-9a-f]{6}$/);
  const taken = new Set([a]);
  const b = newId('requirement', 'seed-1', (id) => taken.has(id));
  assert.match(b, /^R-[0-9a-f]{8}$/);
  assert.ok(b.startsWith(a));
  taken.add(b);
  assert.match(newId('requirement', 'seed-1', (id) => taken.has(id)), /^R-[0-9a-f]{10}$/);
  assert.throws(() => newId('requirement', 'seed-1', () => true), /no free id for this seed/);
  assert.throws(() => newId('Bad Kind', 'seed-1'), TypeError);
  assert.equal(assertKind('ok-1'), 'ok-1');
  assert.equal(idHash('x').length, 12);
  assert.equal(slug('A b/C'), 'a_b_c');
});
