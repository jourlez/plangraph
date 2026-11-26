// lib/jira/host.ts: base URL validation and the user-level host allowlists (Data Center hosts, pinned Cloud sites).
import { JiraError } from './error.ts';
import { AUTH_MODES } from './types.ts';
import type { ValidateOptions, ValidatedBase } from './types.ts';

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
