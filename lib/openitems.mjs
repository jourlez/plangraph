// Open-items register: decisions and fixes owed by a named person before a ticket may start.
// Pure core (plain data in, plain data or strings out). It executes nothing: findings from external checks arrive as JSONL through `parseFindings`.
import { isoDay } from './clock.mjs';
import { sanitizeText, oneLine, guardOutput } from './sanitize.mjs';
import { parseJsonl } from './jsonl.mjs';
import { validators } from './schema.mjs';
//
// Register record (one JSONL line, file open-items.jsonl, sorted by key then kind, canonical field order):
//   key, kind, owner, due_sprint (int|null), status ('open'|'done'), text, closed_at?, closed_by?, close_note?, source? ('manual'), extra fields sorted last.
// An item is identified by key|kind (the same pair `brain ready` uses). `ready` reads ONLY status, key, kind: closed iff status === 'done'.
//
// Config (all optional; nothing person-specific is hardcoded):
//   owner_of_decisions: string                 who owns owner:"decision-owner" rules (unset -> 'unassigned')
//   open_items.rules: [{kind, owner, due, n?}] owner: 'decision-owner' | 'ticket-owner' | '<literal name>'
//                                              due: 'before_ticket_sprint' | 'sprint:N' | 'n_before' (ticket sprint - n, n default 1)
//   open_items.default_rule                    for kinds without a rule (default {owner:'ticket-owner', due:'before_ticket_sprint'})
//   open_items.ignore_kinds: [kind]            findings of these kinds produce no item
//   open_items.lead_time: int                  an item is DUE when due_sprint - lead_time <= current sprint (default 0)
// config.ignore_link_kinds only affects link waits in `ready`; it never hides findings, so it never changes the items derived here.

const lt = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const ORDER = ['key', 'kind', 'owner', 'due_sprint', 'status', 'text', 'closed_at', 'closed_by', 'close_note', 'source'];
const oi = (config) => (config || {}).open_items || {};
const DEFAULT_RULE = { owner: 'ticket-owner', due: 'before_ticket_sprint' };
const ruleFor = (config, kind) => (oi(config).rules || []).find((r) => r.kind === kind) || oi(config).default_rule || DEFAULT_RULE;
const idOf = (i) => i.key + '|' + i.kind; // the closed-set format shared with src/commands/queries.mjs (ready)
// Collision-free identity for grouping and reconciling: a key or kind may itself contain '|' (findings.jsonl only requires strings).
const uidOf = (i) => JSON.stringify([i.key, i.kind]);
const cmpDue = (a, b) => Number(a == null) - Number(b == null) || (a ?? 0) - (b ?? 0);
const cmpItem = (a, b) => lt(a.key, b.key) || lt(a.kind, b.kind);
const cmpWork = (a, b) => cmpDue(a.due_sprint, b.due_sprint) || cmpItem(a, b);
const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

function dueFromRule(rule, ticketSprint) {
  const d = String(rule.due || 'before_ticket_sprint');
  const m = /^sprint:(\d+)$/.exec(d);
  if (m) return +m[1];
  if (ticketSprint == null) return null;
  if (d === 'n_before') return ticketSprint - (rule.n ?? 1);
  return ticketSprint; // before_ticket_sprint
}
const isTicketRelative = (rule) => !/^sprint:/.test(String(rule.due || 'before_ticket_sprint'));

function ownerFromRule(rule, config, sched) {
  if (rule.owner === 'decision-owner') return (config || {}).owner_of_decisions || 'unassigned';
  if (rule.owner === 'ticket-owner' || !rule.owner) return sched?.owner || 'unassigned';
  return rule.owner;
}

