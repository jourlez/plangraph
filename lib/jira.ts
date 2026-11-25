// lib/jira.ts: the ONLY module allowed to use the network. Read-only Jira reader (Cloud scoped token, Cloud site token, Data Center PAT).
// Safety model: committed config is UNTRUSTED (host allowlist by parsed hostname, https only, no redirects, Authorization never leaves the
// allowlisted host); every request must match a (method, path) read-only allowlist BEFORE the network is touched; secrets live in closures and are
// stripped by redact() from every message. No fs, no process.exit, no console: callers print and write.
import crypto from 'node:crypto';
import { sanitizeText, oneLine, fence, neutralizeTags } from './sanitize.ts';
import { parseJsonl } from './jsonl.ts';
import type { JsonlRecord } from './jsonl.ts';
import { execFile } from 'node:child_process';

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
interface RawAnswer {
  accountId?: unknown; name?: unknown; key?: unknown; active?: unknown; timeZone?: unknown; errorMessages?: unknown;
  issues?: unknown; total?: unknown; nextPageToken?: unknown; isLast?: unknown; count?: unknown; values?: unknown;
}
/** What `request` resolves with: parsed JSON of an allowlisted endpoint, unchecked (see the note at the top of this section). */
type JiraAnswer = RawAnswer;
interface RequestOptions { query?: Record<string, string>; body?: unknown }
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

