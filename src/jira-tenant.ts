// Which Jira tenant a brain dir talks to, and the user-level registry that binds each tenant to its own credential source.
// The registry lives outside every repository (never committed) and holds NAMES and references only: env var names, an op:// ref or a
// keychain service. A secret is never stored here. lib/jira.ts stays free of fs; this module does the reading.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AUTH_MODES, JiraError, dcHostsFromEnv, getCredentialsFor, isAuthMode, parseSiteRegistry, siteHostsFromEnv, validateBase } from '../lib/jira.ts';
import type { AuthMode, Exec, JiraCredentials, ProjectEntry, SiteEntry } from '../lib/jira.ts';

/** The Jira settings of one project: the committed config.jira block with the user's `projects` entry laid over it. */
export interface JiraSettings extends ProjectEntry {
  /** true when the tenant field the merged mode uses (cloud_id for scoped, else base_url) came from the user's own registry file, not from the (untrusted) committed config */
  userTenant?: boolean;
  /** committed config only: force a full pull every N delta pulls (0 or absent: never) */
  full_reconcile_every?: number;
}
/** The user-level registry as read from disk; `exists` is false when there is no file (then every map is empty). */
export interface LoadedRegistry { file: string; exists: boolean; reg: Record<string, SiteEntry>; projects: Record<string, ProjectEntry>; problems: string[] }
/** The one trust decision for a project: which tenant, which mode, and whether generic credentials may be sent there. */
export interface TenantResolution { jira: JiraSettings; tenant: string; mode: AuthMode; registry: LoadedRegistry; entry: SiteEntry | null; pinned: boolean; allowGeneric: boolean }

const MAX_REGISTRY = 64 * 1024;

/** Directory of the user-level config: PLANGRAPH_CONFIG_DIR, else $XDG_CONFIG_HOME/project-brain, else ~/.config/project-brain. The directory keeps its pre-rename name on purpose: users' Jira bindings live there. */
export function configDir(env: Record<string, string | undefined> = {}): string {
  if (env.PLANGRAPH_CONFIG_DIR) return path.resolve(String(env.PLANGRAPH_CONFIG_DIR));
  const base = env.XDG_CONFIG_HOME ? String(env.XDG_CONFIG_HOME) : path.join(env.HOME || os.homedir(), '.config');
  return path.join(base, 'project-brain');
}
export const registryFile = (env: Record<string, string | undefined> = {}): string => path.join(configDir(env), 'jira-sites.json');

export function loadRegistry(env: Record<string, string | undefined> = {}): LoadedRegistry {
  const file = registryFile(env);
  let st: fs.Stats; try { st = fs.lstatSync(file); } catch { return { file, exists: false, reg: Object.create(null), projects: Object.create(null), problems: [] }; }
  if (!st.isFile()) return { file, exists: true, reg: Object.create(null), projects: Object.create(null), problems: ['jira-sites.json is not a regular file (a symlink is refused)'] };
  if (st.size > MAX_REGISTRY) return { file, exists: true, reg: Object.create(null), projects: Object.create(null), problems: ['jira-sites.json is larger than 64 KiB'] };
  const { reg, projects, problems } = parseSiteRegistry(fs.readFileSync(file, 'utf8'));
  return { file, exists: true, reg, projects, problems };
}

/** The tenant key credentials are bound to: the cloud id for a scoped token, else the site or Data Center host. '' when it cannot be told. */
export function tenantOf(cfg: JiraSettings = {}, env: Record<string, string | undefined> = {}): string {
  const mode = cfg.auth?.mode || AUTH_MODES.SCOPED;
  if (mode === AUTH_MODES.SCOPED) return String(cfg.cloud_id || '').toLowerCase();
  const url = env.JIRA_BASE_URL || cfg.base_url;
  try { return new URL(String(url)).host.toLowerCase(); } catch { return ''; }
}

/**
 * The Jira settings of one project: the committed config.jira (optional, may be empty) with the user-level `projects` entry for this
 * repository root laid over it. A project can therefore keep its tenant (site, cloud id, JQL) out of the repository entirely: nothing about
 * a company has to be committed, which matters for public repositories.
 * A user entry that names ANY tenant field (base_url, cloud_id or auth) decides the WHOLE tenant: the committed base_url, cloud_id and auth
 * are then dropped, so a committed file can never fill in the half the user left out (a user cloud id plus a committed site-token mode and
 * host would otherwise aim the generic credentials at the committed host). Non-tenant committed fields (jql, sprint_field,
 * full_reconcile_every) still apply unless the entry sets them: they only shape the query sent to the tenant the user chose.
 */
export function effectiveJira(committed: JiraSettings = {}, root = '', env: Record<string, string | undefined> = {}): JiraSettings {
  const u: ProjectEntry = loadRegistry(env).projects[String(root).replace(/\/+$/, '')] || {};
  const userDecides = Boolean(u.base_url || u.cloud_id || u.auth);
  const { base_url: _b, cloud_id: _c, auth: _a, ...rest } = committed; // the committed tenant fields, dropped when the user entry decides
  const merged: JiraSettings = userDecides ? { ...rest, ...u } : { ...committed, ...u };
  // userTenant: the field the merged mode actually uses came from the user's own file, so generic credentials may go there
  const mode = merged.auth?.mode || AUTH_MODES.SCOPED;
  return { ...merged, userTenant: userDecides && Boolean(mode === AUTH_MODES.SCOPED ? u.cloud_id : u.base_url) };
}

