// Which Jira tenant a brain dir talks to, and the user-level registry that binds each tenant to its own credential source.
// The registry lives outside every repository (never committed) and holds NAMES and references only: env var names, an op:// ref or a
// keychain service. A secret is never stored here. lib/jira.mjs stays free of fs; this module does the reading.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSiteRegistry } from '../lib/jira.mjs';

const MAX_REGISTRY = 64 * 1024;

/** Directory of the user-level config: BRAIN_CONFIG_DIR, else $XDG_CONFIG_HOME/open-brain, else ~/.config/project-brain. */
export function configDir(env = {}) {
  if (env.BRAIN_CONFIG_DIR) return path.resolve(String(env.BRAIN_CONFIG_DIR));
  const base = env.XDG_CONFIG_HOME ? String(env.XDG_CONFIG_HOME) : path.join(env.HOME || os.homedir(), '.config');
  return path.join(base, 'open-brain');
}
export const registryFile = (env = {}) => path.join(configDir(env), 'jira-sites.json');

/** @returns {{ file: string, exists: boolean, reg: Record<string, any>, projects: Record<string, any>, problems: string[] }} */
export function loadRegistry(env = {}) {
  const file = registryFile(env);
  let st; try { st = fs.lstatSync(file); } catch { return { file, exists: false, reg: Object.create(null), projects: Object.create(null), problems: [] }; }
  if (!st.isFile()) return { file, exists: true, reg: Object.create(null), projects: Object.create(null), problems: ['jira-sites.json is not a regular file (a symlink is refused)'] };
  if (st.size > MAX_REGISTRY) return { file, exists: true, reg: Object.create(null), projects: Object.create(null), problems: ['jira-sites.json is larger than 64 KiB'] };
  const { reg, projects, problems } = parseSiteRegistry(fs.readFileSync(file, 'utf8'));
  return { file, exists: true, reg, projects, problems };
}

/** The tenant key credentials are bound to: the cloud id for a scoped token, else the site or Data Center host. '' when it cannot be told. */
export function tenantOf(cfg = {}, env = {}) {
  const mode = cfg.auth?.mode || 'scoped';
  if (mode === 'scoped') return String(cfg.cloud_id || '').toLowerCase();
  const url = env.JIRA_BASE_URL || cfg.base_url;
  try { return new URL(String(url)).host.toLowerCase(); } catch { return ''; }
}

/**
 * The Jira settings of one project: the committed config.jira (optional, may be empty) with the user-level `projects` entry for this
 * repository root laid over it. A project can therefore keep its tenant (site, cloud id, JQL) out of the repository entirely: nothing about
 * a company has to be committed, which matters for public repositories.
 */
export function effectiveJira(committed = {}, root = '', env = {}) {
  const u = loadRegistry(env).projects[String(root).replace(/\/+$/, '')] || {};
  // userTenant: the site or cloud id came from the user's own file, not from a committed (untrusted) config, so generic credentials may go there
  return { ...committed, ...u, ...(u.auth || committed.auth ? { auth: u.auth || committed.auth } : {}), userTenant: Boolean(u.base_url || u.cloud_id) };
}

export const AUTH_MODES = Object.freeze({ SCOPED: 'scoped', SITE_TOKEN: 'site-token', DATACENTER: 'datacenter' });

/**
 * The ONE place that decides which tenant a project talks to and whether the generic credentials may be used for it. `jira-pull` (which
 * acts on the decision) and `brain doctor` (which only describes it) both call this, so they cannot disagree.
 * @param {any} committed the committed config.jira block (untrusted, may be empty)
 * @param {string} root the repository root
 * @param {Record<string, string | undefined>} env
 */
export function resolveTenant(committed, root, env = {}) {
  const jira = effectiveJira(committed || {}, root, env), tenant = tenantOf(jira, env), mode = jira.auth?.mode || AUTH_MODES.SCOPED;
  const registry = loadRegistry(env), entry = tenant && Object.hasOwn(registry.reg, tenant) ? registry.reg[tenant] : null;
  const pins = String(env.BRAIN_JIRA_SITES || '').toLowerCase().split(',').map((x) => x.trim()).filter(Boolean);
  const pinned = tenant !== '' && pins.includes(tenant.split(':')[0]);
  // Generic credentials only go where the host is NOT chosen by a committed config: a fixed gateway or a user-allowlisted Data Center host,
  // a site the user pinned, or a site the user named in their own file.
  const allowGeneric = mode !== AUTH_MODES.SITE_TOKEN || pinned || jira.userTenant === true;
  return { jira, tenant, mode, registry, entry, pinned, allowGeneric };
}
