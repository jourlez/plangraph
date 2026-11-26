// The graph as views over the index (docs/FORMAT.md section 7). Two SQLite views, g_nodes(id, type) and g_links(src, src_type, rel, dst,
// dst_type, version, kind), read the tables of the v1 files and of the graph files; nothing is stored twice. This module holds the exact
// DDL (src/db.ts and bin/plangraph-solve accept a view only when its `sql` is byte-equal to it), the bounded breadth-first `reach`, and
// `graphReader`, the read side the commands share: nodes, neighbours and the blocker facts of a ticket.
// - Derived relations come from the tables: needs (edge), assigned_to and scheduled_in (schedule, per version), belongs_to (ticket.epic),
//   implements and part_of (ref.plans: a plan task implements its ticket and is part of its plan), specified_by (plan to doc, through the
//   epic's tasks and the epic row's files), tracked_by (xref), owned_by (repo.owners), part_of (a repo sub-unit `<repo>#<sub>` from repo.paths).
// - held_by is not in the view: open-items.jsonl is not indexed (an `open-items --close` would leave the index stale), so graphReader adds
//   the open-item nodes and the held_by edges from the register in TypeScript.
// - links.jsonl rows hold only hand-authored relations; a derived relation in that table is left out of the view, so the two sources never overlap.
import { PlangraphError } from '../../src/errors.ts';
import { blockingItems, closedSet } from '../openitems.ts';
import type { OpenItem } from '../openitems.ts';
import { DERIVED_RELATIONS, EXT_REL_RE, RELATIONS, isNodeType } from './files.ts';
import type { DerivedRel, NodeType } from './files.ts';

/** The longest path `reach` walks. */
export const GRAPH_MAX_DEPTH = 20;

/** Any relation a path can carry: the stored ones, the derived ones, and extension relations `x-<sys>/<rel>`. */
export type Rel = (typeof RELATIONS)[number] | DerivedRel | `x-${string}/${string}`;
export type NodeRef = { id: string; type: NodeType };
type Step = { rel: Rel; id: string; type: NodeType };
export type Reached = NodeRef & { path: Step[] };
/** What reach reads: IndexHandle (src/db.ts) has this method. `older` is set on a handle of an index built before the graph views existed. */
export interface Queryable { all(sql: string, ...a: unknown[]): unknown[]; older?: boolean }

// ---------- the DDL (one statement each; stored by SQLite exactly as written, so no trailing `;` and no IF NOT EXISTS) ----------
// json_each walks the JSON text of ref.plans, ref.files, repo.owners and repo.paths. Every json_type / json_extract is inside a CASE on the
// entry's type, so a malformed entry (a string where an object is expected) gives NULL and never a SQL error.
const sqlList = (xs: readonly string[]): string => xs.map((x) => `'${x}'`).join(', ');
const ENTRY = (field: string): string => `CASE WHEN j.type = 'object' THEN CASE WHEN json_type(j.value, '$.${field}') = 'text' THEN json_extract(j.value, '$.${field}') END END`;
const PE = `pe(k, plan, task) AS (SELECT r."key", ${ENTRY('plan')}, ${ENTRY('task')} FROM ref r, json_each(r."plans") j)`;
const DE = `de(k, doc) AS (SELECT r."key", j."key" FROM ref r, json_each(r."files") j WHERE substr(r."key", 1, 3) = 'sp:' AND instr(r."key", '/') = 0)`;
const SB = `sb(repo, sub) AS (SELECT p."id", ${ENTRY('sub')} FROM repo p, json_each(p."paths") j)`;
const HAS_PLAN = 'plan IS NOT NULL';
const HAS_TASK = 'plan IS NOT NULL AND task IS NOT NULL';
const HAS_SUB = "sub IS NOT NULL AND sub <> ''";
const TEXT = (c: string): string => `${c} IS NOT NULL AND ${c} <> ''`;

