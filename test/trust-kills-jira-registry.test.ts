// Behavior tests for lib/jira/registry.ts, written to kill the mutants of the trust-root run: parseSiteRegistry is called with exact texts and
// every output (entries, dropped fields, problem lines) is compared whole; the alias-name rule and its prototype-member refusals are asserted.
// NOT covered: reading the file from disk (src/jira-tenant.ts, test/jira-tenants.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSiteRegistry, isAliasName, ALIAS_RE } from '../lib/jira/registry.ts';

const parse = (v: unknown) => { const r = parseSiteRegistry(typeof v === 'string' ? v : JSON.stringify(v)); return { reg: { ...r.reg }, projects: { ...r.projects }, aliases: { ...r.aliases }, problems: r.problems }; };
const H64 = 'a'.repeat(64);

test('alias names: the shape and the prototype-member refusal', () => {
  for (const n of ['work', 'a', 'w-1_x', 'a'.repeat(32)]) assert.equal(isAliasName(n), true, n);
  for (const n of ['', 'Work', '1work', '-w', 'a'.repeat(33), 'w k', 'constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf', 5, null, undefined]) assert.equal(isAliasName(n), false, String(n));
  assert.equal(ALIAS_RE.source, '^[a-z][a-z0-9_-]{0,31}$');
});

test('the result maps are null-prototype and invalid JSON is one problem', () => {
  const r = parseSiteRegistry('{nope');
  assert.deepEqual(r.problems, ['jira-sites.json is not valid JSON']);
  for (const m of [r.reg, r.projects, r.aliases]) { assert.equal(Object.getPrototypeOf(m), null); assert.deepEqual(Object.keys(m), []); }
  for (const text of ['null', '[]', '5', '"x"', '{}', '{"sites":null}', '{"sites":5}']) assert.deepEqual(parse(text).problems, ['jira-sites.json needs a "sites" object'], text);
});

test('sites: host rule, credential fields, and their problems', () => {
  const r = parse({ sites: {
    'Acme.Atlassian.NET': { email_env: 'ACME_EMAIL', token_env: 'ACME_TOKEN', op_ref: 'op://v/i/f', keychain: 'svc:a@b-c.d_e' },
    'jira.corp:8443': { token_env: '_T' },
    'bad host': { token_env: 'X' }, '-bad.example': { token_env: 'X' }, 'a.example:123456': { token_env: 'X' }, 'str.example': 'x', 'null.example': null,
    'noentry.example': {}, 'weird.example': { email_env: '1bad', token_env: 'ok', op_ref: 'vault/item', keychain: 'bad service' },
  } });
  assert.deepEqual(r.reg, { 'acme.atlassian.net': { email_env: 'ACME_EMAIL', token_env: 'ACME_TOKEN', op_ref: 'op://v/i/f', keychain: 'svc:a@b-c.d_e' }, 'jira.corp:8443': { token_env: '_T' }, 'weird.example': { token_env: 'ok' } });
  assert.deepEqual(r.problems, [
    'site bad host: bad host or entry', 'site -bad.example: bad host or entry', 'site a.example:123456: bad host or entry', 'site str.example: bad host or entry', 'site null.example: bad host or entry',
    'site noentry.example: no credential source',
    'site weird.example: email_env is not an env var name', 'site weird.example: op_ref must look like op://vault/item/field', 'site weird.example: keychain is not a service name',
  ]);
  const names = parse({ sites: { 'a.example': { email_env: 'A'.repeat(64), token_env: 'A'.repeat(65) } } });
  assert.deepEqual(names.reg, { 'a.example': { email_env: 'A'.repeat(64) } }); assert.deepEqual(names.problems, ['site a.example: token_env is not an env var name']);
  const svc = parse({ sites: { 'a.example': { keychain: 'k'.repeat(100) }, 'b.example': { keychain: 'k'.repeat(101) }, 'c.example': { keychain: '' }, 'd.example': { token_env: 5 }, 'e.example': { op_ref: 'op://' }, 'f.example': { op_ref: 7 } } });
  assert.deepEqual(Object.keys(svc.reg), ['a.example']);
  assert.deepEqual(svc.problems, ['site b.example: keychain is not a service name', 'site b.example: no credential source', 'site c.example: keychain is not a service name', 'site c.example: no credential source', 'site d.example: token_env is not an env var name', 'site d.example: no credential source', 'site e.example: op_ref must look like op://vault/item/field', 'site e.example: no credential source', 'site f.example: op_ref must look like op://vault/item/field', 'site f.example: no credential source']);
  assert.deepEqual(parse({ sites: { 'x.example': { op_ref: 'op://a b' } } }).problems, ['site x.example: op_ref must look like op://vault/item/field', 'site x.example: no credential source']);
  assert.deepEqual(Object.keys(parse({ sites: { [`a${'b'.repeat(120)}c`]: { token_env: 'X' }, [`a${'b'.repeat(121)}c`]: { token_env: 'X' } } }).reg), [`a${'b'.repeat(120)}c`]);
  assert.deepEqual(Object.keys(parse({ sites: { 'a:1': { token_env: 'X' }, 'a:12345': { token_env: 'X' }, 'a:': { token_env: 'X' } } }).reg), ['a:1', 'a:12345']);
});

