// lib/jira.mjs: the ONLY module allowed to use the network. Read-only Jira reader (Cloud scoped token, Cloud site token, Data Center PAT).
// Safety model: committed config is UNTRUSTED (host allowlist by parsed hostname, https only, no redirects, Authorization never leaves the
// allowlisted host); every request must match a (method, path) read-only allowlist BEFORE the network is touched; secrets live in closures and are
// stripped by redact() from every message. No fs, no process.exit, no console: callers print and write.
import crypto from 'node:crypto';
import { sanitizeText, oneLine, fence, neutralizeTags } from './sanitize.mjs';
import { parseJsonl } from './jsonl.mjs';
import { execFile } from 'node:child_process';

export const SCHEMA = 1;
export const KEY_RE = /^[A-Z][A-Z0-9]*-\d+$/;
const DEFAULT_FIELDS = ['summary', 'status', 'assignee', 'updated', 'resolutiondate', 'issuelinks'];

// ---------------------------------------------------------------- redaction
const secrets = new Set();
function registerSecret(...vals) {
  for (const v of vals) {
    if (typeof v !== 'string' || v.length < 6) continue;
    secrets.add(v); secrets.add(encodeURIComponent(v)); secrets.add(JSON.stringify(v).slice(1, -1));
    secrets.add(Buffer.from(v).toString('base64')); secrets.add(Buffer.from(v).toString('base64url'));
  }
}
export function redact(text) {
  let s = text instanceof Error ? text.message : text == null ? '' : String(text);
  for (const sec of [...secrets].sort((a, b) => b.length - a.length)) s = s.split(sec).join('[redacted]');
  s = s.replace(/(authorization["']?\s*[:=]\s*["']?)(?:(?:basic|bearer)\s+)?[^\s"',;]+/gi, '$1[redacted]');
  s = s.replace(/\b(Basic|Bearer)\s+[A-Za-z0-9+/=._~-]{8,}/g, '$1 [redacted]');
  s = s.replace(/\bAT[A-Z]TT[A-Za-z0-9_=+/.-]{16,}/g, '[redacted]'); // Atlassian API token prefix (heuristic)
  return s;
}

export class JiraError extends Error {
  constructor(code, message, extra = {}) {
    super(redact(message)); this.name = 'JiraError'; this.code = code;
    if (extra.status !== undefined) this.status = extra.status;
    if (extra.resetAt !== undefined) this.resetAt = extra.resetAt;
  }
}

// ---------------------------------------------------------------- host hardening
export function parseDcHosts(v) {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [];
  return new Set(list.map((x) => String(x).trim().toLowerCase()).filter((x) => /^[a-z0-9.-]+(:\d+)?$/.test(x)));
}
export const siteHostsFromEnv = (env = {}) => [...parseDcHosts(env.BRAIN_JIRA_SITES)];
export const dcHostsFromEnv = (env = {}) => [...parseDcHosts(env.BRAIN_JIRA_DC_HOSTS)];

const SITE_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.atlassian\.net$/;
export function validateBase(url, opts = {}) {
  const fail = (why) => { throw new JiraError('bad_host', `base URL rejected: ${why}`); };
  if (typeof url !== 'string' || !url) fail('empty');
  if (/[^\x21-\x7e]/.test(url)) fail('whitespace, control or non-ASCII character');
  if (/[\\%]/.test(url)) fail('backslash or percent-escape');
  let u; try { u = new URL(url); } catch { return fail('not an absolute URL'); }
  const loop = opts.allowInsecureLocalhostForTests === true && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.username || u.password) fail('userinfo');
  if (u.protocol !== 'https:' && !(loop && u.protocol === 'http:')) fail('https required');
  if (u.search || u.hash) fail('query or fragment');
  const host = u.hostname; let kind;
  if (loop) kind = 'loopback';
  else if (opts.mode === 'datacenter') {
    if (!parseDcHosts(opts.dcHosts).has(u.host)) fail('host is not in the user-level Data Center allowlist (BRAIN_JIRA_DC_HOSTS)');
    kind = 'datacenter';
  } else {
    if (/(^|\.)xn--/.test(host)) fail('punycode (xn--) host label'); // never rely on the URL parser: newer Node versions accept some malformed punycode that older ones rejected
    if (u.port) fail('non-default port');
    const gw = host === 'api.atlassian.com', site = SITE_RE.test(host);
    if (opts.mode === 'scoped' ? !gw : opts.mode === 'site-token' ? !site : !gw && !site) fail('host is not on the Atlassian allowlist');
    const pins = parseDcHosts(opts.siteHosts); // optional user-level pin: a committed config must not aim a site token at someone else's tenant
    if (site && pins.size && !pins.has(host)) fail('site is not in the user-level site allowlist (BRAIN_JIRA_SITES)');
    kind = gw ? 'gateway' : 'site';
  }
  const dcPath = kind === 'datacenter' || (loop && opts.mode === 'datacenter');
  if (dcPath ? !/^(?:\/[A-Za-z0-9._~-]+)*\/?$/.test(u.pathname) : u.pathname !== '/') fail('path not allowed');
  return { origin: `${u.protocol}//${u.host}`, host, kind, basePath: u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '') };
}

