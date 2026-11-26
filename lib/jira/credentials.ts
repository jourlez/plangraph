// lib/jira/credentials.ts: credential resolution (environment, 1Password, OS keychain) and the binding of credentials to one host.
// defaultExec and finishCreds stay module-private.
import { execFile } from 'node:child_process';
import { JiraError } from './error.ts';
import { registerSecret } from './redact.ts';
import type { CredentialOptions, Exec, JiraCredentials, SiteEntry } from './types.ts';

// ---------------------------------------------------------------- credentials
function defaultExec(file: string, args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => execFile(file, args, { timeout: 10000, maxBuffer: 65536, windowsHide: true }, (e, out) => (e ? reject(new Error('helper failed')) : resolve(String(out)))));
}
const EMAIL_RE = /^[^\s:@]+@[^\s:@]+$/, TOKEN_RE = /^[\x21-\x7e]{8,}$/;
function finishCreds(email: string, token: string, source: string): JiraCredentials {
  if (email && !EMAIL_RE.test(email)) throw new JiraError('bad_credentials', 'JIRA_EMAIL is not an email address');
  if (!TOKEN_RE.test(token || '')) throw new JiraError('bad_credentials', `token from ${source} is malformed (8+ printable characters, no spaces)`);
  registerSecret({ raw: token }, email ? Buffer.from(`${email}:${token}`).toString('base64') : '');
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
