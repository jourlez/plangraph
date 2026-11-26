// Freezes the public surface of lib/jira.ts: the value exports (runtime keys) and the type exports. A split of the module, or any later
// edit, that drops, renames or adds an export fails here, not only in a later tsc run. Both lists were copied once from the module itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

const FROZEN_VALUES = [
  'AUTH_MODES', 'JiraError', 'KEY_RE', 'adfToText', 'dcHostsFromEnv', 'fetchChangelog', 'fetchIssueText', 'getCredentials', 'getCredentialsFor',
  'importIssues', 'isAuthMode', 'makeClient', 'normalizeIssue', 'parseDcHosts', 'parseJiraTime', 'parseSiteRegistry', 'parseSnapshotJsonl',
  'pullSnapshot', 'redact', 'renderIssue', 'siteHostsFromEnv', 'siteTag', 'snapshotToJsonl', 'toLegacyMap', 'validateBase',
];

const FROZEN_TYPES = [
  'AuthMode', 'ChangelogClient', 'ChangelogEntry', 'ClientOptions', 'CredentialOptions', 'Exec', 'FetchLike', 'ImportResult', 'IssueTextClient',
  'JiraClient', 'JiraCredentials', 'JiraErrorCode', 'JiraIssue', 'JiraSprint', 'LegacyIssue', 'ParsedRegistry', 'ProjectEntry', 'PullOptions',
  'PullResult', 'RawAdf', 'RawImport', 'RawIssue', 'SearchPage', 'SearchQuery', 'SiteEntry', 'Snapshot', 'SnapshotClient', 'ValidateOptions',
  'ValidatedBase',
];

/** The type names a module exports through `export type` and `export interface` declarations. */
const declaredTypes = (text: string): string[] => [...text.matchAll(/^export (?:type|interface) ([A-Za-z]+)/gm)].map((m) => m[1] as string);

test('the module exports exactly the frozen list', async () => {
  const keys = Object.keys(await import('../lib/jira.ts')).sort();
  assert.deepEqual(keys, FROZEN_VALUES);
});

test('the module exports exactly the frozen type list', () => {
  assert.ok(FROZEN_TYPES.length >= 29);
  const names = declaredTypes(fs.readFileSync(path.join(ROOT, 'lib/jira.ts'), 'utf8')).sort();
  assert.deepEqual(names, FROZEN_TYPES);
});
