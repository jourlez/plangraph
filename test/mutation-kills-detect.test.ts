// Characterization goldens for lib/integrations/detect.ts (test/golden/mutation-kills/detect.json, UPDATE_GOLDEN=1 rewrites), written to
// kill mutants that survived scripts/mutate-all.ts: the full detectTools() report (states, versions, evidence and note texts, budget)
// for synthetic worlds covering every branch: all plugins at different settings layers, unsafe keys, other-project entries, the 1 MiB
// read cap, caveman and GitKraken hints, every OpenWolf state, the OpenWolf registry, unreadable files and a throwing fs.
// Paths are replaced by <root> and <home> so the goldens do not depend on the temp directory. All names are invented.
// NOT covered: real installations (the shapes follow docs/research; nothing here reads the real home directory).
import { test, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectTools } from '../lib/integrations/detect.ts';
import { golden } from './helpers/golden-json.ts';

const made: string[] = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const world = () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'detect-k-'))); made.push(base);
  const root = path.join(base, 'proj'), home = path.join(base, 'home'); fs.mkdirSync(root); fs.mkdirSync(home);
  /** @param {string} f @param {unknown} v */
  const put = (f: string, v: unknown) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v)); };
  return { root, home, put };
};
/** @param {unknown} r @param {string} root @param {string} home */
const scrub = (r: unknown, root: string, home: string) => JSON.parse(JSON.stringify(r).split(root).join('<root>').split(home).join('<home>'));
/** @param {string} version @param {string} [scope] @param {string} [projectPath] */
const entry = (version: string, scope = 'user', projectPath?: string) => ({ scope, installPath: '/nowhere', version, ...(projectPath ? { projectPath } : {}) });

test('rich world: every plugin, layered settings, unsafe keys, hints, an active OpenWolf, the registry listing the project', () => {
  const { root, home, put } = world();
  put(path.join(home, '.claude/plugins/installed_plugins.json'), { version: 2, plugins: {
    'superpowers@a': [entry('5.0.1'), entry('bad version!')], 'caveman@b': [entry('1.2.3', 'project', root)], 'context7@c': [entry('0.9.0', 'local', path.join(root, 'elsewhere'))],
    'context7@d': [entry('0.9.1')], 'gitkraken-hooks@e': [entry('2.0.0')], 'extra@f': [entry('0.0.1')], '-unsafe@x': [entry('1.0.0')], 'superpowers@old': 'not an array',
  } });
  put(path.join(root, '.claude/settings.local.json'), { enabledPlugins: { 'caveman@b': true, 'bad key!@z': true }, hooks: { SessionStart: [{ command: 'node .wolf/hooks/session-start.js' }] } });
  put(path.join(root, '.claude/settings.json'), { enabledPlugins: { 'superpowers@a': true, 'context7@d': false, 'extra@f': true } });
  put(path.join(home, '.claude/settings.json'), { enabledPlugins: { 'gitkraken-hooks@e': true, 'context7@d': true } });
  put(path.join(home, '.claude/.caveman-active'), '');
  fs.mkdirSync(path.join(home, 'Library/Caches/GitKrakenCLI'), { recursive: true });
  put(path.join(root, '.wolf/config.json'), { openwolf: { enabled: true, claude: { settings_file: 'conf/claude.json' } } });
  put(path.join(root, '.wolf/hooks/session-start.js'), '');
  put(path.join(root, 'conf/claude.json'), '{"x":"node /p/.wolf/hooks/session-start.js"}');
  put(path.join(root, '.wolf/hooks/runtime.json'), { version: '1.4.0' });
  put(path.join(home, '.openwolf/registry.json'), { projects: [{ root: path.join(root, '.') }, 'junk'] });
  const r = detectTools({ root, home, env: { CAVEMAN_DEFAULT_MODE: 'off' }, names: ['superpowers', 'openwolf', 'caveman', 'context7', 'gitkraken', 'extra'] });
  golden('detect', 'rich', scrub(r, root, home));
});

test('protocol-only OpenWolf, an unreadable plugin registry, a registry that does not list the project', () => {
  const { root, home, put } = world();
  put(path.join(home, '.claude/plugins/installed_plugins.json'), '{ not json');
  put(path.join(root, '.wolf/config.json'), '[1]');
  put(path.join(home, '.openwolf/registry.json'), { projects: [{ root: '/somewhere/else' }, { root: 5 }] });
  put(path.join(root, '.claude/settings.json'), '["not an object"]');
  const r = detectTools({ root, home, env: { CAVEMAN_DEFAULT_MODE: 'on' } });
  golden('detect', 'protocol-only', scrub(r, root, home));
});

test('disabled OpenWolf with a hook registered; a settings file over 1 MiB is unreadable; installed-only and other-project plugins', () => {
  const { root, home, put } = world();
  put(path.join(home, '.claude/plugins/installed_plugins.json'), { version: 2, plugins: { 'superpowers@a': [entry('1.0.0')], 'caveman@b': [entry('1.0.0', 'project', '/other/project')], 'gitkraken-hooks@e': [entry('3.0.0')] } });
  const body = JSON.stringify({ enabledPlugins: { 'superpowers@a': true } });
  put(path.join(home, '.claude/settings.json'), body + ' '.repeat(1024 * 1024 + 1 - body.length));
  put(path.join(root, '.wolf/config.json'), { openwolf: { enabled: false, claude: { settings_file: '../outside.json' } } });
  put(path.join(root, '.wolf/hooks/session-start.js'), '');
  put(path.join(root, '.claude/settings.json'), { hooks: { x: '/.wolf/hooks/session-start.js' } });
  put(path.join(root, '.wolf/hooks/runtime.json'), { version: 'not ok version' });
  golden('detect', 'disabled', scrub(detectTools({ root, home, env: {} }), root, home));
  put(path.join(root, '.wolf/config.json'), { openwolf: { enabled: true } });
  fs.rmSync(path.join(root, '.claude/settings.json'));
  golden('detect', 'hook-not-registered', scrub(detectTools({ root, home, env: {} }), root, home));
});

test('a throwing fs implementation counts as absent everywhere', () => {
  const { root, home, put } = world();
  put(path.join(root, '.wolf/hooks/session-start.js'), '');
  put(path.join(home, '.claude/.caveman-active'), '');
  const boom = () => { throw new Error('fs refused'); };
  const fsImpl = /** @type {typeof fs} */ (/** @type {unknown} */ ({ ...fs, existsSync: boom, statSync: boom }));
  golden('detect', 'throwing-fs', scrub(detectTools({ root, home, env: {}, fsImpl }), root, home));
});
