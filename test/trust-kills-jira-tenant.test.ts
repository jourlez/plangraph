// Behavior tests for the registry file handling of src/jira-tenant.ts (loadRegistry, approveAlias, resolutionOf, effectiveJira), written to kill
// the mutants of the trust-root run: the 64 KiB edge, symlink and non-file refusals with their exact reasons, the exact rewrite of the file on
// approval (2-space JSON, mode 0600, other content kept, once only), and refusals that name the file. Real files in a scratch directory.
// NOT covered: tenant resolution (test/jira-tenants.test.ts, test/jira-tenant-isolation.test.ts, test/jira-alias.test.ts).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRegistry, approveAlias, resolutionOf, effectiveJira, registryFile, configDir } from '../src/jira-tenant.ts';
import type { JiraError } from '../lib/jira.ts';

const posix = process.platform !== 'win32';
const made: string[] = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const scratch = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tenk-'))); made.push(d); return d; };
const world = (text?: string) => { const d = scratch(), env = { PLANGRAPH_CONFIG_DIR: d }; if (text !== undefined) fs.writeFileSync(path.join(d, 'jira-sites.json'), text); return { d, env, file: path.join(d, 'jira-sites.json') }; };
const bad = (code: string, msg: string | RegExp) => (e: JiraError) => e.code === code && (typeof msg === 'string' ? e.message === msg : msg.test(e.message));
const H64 = 'b'.repeat(64);

test('resolutionOf refuses anything that was not minted by resolveTenant', () => {
  for (const x of [{}, null, undefined, 5, 'x', { tenant: 't' }]) assert.throws(() => resolutionOf(x as never), bad('bad_config', 'the tracker needs a tenant decision minted by resolveTenant'));
});

test('configDir and registryFile follow PLANGRAPH_CONFIG_DIR, then XDG_CONFIG_HOME, then HOME', () => {
  assert.equal(configDir({ PLANGRAPH_CONFIG_DIR: '/a/b' }), '/a/b');
  assert.equal(configDir({ XDG_CONFIG_HOME: '/x' }), '/x/plangraph');
  assert.equal(configDir({ HOME: '/h' }), '/h/.config/plangraph');
  assert.equal(registryFile({ PLANGRAPH_CONFIG_DIR: '/a/b' }), '/a/b/jira-sites.json');
});

test('loadRegistry: a missing file, a non-file, the size edge, and a parsed file', { skip: !posix }, () => {
  const none = world(); const r0 = loadRegistry(none.env);
  assert.equal(r0.exists, false); assert.equal(r0.file, none.file); assert.deepEqual(r0.problems, []);
  for (const m of [r0.reg, r0.projects, r0.aliases]) assert.equal(Object.getPrototypeOf(m), null);
  // a directory and a symlink are refused, and the file counts as present
  const dirW = world(); fs.mkdirSync(dirW.file);
  const r1 = loadRegistry(dirW.env);
  assert.equal(r1.exists, true); assert.deepEqual(r1.problems, ['jira-sites.json is not a regular file (a symlink is refused)']); assert.deepEqual({ ...r1.reg }, {});
  const linkW = world(); fs.writeFileSync(path.join(linkW.d, 'real.json'), '{"sites":{}}'); fs.symlinkSync(path.join(linkW.d, 'real.json'), linkW.file);
  const r2 = loadRegistry(linkW.env);
  assert.equal(r2.exists, true); assert.deepEqual(r2.problems, ['jira-sites.json is not a regular file (a symlink is refused)']);
  for (const m of [r1.reg, r1.projects, r1.aliases, r2.reg]) assert.equal(Object.getPrototypeOf(m), null);
  // exactly 64 KiB is read, one byte more is refused
  const pad = (n: number) => { const base = JSON.stringify({ sites: { 'a.example': { token_env: 'X' } }, pad: '' }); return JSON.stringify({ sites: { 'a.example': { token_env: 'X' } }, pad: 'p'.repeat(n - base.length) }); };
  const okW = world(pad(65536)); assert.equal(fs.statSync(okW.file).size, 65536);
  const r3 = loadRegistry(okW.env); assert.deepEqual(r3.problems, []); assert.deepEqual({ ...r3.reg }, { 'a.example': { token_env: 'X' } });
  const bigW = world(pad(65537));
  const r4 = loadRegistry(bigW.env);
  assert.equal(r4.exists, true); assert.deepEqual(r4.problems, ['jira-sites.json is larger than 64 KiB']); assert.deepEqual({ ...r4.reg }, {}); assert.equal(Object.getPrototypeOf(r4.reg), null);
  // a normal file: present, parsed, with the file name
  const w = world('{"sites":{"b.example":{"keychain":"svc"}},"projects":{"/r/":{"jql":"x"}},"aliases":{"work":{"cloud_id":"c"}}}');
  const r5 = loadRegistry(w.env);
  assert.deepEqual([r5.exists, r5.file, r5.problems], [true, w.file, []]);
  assert.deepEqual({ ...r5.reg }, { 'b.example': { keychain: 'svc' } }); assert.deepEqual({ ...r5.projects }, { '/r': { jql: 'x' } }); assert.deepEqual({ ...r5.aliases }, { work: { cloud_id: 'c' } });
  assert.deepEqual(loadRegistry(world('{nope').env).problems, ['jira-sites.json is not valid JSON']);
});

