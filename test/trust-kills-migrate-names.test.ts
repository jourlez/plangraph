// Pure-planner tests for lib/migrate-names.ts, written to kill the mutants of the trust-root run: an in-memory file system and git double
// plant any state, so size limits (64 KiB for user files, 1 MiB for repository text) are tested at their exact edge, paths under HOME are
// shown with ~ only when they really are under it, every occurrence on a line is rewritten, and the printed lines are compared whole.
// The pre-rename names are built from pieces, as test/migrate-names.test.ts does. NOT covered: real files and git (test/migrate-names.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planMigration, report, rewriteLine, oldConfigDir, applyMigration } from '../lib/migrate-names.ts';
import type { Entry, MigrateInput } from '../lib/migrate-names.ts';

const OLD_DIR = ['.', 'brain'].join(''), OLD_RC = `${OLD_DIR}rc`, OLD_DRIVER = ['brain', 'jsonl'].join('-'), OLD_INDEX = ['brain', 'sqlite'].join('.');
const OLD_FOLDER = ['project', 'brain'].join('-'), OLD_KEYCHAIN = `${OLD_FOLDER}-jira`;

interface World { entries: Record<string, Entry>; texts: Record<string, string>; gitOut?: Record<string, { ok: boolean; out: string }> }
const mk = (w: World, over: Partial<MigrateInput> = {}) => {
  const log: string[] = [], reads: Array<[string, number]> = [];
  const fs: MigrateInput['fs'] = {
    lstat: (p) => w.entries[p] ?? null,
    read: (p, max) => { reads.push([p, max]); return w.texts[p] ?? ''; },
    copyPrivate: (a, b) => { log.push(`copy ${a} ${b}`); }, mkdirPrivate: (d) => { log.push(`mkdir ${d}`); }, rename: (a, b) => { log.push(`rename ${a} ${b}`); }, write: (p, t) => { log.push(`write ${p} ${JSON.stringify(t)}`); },
  };
  const git: MigrateInput['git'] = (args) => { const k = args.join(' '); log.push(`git ${k}`); return w.gitOut?.[k] ?? (k === 'rev-parse --git-dir' ? { ok: true, out: '.git' } : k.startsWith('status') ? { ok: true, out: '' } : { ok: true, out: '' }); };
  const input: MigrateInput = { home: '/home/u', oldConfigDir: `/home/u/.config/${OLD_FOLDER}`, newConfigDir: '/home/u/.config/plangraph', root: null, fs, git, driverCommand: () => 'shim %O %A %B %P', ...over };
  return { input, log, reads };
};
const file = (size = 10): Entry => ({ kind: 'file', size });
const dir = (): Entry => ({ kind: 'dir', size: 0 });

test('oldConfigDir: XDG_CONFIG_HOME when set (and not empty), else ~/.config', () => {
  assert.equal(oldConfigDir({ XDG_CONFIG_HOME: '/x' }, '/home/u'), `/x/${OLD_FOLDER}`);
  assert.equal(oldConfigDir({}, '/home/u'), `/home/u/.config/${OLD_FOLDER}`);
  assert.equal(oldConfigDir({ XDG_CONFIG_HOME: '' }, '/home/u'), `/home/u/.config/${OLD_FOLDER}`);
});

