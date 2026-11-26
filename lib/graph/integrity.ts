// Referential integrity of the graph files (docs/FORMAT.md section 6). integrity() returns what parseGraphFile cannot see: a link or xref
// that names no node, one external id on two nodes, a half-dated sprints file, and one work item placed twice. Field shapes, unknown
// relations and duplicate keys are parse errors (exit 2), never returned here. A directory with no graph file has no violation.
import path from 'node:path';
import { readJsonl } from '../jsonl.ts';
import { readGraphFiles, EXT_TYPE_RE } from './files.ts';
import type { GraphFiles } from './files.ts';
import { loadModel } from '../model.ts';
import type { ModelRecords, PlanConfig, ScheduleRow } from '../model.ts';
import type { OpenItem } from '../openitems.ts';
import { oneLine } from '../sanitize.ts';

export type IntegrityCode = 'LINK_MISSING_NODE' | 'XREF_MISSING_NODE' | 'XREF_DUPLICATE' | 'UNDATED_SPRINT' | 'DOUBLE_PLACED_WORK';
export interface IntegrityViolation { code: IntegrityCode; file: string; line: number | null; detail: string; warning: boolean }

const s = (x: unknown, n = 80): string => oneLine(String(x), n);
const isObj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);
const text = (x: unknown): x is string => typeof x === 'string' && x !== '';

/** The nodes the v1 files and the node files imply, as `type\0id` keys (the same sources as the g_nodes view, plus the open-item register). */
function nodeSet(files: GraphFiles, v1: ModelRecords, items: readonly OpenItem[]): Set<string> {
  const nodes = new Set<string>(), add = (type: string, id: unknown) => { if (text(id)) nodes.add(`${type}\0${id}`); };
  for (const t of v1.tickets ?? []) { add('ticket', t.key); add('epic', t.epic); }
  for (const r of v1.schedule ?? []) { add('person', r.owner); if (Number.isInteger(r.sprint)) add('sprint', `S${r.sprint}`); }
  for (const p of files.people) add('person', p.id);
  for (const sp of files.sprints) add('sprint', `S${sp.n}`);
  for (const e of files.epics) add('epic', e.id);
  for (const r of files.repos) {
    add('repo', r.id);
    for (const p of Array.isArray(r.paths) ? r.paths : []) if (isObj(p) && text(p.sub)) add('repo', `${r.id}#${p.sub}`);
  }
  for (const r of (v1.refs ?? []) as Array<Record<string, unknown>>) {
    for (const p of Array.isArray(r.plans) ? r.plans : []) if (isObj(p) && text(p.plan)) { add('plan', p.plan); if (text(p.task)) add('plantask', `${p.plan}#${p.task}`); }
    if (text(r.key) && r.key.startsWith('sp:') && !r.key.includes('/') && isObj(r.files)) for (const d of Object.keys(r.files)) add('doc', d);
  }
  for (const i of items) add('openitem', `${i.key}|${i.kind}`);
  return nodes;
}

/** Violations of the graph files against each other and the v1 data; `items` is the open-item register (any status). */
export function integrity(files: GraphFiles, v1: ModelRecords, items: readonly OpenItem[]): IntegrityViolation[] {
  const out: IntegrityViolation[] = [], nodes = nodeSet(files, v1, items);
  const put = (code: IntegrityCode, file: string, detail: string, warning = false) => out.push({ code, file, line: null, detail, warning });
  const known = (type: string, id: string): boolean => EXT_TYPE_RE.test(type) || nodes.has(`${type}\0${id}`); // an extension type is opaque: never missing
  for (const l of files.links) for (const [id, type] of [[l.from, l.from_type], [l.to, l.to_type]] as const) if (!known(type, id)) put('LINK_MISSING_NODE', 'links.jsonl', `${s(type, 40)} ${s(id)} is not a node (link ${s(l.from)} ${s(l.rel, 40)} ${s(l.to)})`);
  const byXid = new Map<string, Set<string>>();
  for (const x of files.xrefs) {
    if (!known(x.type, x.id)) put('XREF_MISSING_NODE', 'xrefs.jsonl', `${s(x.type, 40)} ${s(x.id)} is not a node (xref ${s(x.sys, 60)} ${s(x.xid)})`);
    const k = `${x.type}\0${x.sys}\0${x.xid}`;
    (byXid.get(k) ?? byXid.set(k, new Set()).get(k) as Set<string>).add(x.id);
  }
  for (const [k, ids] of byXid) if (ids.size > 1) { const [type, sys, xid] = k.split('\0') as [string, string, string]; put('XREF_DUPLICATE', 'xrefs.jsonl', `${s(sys, 60)} ${s(xid)} is on ${ids.size} ${s(type, 40)} nodes (${[...ids].sort().map((i) => s(i, 60)).join(', ')}); keep one row, then run plangraph build`); }
  const dated = files.sprints.filter((x) => text(x.start) && text(x.end)).length;
  if (dated > 0 && dated < files.sprints.length) put('UNDATED_SPRINT', 'sprints.jsonl', `${files.sprints.length - dated} of ${files.sprints.length} sprints have no start and end date; give every sprint both, or none`, true);
  const placed = new Set((v1.schedule ?? []).filter((r) => (r.version ?? 'current') === 'current' && Number.isInteger(r.sprint)).map((r) => r.key));
  for (const x of files.xrefs) if (x.type === 'ticket' && x.id.startsWith('sp:') && x.sys.split(':')[0] === 'jira' && placed.has(x.id) && placed.has(x.xid)) put('DOUBLE_PLACED_WORK', 'xrefs.jsonl', `${s(x.id)} and ${s(x.xid)} are one work item and both are placed, so capacity counts it twice; keep one of the two placed`, true);
  return out;
}

/** `error: CODE file: detail` or `warning: CODE file: detail`, the line build and check print. */
export const renderViolation = (v: IntegrityViolation): string => `${v.warning ? 'warning' : 'error'}: ${v.code} ${v.file}${v.line === null ? '' : `:${v.line}`}: ${v.detail}`;

/** Reads the graph files and the v1 files of a plan directory and checks them (a directory with no graph file gives none). A bad graph file throws
 * as parseGraphFile does (a data error, exit 2). */
export function integrityOf(dir: string, config: PlanConfig, items: readonly OpenItem[]): { files: GraphFiles; violations: IntegrityViolation[] } {
  const files = readGraphFiles(dir);
  if (!files.people.length && !files.sprints.length && !files.epics.length && !files.repos.length && !files.capacity.length && !files.links.length && !files.xrefs.length) return { files, violations: [] };
  const m = loadModel(dir, { config });
  return { files, violations: integrity(files, { tickets: [...m.tickets.values()], schedule: readJsonl(path.join(dir, 'schedule.jsonl')) as ScheduleRow[], refs: m.refs, config }, items) };
}