export const G_NODES_SQL = [
  'CREATE VIEW g_nodes(id, type) AS WITH', [PE, SB].join(', '),
  `SELECT "key", 'ticket' FROM ticket`,
  `UNION SELECT "id", 'person' FROM person`,
  `UNION SELECT "owner", 'person' FROM schedule WHERE ${TEXT('"owner"')}`,
  `UNION SELECT 'S' || "n", 'sprint' FROM sprint`,
  `UNION SELECT 'S' || "sprint", 'sprint' FROM schedule WHERE typeof("sprint") = 'integer'`,
  `UNION SELECT "id", 'epic' FROM epic`,
  `UNION SELECT "epic", 'epic' FROM ticket WHERE ${TEXT('"epic"')}`,
  `UNION SELECT "id", 'repo' FROM repo`,
  `UNION SELECT repo || '#' || sub, 'repo' FROM sb WHERE ${HAS_SUB}`,
  `UNION SELECT plan, 'plan' FROM pe WHERE ${HAS_PLAN}`,
  `UNION SELECT plan || '#' || task, 'plantask' FROM pe WHERE ${HAS_TASK}`,
  `UNION SELECT j."key", 'doc' FROM ref r, json_each(r."files") j WHERE substr(r."key", 1, 3) = 'sp:' AND instr(r."key", '/') = 0`,
].join(' ');

const SYS_NAME = `CASE WHEN instr("sys", ':') > 0 THEN substr("sys", 1, instr("sys", ':') - 1) ELSE "sys" END`;
export const G_LINKS_SQL = [
  'CREATE VIEW g_links(src, src_type, rel, dst, dst_type, version, kind) AS WITH', [PE, DE, SB].join(', '),
  `SELECT "from", "from_type", "rel", "to", "to_type", NULL, NULL FROM link WHERE "rel" NOT IN (${sqlList(DERIVED_RELATIONS)})`,
  `UNION ALL SELECT "consumer", 'ticket', 'needs', "producer", 'ticket', NULL, "kind" FROM edge`,
  `UNION ALL SELECT "key", 'ticket', 'assigned_to', "owner", 'person', "version", NULL FROM schedule WHERE ${TEXT('"owner"')}`,
  `UNION ALL SELECT "key", 'ticket', 'scheduled_in', 'S' || "sprint", 'sprint', "version", NULL FROM schedule WHERE typeof("sprint") = 'integer'`,
  `UNION ALL SELECT "key", 'ticket', 'belongs_to', "epic", 'epic', NULL, NULL FROM ticket WHERE ${TEXT('"epic"')}`,
  `UNION ALL SELECT DISTINCT plan || '#' || task, 'plantask', 'implements', k, 'ticket', NULL, NULL FROM pe WHERE ${HAS_TASK}`,
  `UNION ALL SELECT DISTINCT plan || '#' || task, 'plantask', 'part_of', plan, 'plan', NULL, NULL FROM pe WHERE ${HAS_TASK}`,
  `UNION ALL SELECT repo || '#' || sub, 'repo', 'part_of', repo, 'repo', NULL, NULL FROM sb WHERE ${HAS_SUB}`,
  `UNION ALL SELECT DISTINCT pe.plan, 'plan', 'specified_by', de.doc, 'doc', NULL, NULL FROM pe JOIN ticket t ON t."key" = pe.k JOIN de ON de.k = t."epic" WHERE pe.plan IS NOT NULL`,
  `UNION ALL SELECT "id", "type", 'tracked_by', "sys" || ':' || "xid", 'x-' || ${SYS_NAME} || '.ref', NULL, NULL FROM xref`,
  `UNION ALL SELECT p."id", 'repo', 'owned_by', j.value, 'person', NULL, NULL FROM repo p, json_each(p."owners") j WHERE j.type = 'text'`,
].join(' ');

/** The views, in the order `buildIndex` creates them, with the name and the exact `sql` SQLite stores for each. */
export const GRAPH_VIEWS: ReadonlyArray<readonly [string, string]> = Object.freeze([['g_nodes', G_NODES_SQL], ['g_links', G_LINKS_SQL]] as const);

// ---------- reach ----------
const refKey = (type: string, id: string): string => JSON.stringify([type, id]);
type Row = { a: string; a_type: string; rel: string; b: string; b_type: string };

function refuseOld(db: Queryable): void {
  if (db.older) throw new PlangraphError('STALE', 'the index was built by an older plangraph', { hint: 'run `plangraph build`' });
}

// A relation name and a node type are written into the statement as literals, never bound: with a literal SQLite compares it with the
// constant relation of each branch of the view at compile time and skips the branches that cannot match, so `needs` alone touches the edge
// table only. That is safe because only a name of the closed grammars gets in (a relation of the lists or `x-<sys>/<rel>`, a node type of
// lib/graph/files.ts); anything else is an error before the statement is built.
const REL_LITERAL = new Set<string>([...RELATIONS, ...DERIVED_RELATIONS]);
const relLiteral = (rel: string): string => {
  if (!REL_LITERAL.has(rel) && !EXT_REL_RE.test(rel)) throw new RangeError('not a relation of the graph');
  return `'${rel}'`;
};