test('projects: absolute roots, known fields only, length cap, trailing slashes dropped', () => {
  const r = parse({ sites: {}, projects: {
    '/work/repo/': { base_url: 'https://a.example', cloud_id: 'c', jql: 'project = X', sprint_field: 'customfield_1', auth: { mode: 'site-token' }, extra: 'dropped' },
    '/w/two//': { auth: { mode: 'datacenter' } }, 'relative/path': { jql: 'x' }, '/nul\u0000': { jql: 'x' }, '/str': 'x', '/null': null, '/empty': {}, '/badauth': { auth: { mode: 'bogus' }, jql: '' },
    '/long': { jql: 'j'.repeat(2000), base_url: 'b'.repeat(2001) }, '/auth-str': { auth: 'scoped' },
  } });
  assert.deepEqual(r.projects, {
    '/work/repo': { base_url: 'https://a.example', cloud_id: 'c', jql: 'project = X', sprint_field: 'customfield_1', auth: { mode: 'site-token' } },
    '/w/two': { auth: { mode: 'datacenter' } }, '/long': { jql: 'j'.repeat(2000) },
  });
  assert.deepEqual(r.problems, [
    'project relative/path: needs an absolute path and an object', 'project /nul: needs an absolute path and an object', 'project /str: needs an absolute path and an object', 'project /null: needs an absolute path and an object',
    'project /empty: no usable field', 'project /badauth: no usable field', 'project /auth-str: no usable field',
  ]);
  assert.deepEqual(r.reg, {});
});

test('projects or aliases alone make the registry valid without a sites object', () => {
  assert.deepEqual(parse({ projects: { '/r': { jql: 'x' } } }).problems, []);
  assert.deepEqual(parse({ aliases: { work: { cloud_id: 'c' } } }).problems, []);
  assert.deepEqual(parse({ projects: { '/r': 5 } }).problems, ['project /r: needs an absolute path and an object', 'jira-sites.json needs a "sites" object']);
});

test('aliases: name rule, tenant fields, credentials, repos, and the first bad field kept as `invalid`', () => {
  const r = parse({ sites: {}, aliases: {
    work: { cloud_id: 'c1', base_url: 'https://w.example', auth: { mode: 'scoped' }, jql: 'q', credentials: { token_env: 'W_TOKEN', email_env: 'W_EMAIL' }, repos: [H64, H64, 'b'.repeat(64)] },
    Bad: { cloud_id: 'x' }, constructor: { cloud_id: 'x' }, str: 'x', arr: [], nul: null, empty: {},
    badcred: { cloud_id: 'c', credentials: { token_env: '1bad', keychain: 'ok svc' } },
    credstr: { cloud_id: 'c', credentials: 'x' }, credarr: { cloud_id: 'c', credentials: [] }, credempty: { cloud_id: 'c', credentials: {} },
    credonlybad: { credentials: { op_ref: 'nope' } },
    repostr: { cloud_id: 'c', repos: 'x' }, repomix: { cloud_id: 'c', repos: [H64, 'zz', 5, 'A'.repeat(64)] }, repobad: { repos: ['zz'] },
  } });
  assert.deepEqual(r.aliases.work, { cloud_id: 'c1', base_url: 'https://w.example', auth: { mode: 'scoped' }, jql: 'q', credentials: { token_env: 'W_TOKEN', email_env: 'W_EMAIL' }, repos: [H64, 'b'.repeat(64)] });
  assert.deepEqual(r.aliases.badcred, { cloud_id: 'c', invalid: 'credentials.token_env is not an env var name' });
  assert.deepEqual(r.aliases.credstr, { cloud_id: 'c', invalid: 'credentials must be an object' });
  assert.deepEqual(r.aliases.credarr, { cloud_id: 'c', invalid: 'credentials must be an object' });
  assert.deepEqual(r.aliases.credempty, { cloud_id: 'c' });
  assert.deepEqual(r.aliases.credonlybad, { invalid: 'credentials.op_ref must look like op://vault/item/field' });
  assert.deepEqual(r.aliases.repostr, { cloud_id: 'c' });
  assert.deepEqual(r.aliases.repomix, { cloud_id: 'c', repos: [H64] });
  assert.equal('repobad' in r.aliases, false); assert.equal('empty' in r.aliases, false);
  assert.deepEqual(Object.keys(r.aliases).sort(), ['badcred', 'credempty', 'credonlybad', 'credarr', 'credstr', 'repomix', 'repostr', 'work'].sort());
  assert.deepEqual(r.problems, [
    `alias Bad: the name must match ALIAS_RE ${ALIAS_RE.source}`, `alias constructor: the name must match ALIAS_RE ${ALIAS_RE.source}`,
    'alias str: needs an object', 'alias arr: needs an object', 'alias nul: needs an object', 'alias empty: no usable field',
    'alias badcred: credentials.token_env is not an env var name', 'alias badcred: credentials.keychain is not a service name',
    'alias credstr: credentials must be an object', 'alias credarr: credentials must be an object', 'alias credempty: credentials has no credential source',
    'alias credonlybad: credentials.op_ref must look like op://vault/item/field',
    'alias repostr: repos holds only SHA-256 hex strings (dropped the others)', 'alias repomix: repos holds only SHA-256 hex strings (dropped the others)', 'alias repobad: repos holds only SHA-256 hex strings (dropped the others)', 'alias repobad: no usable field',
  ]);
  const cap = parse({ sites: {}, aliases: { many: { repos: Array.from({ length: 300 }, (_, i) => i.toString(16).padStart(64, '0')) } } });
  assert.equal(cap.aliases.many?.repos?.length, 256);
  assert.deepEqual(cap.problems, ['alias many: repos holds only SHA-256 hex strings (dropped the others)']);
  assert.deepEqual(parse({ sites: {}, aliases: [] }).aliases, {});
  assert.deepEqual(parse({ sites: {}, aliases: 'x' }).problems, []);
});

test('the name of a bad alias or project is cut to one short line', () => {
  const long = 'x'.repeat(100);
  assert.deepEqual(parse({ sites: {}, aliases: { [long.toUpperCase()]: { cloud_id: 'c' } } }).problems, [`alias ${'X'.repeat(40)}…[+60 chars]: the name must match ALIAS_RE ${ALIAS_RE.source}`]);
});
