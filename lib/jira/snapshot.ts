// lib/jira/snapshot.ts: issue normalization, pull (full and delta), import, the snapshot JSONL form and the legacy map. `str` is exported
// to render.ts only (lib/jira/index.ts does not re-export it).
import crypto from 'node:crypto';
import { sanitizeText, oneLine } from '../sanitize.ts';
import { parseJsonl } from '../jsonl.ts';
import type { JsonlRecord } from '../jsonl.ts';
import { JiraError } from './error.ts';
import { redact } from './redact.ts';
import { KEY_RE } from './types.ts';
import type {
  ImportResult, JiraIssue, JiraLink, JiraSprint, LegacyIssue, PullFailure, PullOptions, PullResult, PullSuccess, RawCustomField, RawFields, RawIssue,
  RawLink, RawSprint, Snapshot, SnapshotClient, SnapshotMeta, Unsummarized,
} from './types.ts';

const SCHEMA = 1;
const DEFAULT_FIELDS = ['summary', 'status', 'assignee', 'updated', 'resolutiondate', 'issuelinks'];

// ---------------------------------------------------------------- normalization and snapshots
/** The value when it is a string, otherwise the empty string (every leaf of untrusted JSON is read through it). */
export const str = (x: unknown): string => (typeof x === 'string' ? x : '');
const cmp = <T extends string | number>(a: T, b: T): number => (a < b ? -1 : a > b ? 1 : 0);
export function parseJiraTime(s: unknown): number {
  const m = /^(\d{4}-\d\d-\d\d)T(\d\d:\d\d:\d\d)(?:\.(\d+))?(Z|[+-]\d\d):?(\d\d)?$/.exec(str(s)); if (!m) return NaN;
  return Date.parse(`${m[1]}T${m[2]}.${(m[3] || '0').padEnd(3, '0').slice(0, 3)}${m[4] === 'Z' ? 'Z' : `${m[4]}:${m[5] || '00'}`}`);
}
const cmpTime = (a: unknown, b: unknown): number => { const x = parseJiraTime(a), y = parseJiraTime(b); return Number.isFinite(x) && Number.isFinite(y) ? cmp(x, y) : cmp(str(a), str(b)); };
function formatSince(ms: number, tz: string | undefined): string | null {
  if (!tz || !Number.isFinite(ms)) return null;
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
  } catch { return null; }
}
// Sprint parsing. Hostile-input rules: at most MAX_SPRINTS sprints are kept: the 20 with the HIGHEST ids (sprint ids grow over time, so these
// are the newest and include the current one; Jira lists sprints oldest first but the choice does not depend on input order), the rest are
// dropped silently. Pass 1 reads only each entry's id (O(1) for objects, one linear regex over at most 4000 chars for legacy strings), pass 2
// fully parses just the kept entries. Every string is one sanitized capped line.
const MAX_SPRINTS = 20;
function sprintsOf(v: unknown): JiraSprint[] {
  const arr: Array<RawSprint | string | null> = Array.isArray(v) ? v : [];
  const id = (x: unknown) => { const n = Number(x); return Number.isSafeInteger(n) ? n : 0; };
  const idOf = (s: RawSprint | string | null) => (s && typeof s === 'object' ? id(s.id) : id(/id=(\d+)/.exec(str(s).slice(0, 4000))?.[1]));
  const keyed = arr.map((s, i) => [idOf(s), i] as [number, number]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).slice(-MAX_SPRINTS);
  return keyed.map(([, i]) => {
    const s = arr[i];
    if (s && typeof s === 'object') return { id: id(s.id), name: oneLine(str(s.name), 80), state: oneLine(str(s.state), 20) };
    const t = str(s).slice(0, 4000);
    return { id: id(/id=(\d+)/.exec(t)?.[1]), name: oneLine(/name=([^,\]]*)/.exec(t)?.[1] || '', 80), state: oneLine(/state=(\w+)/.exec(t)?.[1] || '', 20) };
  });
}
// Sprint value lookup. The Atlassian connector nests custom fields under fields.customFields keyed by DISPLAY NAME, each { id, value }.
// Order: entry whose id === sprintField, else the entry named exactly "Sprint", else REST-style fields[sprintField]. Own keys only,
// prototype-ish names skipped, non-object entries tolerated.
const PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const own = (o: unknown, k: string): unknown => (o && typeof o === 'object' && !PROTO_KEYS.has(k) && Object.hasOwn(o, k) ? (o as Record<string, unknown>)[k] : undefined); // hasOwn above proves k is there
function sprintValue(f: RawFields, sprintField: string | undefined): { found: boolean; value?: unknown } {
  const cf = own(f, 'customFields') as Record<string, RawCustomField | undefined> | undefined; // shape unchecked: every read below tests it
  if (cf && typeof cf === 'object' && !Array.isArray(cf)) {
    const names = Object.keys(cf).filter((k) => !PROTO_KEYS.has(k));
    // hasVal returns the raw falsy value (null, 0, '') rather than false: callers use it only for truthiness, so never compare it with === true
    const hasVal = (e: unknown): e is RawCustomField => (e && typeof e === 'object' && !Array.isArray(e)) as boolean; // callers test only its truthiness: a non-null, non-array object
    if (sprintField) for (const k of names) { const e = cf[k]; if (hasVal(e) && e.id === sprintField) return { found: true, value: e.value }; }
    if (names.includes('Sprint') && hasVal(cf.Sprint)) return { found: true, value: cf.Sprint.value };
  }
  if (sprintField && own(f, sprintField) !== undefined) return { found: true, value: own(f, sprintField) };
  return { found: false };
}
/** An issue reduced to the snapshot fields, or null when the input has no valid key. The input is untrusted JSON. */
export function normalizeIssue(raw: RawIssue | null | undefined, { sprintField }: { sprintField?: string | undefined } = {}): JiraIssue | null {
  if (!raw || typeof raw.key !== 'string' || !KEY_RE.test(raw.key)) return null;
  const f: RawFields = raw.fields && typeof raw.fields === 'object' ? raw.fields : {};
  const links: JiraLink[] = [];
  for (const l of (Array.isArray(f.issuelinks) ? f.issuelinks : []) as RawLink[]) { // entries unchecked: each read below tests them
    for (const [dir, side, rel] of [['in', l?.inwardIssue, l?.type?.inward], ['out', l?.outwardIssue, l?.type?.outward]] as Array<['in' | 'out', { key?: unknown } | null | undefined, unknown]>) if (side && KEY_RE.test(str(side.key))) links.push({ key: side.key as string, type: oneLine(str(l.type?.name), 80), dir, rel: oneLine(str(rel), 80) }); // KEY_RE passed, so key is a string
  }
  links.sort((a, b) => cmp(a.key, b.key) || cmp(a.type, b.type) || cmp(a.dir, b.dir));
  const out: JiraIssue = { key: raw.key, summary: sanitizeText(str(f.summary), { max: 300 }), status: oneLine(str(f.status?.name), 80), assignee: sanitizeText(str(f.assignee?.displayName), { max: 300 }), updated: str(f.updated), resolutiondate: str(f.resolutiondate), issuelinks: links };
  const sp = sprintValue(f, sprintField);
  if (sprintField || sp.found) out.sprint = sprintsOf(sp.value);
  return out;
}
function boundedJql(jql: unknown): string {
  const s = typeof jql === 'string' ? jql.trim() : '';
  const m = /\border\s+by\b[^"']*$/i.exec(s); const base = (m ? s.slice(0, m.index) : s).trim();
  if (!base) throw new JiraError('unbounded_jql', 'refusing an empty or ORDER BY-only JQL: Jira rejects it, add a restriction (for example project = ABC)');
  if (base.length > 20000) throw new JiraError('bad_jql', 'JQL is too long');
  return base;
}
function normalizeFields(fields: unknown, sprintField: string | undefined): string[] {
  const f = fields === undefined ? [...DEFAULT_FIELDS] : fields;
  if (!Array.isArray(f) || !f.length || !f.every((x) => typeof x === 'string' && /^[A-Za-z][A-Za-z0-9_.-]*$/.test(x))) throw new JiraError('bad_fields', 'fields must be an explicit non-empty list of field ids (no *all, no negations)');
  const set = new Set<string>(f); set.add('updated'); if (sprintField) set.add(sprintField);
  return [...set].sort();
}
const hash = (issues: JiraIssue[]): string => crypto.createHash('sha256').update(JSON.stringify(issues)).digest('hex');
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export async function pullSnapshot(client: SnapshotClient, opts: PullOptions = {}): Promise<PullResult> {
  const { jql, previous = null, full = false, overlapMinutes = 5, fullReconcileEvery = 0, pageSize = 100, maxPages = 2000, sprintField, driftAbs = 5, driftPct = 0.02 } = opts;
  const base = boundedJql(jql); const fields = normalizeFields(opts.fields, sprintField);
  const me = await client.verify(); // throws on 401 / anonymous: nothing is fetched
  const prev = previous && previous.schema === SCHEMA && previous.meta && previous.meta.complete === true && previous.meta.jql === base && previous.meta.mode === client.mode
    && Object.entries(client.identity).every(([k, v]) => previous.meta[k] === v) && Array.isArray(previous.issues) ? previous : null;
  let reason = full ? 'flag' : !prev ? 'no-previous' : fullReconcileEvery > 0 && (prev.meta.delta_runs || 0) + 1 >= fullReconcileEvery ? 'reconcile' : '';
  let clause: string | null = null;
  if (!reason) {
    let ref = opts.since !== undefined ? new Date(opts.since).getTime() : (prev as Snapshot).issues.map((i) => parseJiraTime(i.updated)).filter(Number.isFinite).reduce((m, x) => Math.max(m, x), -Infinity);
    if (!Number.isFinite(ref)) ref = Date.parse((prev as Snapshot).meta.fetched_at as string); // no usable updated stamps: fall back to the fetch time (prev is set: reason is '')
    clause = formatSince(ref - overlapMinutes * 60000, me.timeZone);
    if (!clause) reason = me.timeZone ? 'bad-since' : 'no-timezone';
  }
  const delta = !reason; const warnings: string[] = [];
  if (!delta && reason === 'no-timezone') warnings.push('delta_unavailable:no-timezone');
  const queryJql = `${delta ? `(${base}) AND updated >= "${clause}"` : base} ORDER BY key ASC`;

  const got = new Map<string, JiraIssue>(); let rows = 0, dropped = 0, failure: { message?: unknown; resetAt?: string } | null = null;
  try {
    let cursor: string | number | null | undefined = null, pages = 0, empties = 0;
    for (;;) {
      if (++pages > maxPages) throw new JiraError('too_many_pages', `stopped after ${maxPages} pages`);
      const page = await client.search({ jql: queryJql, fields, pageSize, cursor });
      rows += page.issues.length;
      for (const raw of page.issues) {
        const it = normalizeIssue(raw, { sprintField });
        if (!it) { dropped++; continue; }
        const old = got.get(it.key); if (!old || cmpTime(it.updated, old.updated) >= 0) got.set(it.key, it);
      }
      if (page.last) break;
      if (page.cursor === cursor) throw new JiraError('pagination_loop', 'Jira returned the same page cursor twice');
      if (page.issues.length === 0 && ++empties > 3) throw new JiraError('pagination_stalled', 'Jira returned several empty pages without finishing');
      cursor = page.cursor;
    }
  } catch (e) { failure = e as { message?: unknown; resetAt?: string }; } // anything may be thrown: only message and resetAt are read
  if (failure) {
    const code = failure instanceof JiraError ? failure.code : 'internal';
    const error = redact(failure instanceof JiraError ? failure.message : `unexpected error: ${failure && failure.message}`);
    const r: Unsummarized<PullFailure> = { ok: false, complete: false, snapshot: null, code, error, resetAt: failure.resetAt, received: rows, warnings, changedKeys: [], removedKeys: [] };
    r.summary = `INCOMPLETE after ${got.size} issues (${code}${r.resetAt ? `, resets ${r.resetAt}` : ''}): ${error}; nothing written`;
    return r as PullFailure; // summary was set on the line above
  }
  if (dropped) warnings.push(`invalid_key_dropped:${dropped}`);

  const merged = new Map<string, JiraIssue>(delta || prev ? (prev as Snapshot).issues.map((i) => [i.key, i]) : []); // delta implies prev
  const changedKeys: string[] = []; let merged2: Map<string, JiraIssue>;
  if (delta) {
    for (const it of got.values()) {
      const old = merged.get(it.key);
      if (!old) { merged.set(it.key, it); changedKeys.push(it.key); continue; }
      const c = cmpTime(it.updated, old.updated); // a staler read (eventual consistency) never overwrites
      if (c < 0 || same(it, old)) continue;
      merged.set(it.key, it); changedKeys.push(it.key);
    }
    merged2 = merged;
  } else {
    merged2 = got;
    if (prev) for (const it of got.values()) { const old = merged.get(it.key); if (!old || !same(it, old)) changedKeys.push(it.key); }
  }
  const removedKeys = !delta && prev ? prev.issues.map((i) => i.key).filter((k) => !got.has(k)).sort() : [];
  changedKeys.sort();
  const issues = [...merged2.values()].sort((a, b) => cmp(a.key, b.key));

  let expected: number | null = null;
  try { expected = await client.count(base); } catch { /* reconciliation is advisory */ }
  const drift = expected === null ? null : issues.length - expected;
  if (expected === null) warnings.push('count_unavailable');
  else if (Math.abs(drift as number) > Math.max(driftAbs, Math.ceil(expected * driftPct))) warnings.push('count_drift'); // drift is a number when expected is
  const meta: SnapshotMeta = { jql: base, fetched_at: client.now().toISOString(), mode: client.mode, ...client.identity, expected_count: expected, received_count: issues.length, count_drift: drift, complete: true, content_hash: hash(issues), pull: delta ? 'delta' : 'full', delta_runs: delta ? ((prev as Snapshot).meta.delta_runs || 0) + 1 : 0 }; // delta implies prev
  const snapshot: Snapshot = { schema: SCHEMA, meta, issues };
  const r: Unsummarized<PullSuccess> = { ok: true, complete: true, snapshot, mode: meta.pull as string, changedKeys, removedKeys, received: rows, warnings, windowMinutes: overlapMinutes, reason };
  r.summary = summarize(r as PullSuccess); // summarize does not read summary on a success
  return r as PullSuccess; // summary was set on the line above
}

function summarize(r: PullResult): string {
  if (!r.ok) return r.summary;
  const m = r.snapshot.meta;
  const how = r.mode === 'delta' ? `delta ${r.changedKeys.length}, window ${r.windowMinutes}m` : `full${r.removedKeys.length ? `, removed ${r.removedKeys.length}` : ''}`;
  return `pulled ${m.received_count} issues (${how}), drift ${m.count_drift ?? 'n/a'}, complete, hash ${(m.content_hash as string).slice(0, 6)}${r.warnings.length ? `, WARN ${r.warnings.join('+')}` : ''}`; // a successful pull always sets content_hash
}

// Import issue JSON that something else already fetched (the Atlassian connector's saved result, a REST export): no credentials, no network.
// Accepts {issues:{nodes:[..]}} (connector), {issues:[..]}, {nodes:[..]}, a bare array, or one issue. Only the needed fields are kept (no
// descriptions, no emails). An issue that carries no issuelinks keeps the links already known (the connector's compact view omits them).
// The result is marked complete:false: it is a partial update, never a reconciled full snapshot.
const KEPT_WHEN_ABSENT = ['summary', 'status', 'assignee', 'updated', 'resolutiondate'] as const;
// `issues` is either the array itself or the connector's { nodes: [...] }; Array.isArray decides which before any read.
export interface RawImport extends RawIssue { issues?: RawIssue[] | { nodes?: RawIssue[] }; nodes?: RawIssue[]; key?: unknown }
export function importIssues(previous: Snapshot | null | undefined, input: RawImport | RawIssue[] | null | undefined, { sprintField, now = () => new Date() }: { sprintField?: string | undefined; now?: () => Date } = {}): ImportResult {
  const rows: RawIssue[] | null = Array.isArray(input) ? input : Array.isArray(input?.issues) ? input.issues : Array.isArray(input?.issues?.nodes) ? input.issues.nodes : Array.isArray(input?.nodes) ? input.nodes : (input && typeof input.key === 'string' ? [input] : null);
  if (!rows) throw new JiraError('bad_input', 'no issues found in the input (expected an array, {issues:[..]}, {issues:{nodes:[..]}} or one issue)');
  const prev = previous && Array.isArray(previous.issues) ? previous : null;
  const merged = new Map<string, JiraIssue>((prev ? prev.issues : []).map((i) => [i.key, i]));
  const changedKeys: string[] = []; let dropped = 0, imported = 0;
  for (const raw of rows) {
    const it = normalizeIssue(raw, { sprintField });
    if (!it) { dropped++; continue; }
    imported++;
    const old = merged.get(it.key);
    if (raw.fields && raw.fields.issuelinks === undefined && old) it.issuelinks = old.issuelinks;
    // A slimmed response (responseFields, docs/JIRA.md) leaves fields out: a field that is not an own property keeps the known value; a
    // field that is present (even null or empty) replaces it. Sprint counts as absent when no customFields entry or REST field carries it.
    if (old && raw.fields && typeof raw.fields === 'object') {
      for (const k of KEPT_WHEN_ABSENT) if (!Object.hasOwn(raw.fields, k) && old[k] !== undefined) it[k] = old[k];
      if (!sprintValue(raw.fields, sprintField).found && old.sprint !== undefined) it.sprint = old.sprint;
    }
    if (old && it.updated && old.updated && it.updated < old.updated) continue; // never replace a newer copy with an older one
    if (!old || !same(it, old)) changedKeys.push(it.key);
    merged.set(it.key, it);
  }
  const issues = [...merged.values()].sort((a, b) => cmp(a.key, b.key));
  const meta: SnapshotMeta = { ...(prev ? prev.meta : {}), source: 'import', imported_at: now().toISOString(), received_count: issues.length, complete: false, pull: 'import', content_hash: hash(issues) };
  const snapshot: Snapshot = { schema: SCHEMA, meta, issues };
  changedKeys.sort();
  return { snapshot, imported, dropped, changedKeys, summary: `imported ${imported} issue(s) (changed ${changedKeys.length}, dropped ${dropped}); snapshot now ${issues.length} issues, partial, hash ${(meta.content_hash as string).slice(0, 6)}` }; // set two lines above
}

// merge-friendly serialization: line 1 = {schema, meta}, then one issue per line sorted by key
export const snapshotToJsonl = (s: Snapshot): string => [JSON.stringify({ schema: s.schema, meta: s.meta }), ...s.issues.map((i) => JSON.stringify(i))].join('\n') + '\n';
export function parseSnapshotJsonl(text: string): Snapshot {
  const [head, ...issues] = parseJsonl(text, 'snapshot.jsonl') as unknown as [JsonlRecord | undefined, ...JiraIssue[]]; // unchecked: issue lines are not validated on read (pre-existing)
  if (!head || head.schema !== SCHEMA || !head.meta) throw new JiraError('bad_snapshot', 'unsupported snapshot schema');
  return { schema: head.schema, meta: head.meta as SnapshotMeta, issues }; // unchecked: meta is tested only for truthiness (pre-existing)
}
// shape the pre-lib bin/plangraph consumers read: { KEY: { summary, status, assignee, updated, resolved, blockedBy } }
export function toLegacyMap(s: Snapshot): Record<string, LegacyIssue> {
  return Object.fromEntries(s.issues.map((i) => [i.key, { summary: i.summary, status: i.status, assignee: i.assignee, updated: i.updated, resolved: i.resolutiondate, blockedBy: i.issuelinks.filter((l) => l.dir === 'in').map((l) => l.key) }]));
}
