// Decision records to `decision` nodes (spec 4.1). Nygard headings (Title, Status, Context, Decision, Consequences) and MADR 4 front matter
// (status, date, decision-makers, optional affects globs). Pure functions: no I/O, no store writes; the caller (ingest docs) writes the nodes.
// Text taken from a document (title, decision summary) is stored as written. It is untrusted data: it is fenced and length-capped where it is
// printed (map, context, brief), not here. The only thing this parser guarantees is that `source` is a repo path, never a URL.
import { newId } from '../store2/layout.ts';
import type { Node } from '../store2/pg.ts';

export const MAX_DOC_BYTES = 256 * 1024;
export interface IngestProblem { code: 'TOO_LARGE' | 'SOURCE_URL' | 'NOT_ADR'; message: string }
export interface AdrResult {
  node: Node | null;
  problems: IngestProblem[];
  /** Set when status is `superseded by ADR-<n>`: put `link` in the `links` of the decision whose ADR number is `adr` (this id is superseded by it). */
  supersededBy?: { adr: string; link: { rel: 'supersedes'; to: string } };
}

const STATUSES = ['accepted', 'deprecated', 'rejected', 'proposed'] as const;
const TEXT_MAX = 500;
const URLISH = /^[a-z][a-z0-9+.-]*:/i;

/** A repo path with an optional #anchor, or undefined: a URL, an absolute path, `..` or a control character is not a source. */
export function cleanSource(p: string): string | undefined {
  const s = p.replace(/\\/g, '/');
  // eslint-disable-next-line no-control-regex
  if (s === '' || URLISH.test(s) || s.includes('://') || s.startsWith('/') || s.startsWith('~') || /(^|\/)\.\.(\/|#|$)/.test(s) || /[\u0000-\u001f\u007f]/.test(s)) return undefined;
  return s;
}

const unq = (s: string): string => s.trim().replace(/^(['"])(.*)\1$/, '$2').trim();
const list = (v: string): string[] => (v.startsWith('[') && v.endsWith(']') ? v.slice(1, -1).split(',').map(unq).filter(Boolean) : v === '' ? [] : [unq(v)]);

function frontMatter(lines: string[]): { fm: Record<string, string[]>; rest: string[] } {
  if (lines[0]?.trim() !== '---') return { fm: {}, rest: lines };
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end < 0) return { fm: {}, rest: lines };
  const fm: Record<string, string[]> = {};
  let key = '';
  for (const l of lines.slice(1, end)) {
    const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(l), it = /^\s*-\s+(.*)$/.exec(l);
    if (m) { key = (m[1] as string).toLowerCase(); fm[key] = list((m[2] as string).trim()); } else if (it && key) (fm[key] ??= []).push(unq(it[1] as string));
  }
  return { fm, rest: lines.slice(end + 1) };
}

function sections(lines: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let cur: string[] | null = null;
  for (const l of lines) {
    const h = /^#{2,6}\s+(.*?)\s*#*\s*$/.exec(l);
    if (h) { cur = []; if (!out.has((h[1] as string).toLowerCase())) out.set((h[1] as string).toLowerCase(), cur); } else if (cur) cur.push(l);
  }
  return out;
}

const normStatus = (raw: string): { status: string; by?: string } => {
  const s = raw.toLowerCase();
  const by = /supersed\w*\s+by\s+\[?\s*(?:adr)?[-\s]?0*(\d+)/i.exec(raw);
  if (/supersed/.test(s)) return by ? { status: 'superseded', by: `ADR-${(by[1] as string).padStart(4, '0')}` } : { status: 'superseded' };
  return { status: STATUSES.find((x) => s.includes(x.slice(0, 5))) ?? 'proposed' };
};

/** Parse one decision record. Never throws; a too-large or non-ADR text gives `node: null` and a problem. */
export function parseAdrDoc(text: string, path: string): AdrResult {
  if (Buffer.byteLength(text) > MAX_DOC_BYTES) return { node: null, problems: [{ code: 'TOO_LARGE', message: `decision record over ${MAX_DOC_BYTES / 1024} KiB: not read` }] };
  const { fm, rest } = frontMatter(text.replace(/\r\n?/g, '\n').split('\n'));
  const head = rest.find((l) => /^#\s+\S/.test(l));
  if (head === undefined) return { node: null, problems: [{ code: 'NOT_ADR', message: 'no title heading' }] };
  const problems: IngestProblem[] = [];
  const title = head.replace(/^#\s+/, '').replace(/\s*#*\s*$/, '').replace(/^(?:ADR[-\s]?)?\d+[.:)]\s*/i, '').trim();
  const sec = sections(rest), body = rest.join('\n');
  const firstLine = (k: string): string => (sec.get(k) ?? []).map((l) => l.trim()).find(Boolean) ?? '';
  const { status, by } = normStatus(fm.status?.[0] || firstLine('status') || /^[*-]?\s*Status:\s*(.+)$/im.exec(body)?.[1] || '');
  const date = [fm.date?.[0], /^[*-]?\s*Date:\s*(\S+)/im.exec(body)?.[1]].find((d) => d !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(d));
  const makers = fm['decision-makers']?.join(', ');
  const affects = (fm.affects ?? []).filter((g) => cleanSource(g) !== undefined);
  const dec = (sec.get('decision') ?? sec.get('decision outcome') ?? []).map((l) => l.trim()).filter(Boolean).join(' ').slice(0, TEXT_MAX);
  const source = cleanSource(path);
  if (source === undefined) problems.push({ code: 'SOURCE_URL', message: 'source is not a repo path: not stored' });
  const node: Node = { id: newId('decision', path), title, status, derivation: 'extracted' };
  if (date) node.date = date;
  if (makers) node['decision-makers'] = makers;
  if (affects.length) node.affects = affects;
  if (dec) node.text = dec;
  if (source !== undefined) node.source = source;
  return { node, problems, ...(by ? { supersededBy: { adr: by, link: { rel: 'supersedes' as const, to: node.id } } } : {}) };
}

/** The decision node for one record, or null when the text is not a decision record (see parseAdrDoc for the reason). */
export const parseAdr = (text: string, path: string): Node | null => parseAdrDoc(text, path).node;