// ---------------------------------------------------------------- credentials
export function defaultExec(file, args) {
  return new Promise((resolve, reject) => execFile(file, args, { timeout: 10000, maxBuffer: 65536, windowsHide: true }, (e, out) => (e ? reject(new Error('helper failed')) : resolve(String(out)))));
}
const EMAIL_RE = /^[^\s:@]+@[^\s:@]+$/, TOKEN_RE = /^[\x21-\x7e]{8,}$/;
function finishCreds(email, token, source) {
  if (email && !EMAIL_RE.test(email)) throw new JiraError('bad_credentials', 'JIRA_EMAIL is not an email address');
  if (!TOKEN_RE.test(token || '')) throw new JiraError('bad_credentials', `token from ${source} is malformed (8+ printable characters, no spaces)`);
  registerSecret(token, email ? Buffer.from(`${email}:${token}`).toString('base64') : '');
  const c = { email: email || '', source };
  Object.defineProperty(c, 'token', { value: token, enumerable: false }); // keeps the token out of JSON.stringify / inspect
  return c;
}
/** @param {{ env?: Record<string, string | undefined>, exec?: (file: string, args: string[]) => Promise<string>, platform?: string }} [opts] */
export async function getCredentials({ env = {}, exec = defaultExec, platform = process.platform, names = {} } = {}) {
  const N = { emailVar: 'JIRA_EMAIL', tokenVar: 'JIRA_API_TOKEN', opVar: 'JIRA_OP_REF', opRef: undefined, service: 'project-brain-jira', ...names };
  const envEmail = String(env[N.emailVar] || '').trim(), envTok = String(env[N.tokenVar] || '').trim();
  let tokenOnly = null;
  const take = (secret, source) => { // secret is "token" or "email:token"
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
    let out; try { out = await exec('op', ['read', ref]); } catch { throw new JiraError('no_credentials', `op read failed for ${N.opRef ? 'op_ref' : N.opVar} (is the 1Password CLI signed in?)`); }
    const c = take(String(out), 'op'); if (c) return c;
  }
  /** @type {[string, string[]] | null} */
  const helper = platform === 'darwin' ? ['security', ['find-generic-password', '-s', N.service, '-w']] : platform === 'linux' ? ['secret-tool', ['lookup', 'service', N.service]] : null;
  if (helper) { let out = null; try { out = await exec(helper[0], helper[1]); } catch { /* item not found: fall through */ } if (out != null) { const c = take(String(out), 'keychain'); if (c) return c; } }
  if (tokenOnly) return tokenOnly;
  throw new JiraError('no_credentials', 'no Jira credentials: set JIRA_EMAIL and JIRA_API_TOKEN, or JIRA_OP_REF, or store the token in the OS keychain (see docs/JIRA.md)');
}

