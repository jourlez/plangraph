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

// ---------------------------------------------------------------- repository part
type GitAnswers = Record<string, { ok: boolean; out: string }>;
const repo = (w: Partial<World> & { git?: GitAnswers } = {}, over: Partial<MigrateInput> = {}) => {
  const gitOut: GitAnswers = { 'rev-parse --git-dir': { ok: true, out: '.git\n' }, 'status --porcelain --untracked-files=no': { ok: true, out: '' }, ...w.git };
  const m = mk({ entries: w.entries ?? {}, texts: w.texts ?? {}, gitOut }, { root: REPO, ...over });
  return { ...m, plan: planMigration(m.input) };
};
const R_RC = `${REPO}/${OLD_RC}`, R_DIR = `${REPO}/${OLD_DIR}`, R_GA = `${REPO}/.gitattributes`, R_GI = `${REPO}/.gitignore`;
const tracked = (p: string): GitAnswers => ({ [`ls-files -- ${p}`]: { ok: true, out: `${p}\n` } });

test('nothing happens outside a git repository or when nothing old is found; the first git call is exact', () => {
  const none = repo({ entries: { [R_RC]: file() } , git: { 'rev-parse --git-dir': { ok: false, out: '' } } });
  assert.equal(none.plan.found, false); assert.deepEqual(none.plan.steps, []);
  assert.deepEqual(none.log, ['git rev-parse --git-dir']);
  const noRoot = mk({ entries: { [R_RC]: file() }, texts: {} }, { root: null }); const p = planMigration(noRoot.input);
  assert.equal(p.found, false); assert.deepEqual(noRoot.log, []);
  const clean = repo({ entries: { [`${REPO}/.gitattributes`]: file() }, texts: { [R_GA]: '*.png binary\n' } });
  assert.equal(clean.plan.found, false); assert.deepEqual(clean.plan.steps, []);
  assert.deepEqual(clean.log, ['git rev-parse --git-dir', 'git config --local --get-regexp ^merge\\.brain-jsonl\\.'.replace('brain-jsonl', OLD_DRIVER)]);
});

test('each old trace alone makes the repository part run', () => {
  const dirty = (w: Partial<World> & { git?: GitAnswers }) => { const r = repo({ ...w, git: { ...w.git, 'status --porcelain --untracked-files=no': { ok: true, out: ' M x\n' } } }); return r.plan; };
  const traces: Array<[string, Partial<World> & { git?: GitAnswers }]> = [
    ['rc file', { entries: { [R_RC]: file() }, texts: { [R_RC]: '{}' } }],
    ['default dir', { entries: { [R_DIR]: dir() } }],
    ['driver line', { entries: { [R_GA]: file() }, texts: { [R_GA]: `x merge=${OLD_DRIVER}\n` } }],
    ['ignore line', { entries: { [R_GI]: file(), [R_DIR]: dir() }, texts: { [R_GI]: `${OLD_INDEX}\n` } }],
    ['old git config', { git: { [`config --local --get-regexp ^merge\\.${OLD_DRIVER}\\.`]: { ok: true, out: `merge.${OLD_DRIVER}.driver x\n` } } }],
    ['refused attributes', { entries: { [R_GA]: { kind: 'symlink', size: 0 } } }],
    ['refused ignore', { entries: { [R_GI]: { kind: 'symlink', size: 0 } } }],
  ];
  for (const [name, w] of traces) { const p = dirty(w); assert.equal(p.found, true, name); assert.deepEqual(p.refused.filter((r) => r.startsWith('the repository')), ['the repository has uncommitted changes to tracked files: commit or stash them, then run again (repository part skipped)'], name); }
  // a custom directory named by the rc: a lone old .brain directory is then not an old trace
  const custom = dirty({ entries: { [R_DIR]: dir(), [R_RC.replace(OLD_RC, '.plangraphrc')]: file() }, texts: { [R_RC.replace(OLD_RC, '.plangraphrc')]: '{"dir":".custom"}' } });
  assert.equal(custom.found, false);
  // a failed status is also a refusal
  const failed = repo({ entries: { [R_RC]: file() }, texts: { [R_RC]: '{}' }, git: { 'status --porcelain --untracked-files=no': { ok: false, out: '' } } });
  assert.deepEqual(failed.plan.steps, []); assert.equal(failed.plan.refused.length, 1);
  assert.ok(failed.log.includes('git status --porcelain --untracked-files=no'));
});

