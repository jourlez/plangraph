// lib/jira/ (public entry lib/jira.ts, which re-exports this file): the ONLY modules allowed to use the network. Read-only Jira reader (Cloud scoped token, Cloud site token, Data Center PAT).
// Safety model: committed config is UNTRUSTED (host allowlist by parsed hostname, https only, no redirects, Authorization never leaves the
// allowlisted host); every request must match a (method, path) read-only allowlist BEFORE the network is touched; secrets live in closures and are
// stripped by redact() from every message. No fs, no process.exit, no console: callers print and write.
// This file re-exports the frozen public list by name (no export *), so a helper shared between modules never becomes public.
export { AUTH_MODES, isAuthMode, KEY_RE } from './types.ts';
export type { AliasEntry, AuthMode, ChangelogClient, ChangelogEntry, ClientOptions, CredentialOptions, Exec, FetchLike, ImportResult, IssueTextClient, JiraClient, JiraCredentials, JiraErrorCode, JiraIssue, JiraSprint, LegacyIssue, ParsedRegistry, ProjectEntry, PullOptions, PullResult, RawAdf, RawIssue, SearchPage, SearchQuery, SiteEntry, Snapshot, SnapshotClient, ValidateOptions, ValidatedBase } from './types.ts';
export { redact } from './redact.ts';
export { JiraError } from './error.ts';
export { dcHostsFromEnv, parseDcHosts, siteHostsFromEnv, validateBase } from './host.ts';
export { parseSiteRegistry } from './registry.ts';
export { getCredentials, getCredentialsFor, siteTag } from './credentials.ts';
export { makeClient } from './client.ts';
export { importIssues, normalizeIssue, parseJiraTime, parseSnapshotJsonl, pullSnapshot, snapshotToJsonl, toLegacyMap } from './snapshot.ts';
export type { RawImport } from './snapshot.ts';
export { adfToText, fetchChangelog, fetchIssueText, renderIssue } from './render.ts';