/** The edges that leave `from` (or reach it, with `reverse`) over `rels`, from the view. Rows come back ordered, so a walk is deterministic. */
function viewEdges(db: Queryable, from: readonly NodeRef[], rels: readonly string[], reverse: boolean, version: string): Row[] {
  if (!rels.length) return [];
  const [a, b] = reverse ? ['dst', 'src'] : ['src', 'dst'], list = [...new Set(rels)].map(relLiteral).join(', ');
  const byType = new Map<string, string[]>();
  for (const n of from) { const l = byType.get(n.type); if (l) l.push(n.id); else byType.set(n.type, [n.id]); }
  const out: Row[] = [];
  for (const [type, ids] of byType) {
    if (!isNodeType(type)) continue; // a type of the grammar only is written into the statement
    const sql = `SELECT ${a} a, ${a}_type a_type, rel, ${b} b, ${b}_type b_type FROM g_links WHERE ${a}_type = '${type}' AND ${a} IN (SELECT value FROM json_each(?)) AND rel IN (${list}) AND (version IS NULL OR version = ?) ORDER BY rel, ${b}, ${b}_type`;
    out.push(...(db.all(sql, JSON.stringify(ids), version) as Row[])); // the columns this SELECT names
  }
  return out;
}

type Fetch = (from: readonly NodeRef[], rels: readonly string[], reverse: boolean, version: string) => Row[];
function walk(start: NodeRef, rels: readonly string[], depth: number, reverse: boolean, version: string, fetch: Fetch): Reached[] {
  if (!Number.isInteger(depth) || depth < 1 || depth > GRAPH_MAX_DEPTH) throw new RangeError(`depth must be a whole number from 1 to ${GRAPH_MAX_DEPTH}`);
  const seen = new Set([refKey(start.type, start.id)]), out: Reached[] = [];
  let frontier: Reached[] = [{ ...start, path: [] }];
  for (let d = 0; d < depth && frontier.length; d++) {
    const rows = fetch(frontier, rels, reverse, version), bySrc = new Map<string, Row[]>();
    for (const r of rows) { const k = refKey(r.a_type, r.a); const l = bySrc.get(k); if (l) l.push(r); else bySrc.set(k, [r]); }
    const next: Reached[] = [];
    for (const f of frontier) {
      for (const r of bySrc.get(refKey(f.type, f.id)) ?? []) {
        const k = refKey(r.b_type, r.b);
        if (seen.has(k)) continue; // the first (shortest) path to a node wins; a cycle ends here
        seen.add(k);
        const node: Reached = { id: r.b, type: r.b_type as NodeType, path: [...f.path, { rel: r.rel as Rel, id: r.b, type: r.b_type as NodeType }] }; // the view's own type strings
        out.push(node); next.push(node);
      }
    }
    frontier = next;
  }
  return out;
}

/** Every node within `depth` steps of `start` over `rels`, breadth first, each (id, type) once with its shortest path (never an enumeration
 * of paths: a diamond chain is linear). `reverse` follows the relations backwards. `version` selects the schedule version of assigned_to
 * and scheduled_in (the other relations carry no version). depth is a whole number from 1 to GRAPH_MAX_DEPTH. */
export function reach(db: Queryable, start: NodeRef, rels: readonly Rel[], depth: number, reverse: boolean, version = 'current'): Reached[] {
  refuseOld(db);
  return walk(start, rels, depth, reverse, version, (from, rs, rv, v) => viewEdges(db, from, rs, rv, v));
}

// ---------- the reader ----------
export interface BlockerSource {
  ticket(key: string): { verdict: string; jira_status: string; impl_status: string | null } | null;
  /** Is the open-items register's item key|kind closed? */
  shut(key: string, kind: string): boolean;
  /** The current placement of a ticket, as stored (unchecked), or null. */
  place(key: string): { owner: unknown; sprint: unknown } | null;
  findings(key: string): ReadonlyArray<{ kind: string; text: string }>;
  openItems(key: string): ReadonlyArray<{ key: string; kind: string; status: string; owner: string; text: string }>;
  producers(key: string): ReadonlyArray<{ key: string; kind: string | null }>;
}
export interface GraphReader extends BlockerSource {
  node(id: string, type?: NodeType): ReadonlyArray<NodeRef>;
  reach(start: NodeRef, rels: readonly Rel[], depth: number, reverse: boolean, version?: string): Reached[];
}

