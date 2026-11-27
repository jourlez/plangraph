// The pre-commit hook runs the related tests. In a git worktree git exports GIT_DIR to hooks, and a test that runs `git init` in a temp directory
// would then re-initialize the real repository (found when a worktree commit set core.bare=true on the main checkout). The hook must scrub them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('the pre-commit test step unsets the git environment variables before running tests', () => {
  const y = fs.readFileSync(path.join(import.meta.dirname, '..', 'lefthook.yml'), 'utf8');
  const run = /^\s+run: (node scripts\/related-tests\.ts.*)$/m.exec(y)?.[1] ?? '';
  assert.ok(run, 'the related-tests command is found');
  for (const v of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR']) assert.match(run, new RegExp(`-u ${v}\\b`), `${v} is unset`);
  assert.match(run, /xargs node --test$/);
});
