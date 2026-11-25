// lib/report.ts: the plan status report as text. Pure: no I/O, no clock, no randomness; the same inputs give the same bytes.
// buildReport(model, opts) -> { markdown, html, data }. Every piece of text that came from a file, tool or person (ticket keys,
// owners, finding kinds, dates) goes through oneLine (sanitized, one line, angle brackets removed) and is then escaped for the target
// format, so a ticket cannot forge markup, an <untrusted> fence or a terminal escape. The HTML carries no script, no event handler and
// no external resource (a Content-Security-Policy meta forbids them as well). Publishing and sharing are not done here.
import { capOf } from './model.ts';
import { oneLine, UNTRUSTED_NOTICE } from './sanitize.ts';
// The definition of ready is lib/ready.ts (shared with `plangraph ready` and `plangraph blockers`): "Can start today" is its ready set, so a
// ticket whose own status is closed is never listed there.
import { readySet } from './ready.ts';
import type { Statuses } from './ready.ts';
import type { Model } from './model.ts';
import type { OpenItem } from './openitems.ts';

/** A schedule slot with an owner and an integer sprint. */
type Placed = { owner: string; sprint: number };
/** One person-sprint of the load table. */
interface LoadCell { sprint: number; owner: string; sp: number; n: number; cap: number; over: boolean }
/** One person's row. */
interface PersonRow { owner: string; tickets: number; sp: number; ready: number; first: number; last: number }
/** buildReport options; each value is tested or converted before use. */
export interface ReportOpts {
  items?: OpenItem[]; statuses?: Statuses | null; jira?: { date?: unknown } | null; forecast?: { state?: unknown; n?: unknown } | null;
  stale?: { count?: unknown; ref?: unknown } | null;
}
/** One report section: a source label, text lines, an optional table. */
interface ReportSection { title: string; label: string; text: string[]; table?: { head: string[]; rows: string[][] } }
/** buildReport's structured answer. */
export interface ReportData {
  tickets: number; placed: number; last_sprint: number; sprint_load: LoadCell[]; over_cap: number; ready: { label: string; count: number; keys: string[] };
  blocked_by_open_item: { label: string; count: number; rows: Array<{ key: string; kinds: string[] }> }; people: PersonRow[];
  critical_chain: { label: string; hops: number; keys: string[]; loop: boolean }; stale: { label: string; count: number } | null;
  forecast: { label: string; state: string; n: number; tag: string } | null;
}

