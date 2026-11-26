// Decision D8: at a release version (no prerelease tag) KNOWN_ISSUES.md lists nothing after its preamble. Between releases (a -dev version) an entry may stay,
// so recording a newly found issue never turns CI red, but no release ships with one. An owner-accepted limit moves to SECURITY.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/** The headings of KNOWN_ISSUES.md below its preamble (every section is a `## ` heading and every entry a `### ` heading). */
export const entries = (text: string): string[] => text.split('\n').filter((l) => /^#{2,3} /.test(l));
/** True when the version carries a prerelease tag such as 0.3.0-dev. */
export const isPrerelease = (v: string): boolean => /^\d+\.\d+\.\d+-/.test(v);

test('a release version has no known issue left', () => {
  const v = JSON.parse(read('package.json')).version as string;
  if (isPrerelease(v)) return; // the check binds at the release version
  assert.deepEqual(entries(read('KNOWN_ISSUES.md')), [], `KNOWN_ISSUES.md must list nothing at release version ${v}`);
});

test('the check itself: entries are found below the preamble, a release version is not a prerelease', () => {
  const text = '# Known issues\n\npreamble\n\n## Open\n\n### something\n';
  assert.deepEqual(entries(text), ['## Open', '### something']);
  assert.equal(isPrerelease('0.3.0'), false);
  assert.equal(isPrerelease('0.3.0-dev'), true);
  assert.deepEqual(entries('# Known issues\n\npreamble only\n'), []);
});