interface JiraLink { key: string; type: string; dir: 'in' | 'out'; rel: string }
export interface JiraSprint { id: number; name: string; state: string }
/** One issue as the snapshot stores it (normalizeIssue's output). */
export interface JiraIssue {
  key: string; summary: string; status: string; assignee: string; updated: string; resolutiondate: string; issuelinks: JiraLink[]; sprint?: JiraSprint[];
}
/** Line 1 of a snapshot. A pull writes the jql..delta_runs fields, an import the source/imported_at ones; a parsed file may hold either. */
interface SnapshotMeta {
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
interface PullSuccess extends PullBase { ok: true; complete: true; snapshot: Snapshot; mode: string; windowMinutes: number; reason: string; code?: never; error?: never; resetAt?: never }
interface PullFailure extends PullBase { ok: false; complete: false; snapshot: null; code: JiraErrorCode | 'internal'; error: string; resetAt: string | undefined; mode?: never; windowMinutes?: never; reason?: never }
export type PullResult = PullSuccess | PullFailure;
/** A result while it is being built: `summary` is filled in last. */
type Unsummarized<T extends PullBase> = Omit<T, 'summary'> & { summary?: string };
export interface ImportResult { snapshot: Snapshot; imported: number; dropped: number; changedKeys: string[]; summary: string }
export interface ChangelogEntry { id: string; created: string; author: string; items: Array<{ field: string; from: string; to: string }> }
export interface LegacyIssue { summary: string; status: string; assignee: string; updated: string; resolved: string; blockedBy: string[] }

/** An issue as Jira or the connector sends it (see the note at the top of this section). */
export interface RawIssue { key?: unknown; fields?: RawFields | null }
interface RawFields {
  summary?: unknown; status?: { name?: unknown } | null; assignee?: { displayName?: unknown } | null; updated?: unknown; resolutiondate?: unknown;
  issuelinks?: unknown; customFields?: unknown; description?: RawAdf | string | null;
  comment?: { comments?: RawComment[]; total?: unknown } | null; // comments: unchecked: iterated without Array.isArray (pre-existing)
  [field: string]: unknown;
}
interface RawComment { author?: { displayName?: unknown } | null; created?: unknown; body?: RawAdf | string | null }
interface RawLink { type?: { name?: unknown; inward?: unknown; outward?: unknown } | null; inwardIssue?: { key?: unknown } | null; outwardIssue?: { key?: unknown } | null }
interface RawSprint { id?: unknown; name?: unknown; state?: unknown }
interface RawCustomField { id?: unknown; value?: unknown }
interface RawHistory {
  id?: unknown; created?: unknown; author?: { displayName?: unknown } | null;
  items?: Array<{ field?: unknown; fromString?: unknown; toString?: unknown }>; // unchecked: iterated without Array.isArray (pre-existing)
}
export interface RawAdf { // content: an array of RawAdf or strings (contentOf checks)
  type?: unknown; text?: unknown; content?: unknown;
  attrs?: { level?: unknown; text?: unknown } | null }
/** The registry file before parseSiteRegistry checks it. */
interface RawRegistryFile { projects?: Record<string, RawProjectEntry | null>; sites?: Record<string, RawSiteEntry | null> }
interface RawProjectEntry { base_url?: string; cloud_id?: string; jql?: string; sprint_field?: string; auth?: { mode?: unknown } | null }
interface RawSiteEntry { email_env?: string; token_env?: string; op_ref?: string; keychain?: string }

const SCHEMA = 1;
export const KEY_RE = /^[A-Z][A-Z0-9]*-\d+$/;
const DEFAULT_FIELDS = ['summary', 'status', 'assignee', 'updated', 'resolutiondate', 'issuelinks'];

// ---------------------------------------------------------------- redaction
const secrets = new Set<string>();
// The base64 characters that depend only on the secret's bytes when it sits at byte offset k (0, 1 or 2 modulo 3) inside a longer encoded
// string: a character covers 6 bits, so the first and last ones also carry bits of the neighbours and are left out. Kept only from 12
// characters up, so a short core cannot match ordinary data.
function base64Cores(b: Buffer): string[] {
  const out: string[] = [];
  for (let k = 0; k < 3; k++) {
    const core = Buffer.concat([Buffer.alloc(k), b]).toString('base64').slice(Math.ceil((8 * k) / 6), Math.floor((8 * (k + b.length)) / 6));
    if (core.length >= 12) out.push(core, core.replace(/\+/g, '-').replace(/\//g, '_'));
  }
  return out;
}
function registerSecret(...vals: unknown[]): void {
  for (const v of vals) {
    if (typeof v !== 'string' || v.length < 6) continue;
    const b = Buffer.from(v), hex = b.toString('hex'), uri = encodeURIComponent(v);
    secrets.add(v); secrets.add(uri); secrets.add(JSON.stringify(v).slice(1, -1));
    secrets.add(b.toString('base64')); secrets.add(b.toString('base64url'));
    // the same secret in forms a proxy or a log may produce: inside a longer base64 blob at any offset, hex, lower-case or full percent-encoding
    for (const c of base64Cores(b)) secrets.add(c);
    secrets.add(hex); secrets.add(hex.toUpperCase());
    secrets.add(uri.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()));
    secrets.add(hex.replace(/../g, '%$&')); secrets.add(hex.toUpperCase().replace(/../g, '%$&'));
  }
}
export function redact(text: unknown): string {
  let s = text instanceof Error ? text.message : text == null ? '' : String(text);
  for (const sec of [...secrets].sort((a, b) => b.length - a.length)) s = s.split(sec).join('[redacted]');
  s = s.replace(/(authorization["']?\s*[:=]\s*["']?)(?:(?:basic|bearer)\s+)?[^\s"',;]+/gi, '$1[redacted]');
  s = s.replace(/\b(Basic|Bearer)\s+[A-Za-z0-9+/=._~-]{8,}/g, '$1 [redacted]');
  s = s.replace(/\bAT[A-Z]TT[A-Za-z0-9_=+/.-]{16,}/g, '[redacted]'); // Atlassian API token prefix (heuristic)
  return s;
}

export class JiraError extends Error {
  // `declare`: type-only fields (no class-field initializer at run time, so status and resetAt stay absent unless given)
  declare readonly code: JiraErrorCode;
  declare status?: number;
  declare resetAt?: string;
  constructor(code: JiraErrorCode, message: string, extra: { status?: number; resetAt?: string | undefined } = {}) {
    super(redact(message)); this.name = 'JiraError'; (this as { code: JiraErrorCode }).code = code; // the one write of the readonly code
    if (extra.status !== undefined) this.status = extra.status;
    if (extra.resetAt !== undefined) this.resetAt = extra.resetAt;
  }
}

// ---------------------------------------------------------------- host hardening
export function parseDcHosts(v: unknown): Set<string> {
  const list: unknown[] = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [];
  return new Set(list.map((x) => String(x).trim().toLowerCase()).filter((x) => /^[a-z0-9.-]+(:\d+)?$/.test(x)));
}
export const siteHostsFromEnv = (env: Record<string, string | undefined> = {}): string[] => [...parseDcHosts(env.PLANGRAPH_JIRA_SITES)];
export const dcHostsFromEnv = (env: Record<string, string | undefined> = {}): string[] => [...parseDcHosts(env.PLANGRAPH_JIRA_DC_HOSTS)];

const SITE_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.atlassian\.net$/;
export function validateBase(url: unknown, opts: ValidateOptions = {}): ValidatedBase {
  const fail: (why: string) => never = (why) => { throw new JiraError('bad_host', `base URL rejected: ${why}`); };
  if (typeof url !== 'string' || !url) fail('empty');
  if (/[^\x21-\x7e]/.test(url)) fail('whitespace, control or non-ASCII character');
  if (/[\\%]/.test(url)) fail('backslash or percent-escape');
  let u: URL; try { u = new URL(url); } catch { return fail('not an absolute URL'); }
  const loop = opts.allowInsecureLocalhostForTests === true && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.username || u.password) fail('userinfo');
  if (u.protocol !== 'https:' && !(loop && u.protocol === 'http:')) fail('https required');
  if (u.search || u.hash) fail('query or fragment');
  const host = u.hostname; let kind: ValidatedBase['kind'];
  if (loop) kind = 'loopback';
  else if (opts.mode === AUTH_MODES.DATACENTER) {
    if (!parseDcHosts(opts.dcHosts).has(u.host)) fail('host is not in the user-level Data Center allowlist (PLANGRAPH_JIRA_DC_HOSTS)');
    kind = 'datacenter';
  } else {
    if (/(^|\.)xn--/.test(host)) fail('punycode (xn--) host label'); // never rely on the URL parser: newer Node versions accept some malformed punycode that older ones rejected
    if (u.port) fail('non-default port');
    const gw = host === 'api.atlassian.com', site = SITE_RE.test(host);
    if (opts.mode === AUTH_MODES.SCOPED ? !gw : opts.mode === AUTH_MODES.SITE_TOKEN ? !site : !gw && !site) fail('host is not on the Atlassian allowlist');
    const pins = parseDcHosts(opts.siteHosts); // optional user-level pin: a committed config must not aim a site token at someone else's tenant
    if (site && pins.size && !pins.has(host)) fail('site is not in the user-level site allowlist (PLANGRAPH_JIRA_SITES)');
    kind = gw ? 'gateway' : 'site';
  }
  const dcPath = kind === 'datacenter' || (loop && opts.mode === AUTH_MODES.DATACENTER);
  if (dcPath ? !/^(?:\/[A-Za-z0-9._~-]+)*\/?$/.test(u.pathname) : u.pathname !== '/') fail('path not allowed');
  return { origin: `${u.protocol}//${u.host}`, host, kind, basePath: u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '') };
}

// ---------------------------------------------------------------- credentials
function defaultExec(file: string, args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => execFile(file, args, { timeout: 10000, maxBuffer: 65536, windowsHide: true }, (e, out) => (e ? reject(new Error('helper failed')) : resolve(String(out)))));
}
const EMAIL_RE = /^[^\s:@]+@[^\s:@]+$/, TOKEN_RE = /^[\x21-\x7e]{8,}$/;
function finishCreds(email: string, token: string, source: string): JiraCredentials {
  if (email && !EMAIL_RE.test(email)) throw new JiraError('bad_credentials', 'JIRA_EMAIL is not an email address');
  if (!TOKEN_RE.test(token || '')) throw new JiraError('bad_credentials', `token from ${source} is malformed (8+ printable characters, no spaces)`);
  registerSecret(token, email ? Buffer.from(`${email}:${token}`).toString('base64') : '');
  const c = { email: email || '', source };
  Object.defineProperty(c, 'token', { value: token, enumerable: false }); // keeps the token out of JSON.stringify / inspect
  return c as JiraCredentials; // token was defined on the line above (non-enumerable, so TypeScript cannot see it)
}
export async function getCredentials({ env = {}, exec = defaultExec, platform = process.platform, names = {} }: CredentialOptions = {}): Promise<JiraCredentials> {
  const N = { emailVar: 'JIRA_EMAIL', tokenVar: 'JIRA_API_TOKEN', opVar: 'JIRA_OP_REF', opRef: undefined as string | undefined, service: 'plangraph-jira', ...names };
  const envEmail = String(env[N.emailVar] || '').trim(), envTok = String(env[N.tokenVar] || '').trim();
  let tokenOnly: JiraCredentials | null = null;
  const take = (secret: string, source: string): JiraCredentials | null => { // secret is "token" or "email:token"
    const s = secret.trim();
    if (!s || /[\r\n]/.test(s)) throw new JiraError('bad_credentials', `${source} returned an empty or multi-line secret`);
    const i = s.indexOf(':'); const email = i > 0 ? s.slice(0, i) : envEmail, token = i > 0 ? s.slice(i + 1) : s;
    return email ? finishCreds(email, token, source) : (tokenOnly ||= finishCreds('', token, source), null);
  };
  if (envTok) { const c = envEmail ? finishCreds(envEmail, envTok, 'env') : (tokenOnly = finishCreds('', envTok, 'env'), null); if (c) return c; }
  const opRef = N.opRef ?? env[N.opVar];
  if (opRef) {
    const ref = String(opRef);
    if (!/^op:\/\/[^\s]+$/.test(ref)) throw new JiraError('bad_credentials', `${N.opRef ? 'op_ref' : N.opVar} must look like op://vault/item/field`);
    let out: string; try { out = await exec('op', ['read', ref]); } catch { throw new JiraError('no_credentials', `op read failed for ${N.opRef ? 'op_ref' : N.opVar} (is the 1Password CLI signed in?)`); }
    const c = take(String(out), 'op'); if (c) return c;
  }
  const helper: [string, string[]] | null = platform === 'darwin' ? ['security', ['find-generic-password', '-s', N.service, '-w']] : platform === 'linux' ? ['secret-tool', ['lookup', 'service', N.service]] : null;
  if (helper) { let out: string | null = null; try { out = await exec(helper[0], helper[1]); } catch { /* item not found: fall through */ } if (out != null) { const c = take(String(out), 'keychain'); if (c) return c; } }
  if (tokenOnly) return tokenOnly;
  throw new JiraError('no_credentials', 'no Jira credentials: set JIRA_EMAIL and JIRA_API_TOKEN, or JIRA_OP_REF, or store the token in the OS keychain (see docs/JIRA.md)');
}