test('the rc file: renamed (plain or by git), refused when special or when the new name exists, and it may name the directory', () => {
  const plain = repo({ entries: { [R_RC]: file() }, texts: { [R_RC]: '{}' } });
  assert.deepEqual(plain.plan.steps.map((s) => s.text), [`rename ${OLD_RC} .plangraphrc (content unchanged)`]);
  applyMigration(plain.plan); assert.ok(plain.log.includes(`rename ${R_RC} ${REPO}/.plangraphrc`));
  const viaGit = repo({ entries: { [R_RC]: file() }, texts: { [R_RC]: '{}' }, git: tracked(OLD_RC) });
  assert.deepEqual(viaGit.plan.steps.map((s) => s.text), [`git mv ${OLD_RC} .plangraphrc (content unchanged)`]);
  applyMigration(viaGit.plan); assert.ok(viaGit.log.includes(`git mv -- ${OLD_RC} .plangraphrc`)); assert.equal(viaGit.log.some((l) => l.startsWith('rename')), false);
  const blank = repo({ entries: { [R_RC]: file() }, texts: { [R_RC]: '{}' }, git: { [`ls-files -- ${OLD_RC}`]: { ok: true, out: '  \n' } } });
  assert.match(blank.plan.steps[0]?.text ?? '', /^rename /, 'blank output is untracked');
  const notOk = repo({ entries: { [R_RC]: file() }, texts: { [R_RC]: '{}' }, git: { [`ls-files -- ${OLD_RC}`]: { ok: false, out: 'x\n' } } });
  assert.match(notOk.plan.steps[0]?.text ?? '', /^rename /, 'a failed ls-files is untracked');
  const failMv = repo({ entries: { [R_RC]: file() }, texts: { [R_RC]: '{}' }, git: { ...tracked(OLD_RC), [`mv -- ${OLD_RC} .plangraphrc`]: { ok: false, out: '' } } });
  assert.deepEqual(applyMigration(failMv.plan), { done: 0, failed: { text: `git mv ${OLD_RC} .plangraphrc (content unchanged)`, error: `git mv ${OLD_RC} .plangraphrc failed` } });
  const special = repo({ entries: { [R_RC]: { kind: 'symlink', size: 0 } } });
  assert.deepEqual(special.plan.refused, [`${OLD_RC} is not a regular file (a symlink is refused): not renamed`]); assert.deepEqual(special.plan.steps, []);
  const both = repo({ entries: { [R_RC]: file(), [`${REPO}/.plangraphrc`]: file() }, texts: { [R_RC]: '{}' } });
  assert.deepEqual(both.plan.refused, [`.plangraphrc exists: ${OLD_RC} not renamed (merge them by hand)`]); assert.deepEqual(both.plan.steps, []);
  const named = repo({ entries: { [R_RC]: file(), [R_DIR]: dir() }, texts: { [R_RC]: '{"dir":".custom"}' } });
  assert.deepEqual(named.plan.notes, ['keep .custom: the directory is named by the rc file']); assert.equal(named.plan.steps.length, 1);
  for (const text of ['not json', '[]', 'null', '5', '{"dir":5}', '{"other":1}']) {
    const r = repo({ entries: { [R_RC]: file(), [R_DIR]: dir() }, texts: { [R_RC]: text } });
    assert.equal(r.plan.steps.some((s) => s.text.includes(`${OLD_DIR} .plangraph`)), true, `default directory for ${text}`);
    assert.deepEqual(r.plan.notes.filter((n) => n.startsWith('keep')), []);
  }
  const withLine = { [R_GA]: file() }, lineText = { [R_GA]: `x merge=${OLD_DRIVER}\n` };
  const fromNew = repo({ entries: { [`${REPO}/.plangraphrc`]: file(), [R_DIR]: dir(), ...withLine }, texts: { [`${REPO}/.plangraphrc`]: '{"dir":".kept"}', ...lineText } });
  assert.deepEqual(fromNew.plan.notes, ['keep .kept: the directory is named by the rc file']);
  const rcDir = repo({ entries: { [R_RC]: { kind: 'dir', size: 0 }, [`${REPO}/.plangraphrc`]: file(), ...withLine }, texts: { [`${REPO}/.plangraphrc`]: '{"dir":".kept"}', ...lineText } });
  assert.deepEqual(rcDir.plan.notes, ['keep .kept: the directory is named by the rc file'], 'only a regular old rc file is read first, else the new one');
  assert.deepEqual(rcDir.plan.refused, [`${OLD_RC} is not a regular file (a symlink is refused): not renamed`]);
});

