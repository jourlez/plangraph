// Tests for scripts/baseline.ts, the differential baseline harness: two captures of the same tree compare equal, the normalizer maps
// only what the migration may change, and the matrix cannot miss a command that `brain explain` lists.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { MATRIX, PROBES, bench, captureAll, compareDirs, normalizeOutput, runMcpSession, runMergeDriver } from '../scripts/baseline.ts';
import { fixture, made, tmp } from './helpers/cli-fixture.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const dir = () => tmp();

test('captures twice and compares equal', { timeout: 600000 }, async () => {
  const a = dir(), b = dir();
  const one = await captureAll({ root: ROOT, outDir: a });
  const two = await captureAll({ root: ROOT, outDir: b });
  assert.ok(one.count >= 200, `count ${one.count}`);
  assert.equal(one.count, two.count);
  assert.deepEqual(compareDirs(a, b).differing, []);
});

// The temp directory differs by platform (/tmp on Linux, /var/folders/../T on macOS), so the same assertions run under each: the host's
// own os.tmpdir() and a mocked Linux-style /tmp. Whatever the platform, a temp path loses its temp prefix and the per-run directory name.
for (const [label, tmpdir] of [['host temp directory', null], ['Linux-style /tmp', '/tmp']] as const) {
  test(`normalizeOutput maps .mjs, .ts and .js to .EXT (${label})`, (t) => {
    if (tmpdir) t.mock.method(os, 'tmpdir', () => tmpdir);
    assert.equal(normalizeOutput('src/cli.ts lib/a.ts x.js'), 'src/cli.EXT lib/a.EXT x.EXT');
    assert.equal(normalizeOutput('a.json and b.jsx stay'), 'a.json and b.jsx stay');
    assert.equal(normalizeOutput(`at ${ROOT}/src/cli.mjs:3`), 'at <ROOT>/src/cli.EXT:3');
    assert.equal(normalizeOutput('/tmp/abc123/x.mjs'), '<ROOT>/x.EXT');
    assert.equal(normalizeOutput('/private/var/folders/ab/cdef/T/clik-X1/.brain'), '<ROOT>/.brain');
    assert.equal(normalizeOutput(`${os.tmpdir()}/abc123/x.mjs`), '<ROOT>/x.EXT');
    assert.equal(normalizeOutput(`${fs.realpathSync(os.tmpdir())}/abc123/x.mjs`), '<ROOT>/x.EXT');
    assert.equal(normalizeOutput(`cwd ${os.tmpdir()}`), 'cwd <ROOT>');
  });
}

test('compareDirs lists the id of a changed file', () => {
  const a = dir(), b = dir();
  for (const d of [a, b]) { fs.writeFileSync(path.join(d, 'one.json'), '{"x":1}\n'); fs.writeFileSync(path.join(d, 'two.json'), '{"y":"a.mjs"}\n'); }
  fs.writeFileSync(path.join(b, 'two.json'), '{"y":"a.ts"}\n'); // only the extension changed: equal
  assert.deepEqual(compareDirs(a, b), { same: 2, differing: [] });
  fs.writeFileSync(path.join(b, 'one.json'), '{"x":2}\n');
  fs.writeFileSync(path.join(b, 'three.json'), '{}\n');
  assert.deepEqual(compareDirs(a, b), { same: 1, differing: ['one', 'three'] });
});

test('the matrix covers every command that brain explain lists', () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-baseline-data-')); // private data dir: the compile cache never goes to the real HOME
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin/brain'), 'explain', '--json'], { encoding: 'utf8', cwd: os.tmpdir(), env: { ...process.env, CLAUDE_PLUGIN_DATA: data } });
  fs.rmSync(data, { recursive: true, force: true });
  const names = JSON.parse(r.stdout).data.commands.map((c: { name: string }) => c.name);
  assert.ok(names.length >= 30);
  for (const n of names) {
    const mine = MATRIX.filter((e) => e.args[0] === n);
    assert.ok(mine.some((e) => e.id === `cli.plan.${n}.plain`), `no plain entry for ${n}`);
    assert.ok(mine.some((e) => e.args.includes('-v')), `no -v entry for ${n}`);
    assert.ok(mine.some((e) => e.args.includes('--json')), `no --json entry for ${n}`);
    assert.ok(mine.some((e) => e.args.includes('--no-such-flag')), `no error entry for ${n}`);
  }
  assert.equal(new Set(MATRIX.map((e) => e.id)).size, MATRIX.length);
  assert.ok(PROBES.length >= 8);
});

