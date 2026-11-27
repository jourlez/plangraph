// Marker-delimited generated regions. Pure string functions, no I/O. The document is scanned line by line (no whole-document regex):
// text outside markers is returned byte-identical and the document's line ending (LF or CRLF) is kept.
import { createHash } from 'node:crypto';

export type Region = { id: string; fp: string; v: number; body: string };
export type RefusalReason = 'REGION_EDITED' | 'MARKER_MALFORMED' | 'MARKER_DUPLICATE';
export type RegionStatus = 'fresh' | 'stale' | 'edited' | 'missing';

const BEGIN = '<!-- plangraph:begin ';
const END = '<!-- plangraph:end ';
const TAG = '<!-- plangraph:';
const ESCAPED_TAG = '<!-- plangraph&#58;';

const sha16 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);
const isHex16 = (s: string): boolean => s.length === 16 && [...s].every((c) => (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'));
const isDigits = (s: string): boolean => s.length > 0 && s.length < 10 && [...s].every((c) => c >= '0' && c <= '9');
const isId = (s: string): boolean => s.length > 0 && [...s].every((c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '.' || c === '_' || c === '-');

// sha256 over the version and every part, each prefixed by its length so ('ab','c') and ('a','bc') differ
export function fingerprint(parts: readonly string[], v: number): string {
  const h = createHash('sha256');
  h.update(`v${v}\n`);
  for (const p of parts) h.update(`${Buffer.byteLength(p)}:${p}\n`);
  return h.digest('hex').slice(0, 16);
}

// body as lines: a marker-looking line in a body is escaped so it can never end (or start) a region; CRs are dropped
function bodyLines(body: string): string[] {
  if (body === '') return [];
  return body.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l).replaceAll(TAG, ESCAPED_TAG));
}
const bodyHash = (lines: readonly string[]): string => sha16(lines.join('\n'));

function checkRegion(r: Region): void {
  if (!isId(r.id)) throw new RangeError(`bad region id: ${JSON.stringify(r.id)}`);
  if (!isHex16(r.fp)) throw new RangeError(`bad region fp for ${r.id}`);
  if (!Number.isInteger(r.v) || r.v < 0) throw new RangeError(`bad region v for ${r.id}`);
}

const beginLine = (r: Region, bh: string): string => `${BEGIN}id=${r.id} fp=${r.fp} bh=${bh} v=${r.v} -->`;
const endLine = (id: string): string => `${END}id=${id} -->`;

export function renderMarkers(r: Region): string {
  checkRegion(r);
  const lines = bodyLines(r.body);
  return [beginLine(r, bodyHash(lines)), ...lines, endLine(r.id)].join('\n');
}

type Line = { s: string; eol: string };
type Begin = { id: string; fp: string; bh: string; v: number };
type Block = { id: string; at: number; end: number; begin: Begin };
type Scan = { lines: Line[]; blocks: Block[]; problems: (string | null)[] };

function splitLines(text: string): Line[] {
  // one split, not an indexOf per line (each indexOf from an offset is a scan of the rest of the text: quadratic in the document size)
  const parts = text.split('\n'), out: Line[] = [];
  for (let k = 0; k < parts.length; k++) {
    const p = parts[k] as string, last = k === parts.length - 1;
    if (last) { if (p !== '') out.push({ s: p, eol: '' }); break; }
    const cr = p.endsWith('\r');
    out.push({ s: cr ? p.slice(0, -1) : p, eol: cr ? '\r\n' : '\n' });
  }
  return out;
}

function parseBegin(s: string): Begin | null {
  const t = s.trim();
  const tok = t.split(' ');
  if (tok.length !== 7 || tok[0] !== '<!--' || tok[1] !== 'plangraph:begin' || tok[6] !== '-->') return null;
  const [id, fp, bh, v] = [tok[2] as string, tok[3] as string, tok[4] as string, tok[5] as string];
  if (!id.startsWith('id=') || !fp.startsWith('fp=') || !bh.startsWith('bh=') || !v.startsWith('v=')) return null;
  const b = { id: id.slice(3), fp: fp.slice(3), bh: bh.slice(3), v: v.slice(2) };
  if (!isId(b.id) || !isHex16(b.fp) || !isHex16(b.bh) || !isDigits(b.v)) return null;
  return { id: b.id, fp: b.fp, bh: b.bh, v: Number(b.v) };
}

// id of an end marker, or null when it is not a well-formed end line
function parseEnd(s: string): string | null {
  const tok = s.trim().split(' ');
  if (tok.length !== 4 || tok[0] !== '<!--' || tok[1] !== 'plangraph:end' || tok[3] !== '-->' || !(tok[2] as string).startsWith('id=')) return null;
  const id = (tok[2] as string).slice(3);
  return isId(id) ? id : null;
}

// loose id for a damaged marker line, so the right region is refused; null when none is recoverable
function looseId(s: string): string | null {
  for (const w of s.trim().split(' ')) if (w.startsWith('id=')) { const id = w.slice(3); if (isId(id)) return id; }
  return null;
}

function scan(text: string): Scan {
  const lines = splitLines(text);
  const blocks: Block[] = [];
  const problems: (string | null)[] = [];
  let open: { at: number; begin: Begin } | null = null;
  const dropOpen = () => { if (open) { problems.push(open.begin.id); open = null; } };
  for (let i = 0; i < lines.length; i++) {
    const s = (lines[i] as Line).s;
    const t = s.trimStart();
    if (!t.startsWith(TAG)) continue;
    if (t.startsWith(BEGIN)) {
      const b = parseBegin(s);
      if (!b) { dropOpen(); problems.push(looseId(s)); continue; }
      dropOpen();
      open = { at: i, begin: b };
    } else if (t.startsWith(END)) {
      const id = parseEnd(s);
      if (id === null) { dropOpen(); problems.push(looseId(s)); continue; }
      if (open && open.begin.id === id) { blocks.push({ id, at: open.at, end: i, begin: open.begin }); open = null; }
      else { dropOpen(); problems.push(id); }
    } else { dropOpen(); problems.push(looseId(s)); }
  }
  dropOpen();
  return { lines, blocks, problems };
}

// a problem with no recoverable id cannot be attributed, so it refuses every region
function problemFor(sc: Scan, id: string): RefusalReason | null {
  if (sc.problems.some((p) => p === id || p === null)) return 'MARKER_MALFORMED';
  if (sc.blocks.filter((b) => b.id === id).length > 1) return 'MARKER_DUPLICATE';
  return null;
}

const bodyOf = (sc: Scan, b: Block): string[] => sc.lines.slice(b.at + 1, b.end).map((l) => l.s);

export function injectRegions(text: string, regions: readonly Region[], opts: { force?: boolean } = {}): { text: string; changed: string[]; refused: { id: string; reason: RefusalReason }[] } {
  const changed: string[] = [];
  const refused: { id: string; reason: RefusalReason }[] = [];
  let cur = text;
  for (const r of regions) {
    checkRegion(r);
    const sc = scan(cur);
    const bad = problemFor(sc, r.id);
    if (bad) { refused.push({ id: r.id, reason: bad }); continue; }
    const want = bodyLines(r.body);
    const wantHash = bodyHash(want);
    const block = sc.blocks.find((b) => b.id === r.id);
    if (!block) {
      const eol = sc.lines.find((l) => l.eol)?.eol ?? '\n';
      const add = [beginLine(r, wantHash), ...want, endLine(r.id)].join(eol);
      let head = cur;
      if (head !== '') {
        if (!head.endsWith('\n')) head += eol;
        if (sc.lines.length > 0 && (sc.lines[sc.lines.length - 1] as Line).s !== '') head += eol;
      }
      cur = `${head}${add}${eol}`;
      changed.push(r.id);
      continue;
    }
    const edited = bodyHash(bodyOf(sc, block)) !== block.begin.bh;
    if (edited && !opts.force) { refused.push({ id: r.id, reason: 'REGION_EDITED' }); continue; }
    if (!edited && block.begin.fp === r.fp && block.begin.v === r.v) continue;
    const beginEol = (sc.lines[block.at] as Line).eol;
    const endEol = (sc.lines[block.end] as Line).eol;
    const bodyEol = beginEol || '\n';
    const out: string[] = sc.lines.slice(0, block.at).map((l) => l.s + l.eol);
    out.push(beginLine(r, wantHash) + beginEol);
    for (const l of want) out.push(l + bodyEol);
    out.push(endLine(r.id) + endEol);
    for (const l of sc.lines.slice(block.end + 1)) out.push(l.s + l.eol);
    cur = out.join('');
    changed.push(r.id);
  }
  return { text: cur, changed, refused };
}

// a damaged, duplicated or unattributable marker needs a human, so it reports as edited
export function checkRegions(text: string, regions: readonly Region[]): { id: string; status: RegionStatus }[] {
  const sc = scan(text);
  return regions.map((r) => {
    if (problemFor(sc, r.id)) return { id: r.id, status: 'edited' as const };
    const block = sc.blocks.find((b) => b.id === r.id);
    if (!block) return { id: r.id, status: 'missing' as const };
    if (bodyHash(bodyOf(sc, block)) !== block.begin.bh) return { id: r.id, status: 'edited' as const };
    return { id: r.id, status: block.begin.fp === r.fp && block.begin.v === r.v ? ('fresh' as const) : ('stale' as const) };
  });
}