test('the default directory: moved, with a note about an old index, refused when special or when the new one exists', () => {
  const plain = repo({ entries: { [R_DIR]: dir() } });
  assert.deepEqual(plain.plan.steps.map((s) => s.text), [`rename ${OLD_DIR} .plangraph`]); assert.deepEqual(plain.plan.notes, []);
  const viaGit = repo({ entries: { [R_DIR]: dir() }, git: tracked(OLD_DIR) });
  assert.deepEqual(viaGit.plan.steps.map((s) => s.text), [`git mv ${OLD_DIR} .plangraph`]);
  applyMigration(viaGit.plan); assert.ok(viaGit.log.includes(`git mv -- ${OLD_DIR} .plangraph`));
  const idx = repo({ entries: { [R_DIR]: dir(), [`${R_DIR}/${OLD_INDEX}`]: file() } });
  assert.deepEqual(idx.plan.notes, [`the old index .plangraph/${OLD_INDEX} can be deleted: \`plangraph build\` writes .plangraph/plangraph.sqlite`]);
  const sym = repo({ entries: { [R_DIR]: { kind: 'symlink', size: 0 } } });
  assert.deepEqual(sym.plan.refused, [`${OLD_DIR} is not a directory (a symlink is refused): not moved`]); assert.deepEqual(sym.plan.steps, []);
  const both = repo({ entries: { [R_DIR]: dir(), [`${REPO}/.plangraph`]: dir() } });
  assert.deepEqual(both.plan.refused, [`.plangraph exists: ${OLD_DIR} not moved`]); assert.deepEqual(both.plan.steps, []);
});

