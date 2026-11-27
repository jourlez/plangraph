// Final security review fixes (0.3.0): the user registry as a trust root (owner, mode, no symlink), the alias approval inside Claude Code and
// from /dev/tty, the private data directory re-check, hostile repository text never printed, and the launcher and solver hardening.
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { main } from '../src/cli.ts';
import { makeContext } from '../src/context.ts';
import { resolveTenant, loadRegistry, approveAlias } from '../src/jira-tenant.ts';
import { steerLine, claudeSnippet } from '../lib/steer.ts';
import type { Stdin } from '../src/context.ts';

const made: string[] = [];
const tmp = (p = 'sec2-'): string => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p))); made.push(d); return d; };
after(() => { for (const d of made) { try { fs.chmodSync(d, 0o700); } catch { /* gone */ } fs.rmSync(d, { recursive: true, force: true }); } });
const POSIX = process.platform !== 'win32' ? false : 'POSIX only';
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const CLOUD = 'work-cloud-0001';

function repo(): string {
  const d = tmp();
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: d, env: GIT_ENV }).status, 0);
  fs.mkdirSync(path.join(d, '.plangraph'));
  fs.writeFileSync(path.join(d, '.plangraph', 'config.json'), JSON.stringify({ jira: { tenant: 'work', jql: 'project = TST' } }));
  return d;
}
const keyOf = (root: string): string => crypto.createHash('sha256').update(fs.realpathSync(path.join(root, '.git'))).digest('hex');
const regText = (root: string): string => JSON.stringify({ aliases: { work: { cloud_id: CLOUD, jql: 'project = W', credentials: { email_env: 'A_MAIL', token_env: 'A_TOKEN' }, repos: [keyOf(root)] } } });
const envFor = (cfg: string, extra: Record<string, string> = {}): Record<string, string> => { const h = tmp(); return { PATH: process.env.PATH as string, HOME: h, CLAUDE_PLUGIN_DATA: path.join(h, 'data'), PLANGRAPH_CONFIG_DIR: cfg, ...extra }; };
const cfgWith = (root: string): { dir: string; file: string } => { const dir = tmp(); const file = path.join(dir, 'jira-sites.json'); fs.writeFileSync(file, regText(root)); return { dir, file }; };
const refused = (root: string, env: Record<string, string>): void => {
  const t = resolveTenant({ tenant: 'work' }, root, env);
  assert.equal(t.alias, null); assert.notEqual(t.tenant, CLOUD); assert.notEqual(t.jira.userTenant, true); assert.equal(t.pinned, false); assert.equal(t.entry, null); // scoped mode keeps allowGeneric for the (empty) committed tenant: what must go is the user tenant
};

test('I2: the registry is read when private (baseline), so the refusals below are the checks', { skip: POSIX }, () => {
  const root = repo(), c = cfgWith(root), env = envFor(c.dir);
  fs.chmodSync(c.dir, 0o700); fs.chmodSync(c.file, 0o600);
  const t = resolveTenant({ tenant: 'work' }, root, env);
  assert.deepEqual([t.alias, t.tenant, t.allowGeneric], ['work', CLOUD, true]);
});
test('I2: a registry file with a group or world write bit is refused', { skip: POSIX }, () => {
  for (const m of [0o666, 0o620]) {
    const root = repo(), c = cfgWith(root), env = envFor(c.dir); fs.chmodSync(c.file, m);
    refused(root, env);
    const reg = loadRegistry(env); assert.equal(reg.exists, true); assert.match(reg.problems.join(), /group or world writable/);
    assert.throws(() => approveAlias(env, 'work', 'ab'.repeat(32)), /refused: jira-sites\.json is not owned by you or is group or world writable/);
  }
});
test('I2: a registry in a group or world writable config directory is refused', { skip: POSIX }, () => {
  for (const m of [0o777, 0o770, 0o757]) {
    const root = repo(), c = cfgWith(root), env = envFor(c.dir); fs.chmodSync(c.dir, m);
    refused(root, env);
    assert.match(loadRegistry(env).problems.join(), /config directory is not owned by you or is group or world writable/);
    assert.throws(() => approveAlias(env, 'work', 'ab'.repeat(32)), /config directory/);
  }
});
test('I2: a symlinked registry is refused, and the message never carries its content', { skip: POSIX }, () => {
  const root = repo(), c = cfgWith(root), env = envFor(c.dir), real = path.join(tmp(), 'real.json');
  fs.renameSync(c.file, real); fs.symlinkSync(real, c.file);
  refused(root, env);
  const reg = loadRegistry(env); assert.deepEqual(reg.problems, ['jira-sites.json is not a regular file (a symlink is refused)']);
  assert.throws(() => approveAlias(env, 'work', 'ab'.repeat(32)), (e: Error) => /symlink/.test(e.message) && !e.message.includes(CLOUD));
});
test('I2: a registry swapped for a symlink after the directory check is refused (O_NOFOLLOW on the open)', { skip: POSIX }, () => {
  const root = repo(), c = cfgWith(root), env = envFor(c.dir), real = path.join(tmp(), 'real.json');
  fs.writeFileSync(real, regText(root));
  const orig = fs.statSync; // the directory check runs first: swap the file as it returns
  mock.method(fs, 'statSync', ((p: fs.PathLike, o?: object) => { const r = (orig as (...a: unknown[]) => unknown)(p, o); if (String(p) === c.dir && fs.existsSync(c.file) && !fs.lstatSync(c.file).isSymbolicLink()) { fs.rmSync(c.file); fs.symlinkSync(real, c.file); } return r; }) as typeof fs.statSync);
  try { refused(root, env); } finally { mock.restoreAll(); }
  assert.ok(fs.lstatSync(c.file).isSymbolicLink(), 'the swap happened');
});
test('I2: an absent registry is simply absent', () => {
  const env = envFor(path.join(tmp(), 'nope'));
  const r = loadRegistry(env); assert.deepEqual([r.exists, r.problems], [false, []]);
});