test('user files: the 64 KiB edge, symlinks, special files, existing targets, and the created directory', () => {
  const od = `/home/u/.config/${OLD_FOLDER}`, nd = '/home/u/.config/plangraph';
  const w: World = { entries: { [od]: dir(), [`${od}/jira-sites.json`]: file(65536), [`${od}/autopilot.json`]: file(65537) }, texts: {} };
  const { input, log } = mk(w);
  const plan = planMigration(input);
  assert.deepEqual(plan.steps.map((s) => s.text), ['copy ~/.config/' + OLD_FOLDER + '/jira-sites.json to ~/.config/plangraph/jira-sites.json (mode 0600)']);
  assert.deepEqual(plan.refused, [`~/.config/${OLD_FOLDER}/autopilot.json is larger than 64 KiB: not copied`]);
  assert.equal(plan.found, true); assert.equal(plan.copied, true); assert.equal(plan.oldConfigDir, od);
  assert.deepEqual(log, [], 'planning writes nothing');
  assert.deepEqual(applyMigration(plan), { done: 1, failed: null });
  assert.deepEqual(log, [`mkdir ${nd}`, `copy ${od}/jira-sites.json ${nd}/jira-sites.json`]);
  // an existing new directory is not created again; an existing file is kept; both files copy into one directory creation
  const w2: World = { entries: { [od]: dir(), [`${od}/jira-sites.json`]: file(), [`${od}/autopilot.json`]: file(), [nd]: dir(), [`${nd}/autopilot.json`]: file() }, texts: {} };
  const m2 = mk(w2); const p2 = planMigration(m2.input);
  assert.deepEqual(p2.notes, ['keep ~/.config/plangraph/autopilot.json: it exists and is never overwritten']);
  applyMigration(p2); assert.deepEqual(m2.log, [`copy ${od}/jira-sites.json ${nd}/jira-sites.json`]);
  const w3: World = { entries: { [od]: dir(), [`${od}/jira-sites.json`]: file(), [`${od}/autopilot.json`]: file() }, texts: {} };
  const m3 = mk(w3); applyMigration(planMigration(m3.input));
  assert.deepEqual(m3.log, [`mkdir ${nd}`, `copy ${od}/jira-sites.json ${nd}/jira-sites.json`, `copy ${od}/autopilot.json ${nd}/autopilot.json`]);
  // refusals
  const w4: World = { entries: { [od]: dir(), [`${od}/jira-sites.json`]: { kind: 'symlink', size: 0 }, [`${od}/autopilot.json`]: { kind: 'other', size: 0 } }, texts: {} };
  const p4 = planMigration(mk(w4).input);
  assert.deepEqual(p4.refused, [`~/.config/${OLD_FOLDER}/jira-sites.json is a symlink: not copied`, `~/.config/${OLD_FOLDER}/autopilot.json is not a regular file: not copied`]);
  assert.equal(p4.copied, false); assert.deepEqual(p4.steps, []);
  assert.equal(planMigration(mk({ entries: { [od]: { kind: 'symlink', size: 0 } }, texts: {} }).input).refused[0], `~/.config/${OLD_FOLDER} is not a directory (a symlink is refused): nothing copied`);
  assert.equal(planMigration(mk({ entries: { [od]: dir(), [nd]: file() }, texts: {} }).input).refused[0], '~/.config/plangraph is not a directory (a symlink is refused): nothing copied');
  const none = planMigration(mk({ entries: {}, texts: {} }).input);
  assert.equal(none.found, false);
  assert.deepEqual(report(none, { apply: false, home: '/home/u' }), ['migrate-names: no old names found, nothing to do']);
});

test('paths are shown with ~ only when they are HOME or under it', () => {
  const entries = (od: string) => ({ [od]: file() }) as Record<string, Entry>;
  const show = (home: string, od: string) => planMigration(mk({ entries: entries(od), texts: {} }, { home, oldConfigDir: od }).input).refused[0];
  assert.equal(show('/home/u', '/home/u'), '~ is not a directory (a symlink is refused): nothing copied');
  assert.equal(show('/home/u', '/home/u/x'), '~/x is not a directory (a symlink is refused): nothing copied');
  assert.equal(show('/home/u', '/home/user2/x'), '/home/user2/x is not a directory (a symlink is refused): nothing copied');
  assert.equal(show('/home/u', '/home/ux'), '/home/ux is not a directory (a symlink is refused): nothing copied');
  assert.equal(show('', '/home/u/x'), '/home/u/x is not a directory (a symlink is refused): nothing copied');
  assert.equal(show('/', '/x'), '/x is not a directory (a symlink is refused): nothing copied');
});

test('rewriteLine rewrites every occurrence on a line, keeps look-alikes, and moves the default directory only when asked', () => {
  assert.equal(rewriteLine(`a merge=${OLD_DRIVER} b merge=${OLD_DRIVER}`, false), 'a merge=plangraph-jsonl b merge=plangraph-jsonl');
  assert.equal(rewriteLine(`merge=${OLD_DRIVER}-x merge=${OLD_DRIVER}2`, false), `merge=${OLD_DRIVER}-x merge=${OLD_DRIVER}2`);
  assert.equal(rewriteLine(`${OLD_INDEX} and ${OLD_INDEX}`, false), 'plangraph.sqlite and plangraph.sqlite');
  assert.equal(rewriteLine(`x${OLD_INDEX} ${OLD_INDEX}-journal ${OLD_INDEX}x .${OLD_INDEX}`, false), `x${OLD_INDEX} plangraph.sqlite-journal ${OLD_INDEX}x .${OLD_INDEX}`);
  assert.equal(rewriteLine(`/${OLD_INDEX}`, false), '/plangraph.sqlite');
  assert.equal(rewriteLine(`${OLD_DIR}/*.sqlite`, true), '.plangraph/*.sqlite'); assert.equal(rewriteLine(`${OLD_DIR}/*.sqlite`, false), `${OLD_DIR}/*.sqlite`);
  assert.equal(rewriteLine(`!${OLD_DIR}/keep`, true), '!.plangraph/keep'); assert.equal(rewriteLine(`**/${OLD_DIR}`, true), '**/.plangraph'); assert.equal(rewriteLine(`/${OLD_DIR}/x`, true), '/.plangraph/x');
  assert.equal(rewriteLine(`  ${OLD_DIR} # c`, true), '  .plangraph # c'); assert.equal(rewriteLine(`${OLD_DIR}x/y`, true), `${OLD_DIR}x/y`); assert.equal(rewriteLine(`a/${OLD_DIR}/y`, true), `a/${OLD_DIR}/y`);
});