test('attribute and ignore files: only changed lines are listed, joined by "; ", and written whole; leftovers are noted when the directory moved', () => {
  const ga = `${OLD_DIR}/*.jsonl merge=${OLD_DRIVER}\n*.png binary\n`, gi = `node_modules/\n${OLD_DIR}/*.sqlite\n# ${OLD_DIR}\nnotes/${OLD_DIR}/x\n${OLD_INDEX}\n`;
  const r = repo({ entries: { [R_DIR]: dir(), [R_GA]: file(), [R_GI]: file() }, texts: { [R_GA]: ga, [R_GI]: gi } });
  assert.deepEqual(r.plan.steps.map((s) => s.text), [
    `rename ${OLD_DIR} .plangraph`,
    `.gitattributes: ${OLD_DIR}/*.jsonl merge=${OLD_DRIVER} to .plangraph/*.jsonl merge=plangraph-jsonl`,
    `.gitignore: ${OLD_DIR}/*.sqlite to .plangraph/*.sqlite; ${OLD_INDEX} to plangraph.sqlite`,
    `git config: set merge.plangraph-jsonl.name and .driver (the stable merge shim)`,
  ]);
  assert.deepEqual(r.plan.notes, [`.gitignore line 4 still names ${OLD_DIR} after the rewrite: change it by hand to .plangraph (printed only, not edited)`]);
  applyMigration(r.plan);
  assert.ok(r.log.includes(`write ${R_GA} ${JSON.stringify(ga.replace(`${OLD_DIR}/*.jsonl merge=${OLD_DRIVER}`, '.plangraph/*.jsonl merge=plangraph-jsonl'))}`));
  assert.ok(r.log.includes(`write ${R_GI} ${JSON.stringify(`node_modules/\n.plangraph/*.sqlite\n# ${OLD_DIR}\nnotes/${OLD_DIR}/x\nplangraph.sqlite\n`)}`));
  // when the directory is not moved, nothing is noted and the directory part of a line stays
  const kept = repo({ entries: { [R_GI]: file(), [R_RC]: file() }, texts: { [R_GI]: `${OLD_DIR}/x\n${OLD_INDEX}\n`, [R_RC]: '{"dir":".c"}' } });
  assert.deepEqual(kept.plan.steps.map((s) => s.text), [`rename ${OLD_RC} .plangraphrc (content unchanged)`, `.gitignore: ${OLD_INDEX} to plangraph.sqlite`]);
  assert.deepEqual(kept.plan.notes, ['keep .c: the directory is named by the rc file']);
  // a file with nothing to change adds no step
  const same = repo({ entries: { [R_GI]: file(), [R_RC]: file() }, texts: { [R_GI]: 'node_modules/\n', [R_RC]: '{}' } });
  assert.deepEqual(same.plan.steps.map((s) => s.text), [`rename ${OLD_RC} .plangraphrc (content unchanged)`]);
  // a refused file is named, and a missing one is skipped
  const sym = repo({ entries: { [R_GA]: { kind: 'symlink', size: 0 }, [R_GI]: file() }, texts: { [R_GI]: `${OLD_INDEX}\n` } });
  assert.deepEqual(sym.plan.refused, ['.gitattributes is not a regular file (a symlink is refused): not rewritten']);
  assert.deepEqual(sym.plan.steps.map((s) => s.text), [`.gitignore: ${OLD_INDEX} to plangraph.sqlite`]);
});

test('the merge driver config: set name and driver, remove the old section only when it exists; each failure names its step', () => {
  const oldCfg: GitAnswers = { [`config --local --get-regexp ^merge\\.${OLD_DRIVER}\\.`]: { ok: true, out: `merge.${OLD_DRIVER}.driver old\n` } };
  const r = repo({ git: oldCfg });
  assert.deepEqual(r.plan.steps.map((s) => s.text), [`git config: set merge.plangraph-jsonl.name and .driver (the stable merge shim), remove merge.${OLD_DRIVER}`]);
  assert.deepEqual(applyMigration(r.plan), { done: 1, failed: null });
  assert.deepEqual(r.log.filter((l) => l.startsWith('git config merge') || l.startsWith('git config --local --remove')), [
    'git config merge.plangraph-jsonl.name plangraph jsonl three-way merge', 'git config merge.plangraph-jsonl.driver shim %O %A %B %P', `git config --local --remove-section merge.${OLD_DRIVER}`,
  ]);
  const lineOnly = repo({ entries: { [R_GA]: file() }, texts: { [R_GA]: `x merge=${OLD_DRIVER}\n` } });
  assert.deepEqual(lineOnly.plan.steps.map((s) => s.text), [`.gitattributes: merge=${OLD_DRIVER} to merge=plangraph-jsonl`.replace('.gitattributes: merge', `.gitattributes: x merge`).replace(` to merge=plangraph-jsonl`, ` to x merge=plangraph-jsonl`), 'git config: set merge.plangraph-jsonl.name and .driver (the stable merge shim)']);
  applyMigration(lineOnly.plan); assert.equal(lineOnly.log.some((l) => l.includes('--remove-section')), false);
  const blankCfg = repo({ entries: { [R_GA]: file() }, texts: { [R_GA]: `x merge=${OLD_DRIVER}\n` }, git: { [`config --local --get-regexp ^merge\\.${OLD_DRIVER}\\.`]: { ok: true, out: '  \n' } } });
  assert.equal(blankCfg.plan.steps[1]?.text, 'git config: set merge.plangraph-jsonl.name and .driver (the stable merge shim)');
  const failedCfg = repo({ entries: { [R_GA]: file() }, texts: { [R_GA]: `x merge=${OLD_DRIVER}\n` }, git: { [`config --local --get-regexp ^merge\\.${OLD_DRIVER}\\.`]: { ok: false, out: `merge.${OLD_DRIVER}.driver old\n` } } });
  assert.equal(failedCfg.plan.steps[1]?.text, 'git config: set merge.plangraph-jsonl.name and .driver (the stable merge shim)', 'a failed query counts as no old config');
  for (const [key, step] of [['name', 'name'], ['driver', 'driver']] as const) {
    const bad = repo({ git: { ...oldCfg, [`config merge.plangraph-jsonl.${key} ${key === 'name' ? 'plangraph jsonl three-way merge' : 'shim %O %A %B %P'}`]: { ok: false, out: '' } } });
    assert.deepEqual(applyMigration(bad.plan).failed?.error, `git config merge.plangraph-jsonl.${step} failed`);
  }
  const noRemove = repo({ git: { ...oldCfg, [`config --local --remove-section merge.${OLD_DRIVER}`]: { ok: false, out: '' } } });
  assert.equal(applyMigration(noRemove.plan).failed?.error, `git config --remove-section merge.${OLD_DRIVER} failed`);
  let asked = 0; const cmd = repo({ git: oldCfg }, { driverCommand: () => { asked++; return 'x'; } });
  assert.equal(asked, 0, 'the shim is created only when the step runs'); applyMigration(cmd.plan); assert.equal(asked, 1);
});

test('printed-only notes: CLAUDE.md names the old directory, settings rules start with the old command', () => {
  const claudeMd = `${REPO}/CLAUDE.md`;
  const names = repo({ entries: { [R_DIR]: dir(), [claudeMd]: file() }, texts: { [claudeMd]: `see ${OLD_DIR}/*.jsonl\n` } });
  assert.deepEqual(names.plan.notes, [`CLAUDE.md names ${OLD_DIR}/*.jsonl: change it to .plangraph/*.jsonl in the plan-questions lines (printed only, not edited)`]);
  const custom = repo({ entries: { [R_RC]: file(), [claudeMd]: file() }, texts: { [R_RC]: '{"dir":".c"}', [claudeMd]: `see ${OLD_DIR}/*.jsonl\n` } });
  assert.deepEqual(custom.plan.notes, ['keep .c: the directory is named by the rc file']);
  const none = repo({ entries: { [R_DIR]: dir(), [claudeMd]: file() }, texts: { [claudeMd]: 'nothing\n' } });
  assert.deepEqual(none.plan.notes, []);
  const word = 'brain';
  const rules = (n: string) => `{"permissions":{"allow":["Bash(${word}:*)","Bash(${word} x)","Bash(${word})","Bash(${word}*)","Bash(${word}storm x)","Bash(x ${word})"]}}`.replace(n, n);
  const set = repo({ entries: { [R_DIR]: dir(), [`${REPO}/.claude/settings.json`]: file(), [`${REPO}/.claude/settings.local.json`]: file() }, texts: { [`${REPO}/.claude/settings.json`]: rules(''), [`${REPO}/.claude/settings.local.json`]: `Bash(${word} a)` } });
  assert.deepEqual(set.plan.notes, [
    '.claude/settings.json: 4 permission rule(s) start with Bash(brain: change them to Bash(plangraph (printed only, not edited)',
    '.claude/settings.local.json: 1 permission rule(s) start with Bash(brain: change them to Bash(plangraph (printed only, not edited)',
  ].map((s) => s.replace('Bash(brain', `Bash(${word}`)));
  const quiet = repo({ entries: { [R_DIR]: dir(), [`${REPO}/.claude/settings.json`]: file() }, texts: { [`${REPO}/.claude/settings.json`]: `Bash(${word}storm x)` } });
  assert.deepEqual(quiet.plan.notes, []);
});