// ---- I1 ----
const run = async (argv: string[], cwd: string, env: Record<string, string>, stdin: Stdin) => {
  const out: string[] = [], err: string[] = [];
  const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l), raw: (t: string) => out.push(t) };
  const code = await main(argv, { io, env, cwd, makeContext: (o) => makeContext({ ...o, stdin }) });
  return { code, text: [...out, ...err].join('\n'), err: err.join('\n') };
};
test('I1: doctor --fix --alias refuses inside Claude Code and writes nothing', async () => {
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT']) {
    const root = repo(), c = cfgWith(root); fs.writeFileSync(c.file, JSON.stringify({ aliases: { work: { cloud_id: CLOUD, repos: [] } } }));
    const before = fs.readFileSync(c.file, 'utf8'); let reads = 0;
    const stdin: Stdin = { isTTY: true, read() { reads++; return CLOUD; }, readTty() { reads++; return CLOUD; } };
    const res = await run(['doctor', '--fix', '--alias', 'work'], root, envFor(c.dir, { [k]: '1' }), stdin);
    assert.equal(res.code, 2, res.text); assert.match(res.err, /approve it in your own terminal outside Claude Code/);
    assert.equal(reads, 0); assert.equal(fs.readFileSync(c.file, 'utf8'), before);
  }
});
test('I1: the typed host comes from readTty when the terminal offers it, never from read or readLine; a tty that cannot open refuses', async () => {
  const root = repo(), c = cfgWith(root); fs.writeFileSync(c.file, JSON.stringify({ aliases: { work: { cloud_id: CLOUD } } }));
  const env = envFor(c.dir); assert.equal((await run(['init'], root, env, { isTTY: false, read: () => '' })).code, 0);
  const bad: Stdin = { isTTY: true, read() { throw new Error('fd 0'); }, readLine() { throw new Error('fd 0'); }, readTty() { throw new Error('ENXIO'); } };
  const no = await run(['doctor', '--fix', '--alias', 'work'], root, env, bad);
  assert.equal(no.code, 2); assert.match(no.err, /could not open the terminal \(\/dev\/tty\)/);
  assert.deepEqual(JSON.parse(fs.readFileSync(c.file, 'utf8')).aliases.work.repos ?? [], []);
  const ok: Stdin = { isTTY: true, read() { throw new Error('fd 0'); }, readLine() { throw new Error('fd 0'); }, readTty: () => CLOUD };
  assert.equal((await run(['doctor', '--fix', '--alias', 'work'], root, env, ok)).code, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(c.file, 'utf8')).aliases.work.repos, [keyOf(root)]);
});
test('I1: the documentation states the limit and the deny rule', () => {
  const dir = path.resolve(import.meta.dirname, '..');
  for (const f of ['docs/JIRA.md', 'SECURITY.md']) {
    const t = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(t.includes('pty-capable agent'), f); assert.ok(t.includes('Bash(plangraph doctor --fix*)'), f);
  }
  const sec = fs.readFileSync(path.join(dir, 'SECURITY.md'), 'utf8');
  assert.match(sec, /Alias approval/); assert.match(sec, /keyed by the git common directory/); assert.match(sec, /D16/);
});

