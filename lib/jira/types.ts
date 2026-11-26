// lib/jira/types.ts: the types of the Jira reader, the auth modes and the issue key pattern. A leaf: it imports no other lib/jira module.

// ---------------------------------------------------------------- types
// Untrusted JSON (a Jira answer, a connector export, the registry file) is read through the Raw* interfaces below. They describe the shape
// the code EXPECTS; nothing in them has been checked yet: every read tests the value at run time (typeof, Array.isArray, KEY_RE, ...)
// before trusting it, exactly as the JavaScript did. Every Raw* field is optional and most leaves are `unknown`, so a Raw* type is the
// structured form of `unknown`: any parsed JSON object (or null) is accepted, and nothing in it can be used without a test. A few leaves
// carry the expected type (RawProjectEntry, RawSiteEntry) because the code tests them by a loop key, which TypeScript cannot narrow.

/** How a project authenticates: a scoped token through the api.atlassian.com gateway, an unscoped site token, or a Data Center PAT. */
export type AuthMode = 'scoped' | 'site-token' | 'datacenter';
export const AUTH_MODES: { readonly SCOPED: 'scoped'; readonly SITE_TOKEN: 'site-token'; readonly DATACENTER: 'datacenter' } = Object.freeze({ SCOPED: 'scoped', SITE_TOKEN: 'site-token', DATACENTER: 'datacenter' });
const AUTH_MODE_LIST: readonly AuthMode[] = Object.freeze([AUTH_MODES.SCOPED, AUTH_MODES.SITE_TOKEN, AUTH_MODES.DATACENTER]);
/** Narrowing function for an auth mode read from untrusted config. */
export const isAuthMode = (x: unknown): x is AuthMode => (AUTH_MODE_LIST as readonly unknown[]).includes(x); // widened only so includes() accepts any value

/** Every code a JiraError carries (`pullSnapshot` reports 'internal' for anything else that was thrown). */
export type JiraErrorCode =
  | 'anonymous' | 'auth' | 'bad_config' | 'bad_credentials' | 'bad_fields' | 'bad_host' | 'bad_input' | 'bad_jql' | 'bad_json' | 'bad_key'
  | 'bad_request' | 'bad_snapshot' | 'forbidden' | 'http' | 'network' | 'no_credentials' | 'not_found' | 'pagination_loop' | 'pagination_stalled'
  | 'quota' | 'rate_limit_wait' | 'rate_limited' | 'read_only' | 'redirect' | 'too_large' | 'too_many_pages' | 'unbounded_jql' | 'unsupported';

/** The result of credential resolution. `token` is a non-enumerable property at run time (kept out of JSON.stringify and inspect). */
export interface JiraCredentials { readonly email: string; source: string; readonly token: string }
/** A command that runs a credential helper (1Password `op`, `security`, `secret-tool`) and resolves with its stdout. */
export type Exec = (file: string, args: string[]) => Promise<string>;
/** One host in the user-level registry (~/.config/plangraph/jira-sites.json): NAMES of credential sources, never a secret. */
export interface SiteEntry { email_env?: string; token_env?: string; op_ref?: string; keychain?: string }
/** One repository root in the registry's `projects` map: the tenant settings kept out of the repository. */
export interface ProjectEntry { auth?: { mode: AuthMode }; base_url?: string; cloud_id?: string; jql?: string; sprint_field?: string }
export interface ParsedRegistry { reg: Record<string, SiteEntry>; projects: Record<string, ProjectEntry>; problems: string[] }
/** Overrides of the variable names and helper references getCredentials reads (getCredentialsFor binds them to one host). */
interface CredentialNames { emailVar?: string; tokenVar?: string; opVar?: string; opRef?: string | undefined; service?: string }
export interface CredentialOptions { env?: Record<string, string | undefined>; exec?: Exec; platform?: string; names?: CredentialNames }

