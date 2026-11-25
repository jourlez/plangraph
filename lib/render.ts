// Output rendering for the brain CLI: everything an agent reads goes through here so it is small, stable and bounded.
// Pure functions: strings in, strings out. No console, no process, no clock.
// Guarantees: deterministic, no ANSI, no trailing spaces, no trailing blank lines.
import { capOf } from './model.ts';
import { sanitizeText, oneLine, fenceInline } from './sanitize.ts';
import { steerLine } from './steer.ts';
import type { Model } from './model.ts';

/** renderCard's meta: the source fingerprint, whether the index is stale, the brain dir as the repo names it. Other fields are ignored. */
export interface CardMeta { fp?: unknown; stale?: unknown; dir?: string; [extra: string]: unknown }
/** The model fields renderCard reads. */
export type CardModel = Pick<Model, 'tickets' | 'edges' | 'sched' | 'config'> & { findings?: Model['findings'] | null };

export const CARD_BUDGET = 250;

// Token estimate used everywhere in the project: ceil(chars / 4). A convention, not a tokenizer: the real count of the current Claude
// tokenizer is UNVERIFIED for this output (test/token-calibration.json keeps factor 1.0 until count_tokens is run; docs/TOKENS.md).
export const estTokens = (s: unknown): number => Math.ceil(String(s).length / 4);

// Strip escape sequences and invisible/control characters (sanitizeText), trailing spaces/tabs on every line and trailing blank lines.
export const clean = (text: unknown): string => sanitizeText(text, { max: Infinity }).split('\n').map((l) => l.replace(/[ \t\r]+$/, '')).join('\n').replace(/\n+$/, '');

// Keep the first `limit` lines and replace the rest with ONE marker line stating exactly how many were dropped.
// marker may contain {n}; default '... {n} more'.
export function bound(lines: readonly string[], { limit = 20, marker = '... {n} more' }: { limit?: number; marker?: string } = {}): string[] {
  if (lines.length <= limit) return lines.slice();
  const n = lines.length - Math.max(0, limit);
  return [...lines.slice(0, Math.max(0, limit)), marker.replace('{n}', String(n))];
}

// The versioned machine format (v2). Keys are short and in a fixed order; compact JSON (no whitespace). `data` is the command's own
// structured answer ({ lines } for a command without a data builder), `ok`/`exit` repeat the exit code so a captured envelope is
// self-contained, `fresh` is { fp, built } (first 8 hex of the fingerprint of the text now / of the text the index was built from) or
// null when the command read no index, `next` holds 0-3 exact follow-up commands. Additive fields never bump `v`.
const ENVELOPE_VERSION = 2;
export const envelope = (command: string | undefined, data: unknown, { fresh = null, ok = true, exit = 0, next = [] }: { fresh?: unknown; ok?: boolean; exit?: number; next?: string[] } = {}): string => JSON.stringify({ v: ENVELOPE_VERSION, cmd: command ?? null, ok, exit, data, fresh, next });

const cell = (v: unknown): string => (v == null ? '' : String(v)).replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
// Compact pipe text: header line, then one line per row. No alignment padding.
export function table(rows: readonly object[], cols: readonly string[], { header = true }: { header?: boolean } = {}): string {
  const out = header ? [cols.join('|')] : [];
  for (const r of rows) out.push(cols.map((c) => cell((r as Record<string, unknown>)[c])).join('|')); // a missing column reads undefined (empty cell)
  return clean(out.join('\n'));
}

// Truncate at a line boundary so that estTokens(result + '\n') <= maxTokens, ending with ONE marker `... N more lines`.
export function budget(text: unknown, maxTokens: number): { text: string; truncated: boolean; omitted: number } {
  const t = clean(text);
  if (estTokens(t + '\n') <= maxTokens) return { text: t, truncated: false, omitted: 0 };
  const lines = t.split('\n'), n = lines.length;
  const prefix: number[] = [0]; for (const l of lines) prefix.push((prefix[prefix.length - 1] as number) + l.length + 1); // prefix starts with one entry and only grows
  for (let k = n - 1; k >= 0; k--) {
    const marker = `... ${n - k} more lines`;
    if (Math.ceil(((prefix[k] as number) + marker.length + 1) / 4) <= maxTokens) return { text: clean(lines.slice(0, k).concat(marker).join('\n')), truncated: true, omitted: n - k }; // prefix has n + 1 entries and 0 <= k < n
  }
  return { text: clean(t.slice(0, Math.max(0, maxTokens * 4 - 1))), truncated: true, omitted: n };
}

// Verbosity convention: terse by default, `-v`/`--verbose` expanded, `--json` machine envelope. Returns the remaining args.
export function outputMode(argv: readonly string[]): { verbose: boolean; json: boolean; args: string[] } {
  const verbose = argv.includes('-v') || argv.includes('--verbose'), json = argv.includes('--json');
  return { verbose, json, args: argv.filter((a) => a !== '-v' && a !== '--verbose' && a !== '--json') };
}

