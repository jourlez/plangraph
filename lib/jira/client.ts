// lib/jira/client.ts: the read-only HTTP client (method and path allowlist, retries, rate limits, body cap). The only lib/jira module that
// touches the network.
import { oneLine } from '../sanitize.ts';
import { JiraError } from './error.ts';
import { validateBase } from './host.ts';
import { redact, registerSecret } from './redact.ts';
import { AUTH_MODES, isAuthMode } from './types.ts';
import type { ClientOptions, JiraAnswer, JiraClient, JiraErrorCode, RawAnswer, RequestOptions, SearchPage, SearchQuery } from './types.ts';

// ---------------------------------------------------------------- read-only allowlist
const K = '[A-Z][A-Z0-9]*-\\d+';
const RULES: Record<'cloud' | 'datacenter', Array<[string, RegExp]>> = {
  cloud: [
    ['GET', /^\/rest\/api\/3\/myself$/], ['POST', /^\/rest\/api\/3\/search\/jql$/], ['POST', /^\/rest\/api\/3\/search\/approximate-count$/],
    ['GET', new RegExp(`^/rest/api/3/issue/${K}$`)], ['GET', new RegExp(`^/rest/api/3/issue/${K}/changelog$`)],
    ['GET', /^\/rest\/agile\/1\.0\/board$/], ['GET', /^\/rest\/agile\/1\.0\/board\/\d+\/sprint$/], ['GET', /^\/rest\/agile\/1\.0\/sprint\/\d+\/issue$/],
    ['GET', /^\/wiki\/api\/v2\/spaces\/\d{1,20}\/pages$/], // Confluence Cloud v2: the pages of one space (sync-fetch)
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
  registerSecret({ raw: token }); if (!dc) registerSecret(Buffer.from(`${email}:${token}`).toString('base64'));
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
    const pre = path.startsWith('/wiki/') && mode === AUTH_MODES.SCOPED ? `/ex/confluence/${baseConfig.cloudId}` : prefix; // the scoped gateway has one prefix per product
    const target = `${base.origin}${base.basePath}${pre}${path}${qs}`;
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
