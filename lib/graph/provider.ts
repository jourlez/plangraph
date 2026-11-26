// The provider seam (docs/superpowers/plans/2026-11-25-graph-v2-amendment.md section 3.3). A provider turns data another tool saved to a file
// into observations: advisory facts about nodes of another system, kept in the uncommitted cache <dir>/cache/<provider>.jsonl and read into
// the index table `obs`. Pure: no file, no network, no process; the input is hostile JSON (or text), every string passes oneLine and a length
// cap, no key of an input object is ever used as a property name of a plain object. An observation never writes edges, schedule or tickets.
import { createHash } from 'node:crypto';
import { oneLine } from '../sanitize.ts';
import { importIssues } from '../jira/snapshot.ts';
import { parseLedger, parsePlan } from '../integrations/superpowers.ts';
import { EXT_REL_RE, EXT_TYPE_RE, isNodeType, sysOk, xidOk } from './files.ts';
import type { NodeType } from './files.ts';
import { FIELD_KEY, MAX_FIELDS, MAX_LINKS, TEXT } from './obs.ts';
export { CACHE_FILES, OBS_COLUMNS, obsProblem } from './obs.ts';

export type FieldValue = string | number | boolean | null;
export interface Observation { sys: string; xid: string; type: NodeType; fields: Readonly<Record<string, FieldValue>>; links: ReadonlyArray<{ rel: string; sys: string; xid: string }>; fp: string }
export interface ProviderBatch { observations: Observation[]; warnings: string[]; dropped: number }
export interface GraphProvider {
  readonly sys: string; readonly schema: 1;
  /** How `plangraph import` reads a file for this provider: parsed JSON, or the text itself. */
  readonly input: 'json' | 'text';
  validXid(xid: string): boolean;
  normalize(input: unknown, opts: { tenant: string; now: string; prev: ReadonlyMap<string, Observation> | null }): ProviderBatch;
}
/** A cache row: an observation plus the day it was seen (`ctx.now`). */
export type ObsRow = Observation & { seen: string };

export const MAX_OBSERVATIONS = 50000;
export const MAX_INPUT_BYTES = 8 << 20;
const MAX_WARNINGS = 20;
const isObj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);
const own = (o: Record<string, unknown>, k: string): unknown => (Object.hasOwn(o, k) ? o[k] : undefined);

/** The fingerprint of an observation's content (type, fields, links): equal input gives equal bytes whatever the key order. */
function fingerprint(type: string, fields: Readonly<Record<string, FieldValue>>, links: ReadonlyArray<{ rel: string; sys: string; xid: string }>): string {
  const f = Object.keys(fields).sort().map((k) => [k, fields[k]]);
  return createHash('sha256').update(JSON.stringify([type, f, links.map((l) => [l.rel, l.sys, l.xid])])).digest('hex').slice(0, 16);
}
function build(sys: string, xid: string, type: NodeType, rawFields: Record<string, FieldValue>, rawLinks: Array<{ rel: string; sys: string; xid: string }>): Observation {
  const fields: Record<string, FieldValue> = Object.create(null);
  for (const k of Object.keys(rawFields).sort()) fields[k] = rawFields[k] as FieldValue; // sorted, so the stored bytes do not depend on the input order
  const links = [...rawLinks].sort((a, b) => (a.rel + a.sys + a.xid < b.rel + b.sys + b.xid ? -1 : 1));
  return { sys, xid, type, fields, links, fp: fingerprint(type, fields, links) };
}
const text = (s: unknown): string => oneLine(s, TEXT);
const batch = (): ProviderBatch & { seen: Set<string> } => ({ observations: [], warnings: [], dropped: 0, seen: new Set() });
const warn = (b: ProviderBatch, m: string): void => { if (b.warnings.length < MAX_WARNINGS) b.warnings.push(oneLine(m, 160)); };
function add(b: ProviderBatch & { seen: Set<string> }, o: Observation): void {
  const id = `${o.sys}\0${o.xid}`;
  if (b.seen.has(id)) { b.dropped++; return; } // the same node twice in one input: the first one stands
  if (b.observations.length >= MAX_OBSERVATIONS) { b.dropped++; return; }
  b.seen.add(id); b.observations.push(o);
}

