// plangraph graph KEY [--rel R,..] [--depth N] [--reverse] [--type T]: the nodes reachable from a key over the relations of the graph, each
// with its relation path (breadth first, shortest path, `current` schedule version only). KEY is a raw id or a `pg:<type>/<id>` URI. Ids are
// untrusted text: a ticket key prints through oneLine, every other id inside a fence (an xref under its system's name). The answer stays
// under about 250 tokens by default; what is left out is counted on a last line, `-v` lifts the cap.
// plangraph graph materialize: appends the people, sprints and epics that the v1 files name (schedule owners and sprints, ticket epics) and that
// have no row in people.jsonl, sprints.jsonl or epics.jsonl, one bare row each (decision D23: no format bump, no v1 file written, idempotent).
import path from 'node:path';
import { oneLine } from '../../lib/sanitize.ts';
import { canonFile, readRecords, SCHEMAS } from '../../lib/store.ts';
import { CORE_NODE_TYPES, DERIVED_RELATIONS, EXT_REL_RE, RELATIONS, idProblem, isNodeType } from '../../lib/graph/files.ts';
import type { NodeType } from '../../lib/graph/files.ts';
import { GRAPH_MAX_DEPTH, graphReader } from '../../lib/graph/views.ts';
import type { NodeRef, Rel } from '../../lib/graph/views.ts';
import { nodeUri, parseNodeUri } from '../../lib/graph/uri.ts';
import { fenceBlock, needBrain, nextCommand, nextList, precheckTargets, readItems, usage, verbose, writeState } from './shared.ts';
import type { Ctx, Args } from '../context.ts';
import type { CommandMap } from '../registry.ts';

const CHARS = 900; // about 225 tokens of node lines; the truncation line comes on top
const MAX_LINES = 500, MAX_JSON = 2000;
const KNOWN_RELS = [...RELATIONS, ...DERIVED_RELATIONS];
const typeHelp = `${CORE_NODE_TYPES.join(', ')}, x-<sys>.<kind>`;
const uriOf = (type: string, id: string): string | null => { try { return nodeUri(type, id); } catch { return null; } }; // an id outside the id rule has no URI

type Values = { rel?: string; depth?: number; reverse?: boolean; type?: string };

type Row = Record<string, unknown>;
const MATERIALIZE: ReadonlyArray<{ file: string; key: 'id' | 'n'; label: string }> = [{ file: 'people.jsonl', key: 'id', label: 'people' }, { file: 'sprints.jsonl', key: 'n', label: 'sprints' }, { file: 'epics.jsonl', key: 'id', label: 'epics' }];

/** The nodes the v1 files name, per node file: the schedule's owners (all versions) and sprints, the tickets' epics. Sorted, each once. */
function namedNodes(ctx: Ctx): Record<string, Array<string | number>> {
  const sched = readRecords(ctx.dir, 'schedule.jsonl', { defaults: false }), tickets = readRecords(ctx.dir, 'tickets.jsonl', { defaults: false });
  const text = (v: unknown): string[] => (typeof v === 'string' && v ? [v] : []);
  const strs = (xs: string[]) => [...new Set(xs)].sort();
  return {
    'people.jsonl': strs(sched.flatMap((r) => text(r.owner))),
    'sprints.jsonl': [...new Set(sched.flatMap((r) => (Number.isSafeInteger(r.sprint) ? [r.sprint as number] : [])))].sort((a, b) => a - b),
    'epics.jsonl': strs(tickets.flatMap((r) => text(r.epic))),
  };
}

function materialize(ctx: Ctx): number {
  needBrain(ctx);
  const named = namedNodes(ctx), writes: Array<{ file: string; rows: Row[] }> = [], counts: Record<string, number> = {};
  let skipped = 0;
  for (const m of MATERIALIZE) {
    const file = path.join(ctx.dir, m.file), rows: Row[] = readRecords(ctx.dir, m.file, { defaults: false });
    const have = new Set(rows.map((r) => String(r[m.key]))), add: Row[] = [];
    for (const v of named[m.file] as Array<string | number>) {
      if (have.has(String(v))) continue;
      if (typeof v === 'string' && idProblem(v)) { skipped++; continue; } // the id rule applies to a new row
      add.push({ [m.key]: v });
    }
    counts[m.label] = add.length;
    if (add.length) writes.push({ file, rows: [...rows, ...add] });
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (skipped) ctx.io.err(`warning: ${skipped} name${skipped === 1 ? '' : 's'} outside the id rule left out`);
  if (writes.length) {
    precheckTargets(ctx, writes.map((w) => w.file));
    for (const w of writes) writeState(ctx, w.file, canonFile(w.rows, SCHEMAS[path.basename(w.file)]));
  }
  ctx.io.data?.({ added: total, ...counts, skipped }, { next: nextList(total ? ['plangraph build'] : []) });
  ctx.io.out(total ? `materialized ${total} node row${total === 1 ? '' : 's'} (${MATERIALIZE.map((m) => `${m.label} ${counts[m.label]}`).join(', ')})` : 'nothing to materialize');
  return 0;
}

async function graph(ctx: Ctx, args: Args<Values>): Promise<number> {
  if (args.positionals[0] === 'materialize') return materialize(ctx); // a ticket with that exact key is asked as pg:ticket/materialize
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
    run: graph as never, positionals: [1, 1], writes: 'text', guard: 'strict', options: { rel: { type: 'string' }, depth: { type: 'integer' }, reverse: B, type: { type: 'string' } },
    summary: 'KEY [--rel R,..] [--depth N] [--reverse] [--type T]: nodes reachable from a key (id or pg: URI) with their relation path; current schedule version only; `graph materialize` appends the people, sprints and epics the v1 files name to their node files (idempotent)',
  },
};
