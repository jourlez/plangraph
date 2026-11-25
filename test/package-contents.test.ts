// Tests for scripts/check-package.ts: what the release archive (git archive HEAD) must not hold and must hold.
// Covered: forbidden directories, sqlite and .env files, every required file reported when missing, the archive of HEAD.
// NOT covered: the tarball CI builds (release-dry-run runs the same script on it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REQUIRED, checkArchive } from '../scripts/check-package.ts';

const ROOT = path.join(import.meta.dirname, '..');

test('checkArchive flags .baseline, .superpowers, node_modules, sqlite files, .env files and coverage', () => {
  const bad = [
    '.baseline/a.json', 'x/.superpowers/plan.md', 'node_modules/knip/package.json', 'data/index.sqlite', 'data/index.sqlite3-wal', 'a.db',
    '.env', '.env.local', 'sub/.env.production', 'coverage/lcov.info', 'lib/coverage/x.txt',
  ];
  const r = checkArchive([...REQUIRED, ...bad, '.env.example', 'docs/superpowers/plan.md', 'src/coverage.ts', 'README.md']);
  assert.deepEqual(r.forbidden, bad);
  assert.deepEqual(r.missing, []);
});

test('checkArchive reports a missing plugin.json, bin/plangraph, src/entry.js, hooks/hooks.json, LICENSE or README.md', () => {
  assert.deepEqual([...REQUIRED].sort(), ['.claude-plugin/plugin.json', 'LICENSE', 'README.md', 'bin/plangraph', 'hooks/hooks.json', 'src/entry.js']);
  for (const f of REQUIRED) assert.deepEqual(checkArchive(REQUIRED.filter((x) => x !== f)).missing, [f]);
  assert.deepEqual(checkArchive(['./README.md', 'dir/']).missing.length, REQUIRED.length - 1, 'a leading ./ is ignored; a directory entry is not a file');
});

test('the current HEAD archive is clean (it may lack only required files that the working tree lacks too)', () => {
  const r = spawnSync(process.execPath, ['scripts/check-package.ts'], { cwd: ROOT, encoding: 'utf8' });
  const absent = REQUIRED.filter((f) => !fs.existsSync(path.join(ROOT, f)));
  assert.ok(!/forbidden in the archive/.test(r.stderr), r.stderr);
  assert.deepEqual([...r.stderr.matchAll(/missing from the archive: (.+)/g)].map((m) => m[1]), absent);
  assert.equal(r.status, absent.length ? 1 : 0);
});
