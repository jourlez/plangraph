// Entity files on disk: read, write, delete, rename and erase of nodes/<kind>/<h2>/<slug>~<h8>.pg (spec 4.0). A damaged file is a
// Problem, never an exception: readers skip it and say why. Writes go through writeAtomicSafe (confined to the store root, no symlink
// written through); reads go through readDataCapped (regular files only, capped). A multi-file operation (rename) is not one transaction
// here: batches/txn wrap it when a command needs that.
import fs from 'node:fs';
import path from 'node:path';
import { assertInside, writeAtomicSafe } from '../fsafe.ts';
import { readDataCapped } from '../jsonl.ts';
import { assertKind, nodePath } from './layout.ts';
import { formatPg, parsePg } from './pg.ts';
import type { Node, PgProblem } from './pg.ts';

export const MAX_NODE_BYTES = 256 * 1024;
export type ProblemCode = PgProblem | 'SYMLINK' | 'OVERSIZE';
export interface Problem { code: ProblemCode; path: string; line: number; fix: string }
export interface ErasePlan { id: string; files: string[]; links: Array<{ path: string; rel: string }>; events: Array<{ path: string; line: number }> }

export const FIX: Readonly<Record<string, string>> = {
  CONFLICT_MARKERS: 'run plangraph resolve, then settle any scalar conflict by hand and run plangraph check',
  BAD_LINE: 'repair or remove the line, then run plangraph check',
  ID_MISMATCH: 'the file name or directory does not match the id inside: restore the file or move it to its hashed name',
  SYMLINK: 'replace the symlink with a regular file',
  OVERSIZE: 'node files are at most 256 KiB: split the content',
};
export const problem = (root: string, abs: string, code: ProblemCode, line: number): Problem => ({ code, path: path.relative(root, abs), line, fix: FIX[code] as string }); // FIX has every code

const sortById = (a: Node, b: Node) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const sortByPath = (a: Problem, b: Problem) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line);
const dirents = (d: string): fs.Dirent[] => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; } }; // a missing directory is an empty one

/** The kinds that have a directory under nodes/ (sorted). */
export const listKinds = (root: string): string[] => dirents(path.join(root, 'nodes')).filter((d) => d.isDirectory() && /^[a-z][a-z0-9-]{0,39}$/.test(d.name)).map((d) => d.name).sort();

/** Every entry a node reader must look at in one kind: `.pg` names in the hash directories (and directly in the kind directory),
 * plus a symlinked hash directory, so the loader can name it. Absolute paths, sorted. */
export function listNodeFiles(root: string, kind: string): string[] {
  const base = path.join(root, 'nodes', assertKind(kind)), out: string[] = [];
  for (const e of dirents(base)) {
    const p = path.join(base, e.name);
    if (e.isDirectory()) { for (const f of dirents(p)) if (f.name.endsWith('.pg')) out.push(path.join(p, f.name)); }
    else if (e.isSymbolicLink() || e.name.endsWith('.pg')) out.push(p);
  }
  return out.sort();
}

export type Raw = { node: Node; text: string } | { problem: Problem };
/** Read and parse one entity file; the location is not judged here. */
export function loadRaw(root: string, abs: string): Raw {
  let text: string;
  try { text = readDataCapped(abs, MAX_NODE_BYTES); }
  catch (e) {
    const c = (e as NodeJS.ErrnoException).code;
    return { problem: problem(root, abs, c === 'SYMLINK' || c === 'ELOOP' ? 'SYMLINK' : c === 'TOO_LARGE' ? 'OVERSIZE' : 'BAD_LINE', 0) }; // anything else unreadable: a bad file
  }
  const r = parsePg(text, abs);
  return 'node' in r ? { node: r.node, text } : { problem: problem(root, abs, r.problem, r.line) };
}

export function readNodes(root: string, kind: string): { nodes: Node[]; problems: Problem[] } {
  const nodes: Node[] = [], problems: Problem[] = [];
  for (const abs of listNodeFiles(root, kind)) {
    const r = loadRaw(root, abs);
    if ('problem' in r) problems.push(r.problem);
    else if (abs !== nodePath(root, kind, r.node.id)) problems.push(problem(root, abs, 'ID_MISMATCH', 1)); // right name, wrong directory
    else nodes.push(r.node);
  }
  return { nodes: nodes.sort(sortById), problems: problems.sort(sortByPath) };
}

