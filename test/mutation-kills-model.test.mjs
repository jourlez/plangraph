// Behavior tests for lib/model.mjs (loadModel's config.json reader) written to kill mutants that survived scripts/mutate-all.mjs: each
// refusal has its own code and message (symlink, over 64 KiB, not a regular file, invalid JSON), a BOM is accepted, and file-system
// errors other than a missing file propagate with their own code instead of being read as an empty config.
// NOT covered: buildModel (test/forecast.test.mjs, test/verify.test.mjs and others build models); running as root (EACCES is skipped).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadModel } from '../lib/model.mjs';

const root0 = typeof process.getuid === 'function' && process.getuid() === 0, posix = process.platform !== 'win32';
/** @type {string[]} */ const made = [];
after(() => { for (const d of made) { try { fs.chmodSync(path.join(d, 'config.json'), 0o600); } catch { /* absent */ } fs.rmSync(d, { recursive: true, force: true }); } });
const dir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'model-k-')); made.push(d); return d; };
/** @param {() => unknown} fn @param {string} code @param {string} [message] */
const fails = (fn, code, message) => assert.throws(fn, (/** @type {any} */ e) => e.code === code && (message === undefined || e.message === message), `${code} ${message ?? ''}`);

test('config.json: symlink, over 64 KiB, a directory and invalid JSON each have their own code and message', { skip: !posix }, () => {
  const a = dir(); fs.writeFileSync(path.join(a, 'real.json'), '{}'); fs.symlinkSync(path.join(a, 'real.json'), path.join(a, 'config.json'));
  fails(() => loadModel(a), 'SYMLINK', 'config.json: is a symlink');
  const b = dir(); fs.writeFileSync(path.join(b, 'config.json'), `{}${' '.repeat(64 * 1024 - 1)}`);
  fails(() => loadModel(b), 'TOO_LARGE', `config.json: too large (over ${64 * 1024} bytes)`);
  fs.writeFileSync(path.join(b, 'config.json'), `{"caps":{"default":7}}${' '.repeat(64 * 1024 - 22)}`);
  assert.equal(loadModel(b).config.caps.default, 7, 'exactly 64 KiB is accepted');
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
  const parent = dir(), file = path.join(parent, 'not-a-dir'); fs.writeFileSync(file, 'x');
  fails(() => loadModel(file), 'ENOTDIR');
  if (root0) return;
  const a = dir(); fs.writeFileSync(path.join(a, 'config.json'), '{}'); fs.chmodSync(path.join(a, 'config.json'), 0o000);
  fails(() => loadModel(a), 'EACCES');
});