/** @param {any} model @param {any} [config] @param {{ extraFindings?: any[] }} [opts] */
export function openItemsFromFindings(model, config = model.config, { extraFindings = [] } = {}) {
  const skip = new Set(oi(config).ignore_kinds || []); const groups = new Map();
  for (const f of [...(model.findings || []), ...extraFindings]) {
    if (!f || skip.has(f.kind)) continue;
    const id = uidOf(f); if (!groups.has(id)) groups.set(id, { key: f.key, kind: f.kind, texts: new Set() });
    groups.get(id).texts.add(squash(f.text));
  }
  const out = [];
  for (const g of groups.values()) {
    const rule = ruleFor(config, g.kind), s = model.sched?.get(g.key);
    out.push({ key: g.key, kind: g.kind, owner: ownerFromRule(rule, config, s), due_sprint: dueFromRule(rule, s?.sprint ?? null), status: 'open', text: [...g.texts].sort(lt).join(' | ').slice(0, 300) });
  }
  return out.sort(cmpItem);
}

// ---- register file ----
const canon = (i) => {
  const o = {}; for (const k of ORDER) if (i[k] !== undefined && !(k !== 'due_sprint' && i[k] === null)) o[k] = i[k];
  if (o.due_sprint === undefined) o.due_sprint = i.due_sprint ?? null;
  const o2 = {}; for (const k of ORDER) if (k in o) o2[k] = o[k];
  for (const k of Object.keys(i).filter((k) => !ORDER.includes(k)).sort(lt)) if (i[k] !== undefined) o2[k] = i[k];
  return o2;
};
export const serializeItems = (items) => [...items].sort(cmpItem).map((i) => JSON.stringify(canon(i))).join('\n') + (items.length ? '\n' : '');
export const parseItems = (text, name = 'open-items.jsonl') => parseJsonl(text, name, { validate: validators['open-items.jsonl'] });

/** @param {any[]} items @param {{ key?: string, kind?: string, owner?: string, due_sprint?: number | null, text?: string }} [item] */
export function registerItem(items, { key, kind, owner, due_sprint = null, text = '' } = {}) {
  if (!key || !kind) throw new Error('registerItem: key and kind are required');
  if (items.some((i) => i.key === key && i.kind === kind)) throw new Error(`registerItem: ${key}|${kind} exists`);
  return [...items, { key, kind, owner: owner || 'unassigned', due_sprint, status: 'open', text: squash(text), source: 'manual' }].sort(cmpItem);
}
/** @param {any[]} items @param {string} key @param {string} kind @param {{ by?: string, note?: string, at?: string, now?: () => Date }} [opts] */
export function closeItem(items, key, kind, { by = '', note = '', at, now = () => new Date() } = {}) {
  const i = items.findIndex((x) => x.key === key && x.kind === kind && x.status !== 'done');
  if (i < 0) throw new Error(`closeItem: no open item ${key}|${kind}`);
  const it = { ...items[i], status: 'done', closed_at: at ?? isoDay(now()) }; if (by) it.closed_by = by; if (note) it.close_note = note;
  return items.map((x, j) => (j === i ? it : x));
}
export function reopenItem(items, key, kind) {
  const i = items.findIndex((x) => x.key === key && x.kind === kind && x.status === 'done');
  if (i < 0) throw new Error(`reopenItem: ${key}|${kind} is not closed`);
  const { closed_at, closed_by, close_note, ...rest } = items[i];
  return items.map((x, j) => (j === i ? { ...rest, status: 'open' } : x));
}

// Merge a stored register with freshly derived items. Items that still derive keep status/closed_*; owner, due and text are refreshed.
// Open items whose finding vanished are dropped (resolved at the source); closed ones stay as history unless pruneClosed. Manual items stay.
export function reconcileItems(existing, derived, { pruneClosed = false } = {}) {
  const old = new Map(existing.map((i) => [uidOf(i), i])), seen = new Set(), out = [];
  for (const d of derived) {
    const o = old.get(uidOf(d)); seen.add(uidOf(d));
    if (!o) { out.push(d); continue; }
    const keep = {}; for (const k of ['status', 'closed_at', 'closed_by', 'close_note', 'source']) if (o[k] !== undefined) keep[k] = o[k];
    out.push({ ...d, ...keep });
  }
  for (const o of existing) if (!seen.has(uidOf(o)) && (o.source === 'manual' || (o.status === 'done' && !pruneClosed))) out.push(o);
  return out.sort(cmpItem);
}

