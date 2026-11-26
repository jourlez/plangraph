// Behavior tests for the heal-consent helpers of lib/driver.ts, written to kill the mutants of the trust-root run (scripts/mutate/trust-roots.json):
// the git arguments they pass are proved by their effect on a real repository (common dir, config file, key, value, trailing newline).
// NOT covered: ensureStableDriver and defaultDataDir (test/mutation-kills-driver.test.ts, test/driver.test.ts).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CONSENT_KEY, gitCommonDir, localConfigValue, hasConsent, hasDeclined, recordConsent } from '../lib/driver.ts';

const made: string[] = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'drvc-'))); made.push(d); return d; };
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' });
const repo = () => { const d = tmp(); git(d, 'init', '-q'); return d; };

test('the consent key is plangraph.heal', () => { assert.equal(CONSENT_KEY, 'plangraph.heal'); });

test('gitCommonDir returns the real .git directory of a repository and null outside one', () => {
  const d = repo();
  assert.equal(gitCommonDir(d), path.join(d, '.git'));
  fs.mkdirSync(path.join(d, 'sub'));
  assert.equal(gitCommonDir(path.join(d, 'sub')), path.join(d, '.git'));
  assert.strictEqual(gitCommonDir(path.join(tmp(), 'does-not-exist')), null);
  const bare = tmp(); git(bare, 'init', '-q', '--bare');
  assert.equal(gitCommonDir(bare), bare);
});

test('localConfigValue reads the key from the config file of that directory, without its trailing newline, and null when unset', () => {
  const d = repo(), cd = path.join(d, '.git');
  assert.strictEqual(localConfigValue(cd, 'plangraph.heal'), null);
  git(d, 'config', '--local', 'plangraph.heal', '1.2.3');
  git(d, 'config', '--local', 'other.key', 'v');
  assert.strictEqual(localConfigValue(cd, 'plangraph.heal'), '1.2.3');
  assert.strictEqual(localConfigValue(cd, 'other.key'), 'v');
  assert.strictEqual(localConfigValue(cd, 'plangraph.nope'), null);
  assert.strictEqual(localConfigValue(path.join(d, 'missing'), 'plangraph.heal'), null);
});

test('hasConsent is true only for a version value and hasDeclined only for never', () => {
  const d = repo(), cd = path.join(d, '.git');
  assert.equal(hasConsent(cd), false); assert.equal(hasDeclined(cd), false);
  git(d, 'config', '--local', 'plangraph.heal', 'never');
  assert.equal(hasDeclined(cd), true); assert.equal(hasConsent(cd), false);
  git(d, 'config', '--local', 'plangraph.heal', 'Never');
  assert.equal(hasDeclined(cd), false);
  git(d, 'config', '--local', 'plangraph.heal', 'true');
  assert.equal(hasConsent(cd), false); assert.equal(hasDeclined(cd), false);
  git(d, 'config', '--local', 'plangraph.heal', '0.3.0');
  assert.equal(hasConsent(cd), true); assert.equal(hasDeclined(cd), false);
});

test('recordConsent writes the version under the key into <commonDir>/config and refuses anything but a version', () => {
  const d = repo(), cd = path.join(d, '.git');
  recordConsent(cd, '0.3.0-rc.1');
  assert.match(fs.readFileSync(path.join(cd, 'config'), 'utf8'), /\[plangraph\]\n\theal = 0\.3\.0-rc\.1\n/);
  assert.equal(git(d, 'config', '--local', 'plangraph.heal').trim(), '0.3.0-rc.1');
  const before = fs.readFileSync(path.join(cd, 'config'), 'utf8');
  for (const bad of ['', 'true', '1.2', 'never', '1.2.3\n', ' 1.2.3']) {
    assert.throws(() => recordConsent(cd, bad), (e: Error) => e instanceof TypeError && e.message === `not a version: ${JSON.stringify(bad)}`, bad);
  }
  assert.equal(fs.readFileSync(path.join(cd, 'config'), 'utf8'), before, 'a refused value writes nothing');
  const long = '9'.repeat(100);
  assert.throws(() => recordConsent(cd, long), (e: Error) => e.message === `not a version: ${JSON.stringify(long).slice(0, 40)}` && e.message.length === 'not a version: '.length + 40);
  assert.throws(() => recordConsent(cd, 5 as unknown as string), (e: Error) => e.message === 'not a version: "5"');
});