const itemId = (i: { key: string; kind: string }): string => `${i.key}|${i.kind}`;
const str = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));

/** The read side over one index handle and the open-items register (`items`, from readItems). */
export function graphReader(db: Queryable, items: readonly OpenItem[]): GraphReader {
  refuseOld(db);
  const shut = closedSet(items);
  const open = new Map<string, OpenItem>(); // open register items by key|kind: the only held_by edges
  for (const i of items) if (!shut.has(itemId(i)) && !open.has(itemId(i))) open.set(itemId(i), i);
  const all = new Map<string, OpenItem>(); for (const i of items) if (!all.has(itemId(i))) all.set(itemId(i), i); // every item is a node
  const heldBy = (from: readonly NodeRef[], rels: readonly string[], reverse: boolean): Row[] => {
    if (!rels.includes('held_by')) return [];
    const rows: Row[] = [];
    for (const n of from) {
      if (!reverse && n.type === 'ticket') for (const [id, i] of open) { if (i.key === n.id) rows.push({ a: n.id, a_type: 'ticket', rel: 'held_by', b: id, b_type: 'openitem' }); }
      if (reverse && n.type === 'openitem' && open.has(n.id)) rows.push({ a: n.id, a_type: 'openitem', rel: 'held_by', b: (open.get(n.id) as OpenItem).key, b_type: 'ticket' }); // has() just checked
    }
    return rows.sort((x, y) => (x.b < y.b ? -1 : x.b > y.b ? 1 : 0));
  };
  return {
    ticket(key) {
      const r = db.all('SELECT "verdict", "jira_status", "impl_status" FROM ticket WHERE "key" = ?', key)[0] as { verdict: unknown; jira_status: unknown; impl_status: unknown } | undefined; // the columns this SELECT names
      return r ? { verdict: str(r.verdict), jira_status: str(r.jira_status), impl_status: r.impl_status === null || r.impl_status === undefined ? null : str(r.impl_status) } : null;
    },
    shut: (key, kind) => shut.has(itemId({ key, kind })),
    place(key) {
      return (db.all(`SELECT "owner", "sprint" FROM schedule WHERE "version" = 'current' AND "key" = ?`, key)[0] as { owner: unknown; sprint: unknown } | undefined) ?? null; // the columns this SELECT names
    },
    findings(key) {
      return (db.all('SELECT "kind", "text" FROM finding WHERE "key" = ? ORDER BY rowid', key) as Array<{ kind: unknown; text: unknown }>).map((f) => ({ kind: str(f.kind), text: str(f.text) })); // the columns this SELECT names
    },
    openItems(key) {
      return blockingItems(items, key).map((i) => ({ key: i.key, kind: i.kind, status: str(i.status), owner: str(i.owner), text: str(i.text) }));
    },
    producers(key) {
      return (db.all('SELECT "producer", "kind" FROM edge WHERE "consumer" = ? ORDER BY "producer"', key) as Array<{ producer: unknown; kind: unknown }>).map((e) => ({ key: str(e.producer), kind: e.kind === null || e.kind === undefined ? null : str(e.kind) })); // the columns this SELECT names
    },
    node(id, type) {
      const rows = (type === undefined ? db.all('SELECT id, type FROM g_nodes WHERE id = ? ORDER BY type', id) : db.all('SELECT id, type FROM g_nodes WHERE id = ? AND type = ?', id, type)) as Array<{ id: string; type: string }>; // the view's columns
      const refs: NodeRef[] = rows.map((r) => ({ id: r.id, type: r.type as NodeType })); // the view's own type strings
      if ((type === undefined || type === 'openitem') && all.has(id)) refs.push({ id, type: 'openitem' });
      return refs.sort((x, y) => (x.type < y.type ? -1 : x.type > y.type ? 1 : 0));
    },
    reach(start, rels, depth, reverse, version = 'current') {
      return walk(start, rels, depth, reverse, version, (from, rs, rv, v) => [...viewEdges(db, from, rs, rv, v), ...heldBy(from, rs, rv)]);
    },
  };
}