// ---------------------------------------------------------------- tenants (several companies, several Jira sites)
// One credential set is not enough when the user works for several companies: a token for company B must never be sent to company A's
// site. Credentials are therefore BOUND to a host. Order for host H (first hit wins; a host that has a registry entry never falls back):
//   1. user-level registry entry for H (~/.config/plangraph/jira-sites.json, never committed): names of env vars, an op:// ref or a keychain service
//   2. convention: env JIRA_EMAIL__TAG + JIRA_API_TOKEN__TAG (or JIRA_OP_REF__TAG) and keychain service `plangraph-jira:H`, TAG = H without .atlassian.net, upper-case
//   3. the generic JIRA_* set, only when `allowGeneric` (src/jira-tenant.ts resolveTenant: scoped mode, the single PLANGRAPH_JIRA_DC_HOSTS host, a
//      site pinned in PLANGRAPH_JIRA_SITES, or the tenant named in the user's own projects entry)
export const siteTag = (host: string): string => String(host).replace(/\.atlassian\.net$/i, '').toUpperCase().replace(/[^A-Z0-9]/g, '_');
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/, SERVICE_RE = /^[A-Za-z0-9._:@-]{1,100}$/, HOST_RE = /^[a-z0-9](?:[a-z0-9.-]{0,120}[a-z0-9])?(?::\d{1,5})?$/;
/** Validates the user-level registry; returns a null-prototype map host -> entry, dropping anything malformed (reported in `problems`). */
export function parseSiteRegistry(text: string): ParsedRegistry {
  const reg: Record<string, SiteEntry> = Object.create(null), problems: string[] = [];
  let j: RawRegistryFile | null; try { j = JSON.parse(text); } catch { return { reg, projects: Object.create(null), problems: ['jira-sites.json is not valid JSON'] }; }
  const projects: Record<string, ProjectEntry> = Object.create(null);
  if (j && typeof j === 'object' && j.projects && typeof j.projects === 'object') {
    for (const [root, e] of Object.entries(j.projects)) {
      if (!root.startsWith('/') || root.includes('\0') || !e || typeof e !== 'object') { problems.push(`project ${oneLine(root, 60)}: needs an absolute path and an object`); continue; }
      const o: ProjectEntry = {};
      for (const k of ['base_url', 'cloud_id', 'jql', 'sprint_field'] as const) if (typeof e[k] === 'string' && e[k] && e[k].length <= 2000) o[k] = e[k];
      if (e.auth && typeof e.auth === 'object' && isAuthMode(e.auth.mode)) o.auth = { mode: e.auth.mode };
      if (Object.keys(o).length) projects[root.replace(/\/+$/, '')] = o; else problems.push(`project ${oneLine(root, 60)}: no usable field`);
    }
  }
  const sites = j && typeof j === 'object' && j.sites && typeof j.sites === 'object' ? j.sites : (Object.keys(projects).length ? {} : null);
  if (!sites) return { reg, projects, problems: ['jira-sites.json needs a "sites" object'] };
  for (const [h, e] of Object.entries(sites)) {
    const host = h.toLowerCase();
    if (!HOST_RE.test(host) || !e || typeof e !== 'object') { problems.push(`site ${oneLine(h, 60)}: bad host or entry`); continue; }
    const out: SiteEntry = {};
    for (const k of ['email_env', 'token_env'] as const) if (e[k] !== undefined) { if (typeof e[k] === 'string' && ENV_NAME_RE.test(e[k])) out[k] = e[k]; else problems.push(`site ${host}: ${k} is not an env var name`); }
    if (e.op_ref !== undefined) { if (typeof e.op_ref === 'string' && /^op:\/\/[^\s]+$/.test(e.op_ref)) out.op_ref = e.op_ref; else problems.push(`site ${host}: op_ref must look like op://vault/item/field`); }
    if (e.keychain !== undefined) { if (typeof e.keychain === 'string' && SERVICE_RE.test(e.keychain)) out.keychain = e.keychain; else problems.push(`site ${host}: keychain is not a service name`); }
    if (!Object.keys(out).length) { problems.push(`site ${host}: no credential source`); continue; }
    reg[host] = out;
  }
  return { reg, projects, problems };
}
/** Credentials for one host. `source` of the result says where they came from (never the secret). */
export async function getCredentialsFor(host: string, { env = {}, exec = defaultExec, platform = process.platform, registry = {}, allowGeneric = false }: { env?: Record<string, string | undefined>; exec?: Exec; platform?: string; registry?: Record<string, SiteEntry>; allowGeneric?: boolean } = {}): Promise<JiraCredentials> {
  const h = String(host).toLowerCase(), e = Object.hasOwn(registry, h) ? registry[h] : null;
  const labelled = (c: JiraCredentials, how: string): JiraCredentials => { c.source = `${how}:${c.source}`; return c; };
  if (e) {
    try { return labelled(await getCredentials({ env, exec, platform, names: { emailVar: e.email_env || 'JIRA_EMAIL', tokenVar: e.token_env || '', opVar: '', opRef: e.op_ref, service: e.keychain || `plangraph-jira:${h}` } }), `registry ${h}`); }
    catch (x) { if (x instanceof JiraError && x.code === 'no_credentials') throw new JiraError('no_credentials', `registry entry for ${h} found no credentials (check the env var, op ref or keychain item it names)`); throw x; }
  }
  const tag = siteTag(h);
  try { return labelled(await getCredentials({ env, exec, platform, names: { emailVar: `JIRA_EMAIL__${tag}`, tokenVar: `JIRA_API_TOKEN__${tag}`, opVar: `JIRA_OP_REF__${tag}`, service: `plangraph-jira:${h}` } }), `host ${h}`); }
  catch (x) { if (!(x instanceof JiraError && x.code === 'no_credentials')) throw x; }
  if (allowGeneric) return labelled(await getCredentials({ env, exec, platform }), 'generic');
  throw new JiraError('no_credentials', `no credentials bound to ${h}: add it to ~/.config/plangraph/jira-sites.json, or set JIRA_EMAIL__${tag} and JIRA_API_TOKEN__${tag}, or store a keychain item named plangraph-jira:${h}; generic JIRA_* credentials are never sent to an unpinned site (see docs/JIRA.md)`);
}

