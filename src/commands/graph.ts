// plangraph graph KEY [--rel R,..] [--depth N] [--reverse] [--type T]: the nodes reachable from a key over the relations of the graph, each
// with its relation path (breadth first, shortest path, `current` schedule version only). KEY is a raw id or a `pg:<type>/<id>` URI. Ids are
// untrusted text: a ticket key prints through oneLine, every other id inside a fence (an xref under its system's name). The answer stays
// under about 250 tokens by default; what is left out is counted on a last line, `-v` lifts the cap.
import { oneLine } from '../../lib/sanitize.ts';
import { CORE_NODE_TYPES, DERIVED_RELATIONS, EXT_REL_RE, RELATIONS, isNodeType } from '../../lib/graph/files.ts';
import type { NodeType } from '../../lib/graph/files.ts';
import { GRAPH_MAX_DEPTH, graphReader } from '../../lib/graph/views.ts';
import type { NodeRef, Rel } from '../../lib/graph/views.ts';
import { nodeUri, parseNodeUri } from '../../lib/graph/uri.ts';
import { fenceBlock, nextCommand, nextList, readItems, usage, verbose } from './shared.ts';
import type { Ctx, Args } from '../context.ts';
import type { CommandMap } from '../registry.ts';

const CHARS = 900; // about 225 tokens of node lines; the truncation line comes on top
const MAX_LINES = 500, MAX_JSON = 2000;
const KNOWN_RELS = [...RELATIONS, ...DERIVED_RELATIONS];
const typeHelp = `${CORE_NODE_TYPES.join(', ')}, x-<sys>.<kind>`;
const uriOf = (type: string, id: string): string | null => { try { return nodeUri(type, id); } catch { return null; } }; // an id outside the id rule has no URI

type Values = { rel?: string; depth?: number; reverse?: boolean; type?: string };

async function graph(ctx: Ctx, args: Args<Values>): Promise<number> {
  const raw = args.positionals[0] as string, v = args.values, out = ctx.io.out;
  const depth = v.depth ?? 1;
  if (!Number.isInteger(depth) || depth < 1 || depth > GRAPH_MAX_DEPTH) throw usage(`--depth must be a whole number from 1 to ${GRAPH_MAX_DEPTH}`);
  if (v.type !== undefined && !isNodeType(v.type)) throw usage(`--type must be one of: ${typeHelp}`);
  const rels = v.rel === undefined ? KNOWN_RELS : v.rel.split(',');
  for (const r of rels) if (!(KNOWN_RELS as string[]).includes(r) && !EXT_REL_RE.test(r)) throw usage(`unknown relation ${oneLine(r, 40)}; known: ${KNOWN_RELS.join(', ')}, x-<sys>/<rel>`);
  let id = raw, type = v.type as NodeType | undefined;
  if (raw.startsWith('pg:')) {
    const u = parseNodeUri(raw);
    if (!u) throw usage('the pg: URI is not in the grammar pg:<type>/<id> (percent-encode %, /, #, |, ?, spaces and non-ASCII in the id)');
    if (type !== undefined && type !== u.type) throw usage('the URI type and --type disagree');
    id = u.id; type = u.type as NodeType;
  }
  const { items } = await readItems(ctx);
  const g = graphReader(ctx.db(), items), found = g.node(id, type);
  if (!found.length) { out(`${oneLine(id, 120)} not in the graph`); return 1; }
  if (found.length > 1) throw usage(`${oneLine(id, 80)} names nodes of several types (${found.map((n) => n.type).join(', ')}); pass --type`);
  const start = found[0] as NodeRef;
  const reached = g.reach(start, rels as Rel[], depth, Boolean(v.reverse));
  const nodes = reached.map((n) => ({ id: n.id, type: n.type, depth: n.path.length, rels: n.path.map((s) => s.rel) }));
  const startUri = uriOf(start.type, start.id);
  {
    const shown = nodes.slice(0, MAX_JSON);
    ctx.io.data?.({ start: startUri, depth, reverse: Boolean(v.reverse), nodes: shown.map((n) => ({ id: uriOf(n.type, n.id), type: n.type, depth: n.depth, rels: n.rels })), truncated: nodes.length - shown.length },
      { next: nextList(nodes.filter((n) => n.type === 'ticket').slice(0, 1).map((n) => nextCommand(['ticket', [n.id]]))) });
  }
  const long = verbose(args);
  let used = 0, shown = 0;
  const plain: string[] = [], fenced = new Map<string, string[]>();
  for (const n of nodes) {
    const line = `${n.depth} ${n.rels.join('>')} ${oneLine(n.id, 120)} ${n.type}`;
    if (long ? shown >= MAX_LINES : used + line.length + 1 > CHARS) break;
    used += line.length + 1; shown++;
    if (n.type === 'ticket') { plain.push(line); continue; }
    const src = n.type.startsWith('x-') ? n.type.slice(2, n.type.indexOf('.')) : 'graph';
    const l = fenced.get(src); if (l) l.push(line); else fenced.set(src, [line]);
  }
  if (!nodes.length) out(`no nodes within depth ${depth}`);
  for (const l of plain) out(l);
  for (const src of [...fenced.keys()].sort()) ctx.io.outBlock(fenceBlock(src, fenced.get(src) as string[]));
  if (nodes.length > shown) out(`truncated ${nodes.length - shown}, narrow with --rel or --depth`);
  return 0;
}

const B = { type: 'boolean' };
export const commands: CommandMap = {
  graph: {
    run: graph as never, positionals: [1, 1], options: { rel: { type: 'string' }, depth: { type: 'integer' }, reverse: B, type: { type: 'string' } },
    summary: 'KEY [--rel R,..] [--depth N] [--reverse] [--type T]: nodes reachable from a key (id or pg: URI) with their relation path; current schedule version only',
  },
};