const REPO = '/repo';
const repoWorld = (extra: Partial<World> = {}): World => ({ entries: { [`${REPO}/${OLD_RC}`]: file() }, texts: { [`${REPO}/${OLD_RC}`]: '{"dir":".custom"}' }, ...extra });

test('repository text: the 1 MiB edge, the sizes passed to the reader, and the refusal names the file', () => {
  const edge = (size: number) => mk({ entries: { [`${REPO}/.gitattributes`]: file(size) }, texts: { [`${REPO}/.gitattributes`]: `x merge=${OLD_DRIVER}\n` } }, { root: REPO });
  const ok = edge(1048576); const pOk = planMigration(ok.input);
  assert.deepEqual(pOk.refused, []); assert.ok(ok.reads.some(([p, max]) => p === `${REPO}/.gitattributes` && max === 1048576));
  const big = edge(1048577); const pBig = planMigration(big.input);
  assert.deepEqual(pBig.refused, ['.gitattributes is larger than 1 MiB: not rewritten']);
  const link = mk({ entries: { [`${REPO}/.gitignore`]: { kind: 'symlink', size: 0 } }, texts: {} }, { root: REPO });
  assert.deepEqual(planMigration(link.input).refused, ['.gitignore is not a regular file (a symlink is refused): not rewritten']);
  // the rc file is read with the 64 KiB cap
  const rc = mk(repoWorld(), { root: REPO }); planMigration(rc.input);
  assert.ok(rc.reads.some(([p, max]) => p === `${REPO}/${OLD_RC}` && max === 65536));
});

test('the printed report: steps, refusals, notes, the keychain recipe and the closing line, all exact', () => {
  const od = `/home/u/.config/${OLD_FOLDER}`;
  const w: World = { entries: { [od]: dir(), [`${od}/jira-sites.json`]: file(), [`${od}/autopilot.json`]: file(65537) }, texts: {} };
  const plan = planMigration(mk(w).input);
  const keychain = `keychain: never read or written here; if a Jira token is stored under ${OLD_KEYCHAIN}[:host], re-save it as plangraph-jira[:host] (macOS: security add-generic-password -s plangraph-jira -a "$JIRA_EMAIL" -w)`;
  assert.deepEqual(report(plan, { apply: false, home: '/home/u' }), [
    'would: copy ~/.config/' + OLD_FOLDER + '/jira-sites.json to ~/.config/plangraph/jira-sites.json (mode 0600)', `refused: ~/.config/${OLD_FOLDER}/autopilot.json is larger than 64 KiB: not copied`,
    keychain, `the old folder ~/.config/${OLD_FOLDER} is left in place and is safe to delete after --apply`, 'dry run: nothing changed; run `plangraph migrate-names --apply` to apply 1 change(s)',
  ]);
  const result = applyMigration(plan);
  assert.deepEqual(report(plan, { apply: true, home: '/home/u', result }), [
    'done: copy ~/.config/' + OLD_FOLDER + '/jira-sites.json to ~/.config/plangraph/jira-sites.json (mode 0600)', `refused: ~/.config/${OLD_FOLDER}/autopilot.json is larger than 64 KiB: not copied`,
    keychain, `the old folder ~/.config/${OLD_FOLDER} is left in place and is safe to delete`, 'applied 1 change(s)',
  ]);
  // a failing step: the lines before it are done, it is failed, the rest are not run
  const fail = { steps: [{ text: 'one', run() {} }, { text: 'two', run() { throw new Error('nope'); } }, { text: 'three', run() {} }], refused: [], notes: [], found: true, copied: false, oldConfigDir: od };
  const res = applyMigration(fail);
  assert.deepEqual(res, { done: 1, failed: { text: 'two', error: 'nope' } });
  assert.deepEqual(report(fail, { apply: true, home: '/home/u', result: res }).filter((l) => !l.startsWith('keychain')), ['done: one', 'failed: two: nope', 'not run: three', 'failed after 1 of 3 change(s): fix the cause, commit what was already changed, then run `plangraph migrate-names --apply` again']);
  assert.deepEqual(applyMigration({ ...fail, steps: [{ text: 'x', run() { throw 'plain'; } }] }), { done: 0, failed: { text: 'x', error: 'plain' } });
  // already migrated
  assert.deepEqual(report({ steps: [], refused: [], notes: [], found: true, copied: false, oldConfigDir: `/home/u/.config/${OLD_FOLDER}` }, { apply: false, home: '/home/u' }), [`migrate-names: already migrated, nothing to do (~/.config/${OLD_FOLDER} can be deleted once you no longer need it)`]);
  // a plan with only notes and no step or refusal counts as already migrated
  assert.deepEqual(report({ steps: [], refused: [], notes: ['n1'], found: true, copied: false, oldConfigDir: od }, { apply: false, home: '/home/u' }), [`migrate-names: already migrated, nothing to do (~/.config/${OLD_FOLDER} can be deleted once you no longer need it)`]);
});
