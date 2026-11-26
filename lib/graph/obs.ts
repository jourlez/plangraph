// The observation cache rows (docs/superpowers/plans/2026-11-25-graph-v2-amendment.md section 3.3): the cheap half of the provider seam, imported by
// src/db.ts at start-up, so it holds no reader of any tracker. lib/graph/provider.ts (the providers themselves) is loaded only by `plangraph import`.
import { EXT_REL_RE, isNodeType, sysOk, xidOk } from './files.ts';

export const MAX_FIELDS = 40, MAX_LINKS = 100, TEXT = 200;
export const FIELD_KEY = /^[a-z][a-z0-9_]{0,31}$/;
const isObj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);
/** The cache file of each built-in provider, relative to the plan directory (a test pins this list to PROVIDERS). */
export const CACHE_FILES: readonly string[] = Object.freeze(['cache/confluence.jsonl', 'cache/generic.jsonl', 'cache/github.jsonl', 'cache/jira.jsonl', 'cache/sp.jsonl']);

/** The problem with a cache row (a line of cache/<provider>.jsonl), or null. The cache is local text and may be edited by hand: it is checked like any input. */
export function obsProblem(r: Record<string, unknown>): string | null {
  const { sys, xid, type, fields, links, fp, seen } = r;
  if (typeof sys !== 'string' || !sysOk(sys)) return '"sys" is not a system name';
  if (typeof xid !== 'string' || !xidOk(xid)) return '"xid" is not an external id';
  if (!isNodeType(type)) return '"type" is not a node type';
  if (!isObj(fields) || Object.keys(fields).length > MAX_FIELDS || Object.entries(fields).some(([k, v]) => !FIELD_KEY.test(k) || !(v === null || typeof v === 'boolean' || typeof v === 'number' || (typeof v === 'string' && v.length <= 4 * TEXT)))) return '"fields" is not a small map of scalars';
  if (!Array.isArray(links) || links.length > MAX_LINKS || links.some((l) => !isObj(l) || typeof l.rel !== 'string' || !EXT_REL_RE.test(l.rel) || typeof l.sys !== 'string' || !sysOk(l.sys) || typeof l.xid !== 'string' || !xidOk(l.xid))) return '"links" is not a list of extension links';
  if (typeof fp !== 'string' || !/^[0-9a-f]{16}$/.test(fp)) return '"fp" is not a fingerprint';
  if (typeof seen !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(seen)) return '"seen" is not a date';
  return null;
}
/** The key order of a cache row: the columns of the index table `obs`. */
export const OBS_COLUMNS: readonly string[] = Object.freeze(['sys', 'xid', 'type', 'fields', 'links', 'fp', 'seen']);