export function writeNode(root: string, kind: string, n: Node): 'created' | 'changed' | 'same' {
  if (typeof n.id !== 'string' || n.id === '') throw new TypeError('a node needs a non-empty string id');
  const file = nodePath(root, kind, n.id), text = formatPg(n);
  let state: 'created' | 'changed' = 'created';
  try { fs.lstatSync(file); state = 'changed'; } catch { /* new file */ }
  if (state === 'changed') { try { if (readDataCapped(file, MAX_NODE_BYTES) === text) return 'same'; } catch { /* unreadable: rewritten below */ } }
  assertInside(root, path.dirname(file));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeAtomicSafe(file, text, { root });
  return state;
}

export function deleteNode(root: string, kind: string, id: string): void {
  const file = nodePath(root, kind, id);
  assertInside(root, path.dirname(file));
  fs.rmSync(file, { force: true });
}

const rewrite = (n: Node, from: string, to: string): Node | null => {
  let hit = false;
  const links = Array.isArray(n.links) ? (n.links as Array<Record<string, unknown>>).map((l) => (l && l.to === from ? ((hit = true), { ...l, to }) : l)) : n.links;
  const xrefs = Array.isArray(n.xrefs) ? (n.xrefs as Array<Record<string, unknown>>).map((x) => (x && x.xid === from ? ((hit = true), { ...x, xid: to }) : x)) : n.xrefs;
  return hit ? { ...n, ...(links !== undefined ? { links } : {}), ...(xrefs !== undefined ? { xrefs } : {}) } : null;
};

/** Move a node to a new id: the new file first, then every link and xref that named the old id (in any kind), then the old file is
 * removed, or kept as `{ id: from, alias_of: to }` with keepAlias. */
export function renameNode(root: string, kind: string, from: string, to: string, opts: { keepAlias?: boolean } = {}): void {
  const src = loadRaw(root, nodePath(root, kind, from));
  if ('problem' in src) throw new Error(`node not found or unreadable: ${from.slice(0, 80)}`);
  if (fs.existsSync(nodePath(root, kind, to))) throw new Error(`target id exists: ${to.slice(0, 80)}`);
  writeNode(root, kind, rewrite({ ...src.node, id: to }, from, to) ?? { ...src.node, id: to });
  for (const k of listKinds(root)) {
    for (const abs of listNodeFiles(root, k)) {
      const r = loadRaw(root, abs);
      if ('problem' in r || (k === kind && r.node.id === from)) continue;
      const n = rewrite(r.node, from, to);
      if (n) writeNode(root, k, n);
    }
  }
  if (opts.keepAlias) writeNode(root, kind, { id: from, alias_of: to }); else deleteNode(root, kind, from);
}

/** Everything that names the id: its node file, the nodes whose links or xrefs point at it, and the lines of events/, runs/ and
 * schedules/ files that contain it. Read-only; git history is not touched. */
export function eraseNode(root: string, kind: string, id: string): ErasePlan {
  const plan: ErasePlan = { id, files: [], links: [], events: [] };
  const own = nodePath(root, kind, id);
  if (fs.existsSync(own)) plan.files.push(path.relative(root, own));
  for (const k of listKinds(root)) {
    for (const abs of listNodeFiles(root, k)) {
      const r = loadRaw(root, abs);
      if ('problem' in r || abs === own) continue;
      for (const l of (Array.isArray(r.node.links) ? r.node.links : []) as Array<Record<string, unknown>>) if (l && l.to === id) plan.links.push({ path: path.relative(root, abs), rel: String(l.rel) });
      for (const x of (Array.isArray(r.node.xrefs) ? r.node.xrefs : []) as Array<Record<string, unknown>>) if (x && x.xid === id) plan.links.push({ path: path.relative(root, abs), rel: `xref:${String(x.sys)}` });
    }
  }
  const needle = JSON.stringify(id);
  for (const f of listBatchFiles(root)) {
    let text: string;
    try { text = readDataCapped(f, 64 * 1024 * 1024); } catch { continue; } // an unreadable batch file is check's business
    text.split('\n').forEach((line, i) => { if (line.includes(needle)) plan.events.push({ path: path.relative(root, f), line: i + 1 }); });
  }
  plan.links.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return plan;
}

/** Every `.jsonl` file under events/, runs/ and schedules/ (absolute, sorted); a symlinked directory is not followed. */
export function listBatchFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => { for (const e of dirents(d)) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.jsonl')) out.push(p); } };
  for (const top of ['events', 'runs', 'schedules']) walk(path.join(root, top));
  return out.sort();
}