// ---------------------------------------------------------------- read-only allowlist
const K = '[A-Z][A-Z0-9]*-\\d+';
const RULES: Record<'cloud' | 'datacenter', Array<[string, RegExp]>> = {
  cloud: [
    ['GET', /^\/rest\/api\/3\/myself$/], ['POST', /^\/rest\/api\/3\/search\/jql$/], ['POST', /^\/rest\/api\/3\/search\/approximate-count$/],
    ['GET', new RegExp(`^/rest/api/3/issue/${K}$`)], ['GET', new RegExp(`^/rest/api/3/issue/${K}/changelog$`)],
    ['GET', /^\/rest\/agile\/1\.0\/board$/], ['GET', /^\/rest\/agile\/1\.0\/board\/\d+\/sprint$/], ['GET', /^\/rest\/agile\/1\.0\/sprint\/\d+\/issue$/],
  ],
  datacenter: [
    ['GET', /^\/rest\/api\/2\/myself$/], ['POST', /^\/rest\/api\/2\/search$/], ['GET', new RegExp(`^/rest/api/2/issue/${K}$`)],
    ['GET', /^\/rest\/agile\/1\.0\/board$/], ['GET', /^\/rest\/agile\/1\.0\/board\/\d+\/sprint$/], ['GET', /^\/rest\/agile\/1\.0\/sprint\/\d+\/issue$/],
  ],
};

