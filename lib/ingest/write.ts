// lib/ingest/write.ts: the one door through which `ingest docs` and `ingest requirements` store and read decision and requirement nodes.
// The PlanStore has no such kinds until task 12, so they go straight to the entity files (nodes/<kind>/<h2>/<slug>~<h8>.pg) of lib/store2;
// when the store learns the kinds, only these two functions change.
import { readNodes, writeNode } from '../store2/nodes.ts';
import type { Node } from '../store2/pg.ts';

export type DocKind = 'decision' | 'requirement';

/** Write one node of a document kind; says whether the file was created, changed or already identical. */
export function writeNodeKind(ctx: { dir: string }, kind: DocKind, node: Node): 'created' | 'changed' | 'same' {
  return writeNode(ctx.dir, kind, node);
}

/** The readable nodes of a document kind, sorted by id (a damaged file is left out; `plangraph check` reports it). */
export function readNodeKind(ctx: { dir: string }, kind: DocKind): Node[] {
  return readNodes(ctx.dir, kind).nodes;
}
