// First-use nudge of the SessionStart hook (`card --if-present`): brain data with no index, or data in an older format than the tool's,
// prints ONE fixed line (no data from the files in it), exit 0, writes nothing, builds nothing. Every refusal of the hook (escaping or
// unsafe dir, symlink, FIFO, bad name, unreadable or huge file, newer format) stays silent with exit 0. No brain at all stays silent.
// A manual `brain card` keeps its error. Real runs of bin/brain in mkdtemp repos (removed in `after`).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const BRAIN = path.join(import.meta.dirname, '../bin/brain');
const tmps = [];
after(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });
const ENV = { ...process.env, BRAIN_DIR: '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const run = (cwd, args, env = {}) => spawnSync(process.execPath, [BRAIN, ...args], { cwd, encoding: 'utf8', env: { ...ENV, CLAUDE_PLUGIN_DATA: path.join(cwd, '.data'), ...env } });
/** A git repo with `brain init` run (data, no index). */
function repo() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-fu-'))); tmps.push(d);
  execFileSync('git', ['init', '-q'], { cwd: d });
  assert.equal(run(d, ['init']).status, 0);
  return d;
}
const HOOK = ['card', '--if-present'], HEAL = ['card', '--if-present', '--heal'];
const NO_INDEX = 'brain: plan data found in .brain but no index: run brain build\n';
const LEGACY = (v) => `brain: plan data found in .brain but no index: run brain migrate --write (format v${v}) then brain build\n`;
const silent = (r, why) => assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', ''], why);
const snapshot = (d) => { const o = {}; const walk = (p) => { for (const e of fs.readdirSync(p, { withFileTypes: true })) { const f = path.join(p, e.name); if (e.name === '.git') continue; if (e.isDirectory()) walk(f); else if (e.isFile()) o[path.relative(d, f)] = fs.readFileSync(f, 'utf8'); else o[path.relative(d, f)] = 'special'; } }; walk(d); return o; };

test('data in the current format and no index: one fixed line, exit 0, nothing written', () => {
  const d = repo(), before = snapshot(d);
  for (const args of [HOOK, HEAL]) {
    const r = run(d, args); assert.deepEqual([r.status, r.stdout, r.stderr], [0, NO_INDEX, ''], args.join(' '));
  }
  assert.ok(!fs.existsSync(path.join(d, '.brain', 'brain.sqlite')), 'no index was built');
  const after_ = snapshot(d); delete after_['.data']; assert.deepEqual(Object.keys(after_).sort(), Object.keys(before).sort()); // --heal may wire the driver: no brain file changes
  for (const k of Object.keys(before)) if (k.startsWith('.brain/')) assert.equal(after_[k], before[k], k);
});

test('legacy format v0 (no format.json) and no index: the migrate line, naming the format number', () => {
  const d = repo(); fs.rmSync(path.join(d, '.brain', 'format.json'));
  const r = run(d, HOOK); assert.deepEqual([r.status, r.stdout, r.stderr], [0, LEGACY(0), '']);
  assert.ok(!fs.existsSync(path.join(d, '.brain', 'format.json')), 'the hook never migrates');
});

test('no brain at all, or a brain dir with no data files: silent', () => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-fu-'))); tmps.push(d); execFileSync('git', ['init', '-q'], { cwd: d });
  silent(run(d, HOOK), 'no brain'); silent(run(d, HEAL), 'no brain heal');
  fs.mkdirSync(path.join(d, '.brain')); silent(run(d, HOOK), 'empty brain dir');
  fs.writeFileSync(path.join(d, '.brain', 'notes.txt'), 'x'); silent(run(d, HOOK), 'unrelated file only');
});

test('a stale index keeps today\'s behavior: the card with its last STALE line, no nudge', () => {
  const d = repo(); assert.equal(run(d, ['build']).status, 0);
  fs.appendFileSync(path.join(d, '.brain', 'tickets.jsonl'), JSON.stringify({ key: 'T-1', sp: 1 }) + '\n');
  const r = run(d, HOOK); assert.equal(r.status, 0); assert.equal(r.stderr, '');
  assert.match(r.stdout, /^brain \S+ \| /); assert.match(r.stdout, /STALE: index older than text, run `brain build`\n$/); assert.doesNotMatch(r.stdout, /plan data found/);
});

test('a manual `brain card` keeps the error (exit 2, no index)', () => {
  const d = repo(); const r = run(d, ['card']);
  assert.deepEqual([r.status, r.stdout], [2, '']); assert.match(r.stderr, /^error: no index: run `brain build`\ntry: brain build\n$/);
});

