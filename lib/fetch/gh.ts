// lib/fetch/gh.ts: read-only GitHub fetch through an injected Runner (the controller wires `gh`; tests use recorded responses). GET only: every
// argv carries `--method GET` and never a field flag; serial pages of at most 100; ETag and a `since` watermark; a Retry-After stops the run.
// Also holds the HTTP pieces the other fetchers share (Runner, httpGet, nextPath). A fetch never throws to its caller: a 429, a network error or a
// bad answer gives a soft result that changes nothing.
import { oneLine } from '../sanitize.ts';
import { scrub } from './cursor.ts';

export type Runner = (argv: string[], stdin?: string) => Promise<{ code: number; out: string; err: string }>;
export const DEFAULT_MAX_ITEMS = 50000;
export const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
export const note = (s: unknown): string => oneLine(scrub(String(s)), 200);

export type Reply =
  | { kind: 'ok'; status: number; headers: Map<string, string>; body: string; bytes: number }
  | { kind: 'retry'; after: number }
  | { kind: 'soft'; note: string };

/** One GET through the runner: `api --include --method GET [-H h]... <path>`. A path never starts with a dash (no flag can be smuggled in). */
export async function httpGet(run: Runner, p: string, headers: string[] = []): Promise<Reply> {
  if (!/^[A-Za-z0-9/][A-Za-z0-9/._~%?&=:,@+*!$'()#-]*$/.test(p)) return { kind: 'soft', note: 'refused a request path with odd characters' };
  let r: { code: number; out: string; err: string };
  try { r = await run(['api', '--include', '--method', 'GET', ...headers.flatMap((h) => ['-H', h]), p]); } catch (e) { return { kind: 'soft', note: `request failed: ${note((e as Error)?.message)}` }; }
  const out = typeof r?.out === 'string' ? r.out : '';
  const cut = out.search(/\r?\n\r?\n/);
  const head = cut < 0 ? out : out.slice(0, cut), body = cut < 0 ? '' : out.slice(cut).replace(/^\r?\n\r?\n/, '');
  const m = /^HTTP\/\S+ (\d{3})/.exec(head);
  if (!m) return { kind: 'soft', note: `request failed: ${note(r?.err || 'no answer')}` };
  const status = Number(m[1]), h = new Map<string, string>();
  for (const line of head.split(/\r?\n/).slice(1)) { const i = line.indexOf(':'); if (i > 0) h.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim()); }
  const ra = h.get('retry-after');
  if ((status === 429 || status === 403 || status === 503) && ra !== undefined) { const n = Number(ra); return { kind: 'retry', after: Number.isFinite(n) && n >= 0 ? Math.min(n, 86400) : 60 }; }
  if (status === 304 || (status >= 200 && status < 300)) return { kind: 'ok', status, headers: h, body, bytes: Buffer.byteLength(out) };
  return { kind: 'soft', note: status === 429 ? 'rate limited (429) without Retry-After' : `answered ${status}` };
}

/** The request path of the `rel="next"` link of a Link header, host dropped (an answer never chooses the host), or ''. */
export function nextPath(link: string | undefined): string {
  const m = link ? /<([^>]*)>\s*;\s*rel="?next"?/.exec(link) : null;
  if (!m) return '';
  try { const u = new URL(m[1] as string, 'https://x.invalid'); return `${u.pathname}${u.search}`; } catch { return ''; }
}

export interface GhRow { number: number; title: string; headRefName: string; state: string; updated: string }
export interface GhNext { watermark: string; etag: string; page: string }
export interface GhResult { status: 'ok' | 'not-modified' | 'retry-after' | 'capped' | 'soft'; rows: GhRow[]; etag: string; next: GhNext; retryAfter?: number; notes: string[] }
export interface GhOpts { repo: string; since?: string; etag?: string; page?: string; full?: boolean; maxItems?: number; maxBytes?: number }
const REPO_RE = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
const lead = (p: string): string => p.replace(/^\//, '');

/** Pull requests of one repository, oldest update first. Rows are the input of the `github` provider (`{ repo, prs: rows }`). */
export async function fetchGithub(run: Runner, o: GhOpts): Promise<GhResult> {
  const orig: GhNext = { watermark: o.since ?? '', etag: o.etag ?? '', page: o.page ?? '' };
  const soft = (n: string): GhResult => ({ status: 'soft', rows: [], etag: orig.etag, next: orig, notes: [n] });
  if (typeof o.repo !== 'string' || !REPO_RE.test(o.repo) || o.repo.includes('..')) return soft('fetch github: the repository is not owner/name');
  const maxItems = o.maxItems ?? DEFAULT_MAX_ITEMS, maxBytes = o.maxBytes ?? DEFAULT_MAX_BYTES;
  const since = o.full ? '' : orig.watermark, resume = o.full ? '' : orig.page;
  const start = `repos/${o.repo}/pulls?per_page=100&sort=updated&direction=asc&state=all`;
  let p = resume ? lead(resume) : start, first = !resume, bytes = 0, mark = since, firstEtag = '';
  const rows: GhRow[] = [], seen = new Set<string>(), notes: string[] = [];
  const done = (status: GhResult['status'], page: string, extra: Partial<GhResult> = {}): GhResult => {
    const etag = status === 'ok' ? firstEtag || orig.etag : orig.etag; // an etag of a first page is kept only when every page was read
    return { status, rows, etag, next: { watermark: mark, etag, page }, notes, ...extra };
  };
  for (;;) {
    if (seen.has(p)) return soft('fetch github: paging loop');
    seen.add(p);
    const send = first && !o.full && orig.etag ? [`If-None-Match: ${orig.etag}`] : [];
    const r = await httpGet(run, p, ['Accept: application/vnd.github+json', ...send]);
    if (r.kind === 'soft') return soft(`fetch github: ${r.note}`);
    if (r.kind === 'retry') { notes.push(`fetch github: Retry-After ${r.after}s, stopped; cursor kept`); return done('retry-after', p, { retryAfter: r.after }); }
    if (r.status === 304) return { status: 'not-modified', rows: [], etag: orig.etag, next: orig, notes: ['fetch github: not modified (304), cache kept'] };
    bytes += r.bytes;
    if (bytes > maxBytes) { notes.push(`fetch.max_bytes ${maxBytes} reached: ${rows.length} rows kept, stopped before the next page`); return done('capped', p); }
    let list: unknown;
    try { list = JSON.parse(r.body); } catch { list = null; }
    if (!Array.isArray(list)) return soft('fetch github: the answer is not a list');
    if (first) firstEtag = r.headers.get('etag') ?? '';
    first = false;
    for (const it of list) {
      const x = it as Record<string, unknown> | null;
      if (!x || typeof x !== 'object' || typeof x.number !== 'number' || !Number.isInteger(x.number)) continue;
      const updated = typeof x.updated_at === 'string' ? x.updated_at : '';
      if (since && updated < since) continue;
      if (rows.length >= maxItems) { notes.push(`fetch.max_items ${maxItems} reached: ${rows.length} rows kept, stopped`); return done('capped', p); }
      const head = x.head as { ref?: unknown } | null;
      rows.push({ number: x.number, title: typeof x.title === 'string' ? x.title : '', headRefName: typeof head?.ref === 'string' ? head.ref : '', state: x.merged_at ? 'merged' : typeof x.state === 'string' ? x.state : 'unknown', updated });
      if (updated > mark) mark = updated;
    }
    const nx = nextPath(r.headers.get('link'));
    if (!nx) return done('ok', '');
    if (rows.length >= maxItems) { notes.push(`fetch.max_items ${maxItems} reached: ${rows.length} rows kept, stopped`); return done('capped', lead(nx)); }
    p = lead(nx);
  }
}
