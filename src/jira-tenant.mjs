// Which Jira tenant a brain dir talks to, and the user-level registry that binds each tenant to its own credential source.
// The registry lives outside every repository (never committed) and holds NAMES and references only: env var names, an op:// ref or a
// keychain service. A secret is never stored here. lib/jira.mjs stays free of fs; this module does the reading.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSiteRegistry } from '../lib/jira.mjs';

const MAX_REGISTRY = 64 * 1024;

/** Directory of the user-level config: BRAIN_CONFIG_DIR, else $XDG_CONFIG_HOME/project-brain, else ~/.config/project-brain. */
export function configDir(env = {}) {
  if (env.BRAIN_CONFIG_DIR) return path.resolve(String(env.BRAIN_CONFIG_DIR));
  const base = env.XDG_CONFIG_HOME ? String(env.XDG_CONFIG_HOME) : path.join(env.HOME || os.homedir(), '.config');
  return path.join(base, 'project-brain');
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
