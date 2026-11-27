// lib/fetch/confluence.ts: read-only Confluence Cloud v2 fetch through an injected Runner. `limit` and `cursor` paging (the next link comes from
// the Link header or `_links.next`, path only: an answer never chooses the host), serial, Retry-After stops. Bodies are converted to plain text
// and capped. Rows are the input of the `confluence` provider (observations of type `x-confluence.page`); print their text only through fence().
import { sanitizeText } from '../sanitize.ts';
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_ITEMS, httpGet, nextPath, note } from './gh.ts';
import type { Runner } from './gh.ts';

const API = '/wiki/api/v2/';
const DEFAULT_BODY_MAX = 2000;
const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ' };

/** Storage-format markup to plain text: scripts, styles, comments and macros dropped, block tags become spaces, entities decoded once, capped with a visible marker. */
export function toPlainText(markup: string, max: number): string {
  const t = String(markup)
    .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ')
    .replace(/<(ac:[a-z-]+)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ')
    .replace(/<\/?(?:p|br|div|li|ul|ol|tr|td|th|h[1-6]|table|pre|blockquote)\b[^>]*>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]{2,6}));/gi, (m, d, h, n) => (n ? NAMED[String(n).toLowerCase()] ?? m : (() => { const c = d ? Number(d) : parseInt(h, 16); return c > 0 && c <= 0x10ffff ? String.fromCodePoint(c) : m; })()))
    .replace(/\s+/g, ' ').trim();
  return sanitizeText(t, { max });
}

interface ConfRow { id: string; title: string; status: string; version: number; updated: string; labels: string[]; text: string }
export interface ConfResult { status: 'ok' | 'retry-after' | 'capped' | 'soft'; rows: ConfRow[]; /** The path to resume at, or '' when every page was read. */ next: string; retryAfter?: number; notes: string[] }
export interface ConfOpts { space: string; labels?: readonly string[]; cursor?: string; full?: boolean; bodyMax?: number; maxItems?: number; maxBytes?: number }
const isObj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);

export async function fetchConfluence(run: Runner, o: ConfOpts): Promise<ConfResult> {
  const orig = o.cursor ?? '';
  const soft = (n: string): ConfResult => ({ status: 'soft', rows: [], next: orig, notes: [n] });
  if (typeof o.space !== 'string' || !/^\d{1,20}$/.test(o.space)) return soft('fetch confluence: the space must be a numeric space id');
  const maxItems = o.maxItems ?? DEFAULT_MAX_ITEMS, maxBytes = o.maxBytes ?? DEFAULT_MAX_BYTES, bodyMax = o.bodyMax ?? DEFAULT_BODY_MAX;
  const want = new Set((o.labels ?? []).map(String));
  const rows: ConfRow[] = [], notes: string[] = [], seen = new Set<string>();
  let p = !o.full && orig.startsWith(API) ? orig : `${API}spaces/${o.space}/pages?limit=100&body-format=storage`, bytes = 0, skipped = 0;
  const done = (status: ConfResult['status'], next: string, extra: Partial<ConfResult> = {}): ConfResult => {
    if (skipped) notes.push(`fetch confluence: ${skipped} page(s) without a configured label skipped`);
    return { status, rows, next, notes, ...extra };
  };
  for (;;) {
    if (seen.has(p)) return soft('fetch confluence: paging loop');
    seen.add(p);
    const r = await httpGet(run, p);
    if (r.kind === 'soft') return soft(`fetch confluence: ${r.note}`);
    if (r.kind === 'retry') { notes.push(`fetch confluence: Retry-After ${r.after}s, stopped; cursor kept`); return done('retry-after', p, { retryAfter: r.after }); }
    bytes += r.bytes;
    if (bytes > maxBytes) { notes.push(`fetch.max_bytes ${maxBytes} reached: ${rows.length} pages kept, stopped before the next page`); return done('capped', p); }
    let j: unknown;
    try { j = JSON.parse(r.body); } catch { j = null; }
    if (!isObj(j) || !Array.isArray(j.results)) return soft(`fetch confluence: ${note('the answer has no results list')}`);
    for (const it of j.results) {
      if (!isObj(it) || typeof it.id !== 'string' || !/^\d{1,20}$/.test(it.id)) continue;
      const lab = isObj(it.labels) && Array.isArray(it.labels.results) ? it.labels.results.flatMap((l) => (isObj(l) && typeof l.name === 'string' ? [l.name] : [])) : [];
      if (want.size && !lab.some((l) => want.has(l))) { skipped++; continue; }
      if (rows.length >= maxItems) { notes.push(`fetch.max_items ${maxItems} reached: ${rows.length} pages kept, stopped`); return done('capped', p); }
      const v = isObj(it.version) ? it.version : {}, body = isObj(it.body) && isObj(it.body.storage) && typeof it.body.storage.value === 'string' ? it.body.storage.value : '';
      rows.push({ id: it.id, title: typeof it.title === 'string' ? it.title : '', status: typeof it.status === 'string' ? it.status : '', version: typeof v.number === 'number' ? v.number : 0, updated: typeof v.createdAt === 'string' ? v.createdAt : '', labels: lab, text: toPlainText(body, bodyMax) });
    }
    const links = isObj(j._links) && typeof j._links.next === 'string' ? j._links.next : '';
    const nx = nextPath(r.headers.get('link')) || nextPath(links ? `<${links}>; rel="next"` : '');
    if (!nx) return done('ok', '');
    if (!nx.startsWith(API)) { notes.push('fetch confluence: refused a next link outside the v2 API'); return done('ok', ''); }
    if (rows.length >= maxItems) { notes.push(`fetch.max_items ${maxItems} reached: ${rows.length} pages kept, stopped`); return done('capped', nx); }
    p = nx;
  }
}