test('effectiveJira: a project entry is found by its root without trailing slashes, and a layer that names a tenant decides it', () => {
  const w = world('{"projects":{"/work/repo":{"cloud_id":"cid-user-123","jql":"project = U"}}}');
  const reg = loadRegistry(w.env);
  const committed = { base_url: 'https://evil.atlassian.net', auth: { mode: 'site-token' as const }, jql: 'project = C', sprint_field: 'customfield_1' };
  for (const root of ['/work/repo', '/work/repo/', '/work/repo//']) {
    assert.deepEqual(effectiveJira(committed, root, w.env, {}, reg), { cloud_id: 'cid-user-123', jql: 'project = U', sprint_field: 'customfield_1', userTenant: true }, root);
  }
  assert.deepEqual(effectiveJira(committed, '/other', w.env, {}, reg), { ...committed, userTenant: false });
  assert.deepEqual(effectiveJira(committed, '', w.env, {}, reg), { ...committed, userTenant: false });
  assert.deepEqual(effectiveJira(committed, '/work/repomutant', w.env, {}, reg), { ...committed, userTenant: false });
});

const aliasFile = (extra: Record<string, unknown> = {}) => JSON.stringify({ sites: { 'a.example': { token_env: 'X' } }, aliases: { work: { cloud_id: 'c1', repos: [H64, 5] }, other: { cloud_id: 'c2' } }, ...extra });

test('approveAlias writes the key once, keeps everything else, mode 0600, 2-space JSON with a final newline', { skip: !posix }, () => {
  const w = world(aliasFile());
  approveAlias(w.env, 'work', 'a'.repeat(64));
  const j = JSON.parse(fs.readFileSync(w.file, 'utf8'));
  assert.deepEqual(j.aliases.work.repos, [H64, 'a'.repeat(64)]); assert.deepEqual(j.aliases.other, { cloud_id: 'c2' }); assert.deepEqual(j.sites, { 'a.example': { token_env: 'X' } });
  assert.equal(fs.readFileSync(w.file, 'utf8'), `${JSON.stringify(j, null, 2)}\n`);
  assert.match(fs.readFileSync(w.file, 'utf8'), /^\{\n {2}"sites": \{\n {4}"a\.example"/);
  assert.equal((fs.statSync(w.file).mode & 0o777).toString(8), '600');
  approveAlias(w.env, 'work', 'a'.repeat(64));
  assert.deepEqual(JSON.parse(fs.readFileSync(w.file, 'utf8')).aliases.work.repos, [H64, 'a'.repeat(64)], 'approving twice adds it once');
  approveAlias(w.env, 'other', H64);
  assert.deepEqual(JSON.parse(fs.readFileSync(w.file, 'utf8')).aliases.other.repos, [H64]);
});

test('approveAlias refuses an unusable file or alias with the reason, and writes nothing', { skip: !posix }, () => {
  const unusable = (file: string) => `${file} is missing, a symlink, larger than 64 KiB or not valid JSON`;
  const none = world(); assert.throws(() => approveAlias(none.env, 'work', H64), bad('bad_config', unusable(none.file)));
  const dirW = world(); fs.mkdirSync(dirW.file); assert.throws(() => approveAlias(dirW.env, 'work', H64), bad('bad_config', unusable(dirW.file)));
  const linkW = world(); fs.writeFileSync(path.join(linkW.d, 'real.json'), aliasFile()); fs.symlinkSync(path.join(linkW.d, 'real.json'), linkW.file);
  assert.throws(() => approveAlias(linkW.env, 'work', H64), bad('bad_config', unusable(linkW.file)));
  assert.equal(JSON.parse(fs.readFileSync(path.join(linkW.d, 'real.json'), 'utf8')).aliases.work.repos.length, 2, 'the symlink target was not written');
  const junk = world('{nope'); assert.throws(() => approveAlias(junk.env, 'work', H64), bad('bad_config', unusable(junk.file)));
  const pad = (n: number) => { const base = aliasFile({ pad: '' }); return aliasFile({ pad: 'p'.repeat(n - base.length) }); };
  const edge = world(pad(65536)); assert.equal(fs.statSync(edge.file).size, 65536);
  approveAlias(edge.env, 'work', 'c'.repeat(64)); assert.ok(JSON.parse(fs.readFileSync(edge.file, 'utf8')).aliases.work.repos.includes('c'.repeat(64)));
  const big = world(pad(65537)); assert.throws(() => approveAlias(big.env, 'work', H64), bad('bad_config', unusable(big.file)));
  // an alias that is not in the file, or a file whose shape cannot hold one
  const notDefined = (text: string, name: string) => { const w = world(text); assert.throws(() => approveAlias(w.env, name, H64), bad('bad_config', `alias ${name} is not defined in ${w.file}`), `${name} in ${text.slice(0, 40)}`); assert.equal(fs.readFileSync(w.file, 'utf8'), text, 'nothing written'); };
  notDefined(aliasFile(), 'missing'); notDefined(aliasFile(), 'Work'); notDefined(aliasFile(), 'constructor'); notDefined(aliasFile(), '__proto__'); notDefined(aliasFile(), '');
  notDefined('null', 'work'); notDefined('5', 'work'); notDefined('{}', 'work'); notDefined('{"aliases":null}', 'work'); notDefined('{"aliases":"work"}', 'work'); notDefined('{"aliases":5}', 'work');
  notDefined('{"aliases":{"work":null}}', 'work'); notDefined('{"aliases":{"work":"x"}}', 'work'); notDefined('{"aliases":{"work":5}}', 'work'); notDefined('{"aliases":{"constructor":{"cloud_id":"c"}}}', 'constructor');
  notDefined('[]', 'work'); notDefined('{"aliases":[]}', 'work');
});