// ---------------------------------------------------------------- tenants (several companies, several Jira sites)
// One credential set is not enough when the user works for several companies: a token for company B must never be sent to company A's
// site. Credentials are therefore BOUND to a host. Order for host H (first hit wins; a host that has a registry entry never falls back):
//   1. user-level registry entry for H (~/.config/project-brain/jira-sites.json, never committed): names of env vars, an op:// ref or a keychain service
//   2. convention: env JIRA_EMAIL__TAG + JIRA_API_TOKEN__TAG (or JIRA_OP_REF__TAG) and keychain service `project-brain-jira:H`, TAG = H without .atlassian.net, upper-case
//   3. the generic JIRA_* set, only when `allowGeneric` (scoped or Data Center mode, or the site is pinned in BRAIN_JIRA_SITES)
export const siteTag = (host) => String(host).replace(/\.atlassian\.net$/i, '').toUpperCase().replace(/[^A-Z0-9]/g, '_');
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/, SERVICE_RE = /^[A-Za-z0-9._:@-]{1,100}$/, HOST_RE = /^[a-z0-9](?:[a-z0-9.-]{0,120}[a-z0-9])?(?::\d{1,5})?$/;
/** Validates the user-level registry; returns a null-prototype map host -> entry, dropping anything malformed (reported in `problems`). */
export function parseSiteRegistry(text) {
  const reg = Object.create(null), problems = [];
  let j; try { j = JSON.parse(text); } catch { return { reg, problems: ['jira-sites.json is not valid JSON'] }; }
  const sites = j && typeof j === 'object' && j.sites && typeof j.sites === 'object' ? j.sites : null;
  if (!sites) return { reg, problems: ['jira-sites.json needs a "sites" object'] };
  for (const [h, e] of Object.entries(sites)) {
    const host = h.toLowerCase();
    if (!HOST_RE.test(host) || !e || typeof e !== 'object') { problems.push(`site ${oneLine(h, 60)}: bad host or entry`); continue; }
    const out = {};
    for (const k of ['email_env', 'token_env']) if (e[k] !== undefined) { if (typeof e[k] === 'string' && ENV_NAME_RE.test(e[k])) out[k] = e[k]; else problems.push(`site ${host}: ${k} is not an env var name`); }
    if (e.op_ref !== undefined) { if (typeof e.op_ref === 'string' && /^op:\/\/[^\s]+$/.test(e.op_ref)) out.op_ref = e.op_ref; else problems.push(`site ${host}: op_ref must look like op://vault/item/field`); }
    if (e.keychain !== undefined) { if (typeof e.keychain === 'string' && SERVICE_RE.test(e.keychain)) out.keychain = e.keychain; else problems.push(`site ${host}: keychain is not a service name`); }
    if (!Object.keys(out).length) { problems.push(`site ${host}: no credential source`); continue; }
    reg[host] = out;
  }
  return { reg, problems };
}
/** Credentials for one host. `source` of the result says where they came from (never the secret). */
export async function getCredentialsFor(host, { env = {}, exec = defaultExec, platform = process.platform, registry = {}, allowGeneric = false } = {}) {
  const h = String(host).toLowerCase(), e = Object.hasOwn(registry, h) ? registry[h] : null;
  const labelled = (c, how) => { c.source = `${how}:${c.source}`; return c; };
  if (e) {
    try { return labelled(await getCredentials({ env, exec, platform, names: { emailVar: e.email_env || 'JIRA_EMAIL', tokenVar: e.token_env || '', opVar: '', opRef: e.op_ref, service: e.keychain || `project-brain-jira:${h}` } }), `registry ${h}`); }
    catch (x) { if (x instanceof JiraError && x.code === 'no_credentials') throw new JiraError('no_credentials', `registry entry for ${h} found no credentials (check the env var, op ref or keychain item it names)`); throw x; }
  }
  const tag = siteTag(h);
  try { return labelled(await getCredentials({ env, exec, platform, names: { emailVar: `JIRA_EMAIL__${tag}`, tokenVar: `JIRA_API_TOKEN__${tag}`, opVar: `JIRA_OP_REF__${tag}`, service: `project-brain-jira:${h}` } }), `host ${h}`); }
  catch (x) { if (!(x instanceof JiraError && x.code === 'no_credentials')) throw x; }
  if (allowGeneric) return labelled(await getCredentials({ env, exec, platform }), 'generic');
  throw new JiraError('no_credentials', `no credentials bound to ${h}: add it to ~/.config/project-brain/jira-sites.json, or set JIRA_EMAIL__${tag} and JIRA_API_TOKEN__${tag}, or store a keychain item named project-brain-jira:${h}; generic JIRA_* credentials are never sent to an unpinned site (see docs/JIRA.md)`);
}