// ---- due logic ----
// Effective due sprint: for derived items the CURRENT schedule of the ticket (so schedule moves are honoured); otherwise the stored one.
export function effectiveDue(model, item, config = model.config) {
  if (item.source === 'manual') return item.due_sprint ?? null;
  const rule = ruleFor(config, item.kind), s = model.sched?.get(item.key);
  if (isTicketRelative(rule) && s) return dueFromRule(rule, s.sprint);
  return item.due_sprint ?? null;
}
/** @param {any} model @param {any[]} items @param {{ currentSprint?: number, leadTime?: number, config?: any }} [opts] */
export function overdueItems(model, items, { currentSprint, leadTime, config = model.config } = {}) {
  const lead = leadTime ?? oi(config).lead_time ?? 0, out = [];
  for (const i of items) {
    if (i.status === 'done') continue;
    const due = effectiveDue(model, i, config);
    if (due != null && due - lead <= currentSprint) out.push({ ...i, due_sprint: due, late: due < currentSprint });
  }
  return out.sort(cmpWork);
}

// ---- ready integration ----
export const closedSet = (items) => new Set(items.filter((i) => i.status === 'done').map(idOf));
export const blockingItems = (items, key) => items.filter((i) => i.key === key && i.status !== 'done').sort(cmpItem);
// True when `ready` must refuse: an open register item for the key, or (when findings are given) a finding with no closed item for its kind.
export function blocksReady(items, key, { findings = [] } = {}) {
  if (blockingItems(items, key).length) return true;
  const closed = closedSet(items);
  return findings.some((f) => f.key === key && !closed.has(key + '|' + f.kind));
}

// ---- rendering ----
const cell = (s) => squash(sanitizeText(s, { max: Infinity })).replace(/\|/g, '\\|'); // free text: no escape sequence or control character, one line
const id1 = (s, n = 120) => cell(oneLine(s, n)); // keys, kinds, owners, dates: data, one sanitized line, no angle brackets
const S = (n) => (n == null ? '-' : 'S' + n);
export function renderOpenItems(items, { byOwner = true } = {}) {
  const open = items.filter((i) => i.status !== 'done').sort(cmpWork), done = items.filter((i) => i.status === 'done').sort(cmpItem);
  const L = ['# Open items', '', `Generated by \`brain open-items --write\` (do not edit). ${open.length} open, ${done.length} closed.`];
  const table = (rows) => ['| Due | Key | Kind | Text |', '|---|---|---|---|', ...rows.map((i) => `| ${S(i.due_sprint)} | ${id1(i.key)} | ${id1(i.kind, 60)} | ${cell(i.text)} |`)];
  const groups = new Map();
  for (const i of open) { const g = byOwner ? i.owner : i.due_sprint == null ? 'No sprint' : 'S' + i.due_sprint; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(i); }
  const names = [...groups.keys()].sort(byOwner ? lt : (a, b) => cmpDue(a === 'No sprint' ? null : +a.slice(1), b === 'No sprint' ? null : +b.slice(1)));
  for (const g of names) L.push('', `## ${oneLine(g, 80)} (${groups.get(g).length} open)`, ...table(groups.get(g)));
  if (done.length) L.push('', `## Closed (${done.length})`, '| Key | Kind | Owner | Closed | By | Note |', '|---|---|---|---|---|---|', ...done.map((i) => `| ${id1(i.key)} | ${id1(i.kind, 60)} | ${cell(i.owner)} | ${id1(i.closed_at || '', 40)} | ${cell(i.closed_by || '')} | ${cell(i.close_note || '')} |`));
  return guardOutput(L.join('\n')) + '\n'; // a file agents read: no forged fence tag from the free text either
}

