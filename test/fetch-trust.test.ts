// lib/fetch/trust.ts: the local list of fetch targets the user trusts, stored outside the work tree, mode 0600.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { trust, isTrusted, trustLine, trustFile } from '../lib/fetch/trust.ts';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'pg-trust-'));
const envOf = (): { XDG_CONFIG_HOME: string } => ({ XDG_CONFIG_HOME: tmp() });

test('nothing is trusted until trust() records it; the file is 0600 and sorted without duplicates', () => {
  const d = tmp(), e = envOf();
  assert.equal(isTrusted(d, 'jira:ABC', e), false);
  trust(d, 'jira:ABC', e); trust(d, 'github:example/widgets', e); trust(d, 'jira:ABC', e);
  const f = trustFile(d, e);
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { root: fs.realpathSync(d), targets: ['github:example/widgets', 'jira:ABC'] });
  assert.equal(isTrusted(d, 'jira:ABC', e), true);
  assert.equal(isTrusted(d, 'jira:ABD', e), false);
  assert.equal(isTrusted(d, 'jira:abc', e), false, 'exact match only');
});

test('a malformed target is refused and never matches', () => {
  const d = tmp(), e = envOf();
  for (const t of ['', 'jira', 'https://example.invalid/x', 'jira:a\nb', 'jira:../x', 'jira: ', 'x'.repeat(300)]) {
    assert.throws(() => trust(d, t, e), /target/, t);
    assert.equal(isTrusted(d, t, e), false);
  }
});

test('a corrupt or hostile file trusts nothing and does not throw', () => {
  const d = tmp(), e = envOf(), f = trustFile(d, e);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  for (const body of ['{nope', '[]', '{"targets":"jira:ABC"}', '{"targets":[5,"jira:ABC"]}', '{"__proto__":{"targets":["jira:ABC"]}}']) {
    fs.writeFileSync(f, body);
    assert.equal(isTrusted(d, 'jira:ABC', e), false, body);
  }
  trust(d, 'jira:ZED', e);
  assert.equal(isTrusted(d, 'jira:ZED', e), true);
});

test('trustLine prints the exact command the user must run', () => {
  assert.equal(trustLine('jira:ABC'), 'plangraph trust jira:ABC');
});