export interface ValidateOptions { mode?: AuthMode; dcHosts?: unknown; siteHosts?: unknown; allowInsecureLocalhostForTests?: boolean }
export interface ValidatedBase { origin: string; host: string; kind: 'loopback' | 'datacenter' | 'gateway' | 'site'; basePath: string }

/** A Jira answer before any check (one interface for every allowlisted endpoint: each caller reads its own fields and tests them). */
export interface RawAnswer {
  accountId?: unknown; name?: unknown; key?: unknown; active?: unknown; timeZone?: unknown; errorMessages?: unknown;
  issues?: unknown; total?: unknown; nextPageToken?: unknown; isLast?: unknown; count?: unknown; values?: unknown;
}
/** What `request` resolves with: parsed JSON of an allowlisted endpoint, unchecked (see the note at the top of this section). */
export type JiraAnswer = RawAnswer;
export interface RequestOptions { query?: Record<string, string>; body?: unknown }
/** cursor: null or absent on the first page; a Cloud page token (string) or a Data Center offset (number) after that. */
export interface SearchQuery { jql: string; fields: string[]; pageSize: number; cursor?: string | number | null | undefined }
export interface SearchPage { issues: RawIssue[]; cursor?: string | number | null | undefined; last: boolean }
interface Identity { cloud_id?: string; host?: string }

/** The one fetch call makeClient makes: an absolute URL and an init object. globalThis.fetch fits; so does a test double. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
export interface ClientOptions {
  /** the committed config.jira, untrusted; a `dcHosts` in it is ignored on purpose (the Data Center allowlist is user-level only) */
  baseConfig?: { auth?: { mode?: unknown } | undefined; mode?: unknown; baseUrl?: unknown; cloudId?: unknown; dcHosts?: unknown };
  creds?: { email?: string; token?: string; source?: string } | undefined;
  fetchImpl?: FetchLike; sleep?: (ms: number) => Promise<unknown>; now?: () => number | Date; random?: () => number; log?: (s: string) => void;
  dcHosts?: string | string[]; siteHosts?: string | string[]; allowInsecureLocalhostForTests?: boolean;
  maxRetries?: number; backoffMs?: number; maxSleepSeconds?: number; timeoutMs?: number; maxBodyBytes?: number;
}
/** The frozen read-only client makeClient returns. */
export interface JiraClient {
  readonly mode: AuthMode;
  request(method: string, path: string, opts?: RequestOptions): Promise<JiraAnswer>;
  verify(): Promise<{ timeZone: string }>;
  search(q: SearchQuery): Promise<SearchPage>;
  count(jql: string): Promise<number | null>;
  issue(key: string, fields: string[]): Promise<JiraAnswer & RawIssue>;
  changelog(key: string, opts?: { maxPages?: number }): Promise<unknown[]>;
  now(): Date;
  readonly identity: Readonly<Identity>;
}
/** The part of a client pullSnapshot uses (tests pass a scripted stand-in). */
export interface SnapshotClient {
  readonly mode: string; readonly identity: Readonly<Record<string, unknown>>; now(): Date;
  verify(): Promise<{ timeZone?: string }>; search(q: SearchQuery): Promise<SearchPage>; count(jql: string): Promise<number | null>;
}
/** The parts of a client fetchIssueText and fetchChangelog use (the result of verify is not read). */
export interface IssueTextClient { verify(): Promise<unknown>; issue(key: string, fields: string[]): Promise<RawIssue | null> }
export interface ChangelogClient { verify(): Promise<unknown>; changelog(key: string): Promise<unknown[]> }