const LIMIT = 50;
const cmp = (a: string | undefined, b: string | undefined): number => ((a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0); // undefined compares false both ways (0)
const num = (n: unknown): number => (Number.isFinite(n) ? n as number : 0); // Number.isFinite is the check
const isPlaced = (s: { owner?: string | null | undefined; sprint?: number | null | undefined } | null | undefined): s is Placed => !!s && typeof s.owner === 'string' && s.owner !== '' && Number.isInteger(s.sprint);

function sprintLoad(model: Model): LoadCell[] {
  const cells = new Map<string, Omit<LoadCell, 'cap' | 'over'>>();
  for (const [k, s] of model.sched) {
    const t = model.tickets.get(k);
    if (!t || !isPlaced(s)) continue;
    const id = `${s.sprint}\t${s.owner}`, c = cells.get(id) || { sprint: s.sprint, owner: s.owner, sp: 0, n: 0 };
    c.sp += num(t.sp); c.n++; cells.set(id, c);
  }
  return [...cells.values()].map((c) => ({ ...c, cap: capOf(model.config, c.owner), over: c.sp > capOf(model.config, c.owner) })).sort((a, b) => a.sprint - b.sprint || cmp(a.owner, b.owner));
}

function perPerson(model: Model, ready: readonly string[]): PersonRow[] {
  const rd = new Set(ready), by = new Map<string, PersonRow>();
  for (const [k, s] of model.sched) {
    const t = model.tickets.get(k);
    if (!t || !isPlaced(s)) continue;
    const p = by.get(s.owner) || { owner: s.owner, tickets: 0, sp: 0, ready: 0, first: s.sprint, last: s.sprint };
    p.tickets++; p.sp += num(t.sp); if (rd.has(k)) p.ready++; p.first = Math.min(p.first, s.sprint); p.last = Math.max(p.last, s.sprint); by.set(s.owner, p);
  }
  return [...by.values()].sort((a, b) => cmp(a.owner, b.owner));
}

/** Longest dependency chain by hops (Kahn order, so no recursion depth); ties go to the smaller key; a loop is reported, not followed. */
function criticalChain(model: Model): { hops: number; chain: string[]; loop: boolean } {
  const keys = [...model.tickets.keys()].sort(cmp), indeg = new Map(keys.map((k) => [k, 0])), adj = new Map<string, string[]>(keys.map((k) => [k, []]));
  for (const k of keys) for (const p of new Set(model.prods.get(k) || [])) if (indeg.has(p) && p !== k) { indeg.set(k, (indeg.get(k) as number) + 1); (adj.get(p) as string[]).push(k); } // k and p are keys of both maps
  const depth = new Map<string, number>(), prev = new Map<string, string>(), q = keys.filter((k) => indeg.get(k) === 0);
  for (const k of q) depth.set(k, 1);
  let seen = 0;
  for (let i = 0; i < q.length; i++) {
    const u = q[i] as string; seen++; // i < q.length (loop bound)
    for (const v of (adj.get(u) as string[]).sort(cmp)) { // u is a key
      const d = (depth.get(u) as number) + 1; // u was queued with a depth
      if (!depth.has(v) || d > (depth.get(v) as number) || (d === depth.get(v) && cmp(u, prev.get(v)) < 0)) { depth.set(v, d); prev.set(v, u); } // v and u have a depth (u was queued with one)
      indeg.set(v, (indeg.get(v) as number) - 1); if (indeg.get(v) === 0) q.push(v); // v is a key
    }
  }
  let end: string | null = null;
  for (const k of keys) if (depth.has(k) && (end === null || (depth.get(k) as number) > (depth.get(end) as number))) end = k; // both have a depth
  const chain: string[] = [];
  for (let k: string | null | undefined = end; k !== undefined && k !== null && chain.length <= keys.length; k = prev.get(k)) chain.push(k);
  return { hops: chain.length ? chain.length - 1 : 0, chain: chain.reverse(), loop: seen !== keys.length };
}

// The shared notice without angle brackets: the report itself never contains a tag-like <untrusted> string, so none in it can be forged.
const NOTICE = UNTRUSTED_NOTICE.replace(/[<>]/g, '');
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** opts: { items, statuses, jira: { date }|null, forecast: { state, n }|null, stale: { count, ref }|null }. */
export function buildReport(model: Model, opts: ReportOpts = {}): { markdown: string; html: string; data: ReportData } {
  const items = opts.items || [], jiraDate = opts.jira ? (DATE.test(String(opts.jira.date)) ? String(opts.jira.date) : 'unknown date') : null;
  const rs = readySet(model, items, opts.statuses || null), load = sprintLoad(model), people = perPerson(model, rs.ready), cc = criticalChain(model);
  const placed = [...model.sched.values()].filter(isPlaced).length;
  const readyLabel = jiraDate ? `from jira snapshot dated ${jiraDate}` : 'computed';
  const fc = opts.forecast ? { state: String(opts.forecast.state), n: Math.max(0, Math.trunc(num(opts.forecast.n))) } : null;
  const st = opts.stale ? { count: Math.max(0, Math.trunc(num(opts.stale.count))), ref: oneLine(opts.stale.ref ?? '', 60) } : null;
  const place = (k: string) => { const s = model.sched.get(k); return isPlaced(s) ? { sprint: s.sprint, owner: s.owner } : null; };
  const data: ReportData = {
    tickets: model.tickets.size, placed, last_sprint: load.reduce((m, r) => Math.max(m, r.sprint), 0),
    sprint_load: load, over_cap: load.filter((r) => r.over).length,
    ready: { label: readyLabel, count: rs.ready.length, keys: rs.ready },
    blocked_by_open_item: { label: 'computed', count: rs.blocked.length, rows: rs.blocked },
    people, critical_chain: { label: 'computed', hops: cc.hops, keys: cc.chain, loop: cc.loop },
    stale: st ? { label: `computed at ${st.ref}`, count: st.count } : null,
    forecast: fc ? { label: `from history n=${fc.n}`, state: fc.state, n: fc.n, tag: 'model-conditional, not a prediction' } : null,
  };
  const T = (s: unknown, max: number = 80): string => oneLine(s, max);
  const more = (n: number) => (n > LIMIT ? `+${n - LIMIT} more` : '');
  const sections: ReportSection[] = []; // { title, label, lines: string[] | table: { head, rows } }
  sections.push({ title: 'Plan', label: 'computed', text: [`${data.tickets} tickets, ${placed} placed, last sprint ${data.last_sprint}.`] });
  sections.push({ title: 'Sprint load against capacity', label: 'computed', table: { head: ['Sprint', 'Person', 'Tickets', 'SP', 'Cap', 'State'], rows: load.slice(0, LIMIT * 4).map((r) => [String(r.sprint), T(r.owner), String(r.n), String(r.sp), String(r.cap), r.over ? 'OVER CAP' : 'ok']) }, text: [`${data.over_cap} of ${load.length} person-sprints are over their cap.${load.length > LIMIT * 4 ? ` Showing ${LIMIT * 4}.` : ''}`] });
  sections.push({ title: 'Can start today', label: readyLabel, text: [`${rs.ready.length} tickets pass the definition of ready (same rules as \`plangraph ready\`).`, rs.ready.slice(0, LIMIT).map((k) => T(k, 60)).join(', ') || 'none', more(rs.ready.length)].filter(Boolean) });
  sections.push({ title: 'Blocked by an open item', label: 'computed', table: { head: ['Ticket', 'Open items'], rows: rs.blocked.slice(0, LIMIT).map((b) => [T(b.key, 60), b.kinds.map((x) => T(x, 40)).join(', ')]) }, text: [`${rs.blocked.length} tickets have an unresolved finding or open item.${more(rs.blocked.length) ? ` ${more(rs.blocked.length)}.` : ''}`] });
  sections.push({ title: 'Per person', label: 'computed', table: { head: ['Person', 'Tickets', 'SP', 'Ready now', 'Sprints'], rows: people.slice(0, LIMIT).map((p) => [T(p.owner), String(p.tickets), String(p.sp), String(p.ready), `${p.first}-${p.last}`]) }, text: [] });
  sections.push({ title: 'Critical chain', label: 'computed', text: [`Longest dependency chain: ${cc.hops} hops${cc.loop ? ' (the links contain a loop; run `plangraph check`)' : ''}.`, cc.chain.slice(0, 30).map((k) => { const p = place(k); return p ? `${T(k, 60)} (S${p.sprint} ${T(p.owner, 40)})` : T(k, 60); }).join(' -> ') + (cc.chain.length > 30 ? ` -> ... (${cc.chain.length - 30} more)` : '')].filter((x) => x !== '') });
  sections.push({ title: 'Stale plan text', label: st ? (data.stale as { label: string }).label : 'not computed', text: [st ? `${st.count} tickets have inputs that changed since their last audit.` : 'Not computed for this report (run `plangraph stale`).'] }); // st is set: the stale data was built from it
  sections.push({ title: 'Delivery forecast', label: fc ? (data.forecast as { label: string }).label : 'not computed', text: [fc ? `State ${T(fc.state, 20)} (${(data.forecast as { tag: string }).tag}). A REFUSED or PRIOR-ONLY state means the history is too thin for a date.` : 'Not computed for this report (run `plangraph forecast`).'] }); // fc is set: the forecast data was built from it

  const mdEsc = (s: unknown) => String(s).replace(/&/g, '&amp;').replace(/[\\`*_[\]|!#~]/g, '\\$&');
  const md: string[] = ['# Plan status report', '', NOTICE, ''];
  const htmlEsc = (s: unknown) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const body: string[] = [];
  for (const s of sections) {
    // a label can carry data (the stale ref, the snapshot date): one sanitized line, escaped for the target format
    md.push(`## ${s.title}`, '', `Source: ${mdEsc(oneLine(s.label, 120))}`, '');
    body.push(`<section><h2>${htmlEsc(s.title)}</h2><p class="src">Source: ${htmlEsc(oneLine(s.label, 120))}</p>`);
    for (const l of s.text) { md.push(mdEsc(l.replace(/`/g, '')), ''); body.push(`<p>${htmlEsc(l.replace(/`/g, ''))}</p>`); }
    if (s.table && s.table.rows.length) {
      md.push(`| ${s.table.head.join(' | ')} |`, `| ${s.table.head.map(() => '---').join(' | ')} |`, ...s.table.rows.map((r) => `| ${r.map(mdEsc).join(' | ')} |`), '');
      body.push(`<table><thead><tr>${s.table.head.map((h) => `<th>${htmlEsc(h)}</th>`).join('')}</tr></thead><tbody>${s.table.rows.map((r) => `<tr>${r.map((c) => `<td>${htmlEsc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
    }
    body.push('</section>');
  }
  const markdown = md.join('\n').replace(/\n+$/, '\n');
  const html = `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Plan status report</title>\n<style>body{font:15px/1.5 system-ui,sans-serif;max-width:60rem;margin:0 auto;padding:1rem 16px;color:#1b1b1b;background:#fff}table{border-collapse:collapse;width:100%;display:block;overflow-x:auto}th,td{border:1px solid #ccc;padding:.25rem .5rem;text-align:left}.src{color:#555;font-size:.85em}@media (prefers-color-scheme:dark){body{color:#eee;background:#111}th,td{border-color:#444}.src{color:#aaa}}</style></head>\n<body><h1>Plan status report</h1><p>${htmlEsc(NOTICE)}</p>\n${body.join('\n')}\n</body></html>\n`;
  return { markdown, html, data };
}