// ---------------------------------------------------------------- client
// A response body is read in chunks and abandoned (stream cancelled) as soon as it passes the cap: a hostile or broken server cannot make
// the client buffer an endless body. A body without a stream (a test double) falls back to res.text().
const MAX_BODY_BYTES = 64 * 1024 * 1024;
async function readBody(res: Response, max: number, where: string): Promise<string> {
  if (!res.body || typeof res.body.getReader !== 'function') return await res.text();
  const reader = res.body.getReader(), chunks: Uint8Array[] = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { try { await reader.cancel(); } catch { /* ignore */ } throw new JiraError('too_large', `Jira answered with a body over ${max} bytes on ${where}`); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
export function makeClient({ baseConfig = {}, creds, fetchImpl, sleep, now, random, log, dcHosts, siteHosts, allowInsecureLocalhostForTests = false, maxRetries = 4, backoffMs = 1000, maxSleepSeconds = 120, timeoutMs = 30000, maxBodyBytes = MAX_BODY_BYTES }: ClientOptions = {}): JiraClient {
  const mode = baseConfig.auth?.mode ?? baseConfig.mode ?? AUTH_MODES.SCOPED;
  if (!isAuthMode(mode)) throw new JiraError('bad_config', 'auth.mode must be scoped, site-token or datacenter');
  const dc = mode === AUTH_MODES.DATACENTER, family = dc ? 'datacenter' : 'cloud';
  const url = baseConfig.baseUrl ?? (mode === AUTH_MODES.SCOPED ? 'https://api.atlassian.com' : '');
  // NOTE: baseConfig.dcHosts is deliberately ignored: the Data Center allowlist may only come from user-level config / env.
  const base = validateBase(url, { mode, dcHosts, siteHosts, allowInsecureLocalhostForTests });
  let prefix = '';
  if (mode === AUTH_MODES.SCOPED) {
    if (!/^[A-Za-z0-9-]{8,64}$/.test(String(baseConfig.cloudId || ''))) throw new JiraError('bad_config', 'scoped mode needs a cloudId (see docs/JIRA.md)');
    prefix = `/ex/jira/${baseConfig.cloudId}`;
  }
  if (!creds || !creds.token || (!dc && !creds.email)) throw new JiraError('no_credentials', dc ? 'a personal access token is required' : 'an email and an API token are required');
  const token = String(creds.token), email = String(creds.email || '');
  registerSecret(token); if (!dc) registerSecret(Buffer.from(`${email}:${token}`).toString('base64'));
  const authHeader = dc ? `Bearer ${token}` : `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
  const fetchFn = fetchImpl ?? globalThis.fetch, sleepFn = sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))), rnd = random ?? Math.random;
  const clock = () => new Date(now ? now() : Date.now());
  const api = dc ? '/rest/api/2' : '/rest/api/3';
  const say = (s: string) => { if (log) log(redact(s)); };

  async function request(method: string, path: string, { query, body }: RequestOptions = {}): Promise<JiraAnswer> {
    const safe = redact(String(path)).slice(0, 80);
    if (typeof path !== 'string' || !/^\/[A-Za-z0-9/._-]*$/.test(path) || !RULES[family].some(([m, re]) => m === method && re.test(path)))
      throw new JiraError('read_only', `blocked: ${method} ${safe} is not on the read-only allowlist`);
    const qs = query ? '?' + new URLSearchParams(query).toString() : '';
    const target = `${base.origin}${base.basePath}${prefix}${path}${qs}`;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetchFn(target, { method, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { Authorization: authHeader, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined } as RequestInit); // fetch reads body: undefined as no body
      } catch (e) { throw new JiraError('network', `network error on ${method} ${safe}: ${e && (e as Error).name === 'TimeoutError' ? 'timeout' : redact(e && (e as Error).message)}`); } // whatever fetch threw: name and message are read defensively
      say(`${method} ${path} -> ${res.status}`);
      const drain = async () => { try { await res.body?.cancel(); } catch { /* ignore */ } };
      if ((res.status >= 300 && res.status < 400) || res.type === 'opaqueredirect') { await drain(); throw new JiraError('redirect', `redirect refused on ${method} ${safe} (status ${res.status}); Authorization is never forwarded`, { status: res.status }); }
      if (res.status === 429) {
        await drain();
        const reason = String(res.headers.get('ratelimit-reason') || '').toLowerCase();
        const ra = Number(res.headers.get('retry-after')); const raOk = Number.isFinite(ra) && ra >= 0;
        const rs = res.headers.get('x-ratelimit-reset'); const resetAt = rs && Number.isFinite(Date.parse(rs)) ? new Date(Date.parse(rs)).toISOString() : raOk ? new Date(clock().getTime() + ra * 1000).toISOString() : undefined;
        if (reason.includes('quota')) throw new JiraError('quota', `rate-limit quota exhausted (${redact(reason)}); stopping${resetAt ? `, resets at ${resetAt}` : ''}`, { status: 429, resetAt });
        if (raOk && ra > maxSleepSeconds) throw new JiraError('rate_limit_wait', `rate limited, Retry-After ${ra}s exceeds the ${maxSleepSeconds}s limit; stopping${resetAt ? `, retry after ${resetAt}` : ''}`, { status: 429, resetAt });
        if (attempt >= maxRetries) throw new JiraError('rate_limited', `rate limited after ${maxRetries} retries`, { status: 429, resetAt });
        await sleepFn(Math.round(Math.max(raOk ? ra * 1000 : 0, backoffMs * 2 ** attempt * (0.7 + 0.6 * rnd())))); // Retry-After is a minimum
        continue;
      }
      if (!res.ok) {
        let extra = ''; // errorMessages are untrusted: oneLine (no newline, no angle brackets, capped)
        if (res.status === 400) { try { const j: RawAnswer = JSON.parse(await readBody(res, 64 * 1024, safe)); extra = ': ' + oneLine(Array.isArray(j.errorMessages) ? j.errorMessages.map(String).join('; ') : '', 200); } catch { /* no detail */ } } else await drain();
        const code = ({ 400: 'bad_request', 401: 'auth', 403: 'forbidden', 404: 'not_found' } as Record<number, JiraErrorCode>)[res.status] || 'http'; // an unlisted status reads undefined
        throw new JiraError(code, `Jira answered ${res.status} on ${method} ${safe}${extra}`, { status: res.status });
      }
      const text = await readBody(res, maxBodyBytes, `${method} ${safe}`).catch((e) => {
        if (e instanceof JiraError) throw e;
        throw new JiraError('network', `network error reading the answer to ${method} ${safe}: ${e && e.name === 'TimeoutError' ? 'timeout' : redact(e && e.message)}`);
      });
      try { return JSON.parse(text); } catch { throw new JiraError('bad_json', `Jira answered ${res.status} with a non-JSON body on ${method} ${safe}`); }
    }
  }

  let verified: { timeZone: string } | null = null;
  async function verify(): Promise<{ timeZone: string }> {
    if (verified) return verified;
    let j: JiraAnswer | null;
    try { j = await request('GET', `${api}/myself`); } catch (e) {
      if ((e as { code?: unknown }).code === 'auth') throw new JiraError('auth', `Jira rejected the credentials (401 on /myself). Scoped tokens need mode "scoped" + cloudId (api.atlassian.com gateway); unscoped tokens need mode "site-token"; Data Center needs a PAT`, { status: 401 }); // reads code off whatever was thrown, as before
      throw e;
    }
    const id = dc ? (j && (j.name || j.key)) : (j && j.accountId);
    if (!j || typeof id !== 'string' || !id || id === 'anonymous' || j.active === false) throw new JiraError('anonymous', 'Jira answered /myself with an anonymous, empty or inactive identity: the token is not being accepted (wrong mode for this token type?)');
    return (verified = { timeZone: typeof j.timeZone === 'string' ? j.timeZone : '' });
  }

  async function search({ jql, fields, pageSize, cursor }: SearchQuery): Promise<SearchPage> {
    if (dc) {
      const j = await request('POST', `${api}/search`, { body: { jql, fields, startAt: cursor || 0, maxResults: pageSize } });
      const issues = Array.isArray(j.issues) ? j.issues : [], next = ((cursor || 0) as number) + issues.length; // Data Center cursors are numbers
      return { issues, cursor: next, last: issues.length === 0 || next >= Number(j.total ?? 0) };
    }
    const body: { jql: string; fields: string[]; maxResults: number; nextPageToken?: string } = { jql, fields, maxResults: pageSize }; if (typeof cursor === 'string' && cursor) body.nextPageToken = cursor;
    const j = await request('POST', `${api}/search/jql`, { body });
    const tok = typeof j.nextPageToken === 'string' && j.nextPageToken ? j.nextPageToken : null;
    const last = j.isLast === true || !tok; // trust isLast, never page fullness
    return { issues: Array.isArray(j.issues) ? j.issues : [], cursor: last ? null : tok, last };
  }
  async function count(jql: string): Promise<number | null> {
    const j = dc ? await request('POST', `${api}/search`, { body: { jql, fields: ['key'], maxResults: 0 } }) : await request('POST', `${api}/search/approximate-count`, { body: { jql } });
    const n = dc ? j.total : j.count;
    return Number.isInteger(n) && (n as number) >= 0 ? (n as number) : null; // Number.isInteger is the check (it does not narrow)
  }
  const issue = (key: string, fields: string[]) => request('GET', `${api}/issue/${key}`, { query: { fields: fields.join(',') } });
  async function changelog(key: string, { maxPages = 20 }: { maxPages?: number } = {}): Promise<unknown[]> {
    if (dc) throw new JiraError('unsupported', 'changelog is only implemented for Cloud');
    const out: unknown[] = []; let startAt = 0;
    for (let p = 0; p < maxPages; p++) {
      const j = await request('GET', `${api}/issue/${key}/changelog`, { query: { startAt: String(startAt), maxResults: '100' } });
      const vals = Array.isArray(j.values) ? j.values : []; out.push(...vals); startAt += vals.length;
      if (j.isLast === true || vals.length === 0) break;
    }
    return out;
  }
  return Object.freeze({ mode, request, verify, search, count, issue, changelog, now: clock, identity: Object.freeze(mode === AUTH_MODES.SCOPED ? { cloud_id: baseConfig.cloudId as string } : { host: base.host }) }); // the pattern test above ran on String(cloudId), so the id is string-like
}

// ---------------------------------------------------------------- normalization and snapshots
const str = (x: unknown): string => (typeof x === 'string' ? x : '');
const cmp = <T extends string | number>(a: T, b: T): number => (a < b ? -1 : a > b ? 1 : 0);
export function parseJiraTime(s: unknown): number {
  const m = /^(\d{4}-\d\d-\d\d)T(\d\d:\d\d:\d\d)(?:\.(\d+))?(Z|[+-]\d\d):?(\d\d)?$/.exec(str(s)); if (!m) return NaN;
  return Date.parse(`${m[1]}T${m[2]}.${(m[3] || '0').padEnd(3, '0').slice(0, 3)}${m[4] === 'Z' ? 'Z' : `${m[4]}:${m[5] || '00'}`}`);
}
const cmpTime = (a: unknown, b: unknown): number => { const x = parseJiraTime(a), y = parseJiraTime(b); return Number.isFinite(x) && Number.isFinite(y) ? cmp(x, y) : cmp(str(a), str(b)); };
function formatSince(ms: number, tz: string | undefined): string | null {
  if (!tz || !Number.isFinite(ms)) return null;
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
  } catch { return null; }
}
// Sprint parsing. Hostile-input rules: at most MAX_SPRINTS sprints are kept: the 20 with the HIGHEST ids (sprint ids grow over time, so these
// are the newest and include the current one; Jira lists sprints oldest first but the choice does not depend on input order), the rest are
// dropped silently. Pass 1 reads only each entry's id (O(1) for objects, one linear regex over at most 4000 chars for legacy strings), pass 2
// fully parses just the kept entries. Every string is one sanitized capped line.
const MAX_SPRINTS = 20;
function sprintsOf(v: unknown): JiraSprint[] {
  const arr: Array<RawSprint | string | null> = Array.isArray(v) ? v : [];
  const id = (x: unknown) => { const n = Number(x); return Number.isSafeInteger(n) ? n : 0; };
  const idOf = (s: RawSprint | string | null) => (s && typeof s === 'object' ? id(s.id) : id(/id=(\d+)/.exec(str(s).slice(0, 4000))?.[1]));
  const keyed = arr.map((s, i) => [idOf(s), i] as [number, number]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).slice(-MAX_SPRINTS);
  return keyed.map(([, i]) => {
    const s = arr[i];
    if (s && typeof s === 'object') return { id: id(s.id), name: oneLine(str(s.name), 80), state: oneLine(str(s.state), 20) };
    const t = str(s).slice(0, 4000);
    return { id: id(/id=(\d+)/.exec(t)?.[1]), name: oneLine(/name=([^,\]]*)/.exec(t)?.[1] || '', 80), state: oneLine(/state=(\w+)/.exec(t)?.[1] || '', 20) };
  });
}
// Sprint value lookup. The Atlassian connector nests custom fields under fields.customFields keyed by DISPLAY NAME, each { id, value }.
// Order: entry whose id === sprintField, else the entry named exactly "Sprint", else REST-style fields[sprintField]. Own keys only,
// prototype-ish names skipped, non-object entries tolerated.
const PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const own = (o: unknown, k: string): unknown => (o && typeof o === 'object' && !PROTO_KEYS.has(k) && Object.hasOwn(o, k) ? (o as Record<string, unknown>)[k] : undefined); // hasOwn above proves k is there
function sprintValue(f: RawFields, sprintField: string | undefined): { found: boolean; value?: unknown } {
  const cf = own(f, 'customFields') as Record<string, RawCustomField | undefined> | undefined; // shape unchecked: every read below tests it
  if (cf && typeof cf === 'object' && !Array.isArray(cf)) {
    const names = Object.keys(cf).filter((k) => !PROTO_KEYS.has(k));
    // hasVal returns the raw falsy value (null, 0, '') rather than false: callers use it only for truthiness, so never compare it with === true
    const hasVal = (e: unknown): e is RawCustomField => (e && typeof e === 'object' && !Array.isArray(e)) as boolean; // callers test only its truthiness: a non-null, non-array object
    if (sprintField) for (const k of names) { const e = cf[k]; if (hasVal(e) && e.id === sprintField) return { found: true, value: e.value }; }
    if (names.includes('Sprint') && hasVal(cf.Sprint)) return { found: true, value: cf.Sprint.value };
  }
  if (sprintField && own(f, sprintField) !== undefined) return { found: true, value: own(f, sprintField) };
  return { found: false };
}
/** An issue reduced to the snapshot fields, or null when the input has no valid key. The input is untrusted JSON. */
export function normalizeIssue(raw: RawIssue | null | undefined, { sprintField }: { sprintField?: string | undefined } = {}): JiraIssue | null {
  if (!raw || typeof raw.key !== 'string' || !KEY_RE.test(raw.key)) return null;
  const f: RawFields = raw.fields && typeof raw.fields === 'object' ? raw.fields : {};
  const links: JiraLink[] = [];
  for (const l of (Array.isArray(f.issuelinks) ? f.issuelinks : []) as RawLink[]) { // entries unchecked: each read below tests them
    for (const [dir, side, rel] of [['in', l?.inwardIssue, l?.type?.inward], ['out', l?.outwardIssue, l?.type?.outward]] as Array<['in' | 'out', { key?: unknown } | null | undefined, unknown]>) if (side && KEY_RE.test(str(side.key))) links.push({ key: side.key as string, type: oneLine(str(l.type?.name), 80), dir, rel: oneLine(str(rel), 80) }); // KEY_RE passed, so key is a string
  }
  links.sort((a, b) => cmp(a.key, b.key) || cmp(a.type, b.type) || cmp(a.dir, b.dir));
  const out: JiraIssue = { key: raw.key, summary: sanitizeText(str(f.summary), { max: 300 }), status: oneLine(str(f.status?.name), 80), assignee: sanitizeText(str(f.assignee?.displayName), { max: 300 }), updated: str(f.updated), resolutiondate: str(f.resolutiondate), issuelinks: links };
  const sp = sprintValue(f, sprintField);
  if (sprintField || sp.found) out.sprint = sprintsOf(sp.value);
  return out;
}
function boundedJql(jql: unknown): string {
  const s = typeof jql === 'string' ? jql.trim() : '';
  const m = /\border\s+by\b[^"']*$/i.exec(s); const base = (m ? s.slice(0, m.index) : s).trim();
  if (!base) throw new JiraError('unbounded_jql', 'refusing an empty or ORDER BY-only JQL: Jira rejects it, add a restriction (for example project = ABC)');
  if (base.length > 20000) throw new JiraError('bad_jql', 'JQL is too long');
  return base;
}
function normalizeFields(fields: unknown, sprintField: string | undefined): string[] {
  const f = fields === undefined ? [...DEFAULT_FIELDS] : fields;
  if (!Array.isArray(f) || !f.length || !f.every((x) => typeof x === 'string' && /^[A-Za-z][A-Za-z0-9_.-]*$/.test(x))) throw new JiraError('bad_fields', 'fields must be an explicit non-empty list of field ids (no *all, no negations)');
  const set = new Set<string>(f); set.add('updated'); if (sprintField) set.add(sprintField);
  return [...set].sort();
}
const hash = (issues: JiraIssue[]): string => crypto.createHash('sha256').update(JSON.stringify(issues)).digest('hex');
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export async function pullSnapshot(client: SnapshotClient, opts: PullOptions = {}): Promise<PullResult> {
  const { jql, previous = null, full = false, overlapMinutes = 5, fullReconcileEvery = 0, pageSize = 100, maxPages = 2000, sprintField, driftAbs = 5, driftPct = 0.02 } = opts;
  const base = boundedJql(jql); const fields = normalizeFields(opts.fields, sprintField);
  const me = await client.verify(); // throws on 401 / anonymous: nothing is fetched
  const prev = previous && previous.schema === SCHEMA && previous.meta && previous.meta.complete === true && previous.meta.jql === base && previous.meta.mode === client.mode
    && Object.entries(client.identity).every(([k, v]) => previous.meta[k] === v) && Array.isArray(previous.issues) ? previous : null;
  let reason = full ? 'flag' : !prev ? 'no-previous' : fullReconcileEvery > 0 && (prev.meta.delta_runs || 0) + 1 >= fullReconcileEvery ? 'reconcile' : '';
  let clause: string | null = null;
  if (!reason) {
    let ref = opts.since !== undefined ? new Date(opts.since).getTime() : (prev as Snapshot).issues.map((i) => parseJiraTime(i.updated)).filter(Number.isFinite).reduce((m, x) => Math.max(m, x), -Infinity);
    if (!Number.isFinite(ref)) ref = Date.parse((prev as Snapshot).meta.fetched_at as string); // no usable updated stamps: fall back to the fetch time (prev is set: reason is '')
    clause = formatSince(ref - overlapMinutes * 60000, me.timeZone);
    if (!clause) reason = me.timeZone ? 'bad-since' : 'no-timezone';
  }
  const delta = !reason; const warnings: string[] = [];
  if (!delta && reason === 'no-timezone') warnings.push('delta_unavailable:no-timezone');
  const queryJql = `${delta ? `(${base}) AND updated >= "${clause}"` : base} ORDER BY key ASC`;

  const got = new Map<string, JiraIssue>(); let rows = 0, dropped = 0, failure: { message?: unknown; resetAt?: string } | null = null;
  try {
    let cursor: string | number | null | undefined = null, pages = 0, empties = 0;
    for (;;) {
      if (++pages > maxPages) throw new JiraError('too_many_pages', `stopped after ${maxPages} pages`);
      const page = await client.search({ jql: queryJql, fields, pageSize, cursor });
      rows += page.issues.length;
      for (const raw of page.issues) {
        const it = normalizeIssue(raw, { sprintField });
        if (!it) { dropped++; continue; }
        const old = got.get(it.key); if (!old || cmpTime(it.updated, old.updated) >= 0) got.set(it.key, it);
      }
      if (page.last) break;
      if (page.cursor === cursor) throw new JiraError('pagination_loop', 'Jira returned the same page cursor twice');
      if (page.issues.length === 0 && ++empties > 3) throw new JiraError('pagination_stalled', 'Jira returned several empty pages without finishing');
      cursor = page.cursor;
    }
  } catch (e) { failure = e as { message?: unknown; resetAt?: string }; } // anything may be thrown: only message and resetAt are read
  if (failure) {
    const code = failure instanceof JiraError ? failure.code : 'internal';
    const error = redact(failure instanceof JiraError ? failure.message : `unexpected error: ${failure && failure.message}`);
    const r: Unsummarized<PullFailure> = { ok: false, complete: false, snapshot: null, code, error, resetAt: failure.resetAt, received: rows, warnings, changedKeys: [], removedKeys: [] };
    r.summary = `INCOMPLETE after ${got.size} issues (${code}${r.resetAt ? `, resets ${r.resetAt}` : ''}): ${error}; nothing written`;
    return r as PullFailure; // summary was set on the line above
  }
  if (dropped) warnings.push(`invalid_key_dropped:${dropped}`);

  const merged = new Map<string, JiraIssue>(delta || prev ? (prev as Snapshot).issues.map((i) => [i.key, i]) : []); // delta implies prev
  const changedKeys: string[] = []; let merged2: Map<string, JiraIssue>;
  if (delta) {
    for (const it of got.values()) {
      const old = merged.get(it.key);
      if (!old) { merged.set(it.key, it); changedKeys.push(it.key); continue; }
      const c = cmpTime(it.updated, old.updated); // a staler read (eventual consistency) never overwrites
      if (c < 0 || same(it, old)) continue;
      merged.set(it.key, it); changedKeys.push(it.key);
    }
    merged2 = merged;
  } else {
    merged2 = got;
    if (prev) for (const it of got.values()) { const old = merged.get(it.key); if (!old || !same(it, old)) changedKeys.push(it.key); }
  }
  const removedKeys = !delta && prev ? prev.issues.map((i) => i.key).filter((k) => !got.has(k)).sort() : [];
  changedKeys.sort();
  const issues = [...merged2.values()].sort((a, b) => cmp(a.key, b.key));

  let expected: number | null = null;
  try { expected = await client.count(base); } catch { /* reconciliation is advisory */ }
  const drift = expected === null ? null : issues.length - expected;
  if (expected === null) warnings.push('count_unavailable');
  else if (Math.abs(drift as number) > Math.max(driftAbs, Math.ceil(expected * driftPct))) warnings.push('count_drift'); // drift is a number when expected is
  const meta: SnapshotMeta = { jql: base, fetched_at: client.now().toISOString(), mode: client.mode, ...client.identity, expected_count: expected, received_count: issues.length, count_drift: drift, complete: true, content_hash: hash(issues), pull: delta ? 'delta' : 'full', delta_runs: delta ? ((prev as Snapshot).meta.delta_runs || 0) + 1 : 0 }; // delta implies prev
  const snapshot: Snapshot = { schema: SCHEMA, meta, issues };
  const r: Unsummarized<PullSuccess> = { ok: true, complete: true, snapshot, mode: meta.pull as string, changedKeys, removedKeys, received: rows, warnings, windowMinutes: overlapMinutes, reason };
  r.summary = summarize(r as PullSuccess); // summarize does not read summary on a success
  return r as PullSuccess; // summary was set on the line above
}

function summarize(r: PullResult): string {
  if (!r.ok) return r.summary;
  const m = r.snapshot.meta;
  const how = r.mode === 'delta' ? `delta ${r.changedKeys.length}, window ${r.windowMinutes}m` : `full${r.removedKeys.length ? `, removed ${r.removedKeys.length}` : ''}`;
  return `pulled ${m.received_count} issues (${how}), drift ${m.count_drift ?? 'n/a'}, complete, hash ${(m.content_hash as string).slice(0, 6)}${r.warnings.length ? `, WARN ${r.warnings.join('+')}` : ''}`; // a successful pull always sets content_hash
}

// Import issue JSON that something else already fetched (the Atlassian connector's saved result, a REST export): no credentials, no network.
// Accepts {issues:{nodes:[..]}} (connector), {issues:[..]}, {nodes:[..]}, a bare array, or one issue. Only the needed fields are kept (no
// descriptions, no emails). An issue that carries no issuelinks keeps the links already known (the connector's compact view omits them).
// The result is marked complete:false: it is a partial update, never a reconciled full snapshot.
const KEPT_WHEN_ABSENT = ['summary', 'status', 'assignee', 'updated', 'resolutiondate'] as const;
// `issues` is either the array itself or the connector's { nodes: [...] }; Array.isArray decides which before any read.
export interface RawImport extends RawIssue { issues?: RawIssue[] | { nodes?: RawIssue[] }; nodes?: RawIssue[]; key?: unknown }
export function importIssues(previous: Snapshot | null | undefined, input: RawImport | RawIssue[] | null | undefined, { sprintField, now = () => new Date() }: { sprintField?: string | undefined; now?: () => Date } = {}): ImportResult {
  const rows: RawIssue[] | null = Array.isArray(input) ? input : Array.isArray(input?.issues) ? input.issues : Array.isArray(input?.issues?.nodes) ? input.issues.nodes : Array.isArray(input?.nodes) ? input.nodes : (input && typeof input.key === 'string' ? [input] : null);
  if (!rows) throw new JiraError('bad_input', 'no issues found in the input (expected an array, {issues:[..]}, {issues:{nodes:[..]}} or one issue)');
  const prev = previous && Array.isArray(previous.issues) ? previous : null;
  const merged = new Map<string, JiraIssue>((prev ? prev.issues : []).map((i) => [i.key, i]));
  const changedKeys: string[] = []; let dropped = 0, imported = 0;
  for (const raw of rows) {
    const it = normalizeIssue(raw, { sprintField });
    if (!it) { dropped++; continue; }
    imported++;
    const old = merged.get(it.key);
    if (raw.fields && raw.fields.issuelinks === undefined && old) it.issuelinks = old.issuelinks;
    // A slimmed response (responseFields, docs/JIRA.md) leaves fields out: a field that is not an own property keeps the known value; a
    // field that is present (even null or empty) replaces it. Sprint counts as absent when no customFields entry or REST field carries it.
    if (old && raw.fields && typeof raw.fields === 'object') {
      for (const k of KEPT_WHEN_ABSENT) if (!Object.hasOwn(raw.fields, k) && old[k] !== undefined) it[k] = old[k];
      if (!sprintValue(raw.fields, sprintField).found && old.sprint !== undefined) it.sprint = old.sprint;
    }
    if (old && it.updated && old.updated && it.updated < old.updated) continue; // never replace a newer copy with an older one
    if (!old || !same(it, old)) changedKeys.push(it.key);
    merged.set(it.key, it);
  }
  const issues = [...merged.values()].sort((a, b) => cmp(a.key, b.key));
  const meta: SnapshotMeta = { ...(prev ? prev.meta : {}), source: 'import', imported_at: now().toISOString(), received_count: issues.length, complete: false, pull: 'import', content_hash: hash(issues) };
  const snapshot: Snapshot = { schema: SCHEMA, meta, issues };
  changedKeys.sort();
  return { snapshot, imported, dropped, changedKeys, summary: `imported ${imported} issue(s) (changed ${changedKeys.length}, dropped ${dropped}); snapshot now ${issues.length} issues, partial, hash ${(meta.content_hash as string).slice(0, 6)}` }; // set two lines above
}

// merge-friendly serialization: line 1 = {schema, meta}, then one issue per line sorted by key
export const snapshotToJsonl = (s: Snapshot): string => [JSON.stringify({ schema: s.schema, meta: s.meta }), ...s.issues.map((i) => JSON.stringify(i))].join('\n') + '\n';
export function parseSnapshotJsonl(text: string): Snapshot {
  const [head, ...issues] = parseJsonl(text, 'snapshot.jsonl') as unknown as [JsonlRecord | undefined, ...JiraIssue[]]; // unchecked: issue lines are not validated on read (pre-existing)
  if (!head || head.schema !== SCHEMA || !head.meta) throw new JiraError('bad_snapshot', 'unsupported snapshot schema');
  return { schema: head.schema, meta: head.meta as SnapshotMeta, issues }; // unchecked: meta is tested only for truthiness (pre-existing)
}
// shape the pre-lib bin/brain consumers read: { KEY: { summary, status, assignee, updated, resolved, blockedBy } }
export function toLegacyMap(s: Snapshot): Record<string, LegacyIssue> {
  return Object.fromEntries(s.issues.map((i) => [i.key, { summary: i.summary, status: i.status, assignee: i.assignee, updated: i.updated, resolved: i.resolutiondate, blockedBy: i.issuelinks.filter((l) => l.dir === 'in').map((l) => l.key) }]));
}

export async function fetchChangelog(client: ChangelogClient, key: string): Promise<ChangelogEntry[]> {
  if (!KEY_RE.test(String(key))) throw new JiraError('bad_key', 'not a Jira issue key');
  await client.verify();
  return ((await client.changelog(key)) as RawHistory[]).map((h) => ({ id: str(h.id), created: str(h.created), author: str(h.author?.displayName), items: (h.items || []).map((x) => ({ field: str(x.field), from: str(x.fromString), to: str(x.toString) })) })); // entries unchecked: str() tests each leaf
}

// ---------------------------------------------------------------- issue text (ADF -> text)
// Same flattening as the previous bin/brain adf(); the only addition is a depth guard because the input is untrusted JSON.
// `content` must be an array (anything else is a JiraError bad_input, a data error), a heading level is clamped to 1..6 (default 2).
const contentOf = (n: RawAdf): Array<RawAdf | string> => {
  if (n.content == null) return [];
  if (!Array.isArray(n.content)) throw new JiraError('bad_input', 'issue text is not valid ADF: "content" must be an array');
  return n.content;
};
const headingLevel = (n: RawAdf): number => { const l = n.attrs && n.attrs.level; return Number.isInteger(l) ? Math.min(6, Math.max(1, l as number)) : 2; }; // Number.isInteger is the check
/** Plain text of an ADF document (untrusted JSON); a string passes through, anything deeper than 100 levels is dropped. */
export function adfToText(n: RawAdf | string | null | undefined, depth = 0): string {
  if (n == null || depth > 100) return ''; if (typeof n === 'string') return n;
  const kids = contentOf(n).map((c) => adfToText(c, depth + 1)).join('');
  switch (n.type) {
    case 'text': return (n.text as string) || ''; // as before: a non-string text is returned as is
    case 'hardBreak': return '\n';
    case 'paragraph': return kids + '\n\n';
    case 'heading': return '#'.repeat(headingLevel(n)) + ' ' + kids + '\n';
    case 'bulletList': case 'orderedList': return contentOf(n).map((li) => '- ' + adfToText(li, depth + 1).trim() + '\n').join('') + '\n';
    case 'codeBlock': return '```\n' + kids + '\n```\n';
    case 'mention': return '@' + ((n.attrs && n.attrs.text) || '');
    default: return kids;
  }
}
// Cut `s` to at most `n` chars without splitting a surrogate pair or a fence tag, and re-close any fence left open,
// so the result always has balanced <untrusted ...> / </untrusted> pairs (the closing tag is appended after the cut).
function cutFenced(s: string, n: number): string {
  if (n > 0 && /[\uD800-\uDBFF]/.test(s[n - 1] as string)) n--; // RegExp.test stringifies undefined, as before
  let t = s.slice(0, Math.max(0, n));
  const lt = t.lastIndexOf('<');
  if (lt >= 0) { const tail = t.slice(lt); if ('</untrusted>'.startsWith(tail) || '<untrusted '.startsWith(tail) || /^<untrusted [^>\n]*$/.test(tail)) t = t.slice(0, lt); }
  const opens = (t.match(/<untrusted /g) || []).length, closes = (t.match(/<\/untrusted>/g) || []).length;
  return opens > closes ? `${t}\n</untrusted>` : t;
}
/** The issue as fenced text for an agent to read. `j` is the untrusted issue JSON (`{ fields: ... }`). */
export function renderIssue(key: string, j: RawIssue | null | undefined, { maxChars = 30000 }: { maxChars?: number } = {}): string {
  const f: RawFields = (j && j.fields) || {}; const cs: RawComment[] = f.comment?.comments || [];
  key = sanitizeText(key, { max: 40 }).replace(/\s+/g, ' ').trim(); const src = `jira:${key}`;
  // header and list text is one line with every <untrusted tag neutralized (no forged closing tag); a fence always starts its own line
  const line = (v: unknown) => neutralizeTags(sanitizeText(v, { max: 300 }).replace(/\n+/g, ' '));
  const desc = adfToText(f.description).trim();
  const summary = line(f.summary || '');
  let out = `# ${key}\nStatus: ${line(f.status?.name || '')} | updated ${line(f.updated || '')}\n\n## Summary\n${summary ? fence('summary', summary, { src, max: 300 }) : '(empty)'}\n\n## Description\n${desc ? fence('description', desc, { src, max: maxChars }) : '(empty)'}\n\n## Comments (${cs.length})\n`;
  for (const c of cs) out += `- [${line(c.author?.displayName || 'unknown')}, ${line(c.created)}]:\n${fence('comment', adfToText(c.body).trim().replace(/\n+/g, ' '), { src, max: 5000 })}\n`;
  if (Number(f.comment?.total) > cs.length) out += `... ${((f.comment as { total: number }).total) - cs.length} more comments not fetched\n`; // Number(total) > length proves comment is set and total is numeric-coercible (not that it is a number)
  return out.length > maxChars ? `${cutFenced(out, maxChars)}\n... ${out.length - maxChars} more chars\n` : out;
}
export async function fetchIssueText(client: IssueTextClient, key: string, opts: { maxChars?: number } = {}): Promise<string> {
  if (typeof key !== 'string' || !KEY_RE.test(key)) throw new JiraError('bad_key', 'not a Jira issue key (expected like ABC-123)');
  await client.verify();
  return renderIssue(key, await client.issue(key, ['summary', 'status', 'updated', 'description', 'comment']), opts);
}
