// lib/fetch/trust.ts: the local list of fetch targets the user trusts, cache/trusted.json mode 0600.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { trust, isTrusted, trustLine } from '../lib/fetch/trust.ts';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'pg-trust-'));

test('nothing is trusted until trust() records it; the file is 0600 and sorted without duplicates', () => {
  const d = tmp();
  assert.equal(isTrusted(d, 'jira:ABC'), false);
  trust(d, 'jira:ABC'); trust(d, 'github:example/widgets'); trust(d, 'jira:ABC');
  const f = path.join(d, 'cache', 'trusted.json');
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { targets: ['github:example/widgets', 'jira:ABC'] });
  assert.equal(isTrusted(d, 'jira:ABC'), true);
  assert.equal(isTrusted(d, 'jira:ABD'), false);
  assert.equal(isTrusted(d, 'jira:abc'), false, 'exact match only');
});

test('a malformed target is refused and never matches', () => {
  const d = tmp();
  for (const t of ['', 'jira', 'https://example.invalid/x', 'jira:a\nb', 'jira:../x', 'jira: ', 'x'.repeat(300)]) {
    assert.throws(() => trust(d, t), /target/, t);
    assert.equal(isTrusted(d, t), false);
  }
});

test('a corrupt or hostile file trusts nothing and does not throw', () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, 'cache'));
  const f = path.join(d, 'cache', 'trusted.json');
  for (const body of ['{nope', '[]', '{"targets":"jira:ABC"}', '{"targets":[5,"jira:ABC"]}', '{"__proto__":{"targets":["jira:ABC"]}}']) {
    fs.writeFileSync(f, body);
    assert.equal(isTrusted(d, 'jira:ABC'), false, body);
  }
  trust(d, 'jira:ZED');
  assert.equal(isTrusted(d, 'jira:ZED'), true);
});

test('trustLine prints the exact command the user must run', () => {
  assert.equal(trustLine('jira:ABC'), 'plangraph trust jira:ABC');
});
