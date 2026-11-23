// The type-check wrapper (scripts/typecheck.ts): parsing tsc output, and exit 2 when tsc cannot run. tsc itself is not run
// here (it is slow and a devDependency); `npm run typecheck` runs it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { classifySpawn, parseTsc } from '../scripts/typecheck.ts';

const ROOT = path.resolve(import.meta.dirname, '..');

const OUT = [
  "src/a.mjs(3,5): error TS7006: Parameter 'x' implicitly has an 'any' type.",
  "src/a.mjs(9,1): error TS2339: Property 'y' does not exist on type '{}'.",
  '  Type number is not assignable to type string.', // continuation line: not an error of its own
  "lib/b c.mjs(1,1): error TS2322: Type 'x' is not assignable.", // a space in the path is kept
  'src/commands/q.mjs(10,2): error TS18046: e is of type unknown.',
  "error TS5023: Unknown compiler option 'zzz'.",
  'src/a.mjs(4,4): warning: not an error line',
  '',
].join('\n');

test('parseTsc counts error lines per file; continuation lines and non-errors are ignored; a positionless error counts as (tsc)', () => {
  assert.deepEqual([...parseTsc(OUT)], [['src/a.mjs', 2], ['lib/b c.mjs', 1], ['src/commands/q.mjs', 1], ['(tsc)', 1]]);
  assert.deepEqual([...parseTsc('')], []);
  assert.deepEqual([...parseTsc('src/a.mjs(1,1): error TS1: x\r\nsrc/a.mjs(2,1): error TS1: y\r\n')], [['src/a.mjs', 2]]);
});

test('the wrapper exits 2 with a hint when tsc is not installed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'typecheck-'));
  try {
    fs.mkdirSync(path.join(dir, 'scripts'));
    fs.copyFileSync(path.join(ROOT, 'scripts/typecheck.ts'), path.join(dir, 'scripts/typecheck.ts'));
    const r = spawnSync(process.execPath, ['--no-warnings', 'scripts/typecheck.ts'], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /tsc did not run/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('classifySpawn: a signal or the timeout is "killed" (rerun), a start failure is "missing", tsc exit 0-2 is a run', () => {
  const base = { status: 0, signal: null, stdout: 'o', stderr: 'e' };
  assert.deepEqual(classifySpawn({ ...base, status: 1 }), { kind: 'ran', status: 1, out: 'o\ne' });
  assert.deepEqual(classifySpawn({ ...base, status: null, signal: 'SIGKILL' }), { kind: 'killed', why: 'signal SIGKILL' });
  assert.deepEqual(classifySpawn({ ...base, status: null, signal: 'SIGTERM', error: Object.assign(new Error('x'), { code: 'ETIMEDOUT' }) }), { kind: 'killed', why: 'timeout' });
  assert.deepEqual(classifySpawn({ ...base, error: Object.assign(new Error('x'), { code: 'ENOENT' }) }), { kind: 'missing' });
  assert.deepEqual(classifySpawn({ ...base, status: null }), { kind: 'missing' });
  assert.deepEqual(classifySpawn({ ...base, status: 7 }), { kind: 'missing' });
});
