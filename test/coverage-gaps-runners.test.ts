// defaultFetchDeps: the tenant is decided from the committed config without credentials; the runner is memoized and built only on request. Synthetic tenant, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultFetchDeps, ghRunner } from '../src/fetch-runners.ts';

test('github() gives a runner that refuses a request that is not a plain GET', async () => {
  const run = defaultFetchDeps({ config: () => ({}), root: '/', env: {} } as never).github();
  const r = await run(['api', '--method', 'POST', 'x']);
  assert.equal(r.code, 126);
  assert.match(r.err, /refused/);
  const ok = await ghRunner(async (file, args) => { assert.equal(file, 'gh'); assert.deepEqual(args.slice(0, 4), ['api', '--include', '--method', 'GET']); return { stdout: 'HTTP/2 200\n\n{}', stderr: '' }; })(['api', '--include', '--method', 'GET', 'user']);
  assert.equal(ok.code, 0);
});

test('tenant() and runner() read the committed config; runner() is memoized and refuses without credentials', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-gap-run-')));
  try {
    let reads = 0;
    const ctx = { config: () => { reads++; return { jira: { mode: 'scoped', cloud_id: 'cloud-1' } }; }, root: dir, env: { XDG_CONFIG_HOME: path.join(dir, 'cfg') }, now: () => new Date('2026-01-01T00:00:00Z'), exec: async () => ({ code: 1, stdout: '', stderr: '' }) };
    const deps = defaultFetchDeps(ctx as never);
    let tenant: string | undefined;
    try { tenant = deps.atlassian.tenant(); } catch (e) { assert.ok(e instanceof Error); }
    assert.ok(reads >= 1);
    if (tenant !== undefined) assert.equal(typeof tenant, 'string');
    const a = deps.atlassian.runner(), b = deps.atlassian.runner();
    assert.equal(a, b, 'the same promise');
    await assert.rejects(a);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