// ---- M4 ----
test('M4: the steer prints only a plain short plan directory name', () => {
  for (const d of ['a;b', 'a|b', 'a$b', 'a`b`', 'a b', 'x'.repeat(41)]) {
    assert.equal(steerLine(d), steerLine('.plangraph'), d); assert.deepEqual(claudeSnippet(d), claudeSnippet('.plangraph'), d);
  }
  assert.equal(steerLine('docs/plan-graph'), steerLine('.plangraph').replace('.plangraph/', 'docs/plan-graph/'));
});

// ---- M5 ----
test('M5: a relative interpreter path printed by uv --script is never executed', { skip: POSIX }, () => {
  const cwd = tmp(), bin = tmp(), mark = path.join(tmp(), 'ran');
  fs.writeFileSync(path.join(cwd, 'evil'), `#!/bin/sh\necho x > ${mark}\nexit 0\n`, { mode: 0o755 });
  const py = path.join(bin, 'fakepy'); fs.writeFileSync(py, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'uv'), ['#!/bin/sh', '[ "$1" = sync ] && exit 0', 'if [ "$1" = python ]; then case "$*" in *--script*) echo ./evil ;; *) echo ' + JSON.stringify(py) + ' ;; esac; exit 0; fi', 'exit 0', ''].join('\n'), { mode: 0o755 });
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: tmp(), CLAUDE_PLUGIN_DATA: tmp() };
  const r = spawnSync(path.resolve(import.meta.dirname, '../bin/plangraph-solve-run'), ['--in', 'x.json'], { cwd, env, encoding: 'utf8', timeout: 60000 });
  assert.ok(!fs.existsSync(mark), `./evil ran: ${r.stderr}`);
});

// ---- M6 ----
const SOLVE = path.resolve(import.meta.dirname, '../bin/plangraph-solve');
const HAVE_PY3 = spawnSync('python3', ['--version'], { stdio: 'ignore' }).status === 0 ? false : 'no python3';
const brainDir = (cwd: string): { status: number | null; out: string; err: string; ms: number } => {
  const t0 = Date.now();
  const body = `import importlib.machinery, importlib.util, sys
l = importlib.machinery.SourceFileLoader('s', sys.argv[1]); sp = importlib.util.spec_from_loader('s', l); m = importlib.util.module_from_spec(sp); l.exec_module(m)
try: print('OK', m.brain_dir())
except m.Fail as f: print('FAIL', f.msg)`;
  const r = spawnSync('python3', ['-I', '-c', body, SOLVE], { cwd, encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH as string } });
  return { status: r.status, out: r.stdout.trim(), err: r.stderr, ms: Date.now() - t0 };
};
const gitDir = (): string => { const d = tmp(); execFileSync('git', ['init', '-q'], { cwd: d, env: GIT_ENV }); return d; };
test('M6: .plangraphrc without a dir key falls back to .plangraph', { skip: HAVE_PY3 }, () => {
  const d = gitDir(); fs.writeFileSync(path.join(d, '.plangraphrc'), '{}');
  assert.equal(brainDir(d).out, `OK ${path.join(d, '.plangraph')}`);
  fs.writeFileSync(path.join(d, '.plangraphrc'), '{"dir":"plan"}'); assert.equal(brainDir(d).out, `OK ${path.join(d, 'plan')}`);
});
test('M6: a symlinked .plangraphrc is refused, a FIFO does not block, an oversized one is refused', { skip: HAVE_PY3 || POSIX }, () => {
  const d = gitDir(); const real = path.join(tmp(), 'rc'); fs.writeFileSync(real, '{"dir":"plan"}'); fs.symlinkSync(real, path.join(d, '.plangraphrc'));
  assert.match(brainDir(d).out, /^FAIL .*symlink/);
  fs.rmSync(path.join(d, '.plangraphrc'));
  const f = spawnSync('mkfifo', [path.join(d, '.plangraphrc')]); if (f.status === 0) { const r = brainDir(d); assert.ok(r.ms < 5000, `blocked ${r.ms} ms`); assert.match(r.out, /^FAIL .*not a regular file/); fs.rmSync(path.join(d, '.plangraphrc')); }
  fs.writeFileSync(path.join(d, '.plangraphrc'), ' '.repeat(70 * 1024)); assert.match(brainDir(d).out, /^FAIL .*too large/);
});
