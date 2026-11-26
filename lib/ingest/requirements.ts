// Requirement documents to `requirement` nodes (spec 4.1). EARS sentences (`The <system> shall`, While, When, Where, If ... then), Gherkin
// Feature/Rule/Scenario (the scenario steps become acceptance lines) and bullets under a `Requirements` heading (kind free). Pure functions:
// no I/O, no store writes; the caller (ingest requirements) writes the nodes and applies --prune.
// Ids: newId('requirement', source + first 40 characters of the text) where source is `<path>#<anchor>` and the anchor is the slug of the
// nearest heading (or the Gherkin feature/rule/scenario slugs), never a position: reordering sections keeps every id, another document gives
// other ids, and there is no sequence number to collide between two branches. The seed is creation input: a changed sentence is a new id.
// Text is stored as written. It is untrusted data (`ignore previous instructions` stays in `text`): it is fenced and length-capped where it is
// printed, not here. The only guarantee made here is that `source` is a repo path, never a URL.
import { newId } from '../store2/layout.ts';
import type { Node } from '../store2/pg.ts';
import { MAX_DOC_BYTES, cleanSource, type IngestProblem } from './adr.ts';

export interface RequirementsResult { nodes: Node[]; problems: IngestProblem[] }

const TEXT_MAX = 2000, ACC_MAX = 200, ACC_LINES = 50, SEED_CHARS = 40;
const EARS = /^(?:(?:the|a|an)\s+.+?\s+shall\b|(?:while|when|where)\s+.+\bshall\b|if\s+.+\bthen\b.+\bshall\b)/i;
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;
const STEP = /^(?:Given|When|Then|And|But|\*)\s/;
const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
const tidy = (s: string): string => s.replace(/\*\*|__/g, '').replace(/\s+/g, ' ').trim();
const cap = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Parse a requirements document (Markdown, or a Gherkin .feature file). Never throws; a too-large text gives no nodes and a problem. */
export function parseRequirementsDoc(text: string, path: string): RequirementsResult {
  if (Buffer.byteLength(text) > MAX_DOC_BYTES) return { nodes: [], problems: [{ code: 'TOO_LARGE', message: `requirements document over ${MAX_DOC_BYTES / 1024} KiB: not read` }] };
  const problems: IngestProblem[] = [], clean = cleanSource(path);
  if (clean === undefined) problems.push({ code: 'SOURCE_URL', message: 'source is not a repo path: not stored' });
  // The id seed always carries the given path, so a rejected source still gives distinct, stable ids.
  const nodes: Node[] = [], seen = new Set<string>();
  const add = (kind: string, anchor: string, body: string, acceptance?: string[]): void => {
    const txt = cap(tidy(body), TEXT_MAX);
    if (!txt) return;
    const id = newId('requirement', `${path}#${anchor}${txt.slice(0, SEED_CHARS)}`);
    if (seen.has(id)) return;
    seen.add(id);
    const n: Node = { id, text: txt, kind, status: 'proposed' };
    if (clean !== undefined) n.source = `${clean}#${anchor}`.replace(/#$/, '');
    if (acceptance?.length) n.acceptance = acceptance;
    nodes.push(n);
  };

  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines[0]?.trim() === '---') { const e = lines.findIndex((l, i) => i > 0 && l.trim() === '---'); if (e > 0) lines.splice(0, e + 1); }
  let anchor = '', reqLevel = 0, fence = false, feature = '', rule = '', scen: { name: string; steps: string[] } | null = null, para: string[] = [], bulletIn = false;
  const flushScen = (): void => {
    if (scen) add('gherkin', [feature, rule, slug(scen.name)].filter(Boolean).join('/'), scen.name, scen.steps.slice(0, ACC_LINES));
    scen = null;
  };
  const flushPara = (): void => {
    const block = para.join(' '); para = [];
    if (!block.trim()) { bulletIn = false; return; }
    const inReq = reqLevel > 0;
    const parts = block.split(/(?<=[.!?])\s+(?=[A-Z])/).map(tidy);
    let hit = false;
    for (const s of parts) if (EARS.test(s)) { add('ears', anchor, s); hit = true; }
    if (!hit && bulletIn && inReq) add('free', anchor, block);
    bulletIn = false;
  };

  for (const raw of lines) {
    const l = raw.trim();
    const g = /^(Feature|Rule|Scenario Outline|Scenario|Example|Background):\s*(.*)$/.exec(l);
    if (g) {
      flushPara();
      const kw = g[1] as string, name = g[2] as string;
      if (kw === 'Feature') { flushScen(); feature = slug(name); rule = ''; } else if (kw === 'Rule') { flushScen(); rule = slug(name); } else if (kw === 'Background') flushScen();
      else { flushScen(); scen = { name: tidy(name), steps: [] }; }
      continue;
    }
    if (scen) {
      if (STEP.test(l)) { scen.steps.push(cap(tidy(l), ACC_MAX)); continue; }
      if (l === '' || (l.startsWith('#') && !/^#{1,6}\s/.test(l)) || l.startsWith('@') || l.startsWith('|') || l.startsWith('"""')) continue;
      flushScen();
    }
    if (l.startsWith('```') || l.startsWith('~~~')) { flushPara(); fence = !fence; continue; }
    if (fence) continue;
    const h = /^(#{1,6})\s+(.*?)\s*#*$/.exec(l);
    if (h) {
      flushPara();
      const level = (h[1] as string).length, title = h[2] as string;
      anchor = slug(title);
      if (/(?:^|\s)requirements?$/i.test(title)) reqLevel = level; else if (reqLevel && level <= reqLevel) reqLevel = 0;
      continue;
    }
    if (l === '') { flushPara(); continue; }
    const b = BULLET.exec(raw);
    if (b) { flushPara(); bulletIn = true; para.push(b[1] as string); } else para.push(l);
  }
  flushPara(); flushScen();
  return { nodes, problems };
}

/** The requirement nodes in one document (empty when it is too large; see parseRequirementsDoc for the problem). */
export const parseRequirements = (text: string, path: string): Node[] => parseRequirementsDoc(text, path).nodes;
