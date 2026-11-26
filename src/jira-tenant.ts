// Which Jira tenant a plan dir talks to, and the user-level registry that binds each tenant to its own credential source.
// The registry lives outside every repository (never committed) and holds NAMES and references only: env var names, an op:// ref or a
// keychain service. A secret is never stored here. lib/jira.ts stays free of fs; this module does the reading.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { AUTH_MODES, JiraError, dcHostsFromEnv, getCredentialsFor, isAuthMode, parseSiteRegistry, siteHostsFromEnv, validateBase } from '../lib/jira.ts';
import type { AliasEntry, AuthMode, Exec, JiraCredentials, ProjectEntry, SiteEntry } from '../lib/jira.ts';
import { ALIAS_RE, isAliasName } from '../lib/jira/registry.ts';
import { gitCommonDir } from '../lib/driver.ts';
import { writeAtomicSafe } from '../lib/fsafe.ts';

/** The Jira settings of one project: the committed config.jira block with the user's `projects` entry laid over it. */
export interface JiraSettings extends ProjectEntry {
  /** true when the tenant field the merged mode uses (cloud_id for scoped, else base_url) came from the user's own registry file, not from the (untrusted) committed config */
  userTenant?: boolean;
  /** committed config only: the NAME of an alias in the user's registry (`"tenant": "work"`); never a host. See ALIAS_RE. */
  tenant?: string;
  /** committed config only: force a full pull every N delta pulls (0 or absent: never) */
  full_reconcile_every?: number;
}
/** The user-level registry as read from disk; `exists` is false when there is no file (then every map is empty). */
export interface LoadedRegistry { file: string; exists: boolean; reg: Record<string, SiteEntry>; projects: Record<string, ProjectEntry>; aliases: Record<string, AliasEntry>; problems: string[] }
/** The one trust decision for a project: which tenant, which mode, and whether generic credentials may be sent there. */
export interface TenantResolution {
  jira: JiraSettings; tenant: string; mode: AuthMode; registry: LoadedRegistry; entry: SiteEntry | null; pinned: boolean; allowGeneric: boolean; trust: Trust;
  /** the alias that decided the tenant (named by the committed config, defined in the user's file and approved for this repository), else null */
  alias: string | null;
  /** the committed config names an alias the user's file does not define (and no projects entry decides the tenant) */
  aliasMissing: boolean;
  /** why a named alias does not resolve (missing, or not approved for this repository): one line for the refusal and for doctor; null when it resolves or none is named */
  aliasProblem: string | null;
}

declare const TRUST: unique symbol; // module-private and type-only: no object can carry the brand without a cast
/** The decision of resolveTenant as a token a networked tracker member requires. The tenant is part of the decision, so a trust minted for one
 * site cannot be presented for another. Type-level brand only: isMintedTrust is the runtime check (a cast or a spread copy is not minted). */
export type Trust = { readonly tenant: string; readonly allowGeneric: boolean; readonly pinned: boolean; readonly userTenant: boolean; readonly [TRUST]: true };
// Every trust resolveTenant minted, with the resolution it stands for. A WeakMap keyed by identity: a copy of a trust is not in it.
const MINTED = new WeakMap<object, TenantResolution>();
/** true only for an object resolveTenant minted (not for a hand-built object, a cast, or a copy of a minted trust). */
export function isMintedTrust(t: unknown): t is Trust { return typeof t === 'object' && t !== null && MINTED.has(t); }
/** The resolution a minted trust stands for. @throws JiraError bad_config for anything else, before any helper runs. */
export function resolutionOf(t: Trust): TenantResolution {
  const r = isMintedTrust(t) ? MINTED.get(t) : undefined;
  if (!r) throw new JiraError('bad_config', 'the tracker needs a tenant decision minted by resolveTenant');
  return r;
}

const MAX_REGISTRY = 64 * 1024;

