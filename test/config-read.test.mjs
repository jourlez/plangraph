// config.json through ONE reader (lib/model.mjs readConfig): capped at 64 KiB, regular files only (a FIFO, a directory refused), a symlink
// refused, JSON object only. Every command that reads it refuses a bad one the same way: exit 2, `error: config.json: ...` naming the
// base file only (never a path or the content), never `internal error` (exit 5).
// A config swapped between the lstat and the open is refused too (readDataCapped: O_NOFOLLOW and the dev/ino check; forced with an injected
// fsImpl in test/toctou-race.test.mjs). Not covered: Windows (no FIFO).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { loadModel, readConfig, CONFIG_MAX } from '../lib/model.mjs';

const BRAIN = path.join(import.meta.dirname, '../bin/brain');
let BASE, HOME, DATA, REPO, OUTSIDE;
const GIT = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
const env = () => ({ PATH: process.env.PATH, HOME, CLAUDE_PLUGIN_DATA: DATA, LC_ALL: 'C', BRAIN_DIR: '', TMPDIR: BASE, BRAIN_STRICT_OUT: '1', ...GIT });
const run = (cwd, ...a) => spawnSync(process.execPath, [BRAIN, ...a], { cwd, env: env(), encoding: 'utf8', timeout: 60000 });
const jl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

before(() => {
  BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-cfg-')));
  HOME = path.join(BASE, 'home'); DATA = path.join(BASE, 'data'); OUTSIDE = path.join(BASE, 'outside');
  for (const d of [HOME, DATA, OUTSIDE]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(OUTSIDE, 'secret.json'), '{"first_sprint": 1, "SECRET": "s3cr3t"}');
  REPO = path.join(BASE, 'repo'); fs.mkdirSync(REPO);
  execFileSync('git', ['init', '-q'], { cwd: REPO, env: env() });
  assert.equal(run(REPO, 'init').status, 0);
  const B = path.join(REPO, '.brain');
  fs.writeFileSync(path.join(B, 'tickets.jsonl'), jl([{ key: 'T-1', sp: 3, verdict: 'READY' }, { key: 'T-2', sp: 2, verdict: 'READY' }]));
  fs.writeFileSync(path.join(B, 'edges.jsonl'), jl([{ consumer: 'T-2', producer: 'T-1', kind: 'code' }]));
  fs.writeFileSync(path.join(B, 'schedule.jsonl'), jl([{ key: 'T-1', owner: 'Ana', sprint: 1 }, { key: 'T-2', owner: 'Ana', sprint: 1 }]));
  execFileSync('git', ['add', '-A'], { cwd: REPO, env: env() }); execFileSync('git', ['commit', '-qm', 'base'], { cwd: REPO, env: env() });
  const b = run(REPO, 'build'); assert.equal(b.status, 0, b.stderr);
});
after(() => { fs.rmSync(BASE, { recursive: true, force: true }); });

const CFG = () => path.join(REPO, '.brain', 'config.json');
let saved;
/** Replace config.json by a bad one for the duration of fn, then restore the original bytes. */
function withBad(kind, fn) {
  saved ??= fs.readFileSync(CFG());
  fs.rmSync(CFG(), { recursive: true, force: true });
  if (kind === 'symlink') fs.symlinkSync(path.join(OUTSIDE, 'secret.json'), CFG());
  else if (kind === 'large') fs.writeFileSync(CFG(), JSON.stringify({ pad: 'x'.repeat(70 * 1024) }));
  else if (kind === 'json') fs.writeFileSync(CFG(), '{"SECRET": "s3cr3t", bad');
  else if (kind === 'array') fs.writeFileSync(CFG(), '[1, 2]');
  else if (kind === 'fifo') execFileSync('mkfifo', [CFG()]);
  else if (kind === 'dir') fs.mkdirSync(CFG());
  try { fn(); } finally { fs.rmSync(CFG(), { recursive: true, force: true }); fs.writeFileSync(CFG(), saved); }
}
const MESSAGE = { symlink: 'config.json: is a symlink', large: `config.json: file too large (limit ${64 * 1024} bytes)`, json: 'config.json: not valid JSON', array: 'config.json: must be a JSON object', fifo: 'config.json: not a regular file', dir: 'config.json: not a regular file' };

test('readConfig: one capped reader, base-name messages, a typed code; missing file is {}', () => {
  assert.equal(CONFIG_MAX, 64 * 1024);
  for (const kind of Object.keys(MESSAGE)) withBad(kind, () => {
    assert.throws(() => readConfig(CFG()), (/** @type {any} */ e) => e.name === 'IngestError' && e.message === MESSAGE[kind] && typeof e.code === 'string', kind);
    assert.throws(() => loadModel(path.join(REPO, '.brain')), (/** @type {any} */ e) => e.name === 'IngestError' && e.message === MESSAGE[kind], kind);
  });
  assert.deepEqual(readConfig(path.join(BASE, 'nope', 'config.json')), {});
  // exactly at the cap is read; one byte over is refused
  withBad('json', () => {
    const body = (n) => { const head = '{"p":"', tail = '"}'; return head + 'x'.repeat(n - head.length - tail.length) + tail; };
    fs.writeFileSync(CFG(), body(CONFIG_MAX)); assert.equal(readConfig(CFG()).p.length, CONFIG_MAX - 8);
    fs.writeFileSync(CFG(), body(CONFIG_MAX + 1)); assert.throws(() => readConfig(CFG()), /too large/);
  });
});

// Every command that reads config.json, with the arguments it needs. card --line reads it through loadModel, card through the index model.
const COMMANDS = [['stale'], ['card'], ['card', '--line'], ['units', '--stale', '--out', 'u'], ['verify'], ['build'], ['doctor'], ['check'], ['ready', 'T-2']];
for (const kind of Object.keys(MESSAGE)) {
  test(`a ${kind} config.json: every reader exits 2 with the fixed base-name message (never internal error)`, () => {
    withBad(kind, () => {
      for (const args of COMMANDS) {
        const r = run(REPO, ...args), what = `${kind}: brain ${args.join(' ')}`;
        assert.equal(r.status, 2, `${what}\n${r.stdout}\n${r.stderr}`);
        const err = r.stderr.split('\n');
        assert.ok(err.includes(`error: ${MESSAGE[kind]}`), `${what}\n${r.stderr}`);
        assert.doesNotMatch(r.stderr, /internal error|s3cr3t|SECRET|outside/, what);
        assert.ok(!r.stderr.includes(BASE), what);
        assert.equal(err.at(-2), `try: brain explain ${args[0]}`, what); // one mapping: a DATA error of the command, not a lib error
      }
      // the session hook stays silent whatever the config is
      const h = run(REPO, 'card', '--if-present');
      assert.deepEqual([h.status, h.stdout, h.stderr], [0, '', ''], kind);
    });
  });
}

test('a good config.json still reads (control): verify 0, build 0, doctor reads it', () => {
  assert.equal(run(REPO, 'verify').status, 0);
  assert.equal(run(REPO, 'build').status, 0);
  assert.notEqual(run(REPO, 'doctor').status, 2);
});