test('the MCP session returns an initialize result and a non-empty tools list', async () => {
  const d = await fixture();
  made.push(d);
  const msgs = runMcpSession(d).map((l) => JSON.parse(l));
  assert.equal(msgs.find((m) => m.id === 1).result.serverInfo.name.length > 0, true);
  assert.ok(msgs.find((m) => m.id === 2).result.tools.length > 0);
  const call = msgs.find((m) => m.id === 3);
  assert.ok(call.result && !call.error);
  assert.notEqual(call.result.isError, true);
});

test('the merge driver result is stable across two runs', () => {
  for (const variant of (['clean', 'conflict'] as const)) {
    const a = runMergeDriver(dir(), variant), b = runMergeDriver(dir(), variant);
    assert.deepEqual(a, b);
    assert.equal(a.code, variant === 'clean' ? 0 : 1);
  }
});

test('compare refuses an empty directory, a missing one and a different number of entries', () => {
  const a = dir(), b = dir(), empty = dir();
  fs.writeFileSync(path.join(a, 'x.json'), '{}\n'); fs.writeFileSync(path.join(b, 'x.json'), '{}\n');
  assert.throws(() => compareDirs(a, empty), /no captured files/);
  assert.throws(() => compareDirs(empty, empty), /no captured files/);
  assert.throws(() => compareDirs(a, path.join(a, 'nope')), /not a directory/);
  fs.writeFileSync(path.join(b, 'y.json'), '{}\n');
  assert.deepEqual(compareDirs(a, b), { same: 1, differing: ['y'] });
  const cli = (...args: string[]) => spawnSync(process.execPath, [path.join(ROOT, 'scripts/baseline.ts'), 'compare', ...args], { encoding: 'utf8' });
  const e = cli('--a', a, '--b', empty); assert.equal(e.status, 2); assert.match(e.stderr, /no captured files/); assert.doesNotMatch(e.stderr, /at .*\.mjs:\d+/);
  const m = cli('--a', a, '--b', path.join(a, 'nope')); assert.equal(m.status, 2); assert.match(m.stderr, /not a directory/); assert.doesNotMatch(m.stderr, /ENOENT/);
  assert.equal(cli('--a', a, '--b', b).status, 1);
});

test('the credentials probe reaches the registry, 1Password and keychain branches', async () => {
  const p = PROBES.find((x) => x.id === 'jira-credentials');
  interface Seen { email?: string; source: string; __error?: unknown; code?: string }
  interface Obs { problems: unknown[]; hosts: string[]; calls: string[]; registryEnv: Seen; registryOp: Seen; registryKeychain: Seen; registryEnvMissing: Seen; [k: string]: unknown }
  const r = (await (p as { run: () => Promise<unknown> }).run()) as Obs; // the probe returns its observations as a plain object (see scripts/baseline.ts)
  assert.deepEqual(r.problems.length, 1);
  assert.deepEqual(r.hosts, ['one.example.invalid', 'three.example.invalid', 'two.example.invalid']);
  for (const k of ['registryEnv', 'registryOp', 'registryKeychain'] as const) { assert.ok(r[k].email && r[k].source, k); assert.ok(!r[k].__error, k); }
  assert.match(r.registryEnv.source, /^registry \S+:env$/);
  assert.match(r.registryOp.source, /^registry \S+:op$/);
  assert.match(r.registryKeychain.source, /^registry \S+:keychain$/);
  assert.equal(r.registryEnvMissing.code, 'no_credentials');
  assert.ok(r.calls.some((c: string) => c.startsWith('op read')) && r.calls.some((c: string) => c.startsWith('security')));
});

test('bench prints a positive number of milliseconds and runs N times', { timeout: 120000 }, async () => {
  const cwds: string[] = [];
  const r = await bench({ runs: 3, runOnce: (cwd) => { cwds.push(cwd); return { code: 0 }; } });
  assert.equal(cwds.length, 4, 'one untimed warm-up run, then N timed runs');
  assert.equal(new Set(cwds).size, 1, 'every run uses the same fixture copy');
  assert.equal(r.samples.length, 3);
  assert.ok(r.samples.every((ms) => Number.isFinite(ms) && ms >= 0));
  await assert.rejects(bench({ runs: 0 }), /at least 1/);
  await assert.rejects(bench({ runs: 2, runOnce: () => ({ code: 3 }) }), /exited 3/);
  const cli = spawnSync(process.execPath, [path.join(ROOT, 'scripts/baseline.ts'), 'bench', '--runs', '2'], { encoding: 'utf8', timeout: 110000 });
  assert.equal(cli.status, 0, cli.stderr);
  const m = /^median_ms: (\d+\.\d)\nruns: 2\n$/.exec(cli.stdout);
  assert.ok(m, cli.stdout);
  assert.ok(Number(m[1]) > 0, `median ${m[1]} ms`);
  assert.equal(spawnSync(process.execPath, [path.join(ROOT, 'scripts/baseline.ts'), 'bench', '--runs', 'x'], { encoding: 'utf8' }).status, 2);
});
