// Behavior tests for lib/model.ts (loadModel's config.json reader) written to kill mutants that survived scripts/mutate-all.ts: each
// refusal has its own code and message (symlink, over 64 KiB, not a regular file, invalid JSON), a BOM is accepted, and file-system
// errors other than a missing file propagate with their own code instead of being read as an empty config.
// NOT covered: buildModel (test/forecast.test.ts, test/verify.test.ts and others build models); running as root (EACCES is skipped).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadModel } from '../lib/model.ts';

const root0 = typeof process.getuid === 'function' && process.getuid() === 0, posix = process.platform !== 'win32';
const made: string[] = [];
after(() => { for (const d of made) { try { fs.chmodSync(path.join(d, 'config.json'), 0o600); } catch { /* absent */ } fs.rmSync(d, { recursive: true, force: true }); } });
const dir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'model-k-')); made.push(d); return d; };
const fails = (fn: () => unknown, code: string, message?: string) => assert.throws(fn, (e: { code: unknown; message: string }) => e.code === code && (message === undefined || e.message === message), `${code} ${message ?? ''}`);

test('config.json: symlink, over 64 KiB, a directory and invalid JSON each have their own code and message', { skip: !posix }, () => {
  const a = dir(); fs.writeFileSync(path.join(a, 'real.json'), '{}'); fs.symlinkSync(path.join(a, 'real.json'), path.join(a, 'config.json'));
  fails(() => loadModel(a), 'SYMLINK', 'config.json: is a symlink');
  const b = dir(); fs.writeFileSync(path.join(b, 'config.json'), `{}${' '.repeat(64 * 1024 - 1)}`);
  fails(() => loadModel(b), 'TOO_LARGE', `config.json: file too large (limit ${64 * 1024} bytes)`);
  fs.writeFileSync(path.join(b, 'config.json'), `{"caps":{"default":7}}${' '.repeat(64 * 1024 - 22)}`);
  assert.equal((loadModel(b).config.caps as Record<string, unknown>).default, 7, 'exactly 64 KiB is accepted'); // the file above sets caps
  const c = dir(); fs.mkdirSync(path.join(c, 'config.json'));
  fails(() => loadModel(c), 'NOT_A_FILE', 'config.json: not a regular file');
  const d = dir(); fs.writeFileSync(path.join(d, 'config.json'), '{nope');
  fails(() => loadModel(d), 'BAD_JSON', 'config.json: not valid JSON');
});

test('config.json: a BOM is accepted; a missing config is empty', () => {
  const a = dir(); fs.writeFileSync(path.join(a, 'config.json'), '﻿{"first_sprint":3}');
  assert.deepEqual(loadModel(a).config, { first_sprint: 3 });
  assert.deepEqual(loadModel(dir()).config, {});
});

test('config.json: errors other than a missing file propagate unchanged', { skip: !posix }, () => {
  const parent = dir(), loop = path.join(parent, 'loop'); fs.symlinkSync(loop, loop);
  fails(() => loadModel(loop), 'ELOOP');
  const file = path.join(parent, 'not-a-dir'); fs.writeFileSync(file, 'x');
  assert.deepEqual(loadModel(file).config, {}, 'a path under a file is a missing config (ENOTDIR counts as missing), not an error');
  if (root0) return;
  const a = dir(); fs.writeFileSync(path.join(a, 'config.json'), '{}'); fs.chmodSync(path.join(a, 'config.json'), 0o000);
  fails(() => loadModel(a), 'EACCES');
});