// ---- session-start card ----
// Cache-stable: the card is a pure function of the model and the source fingerprint (no clock, no relative age, no mtime, no "?"), so
// the same data gives the same bytes in every session, resume and eval run (docs/research/ai-engineering.md 1.4). Usage guidance is not
// repeated here: `brain explain` owns it; the card ends with one fixed steer line (lib/steer.ts: use brain for plan questions, do not read
// the brain dir's JSONL). The only conditional line, STALE, is the last.
// Card fields (verdicts, owners, finding kinds) are data: one line each (no embedded newline can forge a card line), then cut, and each
// card line that lists them holds the list inside one inline <untrusted> fence (fenceInline); our labels and `none` stay outside.
const short = (s: unknown, n: number = 16): string => oneLine(s, 4000).slice(0, n);
const top = (entries: readonly string[], limit: number): string => bound(entries, { limit, marker: '+{n} more' }).join(', ');
export const CARD_STALE = 'STALE: index older than text, run `brain build`';
/** The card identity: the first 8 hex digits of the source fingerprint (anything else in the input is dropped), or `unbuilt`. */
const cardId = (fp: unknown): string => String(fp ?? '').replace(/[^0-9a-f]/g, '').slice(0, 8) || 'unbuilt';

// renderCard(model, { fp, stale }, {maxTokens}) -> text (no trailing newline) with estTokens(text + '\n') <= maxTokens (default 250).
// fp: the source fingerprint of the text (src/db.ts); stale: true when the index no longer matches that text; dir: the brain dir as the
// repo names it (default `.plangraph`), printed in the steer line. Any other meta field (a clock, an mtime) is ignored. Lines carry a priority (lower = more important); when over budget the least important lines are
// dropped whole and one `... N lines omitted` line says so. Identity and size (priority 0) and STALE are never dropped (except by the
// final hard cut).
export function renderCard(model: CardModel, meta: CardMeta = {}, { maxTokens = CARD_BUDGET }: { maxTokens?: number } = {}): string {
  const lines: Array<{ p: number; text: string; i: number }> = []; const add = (p: number, text: string) => { if (text) lines.push({ p, text, i: lines.length }); };
  let first = Infinity, last = -Infinity; const people = new Set<string>();
  for (const s of model.sched.values()) {
    if (Number.isInteger(s.sprint)) { if ((s.sprint as number) < first) first = s.sprint as number; if ((s.sprint as number) > last) last = s.sprint as number; } // Number.isInteger is the check
    if (s.owner) people.add(s.owner);
  }
  const range = first <= last ? `S${first}-S${last}` : 'no sprints';
  add(0, `brain ${cardId(meta.fp)} | ${model.tickets.size} tickets, ${model.edges.length} links, ${range}, ${people.size} ${people.size === 1 ? 'person' : 'people'}`);

  const vc = new Map<string, number>(); for (const t of model.tickets.values()) { const v = short(t.verdict || 'unrated', 20); vc.set(v, (vc.get(v) || 0) + 1); }
  const vs = [...vc].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([v, c]) => `${c} ${v}`);
  if (vs.length) add(1, 'verdicts: ' + fenceInline(top(vs, 5), 400));

  const load = new Map<string, number>();
  for (const [k, s] of model.sched) { const id = s.owner + '\u0000' + s.sprint; load.set(id, (load.get(id) || 0) + ((model.tickets.get(k) || {}).sp || 0)); }
  const over: Array<{ o: string; sprint: number; x: number }> = [];
  for (const [id, sp] of load) { const [o, sprint] = id.split('\u0000') as [string, string]; const x = sp - capOf(model.config, o); if (x > 0) over.push({ o, sprint: +sprint, x }); } // every load id joins an owner and a sprint
  over.sort((a, b) => b.x - a.x || (a.o < b.o ? -1 : a.o > b.o ? 1 : a.sprint - b.sprint));
  add(2, 'over cap: ' + (over.length ? fenceInline(top(over.map((r) => `${short(r.o)} S${r.sprint} +${r.x}`), 3), 400) : 'none'));

  const fc = new Map<string, number>(); for (const f of model.findings || []) { const k = short(f.kind, 20); fc.set(k, (fc.get(k) || 0) + 1); }
  const fs = [...fc].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([k, c]) => `${k} ${c}`);
  if (fs.length) add(3, 'findings: ' + fenceInline(top(fs, 3), 400));
  add(4, steerLine(meta.dir));

  // STALE (when applicable) is appended after the budgeted body, so in the abnormal case only the tail differs.
  const tail = meta.stale === true ? `\n${CARD_STALE}` : '';
  const max = maxTokens - (tail ? estTokens(tail) : 0);
  const render = (ls: typeof lines) => ls.sort((a, b) => a.i - b.i).map((l) => l.text).join('\n');
  const all = render(lines.slice());
  if (estTokens(all + '\n') <= max) return clean(all + tail);
  const byPrio = lines.slice().sort((a, b) => a.p - b.p || a.i - b.i);
  const kept: typeof lines = [];
  for (let n = 0; n < byPrio.length; n++) {
    const cand = kept.concat(byPrio[n] as (typeof lines)[number]); const dropped = byPrio.length - cand.length; // n < byPrio.length (loop bound)
    const text = render(cand.slice()) + (dropped ? `\n... ${dropped} lines omitted` : '');
    if ((byPrio[n] as (typeof lines)[number]).p > 0 && estTokens(text + '\n') > max) break; // priority-0 lines are always kept; n < byPrio.length (loop bound)
    kept.push(byPrio[n] as (typeof lines)[number]); // n < byPrio.length (loop bound)
  }
  const dropped = byPrio.length - kept.length;
  return clean(budget(render(kept) + (dropped ? `\n... ${dropped} lines omitted` : ''), Math.max(1, max)).text + tail);
}