/** Directory of the user-level config: PLANGRAPH_CONFIG_DIR, else $XDG_CONFIG_HOME/plangraph, else ~/.config/plangraph. A binding kept under the pre-rename folder is not read: `plangraph migrate-names` copies it. */
export function configDir(env: Record<string, string | undefined> = {}): string {
  if (env.PLANGRAPH_CONFIG_DIR) return path.resolve(String(env.PLANGRAPH_CONFIG_DIR));
  const base = env.XDG_CONFIG_HOME ? String(env.XDG_CONFIG_HOME) : path.join(env.HOME || os.homedir(), '.config');
  return path.join(base, 'plangraph');
}
export const registryFile = (env: Record<string, string | undefined> = {}): string => path.join(configDir(env), 'jira-sites.json');

export function loadRegistry(env: Record<string, string | undefined> = {}): LoadedRegistry {
  const file = registryFile(env);
  const none = (exists: boolean, problems: string[]): LoadedRegistry => ({ file, exists, reg: Object.create(null), projects: Object.create(null), aliases: Object.create(null), problems });
  let st: fs.Stats; try { st = fs.lstatSync(file); } catch { return none(false, []); }
  if (!st.isFile()) return none(true, ['jira-sites.json is not a regular file (a symlink is refused)']);
  if (st.size > MAX_REGISTRY) return none(true, ['jira-sites.json is larger than 64 KiB']);
  const { reg, projects, aliases, problems } = parseSiteRegistry(fs.readFileSync(file, 'utf8'));
  return { file, exists: true, reg, projects, aliases, problems };
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
export function effectiveJira(committed: JiraSettings = {}, root = '', env: Record<string, string | undefined> = {}, via: { alias?: ProjectEntry; blocked?: boolean } = {}, registry: LoadedRegistry = loadRegistry(env)): JiraSettings {
  // Layers, lowest first: the committed config, then the alias the committed config names (when it resolves; when it is blocked the committed
  // tenant fields are dropped and nothing replaces them), then the user's projects entry for this root. A layer that names ANY tenant field
  // decides the WHOLE tenant: the committed base_url, cloud_id and auth (and the alias's, for a projects entry) are dropped, so a lower layer can
  // never fill in the half the user left out (a user cloud id plus a committed site-token mode and host would otherwise aim the generic
  // credentials at the committed host).
  const lay = (base: JiraSettings, u: ProjectEntry, force = false): { merged: JiraSettings; decides: boolean; userTenant: boolean } => {
    const decides = force || Boolean(u.base_url || u.cloud_id || u.auth);
    const { base_url: _b, cloud_id: _c, auth: _a, ...rest } = base; // the lower tenant fields, dropped when this layer decides
    const merged: JiraSettings = decides ? { ...rest, ...u } : { ...base, ...u };
    // userTenant: the field the merged mode actually uses came from the user's own file, so generic credentials may go there
    const mode = merged.auth?.mode || AUTH_MODES.SCOPED;
    return { merged, decides, userTenant: decides && Boolean(mode === AUTH_MODES.SCOPED ? u.cloud_id : u.base_url) };
  };
  const a = via.alias || via.blocked ? lay(committed, via.alias || {}, via.blocked === true) : null;
  const p = lay(a ? a.merged : committed, registry.projects[String(root).replace(/\/+$/, '')] || {});
  return { ...p.merged, userTenant: p.decides ? p.userTenant : Boolean(a?.userTenant) };
}

/** The hex SHA-256 of the real path of this repository's git common directory (the key of an alias approval); null outside a git repository. */
export function repoKey(root: string): string | null {
  const c = gitCommonDir(root);
  return c ? crypto.createHash('sha256').update(c).digest('hex') : null;
}
/** The alias a committed config names: null when it names none. @throws JiraError bad_input (exit 2) when `tenant` is present and not an alias name (ALIAS_RE, no Object.prototype member): never looked up. */
export function aliasNamed(committed: JiraSettings): string | null {
  const t: unknown = committed.tenant;
  if (t === undefined) return null;
  if (!isAliasName(t)) throw new JiraError('bad_input', `jira.tenant must be an alias name (ALIAS_RE ${ALIAS_RE.source}) that names an entry of "aliases" in your jira-sites.json, never a host; see docs/JIRA.md (Keep the tenant out of the repository, portably)`);
  return t;
}
/** Records `key` as an approved repository of alias `name` in the user's registry file: the file is rewritten whole (other content kept), atomically, mode 0600. @throws JiraError bad_config when the file or the alias is unusable. */
export function approveAlias(env: Record<string, string | undefined>, name: string, key: string): void {
  const file = registryFile(env);
  let j: { aliases?: Record<string, { repos?: unknown } | null> } | null;
  try { const st = fs.lstatSync(file); if (!st.isFile() || st.size > MAX_REGISTRY) throw new Error('not usable'); j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new JiraError('bad_config', `${file} is missing, a symlink, larger than 64 KiB or not valid JSON`); }
  const e = j && typeof j === 'object' && j.aliases && typeof j.aliases === 'object' && isAliasName(name) && Object.hasOwn(j.aliases, name) ? j.aliases[name] : null;
  if (!e || typeof e !== 'object') throw new JiraError('bad_config', `alias ${name} is not defined in ${file}`);
  const repos = Array.isArray(e.repos) ? e.repos.filter((x): x is string => typeof x === 'string') : [];
  if (!repos.includes(key)) repos.push(key);
  e.repos = repos;
  writeAtomicSafe(file, `${JSON.stringify(j, null, 2)}\n`, { mode: 0o600 });
}

export { AUTH_MODES, ALIAS_RE, isAliasName };

// committed is untrusted at runtime: its auth.mode is checked here, before any credential helper runs (makeClient checks it again).
/**
 * The ONE place that decides which tenant a project talks to and whether the generic credentials may be used for it. `jira-pull` (which
 * acts on the decision) and `plangraph doctor` (which only describes it) both call this, so they cannot disagree.
 * Throws JiraError bad_config when auth.mode is not one of AUTH_MODES (compared exactly: no case folding, no trimming).
 * @param committed the committed config.jira block (untrusted, may be empty)
 * @param root the repository root
 */
export function resolveTenant(committed: JiraSettings | undefined, root: string, env: Record<string, string | undefined> = {}): TenantResolution {
  const config = committed || {}, registry = loadRegistry(env), named = aliasNamed(config); // the alias name is checked first: a bad one is a data error (exit 2), never looked up
  const pu = registry.projects[String(root).replace(/\/+$/, '')], projectDecides = Boolean(pu && (pu.base_url || pu.cloud_id || pu.auth)); // a projects entry that names a tenant wins over the alias
  let alias: string | null = null, aliasEntry: AliasEntry | null = null, aliasProblem: string | null = null, missing = false;
  if (named !== null) {
    const ae = Object.hasOwn(registry.aliases, named) ? registry.aliases[named] as AliasEntry : null; // aliases is a null-prototype map and `named` passed isAliasName
    if (!ae) { missing = true; aliasProblem = `jira.tenant names alias ${named}, which is not defined in ${registry.file}; add it under "aliases" (docs/JIRA.md, Keep the tenant out of the repository, portably)`; }
    else {
      const key = repoKey(root);
      if (!key) aliasProblem = `alias ${named} needs a git repository (its approval is keyed by the repository's common directory); this directory is not one`;
      else if (!ae.repos?.includes(key)) aliasProblem = `alias ${named} is not approved for this repository; approve it yourself in an interactive terminal (docs/JIRA.md, Approving an alias)`;
      else if (ae.invalid) throw new JiraError('bad_config', `alias ${named}: ${ae.invalid} (${registry.file})`);
      else { alias = named; aliasEntry = ae; }
    }
  }
  const blocked = aliasProblem !== null && !projectDecides;
  const { credentials: aliasCreds, repos: _repos, invalid: _invalid, ...aliasFields } = aliasEntry || {};
  const jira = effectiveJira(config, root, env, { ...(aliasEntry ? { alias: aliasFields } : {}), blocked }, registry), raw: unknown = jira.auth?.mode ?? AUTH_MODES.SCOPED; // same default as makeClient
  if (!isAuthMode(raw)) throw new JiraError('bad_config', 'auth.mode must be scoped, site-token or datacenter');
  const mode = raw, tenant = tenantOf(jira, env);
  const aliasDecides = alias !== null && !projectDecides && Boolean(aliasFields.base_url || aliasFields.cloud_id || aliasFields.auth);
  const entry = aliasDecides && aliasCreds ? aliasCreds : tenant && Object.hasOwn(registry.reg, tenant) ? registry.reg[tenant] as SiteEntry : null; // the alias's own credentials names only for the tenant it decided; Object.hasOwn on the same line
  const pins = String(env.PLANGRAPH_JIRA_SITES || '').toLowerCase().split(',').map((x) => x.trim()).filter(Boolean);
  const pinned = tenant !== '' && pins.includes(tenant.split(':')[0] as string); // split always returns at least one item
  const dcHosts = dcHostsFromEnv(env);
  // Generic credentials only go where the host is NOT chosen by a committed config (a positive list, so an unknown mode never qualifies):
  // the fixed scoped gateway, the ONLY host of the user-level Data Center allowlist (with several, a committed config could pick any of
  // them: a registry or per-host binding is required), a site the user pinned, or the tenant field the user named in their own file.
  const allowGeneric = mode === AUTH_MODES.SCOPED || (mode === AUTH_MODES.DATACENTER && dcHosts.length === 1 && dcHosts[0] === tenant) || pinned || jira.userTenant === true;
  const trust = Object.freeze({ tenant, allowGeneric, pinned, userTenant: jira.userTenant === true }) as Trust; // as Trust: the brand is type-only; minted here and recorded in MINTED
  const res: TenantResolution = { jira, tenant, mode, registry, entry, pinned, allowGeneric, trust, alias: aliasDecides ? alias : null, aliasMissing: blocked && missing, aliasProblem: blocked ? aliasProblem : null };
  MINTED.set(trust, res);
  return res;
}

/**
 * The credentials for a resolved tenant, bound to it (lib/jira.ts getCredentialsFor). An empty tenant (no cloud id in scoped mode, no usable
 * base_url otherwise) is refused HERE, before any credential helper (op, security, secret-tool) runs: the client would refuse it anyway, so
 * running a helper first only leaks that a pull was tried. The error names what is missing and points to docs/JIRA.md.
 * @param t the decision of resolveTenant
 * @param opts exec and platform: test seams for the helper calls
 */
export async function tenantCredentials(t: TenantResolution, env: Record<string, string | undefined> = {}, opts: { exec?: Exec; platform?: string } = {}): Promise<JiraCredentials> {
  if (t.aliasProblem) throw new JiraError('bad_config', t.aliasProblem); // a named alias that does not resolve never falls back to the committed fields, and no helper runs
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
  const registry: Record<string, SiteEntry> = Object.create(null);
  if (t.entry) registry[t.tenant] = t.entry;
  return getCredentialsFor(t.tenant, { env, registry, allowGeneric: t.allowGeneric, ...opts });
}

/** What makeClient is given for a resolved tenant. JIRA_BASE_URL overrides base_url; an empty base_url (as `plangraph init` writes it) counts as
 * unset, so scoped mode uses the fixed gateway instead of failing with bad_host "empty". */
export function clientBase(t: TenantResolution, env: Record<string, string | undefined> = {}): { auth: { mode?: unknown } | undefined; cloudId: unknown; baseUrl: string | undefined } {
  return { auth: t.jira.auth, cloudId: t.jira.cloud_id, baseUrl: env.JIRA_BASE_URL || t.jira.base_url || undefined };
}
