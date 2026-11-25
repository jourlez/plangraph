// A plangraph.sqlite that is not a regular file (a FIFO, a directory) is refused on open (DATA, `brain build` hint) before SQLite opens it:
// SQLite opens without O_NONBLOCK, so a FIFO with no writer used to block every index command forever and hang the SessionStart hook until
// its 10 s kill (the hook contract: nothing printed, exit 0, on any failure). openIndex lstats the path, refuses a non-file, then opens it
// O_RDONLY|O_NONBLOCK|O_NOFOLLOW, requires a regular file by fstat with the lstat's device and inode, closes it, and only then hands the path
// to SQLite (the residual race between that check and SQLite's own open is stated in docs/CONTRACT.md).
// Skips where mkfifo is unavailable (Windows).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { openIndex, INDEX_FILE } from '../src/db.ts';
import { BrainError } from '../src/errors.ts';

const BRAIN = path.join(import.meta.dirname, '../bin/brain');
const tmps: string[] = [];
after(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });
const HAVE_MKFIFO = process.platform !== 'win32' && spawnSync('mkfifo', ['--help'], { stdio: 'ignore' }).error === undefined;
const SKIP = HAVE_MKFIFO ? false : 'skipped: no mkfifo on this platform';
// a hard kill timer far above the bound: a regression fails the elapsed-time assertion instead of hanging the suite
const run = (cwd: string, args: string[]) => {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [BRAIN, ...args], { cwd, encoding: 'utf8', timeout: 8000, env: { ...process.env, CLAUDE_PLUGIN_DATA: path.join(cwd, '.data') } });
  return { ...r, ms: Date.now() - t0 };
};

function repo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-fifo-')); tmps.push(d);
  execFileSync('git', ['init', '-q'], { cwd: d });
  assert.equal(run(d, ['init']).status, 0);
  const b = path.join(d, '.plangraph');
  fs.writeFileSync(path.join(b, 'tickets.jsonl'), `${JSON.stringify({ key: 'T-1', summary: 'one', sp: 1, v2_owner: 'Ana', v2_sprint: 1 })}\n`);
  return { d, b, file: path.join(b, INDEX_FILE) };
}
const NOT_FILE = (e: unknown) => e instanceof BrainError && e.code === 'DATA' && e.message === 'the index is not a regular file' && e.hint === 'run `brain build` to rebuild it';

test('a FIFO at plangraph.sqlite: the hook (card --if-present --heal) is silent with exit 0 and the commands exit 2 (DATA), all in well under 5 s', { skip: SKIP }, () => {
  const { d, b, file } = repo();
  execFileSync('mkfifo', [file]);
  const hook = run(d, ['card', '--if-present', '--heal']);
  assert.ok(hook.ms < 5000, `the hook took ${hook.ms} ms (signal ${hook.signal})`);
  assert.deepEqual([hook.status, hook.stdout, hook.stderr], [0, '', '']);
  for (const args of [['ticket', 'T-1'], ['card'], ['whatif', 'T-1', '--sprint', '2', '--write', '--apply-plan']]) {
    const r = run(d, args);
    assert.ok(r.ms < 5000, `${args.join(' ')} took ${r.ms} ms (signal ${r.signal})`);
    assert.deepEqual([r.status, r.stdout, r.stderr], [2, '', 'error: the index is not a regular file\ntry: brain build\n'], args.join(' '));
  }
  assert.throws(() => openIndex(file, { dir: b }), NOT_FILE);
  assert.throws(() => openIndex(file, { readOnly: false }), NOT_FILE);
  // `brain build` replaces the FIFO with a real index (rename replaces the name, it never opens the FIFO)
  const bl = run(d, ['build']); assert.equal(bl.status, 0, bl.stderr); assert.ok(bl.ms < 5000);
  assert.equal(run(d, ['ticket', 'T-1']).status, 0);
});

test('a directory at plangraph.sqlite is refused the same way (DATA, not a regular file)', () => {
  const { b, file } = repo();
  fs.mkdirSync(file);
  assert.throws(() => openIndex(file, { dir: b }), NOT_FILE);
});

test('a FIFO sidecar beside the index is refused without opening it (sidecar refusal), quickly', { skip: SKIP }, () => {
  const { d, file } = repo();
  assert.equal(run(d, ['build']).status, 0);
  execFileSync('mkfifo', [`${file}-journal`]);
  const r = run(d, ['ticket', 'T-1']);
  assert.ok(r.ms < 5000, `${r.ms} ms`);
  assert.deepEqual([r.status, r.stderr], [2, `error: the index has a SQLite journal file beside it (${INDEX_FILE}-journal); it is never replayed\ntry: brain build\n`]);
  const hook = run(d, ['card', '--if-present', '--heal']);
  assert.deepEqual([hook.status, hook.stdout, hook.stderr], [0, '', '']);
});