// ---------- generic: strict plangraph-ext-batch@1 ----------
// { "schema": "plangraph-ext-batch@1", "sys": "x-<name>", "observations": [{ "xid", "type": "x-<name>.<kind>", "fields": {k: scalar}, "links": [{ "rel": "x-<name>/<rel>", "sys", "xid" }] }] }
// A generic batch can only speak about its own `x-` system and its own extension types: it cannot claim to be jira or sp.
const BATCH_SCHEMA = 'plangraph-ext-batch@1';
function genericFields(o: Record<string, unknown>): Record<string, FieldValue> | null {
  const raw = own(o, 'fields');
  if (raw === undefined) return {};
  if (!isObj(raw)) return null;
  const out: Record<string, FieldValue> = {}; let n = 0;
  for (const k of Object.keys(raw)) {
    if (!FIELD_KEY.test(k)) return null;
    const v = raw[k];
    if (++n > MAX_FIELDS) return null;
    if (typeof v === 'string') out[k] = text(v);
    else if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) out[k] = v;
    else return null;
  }
  return out;
}
function genericLinks(o: Record<string, unknown>): Array<{ rel: string; sys: string; xid: string }> | null {
  const raw = own(o, 'links');
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_LINKS) return null;
  const out: Array<{ rel: string; sys: string; xid: string }> = [];
  for (const l of raw) {
    if (!isObj(l)) return null;
    const rel = own(l, 'rel'), sys = own(l, 'sys'), xid = own(l, 'xid');
    if (typeof rel !== 'string' || typeof sys !== 'string' || typeof xid !== 'string' || !EXT_REL_RE.test(rel) || !sysOk(sys) || !xidOk(xid)) return null;
    out.push({ rel, sys, xid });
  }
  return out;
}
const generic: GraphProvider = {
  sys: 'generic', schema: 1, input: 'json', validXid: xidOk,
  normalize(input) {
    const b = batch();
    if (!isObj(input) || own(input, 'schema') !== BATCH_SCHEMA) throw new Error(`the input is not a ${BATCH_SCHEMA} batch`);
    const sys = own(input, 'sys'), list = own(input, 'observations');
    if (typeof sys !== 'string' || !sysOk(sys) || !/^x-[a-z][a-z0-9-]{0,23}$/.test(sys)) throw new Error('a generic batch needs "sys": "x-<name>"');
    if (!Array.isArray(list)) throw new Error('a generic batch needs an "observations" array');
    for (const o of list) {
      if (!isObj(o)) { b.dropped++; continue; }
      const xid = own(o, 'xid'), type = own(o, 'type'), fields = genericFields(o), links = genericLinks(o);
      if (typeof xid !== 'string' || !xidOk(xid) || !isNodeType(type) || !EXT_TYPE_RE.test(type) || !type.startsWith(`${sys}.`) || !fields || !links) { b.dropped++; continue; }
      add(b, build(sys, xid, type, fields, links));
    }
    if (b.dropped) warn(b, `${b.dropped} observation(s) dropped (bad shape, id, type, field or link)`);
    return b;
  },
};

// ---------- jira: a snapshot of issues, read through the existing importer ----------
const jira: GraphProvider = {
  sys: 'jira', schema: 1, input: 'json', validXid: (x) => /^[A-Z][A-Z0-9]*-\d+$/.test(x),
  normalize(input, opts) {
    const b = batch(), sys = `jira:${opts.tenant}`;
    if (!sysOk(sys)) throw new Error('jira needs a tenant alias (--tenant ALIAS or jira.tenant in the config)');
    const r = importIssues(null, input as never, { now: () => new Date(opts.now) });
    b.dropped = r.dropped;
    for (const i of r.snapshot.issues) {
      const fields: Record<string, FieldValue> = { summary: text(i.summary), status: text(i.status), assignee: text(i.assignee), updated: text(i.updated), resolved: text(i.resolutiondate) };
      if (i.sprint?.length) { fields.sprint = i.sprint.map((s) => s.id).join(','); fields.sprint_state = text(i.sprint[i.sprint.length - 1]?.state); }
      const links = i.issuelinks.filter((l) => l.dir === 'out' && l.rel.toLowerCase() === 'blocks').slice(0, MAX_LINKS).map((l) => ({ rel: 'x-jira/blocks', sys, xid: l.key }));
      add(b, build(sys, i.key, 'ticket', fields, links));
    }
    return b;
  },
};
// ---------- sp: a superpowers plan (and its ledger) ----------
// Input: { name: <repo-relative plan path>, text: <plan markdown>, ledger?: <ledger text> }. Tickets are `sp:<slug>/<id>`, the plan is a `plan` node.
const sp: GraphProvider = {
  sys: 'sp', schema: 1, input: 'text', validXid: (x) => xidOk(x),
  normalize(input) {
    const b = batch();
    if (!isObj(input) || typeof input.name !== 'string' || typeof input.text !== 'string') throw new Error('an sp input needs a plan name and text');
    const plan = parsePlan(input.text, input.name);
    const status = new Map<string, string>();
    if (typeof input.ledger === 'string') for (const e of parseLedger(input.ledger, 'ledger').entries) status.set(e.task, e.status);
    const tasks = plan.tasks.slice(0, MAX_OBSERVATIONS - 1);
    const planFields: Record<string, FieldValue> = { title: text(plan.header.title), tasks: tasks.length };
    if (xidOk(plan.path)) add(b, build('sp', plan.path, 'plan', planFields, []));
    for (const t of tasks) {
      const xid = `sp:${plan.slug}/${t.id}`;
      if (!xidOk(xid)) { b.dropped++; continue; }
      const fields: Record<string, FieldValue> = { title: text(t.title), steps: t.steps, checked: t.ticked, points: t.points };
      const s = status.get(t.id); if (s !== undefined) fields.status = text(s);
      add(b, build('sp', xid, 'ticket', fields, []));
    }
    for (const w of plan.warnings.slice(0, 3)) warn(b, w);
    return b;
  },
};

/** The built-in providers (nothing loads dynamically): frozen, null-prototype; look up with providerOf (Object.hasOwn), never by a bare key. */
export const PROVIDERS: Readonly<Record<string, GraphProvider>> = Object.freeze(Object.assign(Object.create(null) as Record<string, GraphProvider>, { jira, sp, generic }));
export const providerOf = (name: string): GraphProvider | null => (Object.hasOwn(PROVIDERS, name) ? (PROVIDERS[name] as GraphProvider) : null);