// Terminal view, hard budget 120 tokens (480 chars): header, top lines (mine first, then by due), `... N more`.
/** @param {any[]} items @param {{ me?: string, currentSprint?: number, limit?: number, maxChars?: number }} [opts] @returns {string} */
export function renderCompact(items, { me, currentSprint, limit = 5, maxChars = 480 } = {}) {
  const open = items.filter((i) => i.status !== 'done').sort((a, b) => (me ? Number(b.owner === me) - Number(a.owner === me) : 0) || cmpWork(a, b));
  if (!open.length) return 'open items: 0';
  const parts = []; if (me) parts.push(`${open.filter((i) => i.owner === me).length} yours`);
  const dues = open.map((i) => i.due_sprint).filter((d) => d != null), at = currentSprint ?? (dues.length ? Math.min(...dues) : null);
  if (at != null) parts.push(`due S${at}: ${open.filter((i) => i.due_sprint != null && i.due_sprint <= at).length}`);
  const head = `open items: ${open.length}` + (parts.length ? ` (${parts.join(', ')})` : '');
  const line = (i) => `- ${oneLine(i.key, 120)} ${oneLine(i.kind, 60)} ${S(i.due_sprint)} ${oneLine(i.owner, 60)}: ${squash(i.text).slice(0, 40)}`; // one line per item
  for (let c = Math.min(limit, open.length); c >= 0; c--) {
    const out = [head, ...open.slice(0, c).map(line)]; if (c < open.length) out.push(`... ${open.length - c} more`);
    const s = out.join('\n'); if (s.length <= maxChars || c === 0) return s;
  }
}

// ---- findings ingestion ----
// Findings produced elsewhere (CI, or Claude's own Bash under its permission prompts) arrive as JSONL text. This module never runs anything.
// Task 6 will swap the local line loop for the shared parseJsonl.
export const MAX_FINDINGS_BYTES = 8 * 1024 * 1024;
const MAX_FINDINGS = 100000, MAX_LINE = 1 << 20;
// Keys: Jira keys and sp:<slug>/<id> task keys (docs/FORMAT.md section 6), at most 120 characters; `..` is refused anywhere.
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/, KIND_RE = /^[a-z0-9][a-z0-9_.-]{0,47}$/;
// Errors are bounded like lib/jsonl.mjs parseJsonl: the first 10 messages are kept, `total` counts them, and the scan stops once a
// 1001st error is seen (then the last message says "at least"); with more than 10 a last summary line `... and N more` is added.
const SHOWN_ERRORS = 10, SCAN_LIMIT = 1000;
export function parseFindings(text, name = 'findings') {
  const findings = [], errors = []; let total = 0, stopped = false;
  if (String(text ?? '').length > MAX_FINDINGS_BYTES) return { findings, errors: [`${name}: input larger than ${MAX_FINDINGS_BYTES} bytes, refused`], total: 1 };
  const lines = String(text ?? '').replace(/^\uFEFF/, '').split('\n');
  const errs = { push(m) { if (total >= SCAN_LIMIT) { stopped = true; return; } total++; if (errors.length < SHOWN_ERRORS) errors.push(m); } };
  for (let n = 0; n < lines.length && !stopped; n++) {
    const l = lines[n]; if (!l.trim()) continue;
    const at = `${name}:${n + 1}: `;
    if (l.length > MAX_LINE) { errs.push(at + 'line too long'); continue; }
    if (findings.length >= MAX_FINDINGS) { errs.push(at + `more than ${MAX_FINDINGS} findings, rest ignored`); break; }
    let j; try { j = JSON.parse(l); } catch { errs.push(at + 'invalid JSON'); continue; }
    if (!(j && typeof j === 'object' && !Array.isArray(j) && typeof j.key === 'string' && typeof j.kind === 'string' && typeof j.text === 'string')) { errs.push(at + 'needs string key, kind and text'); continue; }
    if (!KEY_RE.test(j.key) || j.key.includes('..')) { errs.push(at + 'invalid key'); continue; }
    if (!KIND_RE.test(j.kind)) { errs.push(at + 'invalid kind'); continue; }
    findings.push({ key: j.key, kind: j.kind, text: sanitizeText(j.text, { max: 500 }) });
  }
  if (total > SHOWN_ERRORS) errors.push(`... and ${stopped ? 'at least ' : ''}${total - SHOWN_ERRORS} more${stopped ? ` (scan stopped after ${SCAN_LIMIT} errors)` : ''}`);
  return { findings, errors, total };
}
