// GitHub provider input reader (docs/superpowers/plans/2026-11-25-graph-v2-amendment.md sections 3.3 and 3.10). Pure: no file, no network, no token.
// The input is a file an agent saved (`gh pr list --json number,title,headRefName,state` output wrapped as below, or another connector's JSON):
//   { "repo": "owner/name", "prs": [{ "number", "title", "headRefName" | "head", "state" }], "branches": ["name", ...], "projects": ["ABC"] }
// A ticket key found in a branch name or a PR title becomes a link `x-github/closes` (PR) or `x-github/for` (branch) to `jira:<tenant>`. The key
// is a hint: it is never a fact about the ticket. No URL, account id, email or author is read or kept.
import { oneLine } from '../sanitize.ts';
import { sysOk, xidOk } from './files.ts';
import type { FieldValue } from './provider.ts';

export const MAX_KEYS = 5;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
const KEY_RE = /(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,7})(?![0-9])/g;
const STATES = new Set(['open', 'closed', 'merged']);
const isObj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);

/** Ticket keys in a text, upper-cased, first-seen order, at most MAX_KEYS. With an allowlist of project keys only those match; without one a key must have 2 or more letters. */
export function ticketKeys(text: string, projects: ReadonlySet<string> | null): string[] {
  const out: string[] = [];
  for (const m of text.slice(0, 300).matchAll(KEY_RE)) {
    const project = (m[1] as string).toUpperCase(), key = `${project}-${Number(m[2])}`;
    if (projects && !projects.has(project)) continue;
    if (!out.includes(key)) out.push(key);
    if (out.length >= MAX_KEYS) break;
  }
  return out;
}

export interface RawObservation { xid: string; type: 'x-github.pr' | 'x-github.branch'; fields: Record<string, FieldValue>; links: Array<{ rel: string; sys: string; xid: string }> }
export interface GithubRead { sys: string; observations: RawObservation[]; warnings: string[]; dropped: number }

/** Normalize one GitHub input. Throws on a wrong top-level shape; a bad entry is dropped and counted. */
export function readGithub(input: unknown, tenant: string): GithubRead {
  if (!isObj(input) || typeof input.repo !== 'string' || !REPO_RE.test(input.repo)) throw new Error('a github input needs "repo": "owner/name"');
  const repo = input.repo, sys = `github:${repo}`;
  if (!sysOk(sys)) throw new Error('"repo" is not a valid system name');
  const out: GithubRead = { sys, observations: [], warnings: [], dropped: 0 };
  const jira = `jira:${tenant}`, linkable = sysOk(jira);
  if (!linkable) out.warnings.push('no tenant alias (--tenant ALIAS): ticket keys are not linked');
  const projects = Array.isArray(input.projects) ? new Set(input.projects.filter((p): p is string => typeof p === 'string' && /^[A-Za-z][A-Za-z0-9]{1,9}$/.test(p)).map((p) => p.toUpperCase())) : null;
  const links = (rel: string, texts: string[]) => linkable ? [...new Set(texts.flatMap((t) => ticketKeys(t, projects)))].slice(0, MAX_KEYS).map((k) => ({ rel, sys: jira, xid: k })) : [];
  const heads = new Set<string>();
  const prs = Array.isArray(input.prs) ? input.prs : [], branches = Array.isArray(input.branches) ? input.branches : [];
  for (const p of prs) {
    const n = isObj(p) ? p.number : undefined;
    if (!isObj(p) || typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 1e7) { out.dropped++; continue; }
    const head = typeof p.headRefName === 'string' ? p.headRefName : typeof p.head === 'string' ? p.head : '';
    const title = typeof p.title === 'string' ? p.title : '', state = typeof p.state === 'string' && STATES.has(p.state.toLowerCase()) ? p.state.toLowerCase() : 'unknown';
    const xid = `${repo}#${n}`;
    if (!xidOk(xid)) { out.dropped++; continue; }
    if (head) heads.add(head);
    out.observations.push({ xid, type: 'x-github.pr', fields: { title: oneLine(title, 200), state, branch: oneLine(head, 100) }, links: links('x-github/closes', [head, title]) });
  }
  for (const b of branches) {
    const xid = `${repo}:${typeof b === 'string' ? b : ''}`;
    if (typeof b !== 'string' || !xidOk(xid) || heads.has(b)) { if (typeof b !== 'string' || !xidOk(xid)) out.dropped++; continue; } // a branch of a PR is already covered by it
    const l = links('x-github/for', [b]);
    if (l.length) out.observations.push({ xid, type: 'x-github.branch', fields: {}, links: l }); // a branch with no key says nothing
  }
  if (out.dropped) out.warnings.push(`${out.dropped} entr${out.dropped === 1 ? 'y' : 'ies'} dropped (bad shape or id)`);
  return out;
}
