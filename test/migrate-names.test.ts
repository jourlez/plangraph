// `brain migrate-names`: the one bridge from the pre-rename names (project-brain, .brainrc, .brain, brain-jsonl) to plangraph's. Real git,
// a scratch HOME and a scratch plugin data dir per test. The CLI itself never falls back to an old name: the Jira-binding test pins that
// an old folder is invisible until this command copies it. NOT covered: Windows (POSIX modes and the sh shim).
import baseTest, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import type { TestContext } from 'node:test';
import * as S from '../lib/store.ts';
import { loadRegistry } from '../src/jira-tenant.ts';
import { planMigration, report, rewriteLine, oldConfigDir } from '../lib/migrate-names.ts';
import type { Entry, MigrateInput } from '../lib/migrate-names.ts';

const test = (name: string, fn: (t: TestContext) => void | Promise<void>) => baseTest(name, { skip: process.platform === 'win32' }, fn);
const PLUGIN = path.resolve(import.meta.dirname, '..');
const made: string[] = [];
const tmp = (p = 'mn-') => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p))); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const BASE_ENV = { PATH: process.env.PATH ?? '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', TZ: 'UTC' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', env: BASE_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
const tryGit = (cwd: string, ...a: string[]) => spawnSync('git', a, { cwd, encoding: 'utf8', env: BASE_ENV });
const OLD_DIR = ['.', 'brain'].join(''), OLD_RC = `${OLD_DIR}rc`, OLD_DRIVER = ['brain', 'jsonl'].join('-'), OLD_FOLDER = ['project', 'brain'].join('-');
const SITES = `${JSON.stringify({ sites: { 'acme.example.invalid': { email_env: 'E_X', token_env: 'T_X' } } })}\n`;
const T = S.SCHEMAS['tickets.jsonl'], tk = (key: string, o: S.Rec = {}) => ({ key, summary: 's-' + key, epic: 'E', sp: 1, v2_owner: 'Ana', v2_sprint: 1, ...o });

/** A user and a repository as a 0.2.x install left them: old config folder, .brain, the old merge driver in .gitattributes and git config. */
function oldWorld({ rcDir }: { rcDir?: string } = {}) {
  const home = tmp('mn-home-'), data = tmp('mn-data-'), repo = tmp('mn-repo-');
  const od = path.join(home, '.config', OLD_FOLDER);
  fs.mkdirSync(od, { recursive: true }); fs.writeFileSync(path.join(od, 'jira-sites.json'), SITES); fs.writeFileSync(path.join(od, 'autopilot.json'), '{"write":false}\n');
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.name', 't'); git(repo, 'config', 'user.email', 't@example.invalid'); git(repo, 'config', 'commit.gpgsign', 'false');
  const dir = rcDir ?? OLD_DIR;
  if (rcDir) fs.writeFileSync(path.join(repo, OLD_RC), `${JSON.stringify({ dir: rcDir })}\n`);
  fs.mkdirSync(path.join(repo, dir), { recursive: true });
  fs.writeFileSync(path.join(repo, dir, 'tickets.jsonl'), S.canonFile([tk('T-1'), tk('T-2'), tk('T-3')], T));
  fs.writeFileSync(path.join(repo, '.gitattributes'), `${dir}/*.jsonl merge=${OLD_DRIVER}\n*.png binary\n`);
  fs.writeFileSync(path.join(repo, '.gitignore'), `node_modules/\n${dir}/*.sqlite\n${dir}/brain.sqlite-journal\n`);
  fs.writeFileSync(path.join(repo, 'CLAUDE.md'), `## Plan questions\nUse brain; do not read ${dir}/*.jsonl or the index.\n`);
  git(repo, 'config', `merge.${OLD_DRIVER}.name`, 'old'); git(repo, 'config', `merge.${OLD_DRIVER}.driver`, '/old/shim %O %A %B %P');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base');
  const env = { ...BASE_ENV, HOME: home, CLAUDE_PLUGIN_DATA: data, PLANGRAPH_DIR: '' };
  const run = (args: string[], cwd = repo) => spawnSync(process.execPath, [path.join(PLUGIN, 'bin/brain'), 'migrate-names', ...args], { cwd, env, encoding: 'utf8' });
  return { home, data, repo, od, nd: path.join(home, '.config', 'plangraph'), env, run, dir };
}
/** Every file under the given roots with its mode and bytes, plus the repository's git config: a dry run must leave all of it as it was.
 * The launcher's compile cache in the data dir is an optimization of bin/brain, not a write of the command, so it is left out. */
const snapshot = (...roots: string[]) => Object.fromEntries(roots.flatMap((r) => (fs.readdirSync(r, { recursive: true }) as string[]).filter((f) => (!f.startsWith('.git' + path.sep) || f === path.join('.git', 'config')) && !f.startsWith('compile-cache')).map((f) => path.join(r, f)).filter((p) => fs.lstatSync(p).isFile() || fs.lstatSync(p).isSymbolicLink()).map((p) => [p, `${fs.lstatSync(p).mode}:${fs.lstatSync(p).isSymbolicLink() ? fs.readlinkSync(p) : fs.readFileSync(p, 'latin1')}`])));
const mode = (p: string) => (fs.statSync(p).mode & 0o777).toString(8);

test('dry run (the default) lists every change and changes nothing, in HOME, the repository or its git config', () => {
  const w = oldWorld(), before = snapshot(w.home, w.repo, w.data);
  const r = w.run([]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(snapshot(w.home, w.repo, w.data), before);
  for (const want of ['would: copy ~/.config/' + OLD_FOLDER + '/jira-sites.json to ~/.config/plangraph/jira-sites.json (mode 0600)', 'would: copy ~/.config/' + OLD_FOLDER + '/autopilot.json', `would: git mv ${OLD_DIR} .plangraph`, `would: .gitattributes: ${OLD_DIR}/*.jsonl merge=${OLD_DRIVER} to .plangraph/*.jsonl merge=plangraph-jsonl`, `would: .gitignore: ${OLD_DIR}/*.sqlite to .plangraph/*.sqlite; ${OLD_DIR}/brain.sqlite-journal to .plangraph/plangraph.sqlite-journal`, `would: git config: set merge.plangraph-jsonl.name and .driver (the stable merge shim), remove merge.${OLD_DRIVER}`, 'keychain: never read or written here', 'dry run: nothing changed']) assert.ok(r.stdout.includes(want), `missing ${want}\n${r.stdout}`);
  assert.doesNotMatch(r.stdout, /the old index/, 'no old index in this repository, so no note about one');
  assert.match(r.stdout, /note: CLAUDE\.md names \.brain\/\*\.jsonl: change it to \.plangraph\/\*\.jsonl/);
  assert.ok(fs.existsSync(path.join(w.repo, OLD_DIR)) && !fs.existsSync(w.nd));
});

test('--apply copies user state 0600, renames the default directory, rewrites the attribute and ignore lines, rewires git; a real merge then uses plangraph-jsonl', () => {
  const w = oldWorld();
  fs.writeFileSync(path.join(w.repo, OLD_DIR, 'brain.sqlite'), 'old index'); // git-ignored, so the tree stays clean
  const r = w.run(['--apply']);
  assert.equal(r.status, 0, r.stderr);
  for (const f of ['jira-sites.json', 'autopilot.json']) { assert.equal(mode(path.join(w.nd, f)), '600', f); assert.equal(fs.readFileSync(path.join(w.nd, f), 'utf8'), fs.readFileSync(path.join(w.od, f), 'utf8')); }
  assert.equal(mode(w.nd), '700');
  assert.ok(fs.existsSync(path.join(w.od, 'jira-sites.json')), 'the old folder stays (copy, never move)');
  assert.ok(!fs.existsSync(path.join(w.repo, OLD_DIR)) && fs.existsSync(path.join(w.repo, '.plangraph/tickets.jsonl')));
  assert.equal(fs.readFileSync(path.join(w.repo, '.gitattributes'), 'utf8'), '.plangraph/*.jsonl merge=plangraph-jsonl\n*.png binary\n');
  assert.equal(fs.readFileSync(path.join(w.repo, '.gitignore'), 'utf8'), 'node_modules/\n.plangraph/*.sqlite\n.plangraph/plangraph.sqlite-journal\n');
  assert.equal(git(w.repo, 'config', '--get', 'merge.plangraph-jsonl.driver').trim(), `${path.join(w.data, 'bin', 'plangraph-merge')} %O %A %B %P`);
  assert.notEqual(tryGit(w.repo, 'config', '--get-regexp', `^merge\\.${OLD_DRIVER}\\.`).status, 0, 'the old driver section is removed');
  assert.match(fs.readFileSync(path.join(w.repo, 'CLAUDE.md'), 'utf8'), /\.brain\/\*\.jsonl/, 'CLAUDE.md is never edited');
  assert.match(r.stdout, /^applied 6 change\(s\)$/m);
  assert.match(r.stdout, /^note: the old index \.plangraph\/brain\.sqlite can be deleted: `brain build` writes \.plangraph\/plangraph\.sqlite$/m);
  assert.ok(r.stdout.includes(`the old folder ~/.config/${OLD_FOLDER} is left in place and is safe to delete`));
  // a real three-way merge through the new driver name: two branches edit different fields of T-1 and add a ticket each
  git(w.repo, 'add', '-A'); git(w.repo, 'commit', '-qm', 'migrate names'); git(w.repo, 'checkout', '-qb', 'feature');
  const put = (recs: readonly S.Rec[]) => fs.writeFileSync(path.join(w.repo, '.plangraph/tickets.jsonl'), S.canonFile(recs, T)), commit = (m: string) => { git(w.repo, 'add', '-A'); git(w.repo, 'commit', '-qm', m); };
  put([tk('T-1', { sp: 8 }), tk('T-2'), tk('T-3'), tk('T-31')]); commit('feature'); git(w.repo, 'checkout', '-q', 'main');
  put([tk('T-1', { summary: 'renamed' }), tk('T-2'), tk('T-3'), tk('T-32')]); commit('main');
  const m = spawnSync('git', ['merge', '--no-edit', 'feature'], { cwd: w.repo, encoding: 'utf8', env: BASE_ENV });
  assert.equal(m.status, 0, m.stdout + m.stderr);
  assert.equal(fs.readFileSync(path.join(w.repo, '.plangraph/tickets.jsonl'), 'utf8'), S.canonFile([tk('T-1', { sp: 8, summary: 'renamed' }), tk('T-2'), tk('T-3'), tk('T-31'), tk('T-32')], T));
});

test('a second run is a no-op that prints one line', () => {
  const w = oldWorld();
  assert.equal(w.run(['--apply']).status, 0);
  git(w.repo, 'add', '-A'); git(w.repo, 'commit', '-qm', 'migrate names');
  const before = snapshot(w.home, w.repo);
  for (const args of [[], ['--apply']]) {
    const r = w.run(args);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `migrate-names: already migrated, nothing to do (~/.config/${OLD_FOLDER} can be deleted once you no longer need it)\n`);
  }
  assert.deepEqual(snapshot(w.home, w.repo), before);
});

test('no old state at all: one line, nothing written, also outside a git repository', () => {
  const home = tmp('mn-home-'), cwd = tmp('mn-plain-');
  const r = spawnSync(process.execPath, [path.join(PLUGIN, 'bin/brain'), 'migrate-names', '--apply'], { cwd, env: { ...BASE_ENV, HOME: home, CLAUDE_PLUGIN_DATA: tmp('mn-data-') }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'migrate-names: no old names found, nothing to do\n');
  assert.deepEqual(fs.readdirSync(home), []);
});

test('a symlinked old file is refused (exit 4) and never copied; the other file still is', () => {
  const w = oldWorld(), elsewhere = path.join(tmp('mn-secret-'), 'sites.json');
  fs.writeFileSync(elsewhere, SITES); fs.rmSync(path.join(w.od, 'jira-sites.json')); fs.symlinkSync(elsewhere, path.join(w.od, 'jira-sites.json'));
  const r = w.run(['--apply']);
  assert.equal(r.status, 4, r.stdout + r.stderr);
  assert.ok(r.stdout.includes(`refused: ~/.config/${OLD_FOLDER}/jira-sites.json is a symlink: not copied`), r.stdout);
  assert.ok(!fs.existsSync(path.join(w.nd, 'jira-sites.json')));
  assert.equal(mode(path.join(w.nd, 'autopilot.json')), '600');
});

test('a symlinked old config folder is refused as a whole', () => {
  const w = oldWorld(), real = tmp('mn-real-');
  fs.cpSync(w.od, real, { recursive: true }); fs.rmSync(w.od, { recursive: true }); fs.symlinkSync(real, w.od);
  const r = w.run(['--apply']);
  assert.equal(r.status, 4);
  assert.ok(r.stdout.includes(`refused: ~/.config/${OLD_FOLDER} is not a directory (a symlink is refused): nothing copied`), r.stdout);
  assert.ok(!fs.existsSync(w.nd));
});

test('an existing new file is never overwritten', () => {
  const w = oldWorld();
  fs.mkdirSync(w.nd, { recursive: true }); fs.writeFileSync(path.join(w.nd, 'jira-sites.json'), '{"sites":{}}\n');
  const dry = w.run([]);
  assert.ok(dry.stdout.includes('note: keep ~/.config/plangraph/jira-sites.json: it exists and is never overwritten'), dry.stdout);
  assert.equal(w.run(['--apply']).status, 0);
  assert.equal(fs.readFileSync(path.join(w.nd, 'jira-sites.json'), 'utf8'), '{"sites":{}}\n');
  assert.equal(fs.readFileSync(path.join(w.nd, 'autopilot.json'), 'utf8'), '{"write":false}\n');
});

test('a working tree with uncommitted changes is refused for the repository part (exit 4); user state is still copied', () => {
  const w = oldWorld();
  fs.appendFileSync(path.join(w.repo, OLD_DIR, 'tickets.jsonl'), S.canonFile([tk('T-9')], T));
  const cfg = fs.readFileSync(path.join(w.repo, '.git/config'), 'utf8');
  const r = w.run(['--apply']);
  assert.equal(r.status, 4);
  assert.ok(r.stdout.includes('refused: the repository has uncommitted changes to tracked files'), r.stdout);
  assert.ok(fs.existsSync(path.join(w.repo, OLD_DIR)) && !fs.existsSync(path.join(w.repo, '.plangraph')));
  assert.match(fs.readFileSync(path.join(w.repo, '.gitattributes'), 'utf8'), new RegExp(`merge=${OLD_DRIVER}$`, 'm'));
  assert.equal(fs.readFileSync(path.join(w.repo, '.git/config'), 'utf8'), cfg);
  assert.ok(fs.existsSync(path.join(w.nd, 'jira-sites.json')));
});

test('a directory named by the rc file keeps its path; only the rc file, the driver lines and git config change', () => {
  const w = oldWorld({ rcDir: 'docs/plan-graph' }), rc = fs.readFileSync(path.join(w.repo, OLD_RC), 'utf8');
  const r = w.run(['--apply']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.includes(`done: git mv ${OLD_RC} .plangraphrc (content unchanged)`), r.stdout);
  assert.ok(r.stdout.includes('note: keep docs/plan-graph: the directory is named by the rc file'), r.stdout);
  assert.equal(fs.readFileSync(path.join(w.repo, '.plangraphrc'), 'utf8'), rc);
  assert.ok(!fs.existsSync(path.join(w.repo, OLD_RC)));
  assert.ok(fs.existsSync(path.join(w.repo, 'docs/plan-graph/tickets.jsonl')) && !fs.existsSync(path.join(w.repo, '.plangraph')));
  assert.equal(fs.readFileSync(path.join(w.repo, '.gitattributes'), 'utf8'), 'docs/plan-graph/*.jsonl merge=plangraph-jsonl\n*.png binary\n');
  assert.equal(fs.readFileSync(path.join(w.repo, '.gitignore'), 'utf8'), 'node_modules/\ndocs/plan-graph/*.sqlite\ndocs/plan-graph/plangraph.sqlite-journal\n');
  // the CLI now finds the directory through .plangraphrc
  const t = spawnSync(process.execPath, [path.join(PLUGIN, 'bin/brain'), 'doctor'], { cwd: w.repo, env: w.env, encoding: 'utf8' });
  assert.match(t.stdout, /merge driver: ok|merge driver installed|data format/);
  assert.doesNotMatch(t.stdout + t.stderr, /lacks/);
});

test('an existing .plangraphrc or .plangraph is never overwritten', () => {
  const w = oldWorld({ rcDir: 'plan' });
  fs.writeFileSync(path.join(w.repo, '.plangraphrc'), '{"dir":"other"}\n'); git(w.repo, 'add', '-A'); git(w.repo, 'commit', '-qm', 'both');
  const r = w.run(['--apply']);
  assert.equal(r.status, 4);
  assert.ok(r.stdout.includes(`refused: .plangraphrc exists: ${OLD_RC} not renamed`), r.stdout);
  assert.equal(fs.readFileSync(path.join(w.repo, '.plangraphrc'), 'utf8'), '{"dir":"other"}\n');
  const v = oldWorld(); fs.mkdirSync(path.join(v.repo, '.plangraph')); fs.writeFileSync(path.join(v.repo, '.plangraph/x'), 'x'); git(v.repo, 'add', '-A'); git(v.repo, 'commit', '-qm', 'x');
  const s = v.run(['--apply']);
  assert.equal(s.status, 4); assert.ok(s.stdout.includes(`refused: .plangraph exists: ${OLD_DIR} not moved`), s.stdout);
  assert.ok(fs.existsSync(path.join(v.repo, OLD_DIR, 'tickets.jsonl')));
});

test('Jira binding: an old folder is invisible to the CLI (no fallback) until migrate-names --apply copies it', () => {
  const w = oldWorld();
  fs.mkdirSync(w.nd, { recursive: true }); // an empty new folder
  const env = { HOME: w.home };
  const before = loadRegistry(env);
  assert.equal(before.exists, false); assert.deepEqual(Object.keys(before.reg), []);
  assert.equal(w.run(['--apply']).status, 0);
  const now = loadRegistry(env);
  assert.equal(now.exists, true); assert.deepEqual(Object.keys(now.reg), ['acme.example.invalid']);
  assert.equal(now.file, path.join(w.nd, 'jira-sites.json'));
});

test('permission rules naming the old command are named, never edited', () => {
  const w = oldWorld(), f = path.join(w.repo, '.claude/settings.json');
  fs.mkdirSync(path.dirname(f)); fs.writeFileSync(f, '{"permissions":{"allow":["Bash(brain ticket:*)","Bash(brainstorm:*)","Bash(brain:*)"]}}\n'); git(w.repo, 'add', '-A'); git(w.repo, 'commit', '-qm', 's');
  const r = w.run(['--apply']);
  assert.ok(r.stdout.includes('note: .claude/settings.json: 2 permission rule(s) start with Bash(brain: change them to Bash(plangraph (printed only, not edited)'), r.stdout);
  assert.match(fs.readFileSync(f, 'utf8'), /Bash\(brain ticket/);
});

// ---- the pure planner, with an injected file system and git ----
function fakeInput(files: Record<string, Entry & { text?: string }>, gitOut: Record<string, { ok: boolean; out: string }> = {}): MigrateInput {
  const calls: string[] = [];
  return {
    home: '/h', oldConfigDir: '/h/.config/old', newConfigDir: '/h/.config/new', root: '/r',
    fs: { lstat: (p) => files[p] ?? null, read: (p) => files[p]?.text ?? '', copyPrivate: (a, b) => { calls.push(`copy ${a} ${b}`); }, mkdirPrivate: (d) => { calls.push(`mkdir ${d}`); }, rename: (a, b) => { calls.push(`rename ${a} ${b}`); }, write: (p) => { calls.push(`write ${p}`); } },
    git: (args) => gitOut[args.join(' ')] ?? (args[0] === 'rev-parse' || args[0] === 'status' ? { ok: true, out: '' } : { ok: false, out: '' }),
    driverCommand: () => 'shim %O %A %B %P',
  };
}
test('planner: an oversized or non-regular old file is refused; nothing is planned for it', () => {
  const p = planMigration(fakeInput({ '/h/.config/old': { kind: 'dir', size: 0 }, '/h/.config/old/jira-sites.json': { kind: 'file', size: 70000 }, '/h/.config/old/autopilot.json': { kind: 'other', size: 0 } }));
  assert.deepEqual(p.steps, []);
  assert.deepEqual(p.refused, ['~/.config/old/jira-sites.json is larger than 64 KiB: not copied', '~/.config/old/autopilot.json is not a regular file: not copied']);
});
test('planner: a symlinked .gitattributes is refused, never read', () => {
  const p = planMigration(fakeInput({ '/r/.gitattributes': { kind: 'symlink', size: 0, text: `.x/*.jsonl merge=${OLD_DRIVER}` } }));
  assert.deepEqual(p.refused, ['.gitattributes is not a regular file (a symlink is refused): not rewritten']);
  assert.deepEqual(p.steps, []);
});
test('planner: an untracked default directory is renamed without git; report lines say would/done', () => {
  const p = planMigration(fakeInput({ [`/r/${OLD_DIR}`]: { kind: 'dir', size: 0 } }));
  assert.deepEqual(p.steps.map((s) => s.text), [`rename ${OLD_DIR} .plangraph`]);
  assert.equal(report(p, { apply: false, home: '/h' })[0], `would: rename ${OLD_DIR} .plangraph`);
  assert.equal(report(p, { apply: true, home: '/h' })[0], `done: rename ${OLD_DIR} .plangraph`);
});
test('rewriteLine: driver and index names by whole token, the directory only when it moves, never inside brainstorm', () => {
  assert.equal(rewriteLine(`${OLD_DIR}/*.jsonl merge=${OLD_DRIVER}`, true), '.plangraph/*.jsonl merge=plangraph-jsonl');
  assert.equal(rewriteLine(`${OLD_DIR}/*.jsonl merge=${OLD_DRIVER}`, false), `${OLD_DIR}/*.jsonl merge=plangraph-jsonl`);
  assert.equal(rewriteLine(`/${OLD_DIR}/brain.sqlite`, true), '/.plangraph/plangraph.sqlite');
  assert.equal(rewriteLine(`${OLD_DIR}x/a merge=${OLD_DRIVER}x`, true), `${OLD_DIR}x/a merge=${OLD_DRIVER}x`);
  assert.equal(rewriteLine('docs/brainstorm.sqlite', true), 'docs/brainstorm.sqlite');
});
test('oldConfigDir: XDG_CONFIG_HOME, else ~/.config; the old variable is not read', () => {
  assert.equal(oldConfigDir({ XDG_CONFIG_HOME: '/x' }, '/h'), path.join('/x', OLD_FOLDER));
  assert.equal(oldConfigDir({ ['BRAIN_' + 'CONFIG_DIR']: '/y' }, '/h'), path.join('/h', '.config', OLD_FOLDER));
});