export { AUTH_MODES };

// committed is untrusted at runtime: its auth.mode is checked here, before any credential helper runs (makeClient checks it again).
/**
 * The ONE place that decides which tenant a project talks to and whether the generic credentials may be used for it. `jira-pull` (which
 * acts on the decision) and `brain doctor` (which only describes it) both call this, so they cannot disagree.
 * Throws JiraError bad_config when auth.mode is not one of AUTH_MODES (compared exactly: no case folding, no trimming).
 * @param committed the committed config.jira block (untrusted, may be empty)
 * @param root the repository root
 */
export function resolveTenant(committed: JiraSettings | undefined, root: string, env: Record<string, string | undefined> = {}): TenantResolution {
  const jira = effectiveJira(committed || {}, root, env), raw: unknown = jira.auth?.mode ?? AUTH_MODES.SCOPED; // same default as makeClient
  if (!isAuthMode(raw)) throw new JiraError('bad_config', 'auth.mode must be scoped, site-token or datacenter');
  const mode = raw, tenant = tenantOf(jira, env);
  const registry = loadRegistry(env), entry = tenant && Object.hasOwn(registry.reg, tenant) ? registry.reg[tenant] as SiteEntry : null; // Object.hasOwn on the same line
  const pins = String(env.PLANGRAPH_JIRA_SITES || '').toLowerCase().split(',').map((x) => x.trim()).filter(Boolean);
  const pinned = tenant !== '' && pins.includes(tenant.split(':')[0] as string); // split always returns at least one item
  const dcHosts = dcHostsFromEnv(env);
  // Generic credentials only go where the host is NOT chosen by a committed config (a positive list, so an unknown mode never qualifies):
  // the fixed scoped gateway, the ONLY host of the user-level Data Center allowlist (with several, a committed config could pick any of
  // them: a registry or per-host binding is required), a site the user pinned, or the tenant field the user named in their own file.
  const allowGeneric = mode === AUTH_MODES.SCOPED || (mode === AUTH_MODES.DATACENTER && dcHosts.length === 1 && dcHosts[0] === tenant) || pinned || jira.userTenant === true;
  return { jira, tenant, mode, registry, entry, pinned, allowGeneric };
}

/**
 * The credentials for a resolved tenant, bound to it (lib/jira.ts getCredentialsFor). An empty tenant (no cloud id in scoped mode, no usable
 * base_url otherwise) is refused HERE, before any credential helper (op, security, secret-tool) runs: the client would refuse it anyway, so
 * running a helper first only leaks that a pull was tried. The error names what is missing and points to docs/JIRA.md.
 * @param t the decision of resolveTenant
 * @param opts exec and platform: test seams for the helper calls
 */
export async function tenantCredentials(t: TenantResolution, env: Record<string, string | undefined> = {}, opts: { exec?: Exec; platform?: string } = {}): Promise<JiraCredentials> {
  if (!t.tenant) {
    if (t.mode === AUTH_MODES.SCOPED) {
      if (env.JIRA_BASE_URL || t.jira.base_url) throw new JiraError('bad_config', 'scoped mode (the default auth.mode) needs cloud_id; for a site URL alone add "auth": {"mode": "site-token"} (see docs/JIRA.md)');
      throw new JiraError('bad_config', 'scoped mode needs a cloud_id (see docs/JIRA.md)');
    }
    // site-token or datacenter: validateBase names what is wrong with the URL (empty, not absolute, not allowlisted)
    const url = env.JIRA_BASE_URL || t.jira.base_url;
    try { validateBase(url, { mode: t.mode, dcHosts: dcHostsFromEnv(env), siteHosts: siteHostsFromEnv(env) }); } catch (e) { throw new JiraError('bad_host', `${(e as Error).message} (see docs/JIRA.md)`); } // validateBase throws only JiraError bad_host
    throw new JiraError('bad_host', `base URL rejected: no host (see docs/JIRA.md)`);
  }
  return getCredentialsFor(t.tenant, { env, registry: t.registry.reg, allowGeneric: t.allowGeneric, ...opts });
}

/** What makeClient is given for a resolved tenant. JIRA_BASE_URL overrides base_url; an empty base_url (as `brain init` writes it) counts as
 * unset, so scoped mode uses the fixed gateway instead of failing with bad_host "empty". */
export function clientBase(t: TenantResolution, env: Record<string, string | undefined> = {}): { auth: { mode?: unknown } | undefined; cloudId: unknown; baseUrl: string | undefined } {
  return { auth: t.jira.auth, cloudId: t.jira.cloud_id, baseUrl: env.JIRA_BASE_URL || t.jira.base_url || undefined };
}
