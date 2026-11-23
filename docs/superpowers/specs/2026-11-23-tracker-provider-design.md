# Tracker provider and tenant alias: design

Date: 2026-11-23. Status: approved in conversation; executes after the TypeScript migration (`2026-11-23-typescript-migration-design.md`) is released, so every file named here is already `.ts`.
Plan: `docs/superpowers/plans/2026-11-23-tracker-provider.md`.

## 1. Purpose

Two problems remain in the Jira part of the plugin after 0.1.2:

1. **Structure.** `lib/jira` is one 572-line module that mixes host validation, secret redaction, credential resolution, the HTTP client, snapshot normalization and text rendering. Commands call it directly, so a second tracker (or a test double) has no seam to plug into.
2. **Public repositories.** A committed `config.json` can still name a company's Jira site. The user-level `projects` entry (0.1.2) keeps it out, but it is keyed by an absolute path, which is not portable between machines or clones.

This design fixes both without changing any command's output for existing configurations.

## 2. Non-goals

- No second tracker implementation. The interface is sized from what Jira needs today (YAGNI); a second provider is a later, separate spec.
- No Jira writes. `brain` stays read-only; writes through the Atlassian connector remain the owner's explicit call.
- No change to credential security rules: a site named only in a committed config never receives the generic credentials.

## 3. Module split

`lib/jira.ts` becomes a directory of modules with one responsibility each. `lib/jira/index.ts` re-exports the exact export list of today's `lib/jira.ts`, so no importer changes and a test freezes the list.

| Module | Responsibility | Moves from `lib/jira` |
|---|---|---|
| `lib/jira/redact.ts` | secret registry and `redact` | `registerSecret`, `redact`, `secrets` |
| `lib/jira/host.ts` | host validation and allowlists | `validateBase`, `parseDcHosts`, `siteHostsFromEnv`, `dcHostsFromEnv` |
| `lib/jira/credentials.ts` | credential resolution | `getCredentials`, `getCredentialsFor`, `siteTag`, `defaultExec`, `finishCreds` |
| `lib/jira/registry.ts` | user-level registry parsing | `parseSiteRegistry` |
| `lib/jira/client.ts` | HTTP client, retries, rate limits, read-only allowlist | `makeClient`, `JiraError` |
| `lib/jira/snapshot.ts` | normalization, pull, import, JSONL | `normalizeIssue`, `pullSnapshot`, `importIssues`, `summarize`, `snapshotToJsonl`, `parseSnapshotJsonl`, `toLegacyMap`, `parseJiraTime` |
| `lib/jira/render.ts` | issue text rendering | `adfToText`, `renderIssue`, `fetchIssueText`, `fetchChangelog` |

The import graph is acyclic: `redact` and `host` are leaves; `credentials`, `registry` and `client` import them; `snapshot` and `render` import `client`.

## 4. Tracker provider interface

```ts
export interface TrackerProvider {
  readonly kind: string;                       // 'jira'
  tenantId(settings: TrackerSettings): string; // site host, cloud id or ''
  credentials(tenant: string, trust: Trust): Promise<Credentials>;
  pull(opts: PullOptions): Promise<SnapshotResult>;
  importIssues(previous: Snapshot | null, input: unknown): Snapshot;
  renderIssue(key: string, opts?: RenderOptions): Promise<string>;
}
```

- `JiraProvider` implements it with the modules of section 3.
- `Ctx` gains `tracker(): TrackerProvider`, built by `createTracker(ctx)` from the effective settings; commands call `ctx.tracker()` and never import the Jira modules. Tests inject a fake provider through the existing context factory (inversion of control: the command depends on the interface, not on the network).
- `Trust` carries the decision `resolveTenant` already makes (`allowGeneric`, `pinned`, `userTenant`), so the security rule has exactly one home.
- `kind` comes from `config.json` `tracker.kind` (default `'jira'`), looked up in a frozen map; an unknown kind is a data error (exit 2) naming the known ones.

## 5. Tenant alias

A committed `config.json` may say only `{"jira": {"tenant": "<alias>"}}`, or nothing. The user-level `jira-sites.json` gains an `aliases` object:

`{"aliases": {"work": {"auth": {"mode": "site-token"}, "base_url": "https://acme.atlassian.net", "jql": "project = ABC", "credentials": {"token_env": "WORK_JIRA_TOKEN", "email_env": "WORK_JIRA_EMAIL"}}}}`

Resolution order for the effective settings: the `projects` entry for the repository path (0.1.2, unchanged), then the alias named in the committed config, then the committed fields. A site that comes from an alias or a `projects` entry is the user's own choice and is trusted; a site that comes only from committed fields is not (unchanged rule). An alias that does not exist on this machine is not an error for commands that need no Jira; for Jira commands it is exit 3 (environment missing) with one line naming the alias and the file to edit.

The alias is a neutral label, so a public repository can say `"tenant": "work"` and leak nothing; each person maps it on their machine.

## 6. Observability

`brain doctor` adds the alias to its `jira:` line (`tenant <host> (alias work)`), keeps the connector check line, and reports an unresolved alias as a warning. Nothing else in the output changes.

## 7. Safety net

Same differential baseline as the migration (CLI matrix, hook, merge driver, MCP session, library probes), plus new probes for the provider seam and alias resolution. A frozen-exports test guards the re-export list. The full suite and the coverage floors stay green per task. Existing `config.json` files that name a site keep working exactly as in 0.1.2.

## 8. Risks

| Risk | Mitigation |
|---|---|
| The split drops or renames an export | Frozen-exports test written before the move |
| The interface is too wide or too narrow | Derived from the call sites in `src/commands`; every member has a command that uses it |
| An alias resolves differently on two machines | Documented; `brain doctor` prints the resolved host and where it came from |
| The trust rule is bypassed through the new path | `Trust` is produced only by `resolveTenant`; a test asserts an alias-less committed site never gets generic credentials |
