// lib/fetch/jira.ts: read-only Jira Cloud fetch through an injected Runner (`api --include --method GET <path>`; the controller maps it to the
// existing client and its keychain entry). `search/jql` with an explicit field list and `nextPageToken`, serial; the JQL watermark is
// overlapped by 5 minutes and the result is upserted on key, so a repeated issue is harmless. An optional per-ticket changelog read gives
// `x-jira.transition` observations. Never throws to the caller.
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_ITEMS, httpGet, note } from './gh.ts';
import type { Runner } from './gh.ts';

const FIELDS = 'summary,status,assignee,updated,resolutiondate,issuelinks,sprint';
const KEY_RE = /^[A-Z][A-Z0-9]*-\d+$/;
const OVERLAP_MS = 5 * 60 * 1000;
const MAX_CHANGELOG_PAGES = 20;
type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => x !== null && typeof x === 'object' && !Array.isArray(x);
const ms = (s: unknown): number => (typeof s === 'string' ? Date.parse(s) : NaN);

export interface JiraIssueRow { key: string; fields: Obj }
export interface TransitionObservation { xid: string; type: 'x-jira.transition'; fields: { from: string; to: string; at: string }; links: Array<{ rel: string; sys: string; xid: string }> }
export interface JiraOpts { jql: string; watermark?: string; changelog?: readonly string[]; tenant?: string; maxItems?: number; maxBytes?: number }
export interface JiraResult {
  status: 'ok' | 'retry-after' | 'capped' | 'aborted' | 'soft';
  /** Raw issues (the input of the `jira` provider), unique by key, sorted by key. */
  issues: JiraIssueRow[];
  nextWatermark: string;
  /** A generic batch (`plangraph-ext-batch@1`) of status transitions, or null when no changelog was asked for. */
  transitions: { schema: 'plangraph-ext-batch@1'; sys: 'x-jira'; observations: TransitionObservation[] } | null;
  retryAfter?: number; error?: string; notes: string[];
}
const jqlTime = (t: number): string => new Date(t).toISOString().slice(0, 16).replace('T', ' '); // JQL: "yyyy-MM-dd HH:mm"

export async function fetchJira(run: Runner, o: JiraOpts): Promise<JiraResult> {
  const wm = o.watermark ?? '';
  const out: JiraResult = { status: 'ok', issues: [], nextWatermark: wm, transitions: null, notes: [] };
  const fail = (status: JiraResult['status'], n: string, extra: Partial<JiraResult> = {}): JiraResult => ({ ...out, status, issues: status === 'soft' || status === 'aborted' ? [] : out.issues, nextWatermark: status === 'soft' || status === 'aborted' ? wm : out.nextWatermark, notes: [...out.notes, n], ...extra });
  const base = typeof o.jql === 'string' ? o.jql.trim() : '';
  if (!base || /\border\s+by\b/i.test(base)) return fail('soft', 'fetch jira: give a JQL filter without ORDER BY (an unbounded or ordered query is refused)');
  const wms = wm ? ms(wm) : null;
  if (wm && !Number.isFinite(wms)) return fail('soft', 'fetch jira: the watermark is not a date');
  const jql = wms === null ? `${base} ORDER BY updated ASC` : `(${base}) AND updated >= "${jqlTime((wms as number) - OVERLAP_MS)}" ORDER BY updated ASC`;
  const maxItems = o.maxItems ?? DEFAULT_MAX_ITEMS, maxBytes = o.maxBytes ?? DEFAULT_MAX_BYTES;
  const byKey = new Map<string, JiraIssueRow>(), tokens = new Set<string>();
  let bytes = 0, mark = wms ?? -Infinity, token = '';
  const watermark = (): string => (Number.isFinite(mark) ? new Date(mark).toISOString() : wm);
  const sync = (): void => { out.issues = [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : 1)); out.nextWatermark = watermark(); };

  for (;;) {
    const q = new URLSearchParams({ jql, fields: FIELDS, maxResults: '100' });
    if (token) q.set('nextPageToken', token);
    const r = await httpGet(run, `/rest/api/3/search/jql?${q.toString()}`);
    if (r.kind === 'soft') return fail('soft', `fetch jira: ${r.note}`);
    if (r.kind === 'retry') { sync(); return fail('retry-after', `fetch jira: Retry-After ${r.after}s, stopped; watermark kept at what was read`, { retryAfter: r.after }); }
    bytes += r.bytes;
    if (bytes > maxBytes) { sync(); return fail('capped', `fetch.max_bytes ${maxBytes} reached: ${byKey.size} issues kept, stopped`); }
    let j: unknown;
    try { j = JSON.parse(r.body); } catch { j = null; }
    if (!isObj(j) || !Array.isArray(j.issues)) return fail('soft', 'fetch jira: the answer has no issues list');
    for (const it of j.issues) {
      if (!isObj(it) || typeof it.key !== 'string' || !KEY_RE.test(it.key) || !isObj(it.fields)) continue;
      const old = byKey.get(it.key), t = ms(it.fields.updated);
      if (old && t < ms(old.fields.updated)) continue; // idempotent upsert: the newer copy stands
      if (!old && byKey.size >= maxItems) { sync(); return fail('capped', `fetch.max_items ${maxItems} reached: ${byKey.size} issues kept, stopped`); }
      byKey.set(it.key, { key: it.key, fields: it.fields });
      if (t > mark) mark = t;
    }
    const next = typeof j.nextPageToken === 'string' ? j.nextPageToken : '';
    if (j.isLast === true || !next) break;
    if (tokens.has(next)) return fail('aborted', 'fetch jira: paging loop', { error: 'fetch jira: paging loop' });
    tokens.add(next); token = next;
    if (byKey.size >= maxItems) { sync(); return fail('capped', `fetch.max_items ${maxItems} reached: ${byKey.size} issues kept, stopped`); }
  }
  sync();
  if (o.changelog) await readChangelogs(run, o, out, maxBytes - bytes);
  return out;
}