export interface JiraLink { key: string; type: string; dir: 'in' | 'out'; rel: string }
export interface JiraSprint { id: number; name: string; state: string }
/** One issue as the snapshot stores it (normalizeIssue's output). */
export interface JiraIssue {
  key: string; summary: string; status: string; assignee: string; updated: string; resolutiondate: string; issuelinks: JiraLink[]; sprint?: JiraSprint[];
}
/** Line 1 of a snapshot. A pull writes the jql..delta_runs fields, an import the source/imported_at ones; a parsed file may hold either. */
export interface SnapshotMeta {
  jql?: string; fetched_at?: string; mode?: string; cloud_id?: string; host?: string; expected_count?: number | null; received_count?: number;
  count_drift?: number | null; complete?: boolean; content_hash?: string; pull?: string; delta_runs?: number; source?: string; imported_at?: string;
  [extra: string]: unknown;
}
export interface Snapshot { schema: number; meta: SnapshotMeta; issues: JiraIssue[] }
export interface PullOptions {
  jql?: unknown; previous?: Snapshot | null; full?: boolean; overlapMinutes?: number; fullReconcileEvery?: number; pageSize?: number; maxPages?: number;
  sprintField?: string; driftAbs?: number; driftPct?: number; since?: string | number | Date; fields?: unknown;
}
interface PullBase { received: number; warnings: string[]; changedKeys: string[]; removedKeys: string[]; summary: string }
// `?: never` members: reading a field of the other variant without narrowing on `ok` is allowed and gives undefined, as at run time.
export interface PullSuccess extends PullBase { ok: true; complete: true; snapshot: Snapshot; mode: string; windowMinutes: number; reason: string; code?: never; error?: never; resetAt?: never }
export interface PullFailure extends PullBase { ok: false; complete: false; snapshot: null; code: JiraErrorCode | 'internal'; error: string; resetAt: string | undefined; mode?: never; windowMinutes?: never; reason?: never }
export type PullResult = PullSuccess | PullFailure;
/** A result while it is being built: `summary` is filled in last. */
export type Unsummarized<T extends PullBase> = Omit<T, 'summary'> & { summary?: string };
export interface ImportResult { snapshot: Snapshot; imported: number; dropped: number; changedKeys: string[]; summary: string }
export interface ChangelogEntry { id: string; created: string; author: string; items: Array<{ field: string; from: string; to: string }> }
export interface LegacyIssue { summary: string; status: string; assignee: string; updated: string; resolved: string; blockedBy: string[] }

/** An issue as Jira or the connector sends it (see the note at the top of this section). */
export interface RawIssue { key?: unknown; fields?: RawFields | null }
export interface RawFields {
  summary?: unknown; status?: { name?: unknown } | null; assignee?: { displayName?: unknown } | null; updated?: unknown; resolutiondate?: unknown;
  issuelinks?: unknown; customFields?: unknown; description?: RawAdf | string | null;
  comment?: { comments?: RawComment[]; total?: unknown } | null; // comments: unchecked: iterated without Array.isArray (pre-existing)
  [field: string]: unknown;
}
export interface RawComment { author?: { displayName?: unknown } | null; created?: unknown; body?: RawAdf | string | null }
export interface RawLink { type?: { name?: unknown; inward?: unknown; outward?: unknown } | null; inwardIssue?: { key?: unknown } | null; outwardIssue?: { key?: unknown } | null }
export interface RawSprint { id?: unknown; name?: unknown; state?: unknown }
export interface RawCustomField { id?: unknown; value?: unknown }
export interface RawHistory {
  id?: unknown; created?: unknown; author?: { displayName?: unknown } | null;
  items?: Array<{ field?: unknown; fromString?: unknown; toString?: unknown }>; // unchecked: iterated without Array.isArray (pre-existing)
}
export interface RawAdf { // content: an array of RawAdf or strings (contentOf checks)
  type?: unknown; text?: unknown; content?: unknown;
  attrs?: { level?: unknown; text?: unknown } | null }
/** The registry file before parseSiteRegistry checks it. */
export interface RawRegistryFile { projects?: Record<string, RawProjectEntry | null>; sites?: Record<string, RawSiteEntry | null> }
interface RawProjectEntry { base_url?: string; cloud_id?: string; jql?: string; sprint_field?: string; auth?: { mode?: unknown } | null }
interface RawSiteEntry { email_env?: string; token_env?: string; op_ref?: string; keychain?: string }


export const KEY_RE = /^[A-Z][A-Z0-9]*-\d+$/;
