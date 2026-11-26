// lib/jira/registry.ts: parsing of the user-level registry file (~/.config/plangraph/jira-sites.json). It reads no file: callers pass the text.
import { oneLine } from '../sanitize.ts';
import { isAuthMode } from './types.ts';
import type { ParsedRegistry, ProjectEntry, RawRegistryFile, SiteEntry } from './types.ts';

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
