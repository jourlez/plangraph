// Tests for scripts/lint-sh.ts (`npm run lint:sh`): which files shellcheck reads, the accepted codes, and the skip-or-fail rule when shellcheck is absent.
// Covered: shebang detection, the tracked shell scripts, every excluded code carries a reason, a missing shellcheck skips (exit 0) or fails (exit 1) by PLANGRAPH_REQUIRE_TOOLS.
// NOT covered: shellcheck's own findings (CI runs the pinned 0.11.0 in the static job).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EXCLUDE, isShellShebang, shellFiles } from '../scripts/lint-sh.ts';

const ROOT = path.join(import.meta.dirname, '..');

test('isShellShebang accepts sh, bash and env forms and rejects node and python', () => {
  for (const l of ['#!/bin/sh', '#!/usr/bin/env bash', '#!/bin/bash -e', '#!/usr/bin/env -S bash -eu']) assert.equal(isShellShebang(l), true, l);
  for (const l of ['#!/usr/bin/env node', '#!/usr/bin/env python3', 'echo hi', '', '# sh']) assert.equal(isShellShebang(l), false, l);
});

test('shellFiles lists the launcher and the smoke test, and no node or python script', () => {
  const f = shellFiles(ROOT);
  assert.ok(f.includes('bin/plangraph-solve-run') && f.includes('test/smoke.sh'), f.join(','));
  assert.ok(!f.includes('bin/plangraph') && !f.includes('bin/plangraph-solve'));
});

test('every excluded shellcheck code has a reason and names an existing file', () => {
  for (const [file, e] of Object.entries(EXCLUDE)) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), file);
    assert.ok(e.why.length > 20 && e.codes.length > 0 && e.codes.every((c) => /^SC\d{4}$/.test(c)), file);
  }
});

test('without shellcheck on PATH: skips with a notice, and fails when PLANGRAPH_REQUIRE_TOOLS=1', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-nosc-'));
  try {
    const run = (extra: Record<string, string>) => spawnSync(process.execPath, [path.join(ROOT, 'scripts/lint-sh.ts')], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, PATH: empty, PLANGRAPH_REQUIRE_TOOLS: '', ...extra } });
    let r = run({});
    assert.equal(r.status, 0); assert.match(r.stdout, /shellcheck is not installed, skipped/);
    r = run({ PLANGRAPH_REQUIRE_TOOLS: '1' });
    assert.equal(r.status, 1); assert.match(r.stderr, /PLANGRAPH_REQUIRE_TOOLS=1/);
  } finally { fs.rmSync(empty, { recursive: true, force: true }); }
});

test('with shellcheck available the repository scripts pass', { skip: spawnSync('shellcheck', ['--version']).status === 0 ? false : 'shellcheck is not installed' }, () => {
  const r = spawnSync(process.execPath, ['scripts/lint-sh.ts'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