// ---------------------------------------------------------------- read-only allowlist
const K = '[A-Z][A-Z0-9]*-\\d+';
/** @type {Record<'cloud' | 'datacenter', Array<[string, RegExp]>>} */
const RULES = {
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
async function readBody(res, max, where) {
  if (!res.body || typeof res.body.getReader !== 'function') return await res.text();
  const reader = res.body.getReader(), chunks = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { try { await reader.cancel(); } catch { /* ignore */ } throw new JiraError('too_large', `Jira answered with a body over ${max} bytes on ${where}`); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
/** @typedef {{ baseConfig?: Record<string, any>, creds?: { email?: string, token?: string, source?: string }, fetchImpl?: typeof fetch,
 *   sleep?: (ms: number) => Promise<unknown>, now?: () => number | Date, random?: () => number, log?: (s: string) => void, dcHosts?: string | string[], siteHosts?: string | string[],
 *   allowInsecureLocalhostForTests?: boolean, maxRetries?: number, backoffMs?: number, maxSleepSeconds?: number, timeoutMs?: number, maxBodyBytes?: number }} ClientOptions */
/** @param {ClientOptions} [opts] */
export function makeClient({ baseConfig = {}, creds, fetchImpl, sleep, now, random, log, dcHosts, siteHosts, allowInsecureLocalhostForTests = false, maxRetries = 4, backoffMs = 1000, maxSleepSeconds = 120, timeoutMs = 30000, maxBodyBytes = MAX_BODY_BYTES } = {}) {
  const mode = baseConfig.auth?.mode ?? baseConfig.mode ?? 'scoped';
  if (!['scoped', 'site-token', 'datacenter'].includes(mode)) throw new JiraError('bad_config', 'auth.mode must be scoped, site-token or datacenter');
  const dc = mode === 'datacenter', family = dc ? 'datacenter' : 'cloud';
  const url = baseConfig.baseUrl ?? (mode === 'scoped' ? 'https://api.atlassian.com' : '');
  // NOTE: baseConfig.dcHosts is deliberately ignored: the Data Center allowlist may only come from user-level config / env.
  const base = validateBase(url, { mode, dcHosts, siteHosts, allowInsecureLocalhostForTests });
  let prefix = '';
  if (mode === 'scoped') {
    if (!/^[A-Za-z0-9-]{8,64}$/.test(String(baseConfig.cloudId || ''))) throw new JiraError('bad_config', 'scoped mode needs a cloudId (see docs/JIRA.md)');
    prefix = `/ex/jira/${baseConfig.cloudId}`;
  }
  if (!creds || !creds.token || (!dc && !creds.email)) throw new JiraError('no_credentials', dc ? 'a personal access token is required' : 'an email and an API token are required');
  const token = String(creds.token), email = String(creds.email || '');
  registerSecret(token); if (!dc) registerSecret(Buffer.from(`${email}:${token}`).toString('base64'));
  const authHeader = dc ? `Bearer ${token}` : `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
  const fetchFn = fetchImpl ?? globalThis.fetch, sleepFn = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))), rnd = random ?? Math.random;
  const clock = () => new Date(now ? now() : Date.now());
  const api = dc ? '/rest/api/2' : '/rest/api/3';
  const say = (s) => { if (log) log(redact(s)); };

  /** @param {string} method @param {string} path @param {{ query?: any, body?: unknown }} [opts] */
  async function request(method, path, { query, body } = {}) {
    const safe = redact(String(path)).slice(0, 80);
    if (typeof path !== 'string' || !/^\/[A-Za-z0-9/._-]*$/.test(path) || !RULES[family].some(([m, re]) => m === method && re.test(path)))
      throw new JiraError('read_only', `blocked: ${method} ${safe} is not on the read-only allowlist`);
    const qs = query ? '?' + new URLSearchParams(query).toString() : '';
    const target = `${base.origin}${base.basePath}${prefix}${path}${qs}`;
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetchFn(target, { method, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { Authorization: authHeader, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
      } catch (e) { throw new JiraError('network', `network error on ${method} ${safe}: ${e && e.name === 'TimeoutError' ? 'timeout' : redact(e && e.message)}`); }
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
        if (res.status === 400) { try { const j = JSON.parse(await readBody(res, 64 * 1024, safe)); extra = ': ' + oneLine(Array.isArray(j.errorMessages) ? j.errorMessages.map(String).join('; ') : '', 200); } catch { /* no detail */ } } else await drain();
        const code = { 400: 'bad_request', 401: 'auth', 403: 'forbidden', 404: 'not_found' }[res.status] || 'http';
        throw new JiraError(code, `Jira answered ${res.status} on ${method} ${safe}${extra}`, { status: res.status });
      }
      const text = await readBody(res, maxBodyBytes, `${method} ${safe}`).catch((e) => {
        if (e instanceof JiraError) throw e;
        throw new JiraError('network', `network error reading the answer to ${method} ${safe}: ${e && e.name === 'TimeoutError' ? 'timeout' : redact(e && e.message)}`);
      });
      try { return JSON.parse(text); } catch { throw new JiraError('bad_json', `Jira answered ${res.status} with a non-JSON body on ${method} ${safe}`); }
    }
  }

  let verified = null;
  async function verify() {
    if (verified) return verified;
    let j;
    try { j = await request('GET', `${api}/myself`); } catch (e) {
      if (e.code === 'auth') throw new JiraError('auth', `Jira rejected the credentials (401 on /myself). Scoped tokens need mode "scoped" + cloudId (api.atlassian.com gateway); unscoped tokens need mode "site-token"; Data Center needs a PAT`, { status: 401 });
      throw e;
    }
    const id = dc ? (j && (j.name || j.key)) : (j && j.accountId);
    if (!j || typeof id !== 'string' || !id || id === 'anonymous' || j.active === false) throw new JiraError('anonymous', 'Jira answered /myself with an anonymous, empty or inactive identity: the token is not being accepted (wrong mode for this token type?)');
    return (verified = { timeZone: typeof j.timeZone === 'string' ? j.timeZone : '' });
  }

  async function search({ jql, fields, pageSize, cursor }) {
    if (dc) {
      const j = await request('POST', `${api}/search`, { body: { jql, fields, startAt: cursor || 0, maxResults: pageSize } });
      const issues = Array.isArray(j.issues) ? j.issues : [], next = (cursor || 0) + issues.length;
      return { issues, cursor: next, last: issues.length === 0 || next >= Number(j.total ?? 0) };
    }
    const body = { jql, fields, maxResults: pageSize }; if (typeof cursor === 'string' && cursor) body.nextPageToken = cursor;
    const j = await request('POST', `${api}/search/jql`, { body });
    const tok = typeof j.nextPageToken === 'string' && j.nextPageToken ? j.nextPageToken : null;
    const last = j.isLast === true || !tok; // trust isLast, never page fullness
    return { issues: Array.isArray(j.issues) ? j.issues : [], cursor: last ? null : tok, last };
  }
  async function count(jql) {
    const j = dc ? await request('POST', `${api}/search`, { body: { jql, fields: ['key'], maxResults: 0 } }) : await request('POST', `${api}/search/approximate-count`, { body: { jql } });
    const n = dc ? j.total : j.count;
    return Number.isInteger(n) && n >= 0 ? n : null;
  }
  const issue = (key, fields) => request('GET', `${api}/issue/${key}`, { query: { fields: fields.join(',') } });
  async function changelog(key, { maxPages = 20 } = {}) {
    if (dc) throw new JiraError('unsupported', 'changelog is only implemented for Cloud');
    const out = []; let startAt = 0;
    for (let p = 0; p < maxPages; p++) {
      const j = await request('GET', `${api}/issue/${key}/changelog`, { query: { startAt: String(startAt), maxResults: '100' } });
      const vals = Array.isArray(j.values) ? j.values : []; out.push(...vals); startAt += vals.length;
      if (j.isLast === true || vals.length === 0) break;
    }
    return out;
  }
  return Object.freeze({ mode, request, verify, search, count, issue, changelog, now: clock, identity: Object.freeze(mode === 'scoped' ? { cloud_id: baseConfig.cloudId } : { host: base.host }) });
}

// ---------------------------------------------------------------- normalization and snapshots
const str = (x) => (typeof x === 'string' ? x : '');
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export function parseJiraTime(s) {
  const m = /^(\d{4}-\d\d-\d\d)T(\d\d:\d\d:\d\d)(?:\.(\d+))?(Z|[+-]\d\d):?(\d\d)?$/.exec(str(s)); if (!m) return NaN;
  return Date.parse(`${m[1]}T${m[2]}.${(m[3] || '0').padEnd(3, '0').slice(0, 3)}${m[4] === 'Z' ? 'Z' : `${m[4]}:${m[5] || '00'}`}`);
}
const cmpTime = (a, b) => { const x = parseJiraTime(a), y = parseJiraTime(b); return Number.isFinite(x) && Number.isFinite(y) ? cmp(x, y) : cmp(str(a), str(b)); };
function formatSince(ms, tz) {
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
export const MAX_SPRINTS = 20;
function sprintsOf(v) {
  const arr = Array.isArray(v) ? v : [];
  const id = (x) => { const n = Number(x); return Number.isSafeInteger(n) ? n : 0; };
  const idOf = (s) => (s && typeof s === 'object' ? id(s.id) : id(/id=(\d+)/.exec(str(s).slice(0, 4000))?.[1]));
  const keyed = arr.map((s, i) => [idOf(s), i]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).slice(-MAX_SPRINTS);
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
const own = (o, k) => (o && typeof o === 'object' && !PROTO_KEYS.has(k) && Object.hasOwn(o, k) ? o[k] : undefined);
function sprintValue(f, sprintField) {
  const cf = own(f, 'customFields');
  if (cf && typeof cf === 'object' && !Array.isArray(cf)) {
    const names = Object.keys(cf).filter((k) => !PROTO_KEYS.has(k));
    const hasVal = (e) => e && typeof e === 'object' && !Array.isArray(e);
    if (sprintField) for (const k of names) { const e = cf[k]; if (hasVal(e) && e.id === sprintField) return { found: true, value: e.value }; }
    if (names.includes('Sprint') && hasVal(cf.Sprint)) return { found: true, value: cf.Sprint.value };
  }
  if (sprintField && own(f, sprintField) !== undefined) return { found: true, value: own(f, sprintField) };
  return { found: false };
}
/** @param {any} raw @param {{ sprintField?: string }} [opts] */
export function normalizeIssue(raw, { sprintField } = {}) {
  if (!raw || typeof raw.key !== 'string' || !KEY_RE.test(raw.key)) return null;
  const f = raw.fields && typeof raw.fields === 'object' ? raw.fields : {};
  const links = [];
  for (const l of Array.isArray(f.issuelinks) ? f.issuelinks : []) {
    for (const [dir, side, rel] of [['in', l?.inwardIssue, l?.type?.inward], ['out', l?.outwardIssue, l?.type?.outward]]) if (side && KEY_RE.test(str(side.key))) links.push({ key: side.key, type: oneLine(str(l.type?.name), 80), dir, rel: oneLine(str(rel), 80) });
  }
  links.sort((a, b) => cmp(a.key, b.key) || cmp(a.type, b.type) || cmp(a.dir, b.dir));
  const out = { key: raw.key, summary: sanitizeText(str(f.summary), { max: 300 }), status: oneLine(str(f.status?.name), 80), assignee: sanitizeText(str(f.assignee?.displayName), { max: 300 }), updated: str(f.updated), resolutiondate: str(f.resolutiondate), issuelinks: links };
  const sp = sprintValue(f, sprintField);
  if (sprintField || sp.found) out.sprint = sprintsOf(sp.value);
  return out;
}
function boundedJql(jql) {
  const s = typeof jql === 'string' ? jql.trim() : '';
  const m = /\border\s+by\b[^"']*$/i.exec(s); const base = (m ? s.slice(0, m.index) : s).trim();
  if (!base) throw new JiraError('unbounded_jql', 'refusing an empty or ORDER BY-only JQL: Jira rejects it, add a restriction (for example project = ABC)');
  if (base.length > 20000) throw new JiraError('bad_jql', 'JQL is too long');
  return base;
}
function normalizeFields(fields, sprintField) {
  const f = fields === undefined ? [...DEFAULT_FIELDS] : fields;
  if (!Array.isArray(f) || !f.length || !f.every((x) => typeof x === 'string' && /^[A-Za-z][A-Za-z0-9_.-]*$/.test(x))) throw new JiraError('bad_fields', 'fields must be an explicit non-empty list of field ids (no *all, no negations)');
  const set = new Set(f); set.add('updated'); if (sprintField) set.add(sprintField);
  return [...set].sort();
}
const hash = (issues) => crypto.createHash('sha256').update(JSON.stringify(issues)).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** @param {any} client @param {Record<string, any>} [opts] @returns {Promise<Record<string, any>>} */
export async function pullSnapshot(client, opts = {}) {
  const { jql, previous = null, full = false, overlapMinutes = 5, fullReconcileEvery = 0, pageSize = 100, maxPages = 2000, sprintField, driftAbs = 5, driftPct = 0.02 } = opts;
  const base = boundedJql(jql); const fields = normalizeFields(opts.fields, sprintField);
  const me = await client.verify(); // throws on 401 / anonymous: nothing is fetched
  const prev = previous && previous.schema === SCHEMA && previous.meta && previous.meta.complete === true && previous.meta.jql === base && previous.meta.mode === client.mode
    && Object.entries(client.identity).every(([k, v]) => previous.meta[k] === v) && Array.isArray(previous.issues) ? previous : null;
  let reason = full ? 'flag' : !prev ? 'no-previous' : fullReconcileEvery > 0 && (prev.meta.delta_runs || 0) + 1 >= fullReconcileEvery ? 'reconcile' : '';
  let clause = null;
  if (!reason) {
    let ref = opts.since !== undefined ? new Date(opts.since).getTime() : prev.issues.map((i) => parseJiraTime(i.updated)).filter(Number.isFinite).reduce((m, x) => Math.max(m, x), -Infinity);
    if (!Number.isFinite(ref)) ref = Date.parse(prev.meta.fetched_at); // no usable updated stamps: fall back to the fetch time
    clause = formatSince(ref - overlapMinutes * 60000, me.timeZone);
    if (!clause) reason = me.timeZone ? 'bad-since' : 'no-timezone';
  }
  const delta = !reason; const warnings = [];
  if (!delta && reason === 'no-timezone') warnings.push('delta_unavailable:no-timezone');
  const queryJql = `${delta ? `(${base}) AND updated >= "${clause}"` : base} ORDER BY key ASC`;

  const got = new Map(); let rows = 0, dropped = 0, failure = null;
  try {
    let cursor = null, pages = 0, empties = 0;
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
  } catch (e) { failure = e; }
  if (failure) {
    const code = failure instanceof JiraError ? failure.code : 'internal';
    const error = redact(failure instanceof JiraError ? failure.message : `unexpected error: ${failure && failure.message}`);
    const r = { ok: false, complete: false, snapshot: null, code, error, resetAt: failure.resetAt, received: rows, warnings, changedKeys: [], removedKeys: [] };
    r.summary = `INCOMPLETE after ${got.size} issues (${code}${r.resetAt ? `, resets ${r.resetAt}` : ''}): ${error}; nothing written`;
    return r;
  }
  if (dropped) warnings.push(`invalid_key_dropped:${dropped}`);

  const merged = new Map(delta || prev ? prev.issues.map((i) => [i.key, i]) : []);
  const changedKeys = []; let merged2;
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

  let expected = null;
  try { expected = await client.count(base); } catch { /* reconciliation is advisory */ }
  const drift = expected === null ? null : issues.length - expected;
  if (expected === null) warnings.push('count_unavailable');
  else if (Math.abs(drift) > Math.max(driftAbs, Math.ceil(expected * driftPct))) warnings.push('count_drift');
  const meta = { jql: base, fetched_at: client.now().toISOString(), mode: client.mode, ...client.identity, expected_count: expected, received_count: issues.length, count_drift: drift, complete: true, content_hash: hash(issues), pull: delta ? 'delta' : 'full', delta_runs: delta ? (prev.meta.delta_runs || 0) + 1 : 0 };
  const snapshot = { schema: SCHEMA, meta, issues };
  const r = { ok: true, complete: true, snapshot, mode: meta.pull, changedKeys, removedKeys, received: rows, warnings, windowMinutes: overlapMinutes, reason };
  r.summary = summarize(r);
  return r;
}

export function summarize(r) {
  if (!r.ok) return r.summary;
  const m = r.snapshot.meta;
  const how = r.mode === 'delta' ? `delta ${r.changedKeys.length}, window ${r.windowMinutes}m` : `full${r.removedKeys.length ? `, removed ${r.removedKeys.length}` : ''}`;
  return `pulled ${m.received_count} issues (${how}), drift ${m.count_drift ?? 'n/a'}, complete, hash ${m.content_hash.slice(0, 6)}${r.warnings.length ? `, WARN ${r.warnings.join('+')}` : ''}`;
}

// Import issue JSON that something else already fetched (the Atlassian connector's saved result, a REST export): no credentials, no network.
// Accepts {issues:{nodes:[..]}} (connector), {issues:[..]}, {nodes:[..]}, a bare array, or one issue. Only the needed fields are kept (no
// descriptions, no emails). An issue that carries no issuelinks keeps the links already known (the connector's compact view omits them).
// The result is marked complete:false: it is a partial update, never a reconciled full snapshot.
const KEPT_WHEN_ABSENT = ['summary', 'status', 'assignee', 'updated', 'resolutiondate'];
/** @param {any} previous @param {any} input @param {{ sprintField?: string, now?: () => Date }} [opts] */
export function importIssues(previous, input, { sprintField, now = () => new Date() } = {}) {
  const rows = Array.isArray(input) ? input : Array.isArray(input?.issues) ? input.issues : Array.isArray(input?.issues?.nodes) ? input.issues.nodes : Array.isArray(input?.nodes) ? input.nodes : (input && typeof input.key === 'string' ? [input] : null);
  if (!rows) throw new JiraError('bad_input', 'no issues found in the input (expected an array, {issues:[..]}, {issues:{nodes:[..]}} or one issue)');
  const prev = previous && Array.isArray(previous.issues) ? previous : null;
  const merged = new Map((prev ? prev.issues : []).map((i) => [i.key, i]));
  const changedKeys = []; let dropped = 0, imported = 0;
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
  const meta = { ...(prev ? prev.meta : {}), source: 'import', imported_at: now().toISOString(), received_count: issues.length, complete: false, pull: 'import', content_hash: hash(issues) };
  const snapshot = { schema: SCHEMA, meta, issues };
  changedKeys.sort();
  return { snapshot, imported, dropped, changedKeys, summary: `imported ${imported} issue(s) (changed ${changedKeys.length}, dropped ${dropped}); snapshot now ${issues.length} issues, partial, hash ${meta.content_hash.slice(0, 6)}` };
}

// merge-friendly serialization: line 1 = {schema, meta}, then one issue per line sorted by key
export const snapshotToJsonl = (s) => [JSON.stringify({ schema: s.schema, meta: s.meta }), ...s.issues.map((i) => JSON.stringify(i))].join('\n') + '\n';
export function parseSnapshotJsonl(text) {
  const [head, ...issues] = parseJsonl(text, 'snapshot.jsonl');
  if (!head || head.schema !== SCHEMA || !head.meta) throw new JiraError('bad_snapshot', 'unsupported snapshot schema');
  return { schema: head.schema, meta: head.meta, issues };
}
// shape the pre-lib bin/brain consumers read: { KEY: { summary, status, assignee, updated, resolved, blockedBy } }
export function toLegacyMap(s) {
  return Object.fromEntries(s.issues.map((i) => [i.key, { summary: i.summary, status: i.status, assignee: i.assignee, updated: i.updated, resolved: i.resolutiondate, blockedBy: i.issuelinks.filter((l) => l.dir === 'in').map((l) => l.key) }]));
}

export async function fetchChangelog(client, key) {
  if (!KEY_RE.test(String(key))) throw new JiraError('bad_key', 'not a Jira issue key');
  await client.verify();
  return (await client.changelog(key)).map((h) => ({ id: str(h.id), created: str(h.created), author: str(h.author?.displayName), items: (h.items || []).map((x) => ({ field: str(x.field), from: str(x.fromString), to: str(x.toString) })) }));
}

// ---------------------------------------------------------------- issue text (ADF -> text)
// Same flattening as the previous bin/brain adf(); the only addition is a depth guard because the input is untrusted JSON.
// `content` must be an array (anything else is a JiraError bad_input, a data error), a heading level is clamped to 1..6 (default 2).
const contentOf = (n) => {
  if (n.content == null) return [];
  if (!Array.isArray(n.content)) throw new JiraError('bad_input', 'issue text is not valid ADF: "content" must be an array');
  return n.content;
};
const headingLevel = (n) => { const l = n.attrs && n.attrs.level; return Number.isInteger(l) ? Math.min(6, Math.max(1, l)) : 2; };
export function adfToText(n, depth = 0) {
  if (n == null || depth > 100) return ''; if (typeof n === 'string') return n;
  const kids = contentOf(n).map((c) => adfToText(c, depth + 1)).join('');
  switch (n.type) {
    case 'text': return n.text || '';
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
function cutFenced(s, n) {
  if (n > 0 && /[\uD800-\uDBFF]/.test(s[n - 1])) n--;
  let t = s.slice(0, Math.max(0, n));
  const lt = t.lastIndexOf('<');
  if (lt >= 0) { const tail = t.slice(lt); if ('</untrusted>'.startsWith(tail) || '<untrusted '.startsWith(tail) || /^<untrusted [^>\n]*$/.test(tail)) t = t.slice(0, lt); }
  const opens = (t.match(/<untrusted /g) || []).length, closes = (t.match(/<\/untrusted>/g) || []).length;
  return opens > closes ? `${t}\n</untrusted>` : t;
}
export function renderIssue(key, j, { maxChars = 30000 } = {}) {
  const f = (j && j.fields) || {}; const cs = f.comment?.comments || [];
  key = sanitizeText(key, { max: 40 }).replace(/\s+/g, ' ').trim(); const src = `jira:${key}`;
  // header and list text is one line with every <untrusted tag neutralized (no forged closing tag); a fence always starts its own line
  const line = (v) => neutralizeTags(sanitizeText(v, { max: 300 }).replace(/\n+/g, ' '));
  const desc = adfToText(f.description).trim();
  const summary = line(f.summary || '');
  let out = `# ${key}\nStatus: ${line(f.status?.name || '')} | updated ${line(f.updated || '')}\n\n## Summary\n${summary ? fence('summary', summary, { src, max: 300 }) : '(empty)'}\n\n## Description\n${desc ? fence('description', desc, { src, max: maxChars }) : '(empty)'}\n\n## Comments (${cs.length})\n`;
  for (const c of cs) out += `- [${line(c.author?.displayName || 'unknown')}, ${line(c.created)}]:\n${fence('comment', adfToText(c.body).trim().replace(/\n+/g, ' '), { src, max: 5000 })}\n`;
  if (Number(f.comment?.total) > cs.length) out += `... ${f.comment.total - cs.length} more comments not fetched\n`;
  return out.length > maxChars ? `${cutFenced(out, maxChars)}\n... ${out.length - maxChars} more chars\n` : out;
}
export async function fetchIssueText(client, key, opts = {}) {
  if (typeof key !== 'string' || !KEY_RE.test(key)) throw new JiraError('bad_key', 'not a Jira issue key (expected like ABC-123)');
  await client.verify();
  return renderIssue(key, await client.issue(key, ['summary', 'status', 'updated', 'description', 'comment']), opts);
}