/** Status transitions of each given ticket, paged. A soft failure on one ticket is noted and skipped; a Retry-After or the byte cap stops the loop. */
async function readChangelogs(run: Runner, o: JiraOpts, out: JiraResult, budget: number): Promise<void> {
  const obs: TransitionObservation[] = [];
  const sys = o.tenant && /^[A-Za-z0-9._-]{1,100}$/.test(o.tenant) && !o.tenant.includes('..') ? `jira:${o.tenant}` : '';
  out.transitions = { schema: 'plangraph-ext-batch@1', sys: 'x-jira', observations: obs };
  let bytes = 0;
  for (const key of [...new Set(o.changelog)].filter((k) => KEY_RE.test(k)).sort()) {
    for (let at = 0, page = 0; page < MAX_CHANGELOG_PAGES; page++) {
      const r = await httpGet(run, `/rest/api/3/issue/${key}/changelog?startAt=${at}&maxResults=100`);
      if (r.kind === 'soft') { out.notes.push(`fetch jira: changelog of ${key} skipped: ${r.note}`); break; }
      if (r.kind === 'retry') { out.status = 'retry-after'; out.retryAfter = r.after; out.notes.push(`fetch jira: Retry-After ${r.after}s during changelogs, stopped`); return; }
      bytes += r.bytes;
      if (bytes > budget) { out.status = 'capped'; out.notes.push(`fetch.max_bytes reached during changelogs: ${obs.length} transitions kept, stopped`); return; }
      let j: unknown;
      try { j = JSON.parse(r.body); } catch { j = null; }
      const vals = isObj(j) && Array.isArray(j.values) ? j.values : [];
      for (const h of vals) {
        if (!isObj(h) || (typeof h.id !== 'string' && typeof h.id !== 'number') || !Number.isFinite(ms(h.created)) || !Array.isArray(h.items)) continue;
        const st = h.items.find((i) => isObj(i) && i.field === 'status') as Obj | undefined;
        if (!st) continue;
        const str = (v: unknown): string => (typeof v === 'string' ? note(v).slice(0, 100) : '');
        obs.push({ xid: `${key}#${String(h.id).replace(/[^0-9A-Za-z]/g, '')}`, type: 'x-jira.transition', fields: { from: str(st.fromString), to: str(st.toString), at: new Date(ms(h.created)).toISOString() }, links: sys ? [{ rel: 'x-jira/of', sys, xid: key }] : [] });
      }
      at += vals.length;
      if ((isObj(j) && j.isLast === true) || vals.length === 0) break;
    }
  }
  obs.sort((a, b) => (a.xid < b.xid ? -1 : 1));
}
