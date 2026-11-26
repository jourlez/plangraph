// lib/jira/registry.ts: parsing of the user-level registry file (~/.config/plangraph/jira-sites.json). It reads no file: callers pass the text.
import { oneLine } from '../sanitize.ts';
import { isAuthMode } from './types.ts';
import type { AliasEntry, ParsedRegistry, ProjectEntry, RawRegistryFile, SiteEntry } from './types.ts';

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/, SERVICE_RE = /^[A-Za-z0-9._:@-]{1,100}$/, HOST_RE = /^[a-z0-9](?:[a-z0-9.-]{0,120}[a-z0-9])?(?::\d{1,5})?$/;
const REPO_HASH_RE = /^[0-9a-f]{64}$/, MAX_REPOS = 256;
/** The shape of an alias name (a committed `jira.tenant` and the keys of `aliases`). Names that are members of Object.prototype are refused too (isAliasName). */
export const ALIAS_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const RESERVED = new Set(Object.getOwnPropertyNames(Object.prototype)); // `constructor` matches ALIAS_RE; no alias may carry a prototype member's name
/** true when `x` is a usable alias name: a string of the ALIAS_RE shape that is not a member of Object.prototype. */
export const isAliasName = (x: unknown): x is string => typeof x === 'string' && ALIAS_RE.test(x) && !RESERVED.has(x);

/** Copies the known tenant fields of a registry entry (a project or an alias) into `o`. */
function tenantFields(e: NonNullable<RawRegistryFile['projects']>[string] & object, o: ProjectEntry): void {
  for (const k of ['base_url', 'cloud_id', 'jql', 'sprint_field'] as const) if (typeof e[k] === 'string' && e[k] && e[k].length <= 2000) o[k] = e[k];
  if (e.auth && typeof e.auth === 'object' && isAuthMode(e.auth.mode)) o.auth = { mode: e.auth.mode };
}
/** One credential source entry. `who` names it in a problem ("site acme.example", "alias work"), `field` prefixes the field name ("credentials."). */
function credentialEntry(e: object, who: string, field: string, problems: string[]): SiteEntry {
  const r = e as Record<string, unknown>, out: SiteEntry = {};
  for (const k of ['email_env', 'token_env'] as const) if (r[k] !== undefined) { if (typeof r[k] === 'string' && ENV_NAME_RE.test(r[k])) out[k] = r[k]; else problems.push(`${who}: ${field}${k} is not an env var name`); }
  if (r.op_ref !== undefined) { if (typeof r.op_ref === 'string' && /^op:\/\/[^\s]+$/.test(r.op_ref)) out.op_ref = r.op_ref; else problems.push(`${who}: ${field}op_ref must look like op://vault/item/field`); }
  if (r.keychain !== undefined) { if (typeof r.keychain === 'string' && SERVICE_RE.test(r.keychain)) out.keychain = r.keychain; else problems.push(`${who}: ${field}keychain is not a service name`); }
  return out;
}
const isPlainObject = (x: unknown): x is Record<string, unknown> => Boolean(x) && typeof x === 'object' && !Array.isArray(x);

/** Validates the user-level registry; returns a null-prototype map host -> entry, dropping anything malformed (reported in `problems`). */
export function parseSiteRegistry(text: string): ParsedRegistry {
  const reg: Record<string, SiteEntry> = Object.create(null), problems: string[] = [];
  const aliases: Record<string, AliasEntry> = Object.create(null), projects: Record<string, ProjectEntry> = Object.create(null);
  let j: RawRegistryFile | null; try { j = JSON.parse(text); } catch { return { reg, projects, aliases, problems: ['jira-sites.json is not valid JSON'] }; }
  if (j && typeof j === 'object' && j.projects && typeof j.projects === 'object') {
    for (const [root, e] of Object.entries(j.projects)) {
      if (!root.startsWith('/') || root.includes('\0') || !e || typeof e !== 'object') { problems.push(`project ${oneLine(root, 60)}: needs an absolute path and an object`); continue; }
      const o: ProjectEntry = {};
      tenantFields(e, o);
      if (Object.keys(o).length) projects[root.replace(/\/+$/, '')] = o; else problems.push(`project ${oneLine(root, 60)}: no usable field`);
    }
  }
  if (isPlainObject(j) && isPlainObject(j.aliases)) {
    for (const [name, e] of Object.entries(j.aliases)) {
      if (!isAliasName(name)) { problems.push(`alias ${oneLine(name, 40)}: the name must match ALIAS_RE ${ALIAS_RE.source}`); continue; }
      if (!isPlainObject(e)) { problems.push(`alias ${name}: needs an object`); continue; }
      const o: AliasEntry = {}, who = `alias ${name}`;
      tenantFields(e as never, o);
      if (e.credentials !== undefined) {
        if (isPlainObject(e.credentials)) {
          const before = problems.length, c = credentialEntry(e.credentials, who, 'credentials.', problems);
          if (problems.length > before) o.invalid = (problems[before] as string).slice(who.length + 2); // the first bad field, named, for the refusal at resolution
          if (Object.keys(c).length) o.credentials = c; else if (problems.length === before) problems.push(`${who}: credentials has no credential source`);
        } else { problems.push(`${who}: credentials must be an object`); o.invalid = 'credentials must be an object'; }
      }
      if (e.repos !== undefined) {
        const repos = Array.isArray(e.repos) ? e.repos.filter((x): x is string => typeof x === 'string' && REPO_HASH_RE.test(x)).slice(0, MAX_REPOS) : [];
        if (!Array.isArray(e.repos) || repos.length !== e.repos.length) problems.push(`${who}: repos holds only SHA-256 hex strings (dropped the others)`);
        if (repos.length) o.repos = [...new Set(repos)];
      }
      if (Object.keys(o).length) aliases[name] = o; else problems.push(`${who}: no usable field`);
    }
  }
  const sites = j && typeof j === 'object' && j.sites && typeof j.sites === 'object' ? j.sites : (Object.keys(projects).length || Object.keys(aliases).length ? {} : null);
  if (!sites) return { reg, projects, aliases, problems: [...problems, 'jira-sites.json needs a "sites" object'] };
  for (const [h, e] of Object.entries(sites)) {
    const host = h.toLowerCase();
    if (!HOST_RE.test(host) || !e || typeof e !== 'object') { problems.push(`site ${oneLine(h, 60)}: bad host or entry`); continue; }
    const out = credentialEntry(e, `site ${host}`, '', problems);
    if (!Object.keys(out).length) { problems.push(`site ${host}: no credential source`); continue; }
    reg[host] = out;
  }
  return { reg, projects, aliases, problems };
}
