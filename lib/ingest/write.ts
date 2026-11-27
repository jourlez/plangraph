// lib/ingest/write.ts: the one door through which `ingest docs` and `ingest requirements` store and read decision and requirement nodes.
// The PlanStore has no such kinds until task 12, so they go straight to the entity files (nodes/<kind>/<h2>/<slug>~<h12>.pg) of lib/store2;
// when the store learns the kinds, only this file changes.
import { readNodes, withNodes } from '../store2/nodes.ts';
import type { NodeTx } from '../store2/nodes.ts';
import { refuseWrite } from '../planstore.ts';
import type { Node } from '../store2/pg.ts';

export type DocKind = 'decision' | 'requirement';

/** The readable nodes of a document kind, sorted by id (a damaged file is left out; `plangraph check` reports it). */
export function readNodeKind(ctx: { dir: string }, kind: DocKind): Node[] {
  return readNodes(ctx.dir, kind).nodes;
}

/** Read and write document nodes in one transaction under the store lock: a node another writer changed between the read and the write is never overwritten with stale content. */
export function updateNodes<T>(ctx: { dir: string }, fn: (t: NodeTx) => T): T {
  try { return withNodes(ctx.dir, fn); } catch (e) { refuseWrite(e); }
}
