// lib/identity.ts: proposals from observed refs, resolve, and the 0600 cache/identities.json read and write confined to the plan directory.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { proposeIdentities, resolve, readIdentityMap, writeIdentityMap, emptyIdentityMap } from '../lib/identity.ts';

const tmps: string[] = [];
after(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-identity-'))); tmps.push(d); return d; };
const ppl = (...ids: string[]) => ids.map((id) => ({ id }));

test('a display that is a person id is exact; a full name with a matching first name is fuzzy', () => {
  assert.deepEqual(proposeIdentities([{ ref: 'jira:a:ana', display: 'ana' }], ppl('ana', 'ben')), [{ ref: 'jira:a:ana', person: 'ana', conf: 'exact', why: 'id' }]);
  assert.deepEqual(proposeIdentities([{ ref: 'r1', display: 'Ana Lopez' }], ppl('ana', 'ben')), [{ ref: 'r1', person: 'ana', conf: 'fuzzy', why: 'first name' }]);
});
test('two matching people give no proposal; no match gives none', () => {
  assert.deepEqual(proposeIdentities([{ ref: 'r1', display: 'Ana Lopez' }], [{ id: 'ana' }, { id: 'Ana' }]), []);
  assert.deepEqual(proposeIdentities([{ ref: 'r1', display: 'Zed' }], ppl('ana')), []);
});
test('proposals are sorted by ref and never read an email', () => {
  const out = proposeIdentities([{ ref: 'b', display: 'Ben' }, { ref: 'a', display: 'ana' }], [{ id: 'ana', email: 'x@example.invalid' } as never, { id: 'ben' }]);
  assert.deepEqual(out.map((p) => p.ref), ['a', 'b']);
  assert.deepEqual(proposeIdentities([{ ref: 'e', display: 'x@example.invalid' }], [{ id: 'ana', email: 'x@example.invalid' } as never]), []);
});
test('resolve returns the mapped person or null, never a prototype member', () => {
  const m = { version: 1 as const, byRef: { r1: 'ana' } };
  assert.equal(resolve(m, 'r1'), 'ana');
  assert.equal(resolve(m, 'r2'), null);
  assert.equal(resolve(m, 'constructor'), null);
  assert.equal(resolve(m, '__proto__'), null);
});
test('write makes cache/identities.json mode 0600 with sorted keys; read returns it; missing file is empty', () => {
  const d = tmp();
  assert.deepEqual(readIdentityMap(d), emptyIdentityMap());
  writeIdentityMap(d, { version: 1, byRef: { b: 'ben', a: 'ana' } });
  const f = path.join(d, 'cache/identities.json');
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(f, 'utf8')).byRef), ['a', 'b']);
  assert.deepEqual(readIdentityMap(d).byRef, { a: 'ana', b: 'ben' });
});
test('a path outside the plan directory is refused for read and write', () => {
  const d = tmp(), other = tmp();
  assert.throws(() => writeIdentityMap(d, emptyIdentityMap(), path.join(other, 'identities.json')), /outside/);
  assert.throws(() => readIdentityMap(d, path.join(other, 'identities.json')), /outside/);
});
test('a bad file is a data error, not a crash', () => {
  const d = tmp(); fs.mkdirSync(path.join(d, 'cache'));
  fs.writeFileSync(path.join(d, 'cache/identities.json'), '{not json');
  assert.throws(() => readIdentityMap(d), /identities\.json/);
  fs.writeFileSync(path.join(d, 'cache/identities.json'), '{"version":2,"byRef":{}}');
  assert.throws(() => readIdentityMap(d), /identities\.json/);
});