test('every unsafe or hostile shape stays silent with exit 0 (hook and hook --heal)', () => {
  const cases = {
    'tickets.jsonl is a symlink': (d, b) => { fs.rmSync(path.join(b, 'tickets.jsonl')); fs.symlinkSync('/etc/hosts', path.join(b, 'tickets.jsonl')); },
    'config.json is a symlink': (d, b) => { fs.rmSync(path.join(b, 'config.json')); fs.symlinkSync('/etc/hosts', path.join(b, 'config.json')); },
    'tickets.jsonl is a dangling symlink': (d, b) => { fs.rmSync(path.join(b, 'tickets.jsonl')); fs.symlinkSync(path.join(d, 'nope'), path.join(b, 'tickets.jsonl')); },
    'tickets.jsonl is a FIFO': (d, b) => { fs.rmSync(path.join(b, 'tickets.jsonl')); execFileSync('mkfifo', [path.join(b, 'tickets.jsonl')]); },
    'tickets.jsonl is a directory': (d, b) => { fs.rmSync(path.join(b, 'tickets.jsonl')); fs.mkdirSync(path.join(b, 'tickets.jsonl')); },
    'tickets.jsonl is huge': (d, b) => { fs.truncateSync(path.join(b, 'tickets.jsonl'), 64 * 1024 * 1024 + 1); },
    'config.json is huge': (d, b) => { fs.truncateSync(path.join(b, 'config.json'), 64 * 1024 + 1); },
    'edges.jsonl is a FIFO': (d, b) => { fs.rmSync(path.join(b, 'edges.jsonl')); execFileSync('mkfifo', [path.join(b, 'edges.jsonl')]); },
    'config.json is unreadable': (d, b) => { fs.chmodSync(path.join(b, 'config.json'), 0); },
    'format.json is a symlink': (d, b) => { fs.rmSync(path.join(b, 'format.json')); fs.symlinkSync('/etc/hosts', path.join(b, 'format.json')); },
    'format.json is not JSON': (d, b) => { fs.writeFileSync(path.join(b, 'format.json'), '{nope'); },
    'format.json is huge': (d, b) => { fs.truncateSync(path.join(b, 'format.json'), 64 * 1024 + 1); },
    'format is newer than the tool': (d, b) => { fs.writeFileSync(path.join(b, 'format.json'), '{"format_version":99,"min_reader":99}\n'); },
    'the index path is a dangling symlink': (d, b) => { fs.symlinkSync(path.join(d, 'nope'), path.join(b, 'brain.sqlite')); },
    'the index path is a FIFO': (d, b) => { execFileSync('mkfifo', [path.join(b, 'brain.sqlite')]); },
    'the brain dir is a symlink': (d, b) => { fs.renameSync(b, path.join(d, 'real')); fs.symlinkSync(path.join(d, 'real'), b); },
    '.brainrc is not JSON': (d) => { fs.writeFileSync(path.join(d, '.brainrc'), '{bad'); },
    '.brainrc dir escapes the repo': (d) => { fs.writeFileSync(path.join(d, '.brainrc'), '{"dir":"../x"}'); },
    '.brainrc dir has a bad name': (d) => { fs.writeFileSync(path.join(d, '.brainrc'), '{"dir":"a b"}'); },
  };
  for (const [what, setup] of Object.entries(cases)) {
    const d = repo(); const b = path.join(d, '.brain'); setup(d, b);
    try { for (const a of [HOOK, HEAL]) silent(run(d, a), `${what} ${a.join(' ')}`); } finally { try { fs.chmodSync(path.join(b, 'config.json'), 0o644); } catch { /* not there */ } }
  }
  const d = repo();
  for (const [what, env] of [['absolute BRAIN_DIR', { BRAIN_DIR: '/etc' }], ['escaping BRAIN_DIR', { BRAIN_DIR: '../x' }], ['BRAIN_DIR with a space', { BRAIN_DIR: 'a b' }]]) silent(run(d, HOOK, env), what);
  silent(run(d, [...HOOK, '--dir', '../x']), 'escaping --dir'); silent(run(d, [...HOOK, '--bogus']), 'unknown option');
});

test('card off silences the nudge too', () => {
  const d = repo(); silent(run(d, HOOK, { BRAIN_CARD: 'off' }), 'BRAIN_CARD=off'); silent(run(d, HOOK, { CLAUDE_PLUGIN_OPTION_CARD: 'off' }), 'option off');
});

test('the nudge shows a configured dir relative and sanitized', () => {
  const d = repo(); fs.renameSync(path.join(d, '.brain'), path.join(d, 'plan-data')); fs.writeFileSync(path.join(d, '.brainrc'), '{"dir":"plan-data"}');
  const r = run(d, HOOK); assert.deepEqual([r.status, r.stdout, r.stderr], [0, 'brain: plan data found in plan-data but no index: run brain build\n', '']);
});
