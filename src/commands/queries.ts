// Read-only queries over the index: ticket neighbors chain sprint person blockers findings rules check verify ready card.
// Output and exit codes are those of the old bin/plangraph (frozen by test/golden.test.ts); errors are typed (src/errors.ts).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readDataCapped, presentDataFile } from '../../lib/jsonl.ts';
import { oneLine, fenceInline } from '../../lib/sanitize.ts';
import { makeGit } from '../../lib/gitsafe.ts';
import { SAFE_ATTR_DIR } from '../../lib/store.ts';
import { PlangraphError } from '../errors.ts';
import { INDEX_FILE } from '../db.ts';
import { reach } from '../../lib/graph/views.ts';
import { BIN, CUR, SRC_FILES, GRAPH_SRC_FILES, MAX_DATA, capOf, dbFile, rel, verbose, isPlaced, needBrain, usage, dataError, readJsonInput, modelFromDb, readItems, loadJiraSnap, wireMergeDriver, pluginVersion, precheckTargets, writeState, fenceBlock, fencedList, nextCommand, nextList, dataText } from './shared.ts';
import type { Ctx, Args } from '../context.ts';
import type { CommandMap } from '../registry.ts';
import type { IndexHandle } from '../db.ts';
import type { Model } from '../../lib/model.ts';
import type { Dense } from './shared.ts';
/** Columns of the index rows read below, as each SELECT names them (unchecked rows: printed through w() and oneLine()). */
interface Place { owner: unknown; sprint: unknown }
interface PlaceRow { key: string; owner: string; sprint: number }
interface EdgeRow { consumer: string; producer: string; kind: string }
type RulesValues = { repo?: boolean; max?: string; topic?: string; all?: boolean };
type ReadyValues = { jira?: string; person?: string; sprint?: number };

const placeOf = (d: IndexHandle, key: unknown) => d.get(`SELECT owner,sprint FROM schedule WHERE ${CUR} AND key=?`, key) as Place | undefined; // one row or none

// The `needs` relation as rows (src, dst, kind): the g_links view; an index built before the views existed answers from the edge table (v1 commands still work on it).
const needsRows = (d: IndexHandle): string => (d.older ? 'SELECT consumer src, producer dst, kind FROM edge' : "SELECT src, dst, kind FROM g_links WHERE rel='needs'");
// The tickets one step from a node over a relation, by reach; null (no restriction) on an index without the views.
const held = (d: IndexHandle, start: { id: string; type: 'person' | 'sprint' }, rel: 'assigned_to' | 'scheduled_in'): string | null => (d.older ? null : JSON.stringify(reach(d, start, [rel], 1, true).map((r) => r.id)));
const IN_KEYS = '(? IS NULL OR s.key IN (SELECT value FROM json_each(?)))';

// Short data fields (status, verdict, owner, kind) are printed as one sanitized capped line each; free text (summary, finding text,
// evidence resolution) only inside one <untrusted> fence, one record per line, with the number of records bounded.
const w = (x: unknown, n = 40) => oneLine(x, n);
function ticket(ctx: Ctx, args: Args): number {
  const d = ctx.db(), [key] = args.positionals, out = ctx.io.out, v = verbose(args);
  const t = d.get('SELECT * FROM ticket WHERE key=?', key) as Record<string, unknown> | undefined; // one row or none
  if (!t) { out('not in the plan'); return 0; }
  const s = placeOf(d, key);
  // Fragments with no value are omitted (an unplaced or freshly ingested sp: task has no points, Jira status, verdict or placement).
  const parts = [w(t.key, 120)], data: string[] = [];
  if (t.sp != null) parts.push(`${w(t.sp, 20)} SP`);
  if (t.jira_status) data.push(`Jira ${w(t.jira_status)}`);
  if (t.verdict) data.push(`verdict ${w(t.verdict)}${t.verdict_source ? ` (${w(t.verdict_source)})` : ''}`);
  if (t.impl_status) data.push(`impl ${w(t.impl_status)}`);
  if (isPlaced(s)) data.push(`plan S${s.sprint} ${w(s.owner, 60)}`);
  const me = { id: String(key), type: 'ticket' as const };
  const needs = d.all(`SELECT e.dst producer,e.kind,s.sprint,s.owner FROM (${needsRows(d)}) e LEFT JOIN schedule s ON s.key=e.dst AND s.${CUR} WHERE e.src=? ORDER BY s.sprint, e.dst`, key) as Array<{ producer: unknown; kind: unknown; sprint: unknown; owner: unknown }>; // the columns this SELECT names
  const neededBy = d.older ? (d.get('SELECT COUNT(*) c FROM edge WHERE producer=?', key) as { c: number }).c : reach(d, me, ['needs'], 1, true).length; // the consumers one step back, each once; COUNT(*) returns one row
  const fs_ = d.all('SELECT kind,text FROM finding WHERE key=?', key) as Array<{ kind: unknown; text: unknown }>; // the columns this SELECT names
  // The data fields (statuses, verdict and its source, owner) are text from the plan: one inline <untrusted> fence around the group.
  if (data.length) parts.push(fenceInline(data.join(' | '), 400));
  if (!v) {
    // Default: ONE line. The summary is free text: one sanitized line (fenceInline: no newline, no angle brackets, so no forged line or tag),
    // capped at 60 characters, last, inside one inline <untrusted> fence; -v shows it inside the fence with the findings and evidence.
    parts.push(`needs ${needs.length}`, `needed by ${neededBy}`);
    if (fs_.length) parts.push(`${fs_.length} finding${fs_.length === 1 ? '' : 's'}`);
    if (t.summary) parts.push(fenceInline(t.summary, 60));
    out(parts.join(' | '));
    return 0;
  }
  out(parts.join(' | '));
  out(`needs: ${needs.map((n) => `${w(n.producer, 120)}${isPlaced(n) ? ` S${n.sprint}/${w(n.owner.split(' ')[0])}` : ''} [${w(n.kind)}]`).join(', ') || 'nothing'}`);
  out(`needed by: ${neededBy} tickets`);
  const max = 100, ev = d.all('SELECT source,verdict,resolution FROM evidence WHERE key=?', key) as Array<{ source: unknown; verdict: unknown; resolution: unknown }>; // the columns this SELECT names
  const lines = [
    ...(t.summary ? [`summary: ${oneLine(t.summary, 100)}`] : []),
    ...fs_.slice(0, max).map((f) => `finding [${w(f.kind)}]: ${oneLine(f.text, 1000)}`),
    ...ev.slice(0, max).map((e) => `evidence [${w(e.source)}] ${w(e.verdict)}: ${oneLine(e.resolution || '', 400)}`),
  ];
  if (lines.length) ctx.io.outBlock(fenceBlock(`ticket:${key}`, lines));
  const more = Math.max(0, fs_.length - max) + Math.max(0, ev.length - max);
  if (more) out(`... ${more} more findings or evidence rows`);
  return 0;
}

const MAX_DEPTH = 50;
function neighbors(ctx: Ctx, args: Args): number {
  const d = ctx.db(), [key, rawDepth = '1'] = args.positionals;
  // The depth bounds a recursive query: an ASCII whole number from 0 to 50, never NaN or a huge value.
  if (!/^\d{1,3}$/.test(rawDepth) || Number(rawDepth) > MAX_DEPTH) throw usage('depth must be a whole number from 0 to 50');
  const depth = Number(rawDepth);
  const rows = d.all(needsRows(d)) as Array<{ src: string; dst: string }>, fwd = new Map<string, string[]>(), back = new Map<string, string[]>(); // the columns this SELECT names
  for (const r of rows) { for (const [m, a, b] of [[fwd, r.src, r.dst], [back, r.dst, r.src]] as const) { const l = m.get(a); if (l) l.push(b); else m.set(a, [b]); } }
  const walk = (adj: Map<string, string[]>) => { // breadth first: each key once, at its least depth, the key itself left out
    const seen = new Set([key as string]), out: string[] = []; let frontier = [key as string];
    for (let i = 0; i < depth && frontier.length; i++) { const next: string[] = []; for (const k of frontier) for (const n of adj.get(k) ?? []) if (!seen.has(n)) { seen.add(n); out.push(n); next.push(n); } frontier = next; }
    return out.sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)).map((k) => ({ k }));
  };
  const fmt = (r: { k: string }) => { const s = placeOf(d, r.k); return `${w(r.k, 120)}${s ? ` S${w(s.sprint, 20)}/${w(String(s.owner).split(' ')[0])}` : ''}`; };
  const down = walk(fwd), up = walk(back);
  const lim = verbose(args) ? Infinity : 25, lst = (a: Array<{ k: string }>) => a.slice(0, lim).map(fmt).join(', ') + (a.length > lim ? ` +${a.length - lim} more` : '');
  ctx.io.out(`${w(key, 120)} needs (${down.length}): ${lst(down)}`);
  ctx.io.out(`${w(key, 120)} is needed by (${up.length}): ${lst(up)}`);
  return 0;
}

// Longest dependency chain behind a ticket: memoized DP over the producers in O(tickets + links), no path enumeration.
// "hops" is the longest path; "handoffs" is the longest path counting only links where the owner changes (each costs a sprint).
function chain(ctx: Ctx, args: Args): number {
  const d = ctx.db(), [key] = args.positionals as [string], out = ctx.io.out, skip = new Set<unknown>(ctx.config().ignore_link_kinds || []); // like check; chain's positionals is [1, 1]: parse() refused any other count
  const prods = new Map<string, string[]>();
  for (const e of d.all(`SELECT src consumer,dst producer,kind FROM (${needsRows(d)})`) as EdgeRow[]) { if (skip.has(e.kind)) continue; if (!prods.has(e.consumer)) prods.set(e.consumer, []); (prods.get(e.consumer) as string[]).push(e.producer); } // set just before
  for (const a of prods.values()) a.sort(); // stable tie-break: the smallest key wins
  const own = new Map((d.all(`SELECT key,owner FROM schedule WHERE ${CUR}`) as Array<{ key: string; owner: unknown }>).map((r) => [r.key, r.owner])); // the columns this SELECT names
  const hops = new Map() as Dense<string, number>, via = new Map() as Dense<string, string | null>, cnt = new Map() as Dense<string, number>, hand = new Map() as Dense<string, number>, state = new Map<string, number>(); // read only after a key is done
  const stack = ([[key, 0]] as Array<[string, number]>); state.set(key, 1); // a literal list of these tuples
  while (stack.length) {
    const top = stack[stack.length - 1] as [string, number], v = top[0], ps = prods.get(v) || []; // the loop runs only while stack is not empty
    if (top[1] < ps.length) {
      const p = ps[top[1]++] as string, st = state.get(p); // top[1] < ps.length was checked just above
      if (st === 1) throw dataError(`dependency cycle: ${oneLine(p, 120)} is needed by ${oneLine(v, 120)} and also needs it`, 'run `plangraph check`');
      if (!st) { state.set(p, 1); stack.push([p, 0]); }
      continue;
    }
    let h = 0, bp = null, c = 1, w = 0;
    for (const p of ps) {
      const hp = hops.get(p) + 1;
      if (hp > h) { h = hp; bp = p; c = cnt.get(p); } else if (hp === h) c += cnt.get(p);
      const wp = hand.get(p) + (own.get(p) && own.get(v) && own.get(p) !== own.get(v) ? 1 : 0);
      if (wp > w) w = wp;
    }
    hops.set(v, h); via.set(v, bp); cnt.set(v, c); hand.set(v, w); state.set(v, 2); stack.pop();
  }
  const list: string[] = []; for (let v: string | null = key; v; v = via.get(v)) list.push(v);
  out(`longest chain behind ${w(key, 120)}: ${hops.get(key)} hops, ${hand.get(key)} handoffs, ${cnt.get(key)} critical path${cnt.get(key) === 1 ? '' : 's'}`);
  const rev = list.reverse(), show = rev.length > 12 ? [...rev.slice(0, 5), null, ...rev.slice(-5)] : rev;
  for (const k of show) {
    if (k === null) { out(`  ... ${rev.length - 10} more`); continue; }
    const s = placeOf(d, k); out(`  ${w(k, 120)} ${s ? `S${w(s.sprint, 20)} ${w(String(s.owner).split(' ')[0])}` : ''}`);
  }
  return 0;
}

function sprint(ctx: Ctx, args: Args): number {
  if (!/^-?\d{1,7}$/.test(String(args.positionals[0]))) throw usage(`sprint needs a whole number, got "${oneLine(String(args.positionals[0])).slice(0, 40)}"`);
  const d = ctx.db(), cfg = ctx.config(), n = Number(args.positionals[0]);
  const keys = held(d, { id: `S${n}`, type: 'sprint' }, 'scheduled_in'); // the tickets placed in the sprint now
  const rows = d.all(`SELECT s.owner, SUM(t.sp) sp, COUNT(*) n FROM schedule s JOIN ticket t ON t.key=s.key WHERE s.${CUR} AND s.sprint=? AND ${IN_KEYS} GROUP BY s.owner ORDER BY s.owner`, Number.isFinite(n) ? n : null, keys, keys) as Array<{ owner: string; sp: number | null; n: number }>; // the columns this SELECT names (SUM is NULL when every sp is; COUNT never is)
  for (const r of rows) ctx.io.out(`${w(r.owner, 60)}: ${r.sp} SP / cap ${capOf(cfg, r.owner)} (${r.n} tickets)`);
  const over = rows.filter((r) => (r.sp as number) > capOf(cfg, r.owner)); // unchecked: a NULL sum compares as 0, as before
  let none = null;
  if (!rows.length) { // say so, with the sprints the plan does cover, instead of printing nothing
    const rg = d.get(`SELECT MIN(sprint) lo, MAX(sprint) hi FROM schedule WHERE ${CUR}`) as { lo: number | null; hi: number | null } | undefined; // the columns this SELECT names
    none = rg && rg.lo != null ? { first: rg.lo, last: rg.hi } : null;
    ctx.io.out(`sprint ${w(args.positionals[0], 40)}: no tickets${none ? `; plan covers S${none.first}-S${none.last}` : '; the plan has no scheduled tickets'}`);
  }
  ctx.io.data?.({ sprint: Number.isFinite(n) ? n : null, ...(rows.length ? {} : { empty: true, covers: none }), rows: rows.map((r) => ({ owner: w(r.owner, 60), sp: r.sp, cap: capOf(cfg, r.owner), tickets: r.n })), over: over.map((r) => w(r.owner, 60)) },
    { next: nextList(over.map((r) => nextCommand(['person', [r.owner]]))) });
  return 0;
}

function person(ctx: Ctx, args: Args): number {
  const d = ctx.db(), keys = held(d, { id: String(args.positionals[0]), type: 'person' }, 'assigned_to'); // the tickets the person holds now
  const rows = d.all(`SELECT s.sprint, SUM(t.sp) sp, COUNT(*) n FROM schedule s JOIN ticket t ON t.key=s.key WHERE s.${CUR} AND s.owner=? AND ${IN_KEYS} GROUP BY s.sprint ORDER BY s.sprint`, args.positionals[0], keys, keys) as Array<{ sprint: number; sp: number; n: number }>; // the columns this SELECT names
  ctx.io.out(`total ${rows.reduce((a, r) => a + r.sp, 0)} SP in ${rows.length} sprints`);
  for (const r of rows) ctx.io.out(`S${r.sprint}: ${r.sp} SP (${r.n})`);
  return 0;
}

function blockers(ctx: Ctx, args: Args): number {
  // the verdict list as stored (a closed ticket with a non-READY verdict is listed too: `plangraph ready` says DONE for it)
  const d = ctx.db(), rows = d.all("SELECT key,verdict FROM ticket WHERE verdict<>'READY' AND verdict<>'' ORDER BY verdict,key") as Array<{ key: string; verdict: string }>, by = new Map<string, string[]>(); // the columns this SELECT names
  for (const r of rows) { if (!by.has(r.verdict)) by.set(r.verdict, []); (by.get(r.verdict) as string[]).push(r.key); } // set just before
  ctx.io.out(`${rows.length} tickets not READY`); const lim = verbose(args) ? Infinity : 150;
  for (const [v, ks] of by) ctx.io.out(`${w(v)} (${ks.length}): ${ks.slice(0, lim).map((k: unknown) => w(k, 120)).join(' ')}${ks.length > lim ? ` +${ks.length - lim} more` : ''}`);
  return 0;
}

function findings(ctx: Ctx, args: Args): number {
  const d = ctx.db(), [kind] = args.positionals;
  if (!kind) { for (const r of d.all('SELECT kind, COUNT(*) c FROM finding GROUP BY kind') as Array<{ kind: unknown; c: number }>) ctx.io.out(`${w(r.kind, 48)}: ${r.c}`); return 0; } // the columns this SELECT names
  const v = verbose(args), rows = d.all('SELECT key,text FROM finding WHERE kind=? ORDER BY key', kind) as Array<{ key: unknown; text: unknown }>; // the columns this SELECT names
  ctx.io.outBlock(fencedList(`findings:${kind}`, rows, v ? 2000 : 30, (r) => `${w(r.key, 120)}: ${oneLine(r.text, v ? 2000 : 100)}`, `findings${v ? '' : ' (-v for up to 2000)'}`));
  return 0;
}

// ---- rules: plangraph learnings (index) or, with --repo, OpenWolf's .wolf/cerebrum.md read through and fenced ----
const TOPIC_USAGE = '--topic needs a word of 1 to 60 characters on one line';
async function rulesRepo(ctx: Ctx, args: Args<RulesValues>): Promise<number> {
  const W = await import('../../lib/integrations/openwolf.ts'), v = verbose(args); let max = v ? 200 : 12;
  if (args.values.max !== undefined) {
    const m = args.values.max;
    if (!/^\d{1,3}$/.test(m) || +m < 1 || +m > (v ? 200 : 30)) throw usage('--max needs a whole number from 1 to 30 (up to 200 with -v)');
    max = +m;
  }
  const topic = args.values.topic;
  // oneLine caps with a marker and collapses line breaks, so a longer or multi-line topic differs from itself after it
  if (topic !== undefined && (typeof topic !== 'string' || !topic || oneLine(topic, W.TOPIC_MAX) !== topic)) throw usage(TOPIC_USAGE);
  const r = W.readWolfFile(ctx.root, 'cerebrum.md');
  if (!r.ok) { ctx.io.out(r.missing ? 'no repo rules: .wolf/cerebrum.md not found' : `warning: ${r.warning}`); return 0; }
  ctx.io.outBlock(W.renderRepoRules(W.parseCerebrum(r.text), { max, entryMax: v ? 1000 : 200, topic, all: Boolean(args.values.all) } as NonNullable<Parameters<typeof W.renderRepoRules>[1]>)); // renderRepoRules destructures topic without a default: undefined reads as absent
  return 0;
}
function rules(ctx: Ctx, args: Args<RulesValues>): Promise<number> | number {
  if (args.values.repo) return rulesRepo(ctx, args);
  if (args.values.topic !== undefined || args.values.all) throw usage('--topic and --all need --repo (a plangraph topic is the positional argument)');
  const d = ctx.db(), [topic] = args.positionals;
  if (!topic) { for (const r of d.all('SELECT topic, COUNT(*) c FROM learning GROUP BY topic ORDER BY topic') as Array<{ topic: unknown; c: number }>) ctx.io.out(`${w(r.topic, 80)}: ${r.c}`); return 0; } // the columns this SELECT names
  // learning text is free text from the repo: one fence, one sanitized line per field, bounded
  const v = verbose(args), rows = d.all('SELECT id,kind,text,why FROM learning WHERE topic=? ORDER BY id', topic) as Array<{ id: unknown; kind: unknown; text: unknown; why: unknown }>; // the columns this SELECT names
  const t = v ? 1000 : 300;
  ctx.io.outBlock(fencedList(`rules:${topic}`, rows, v ? 2000 : 30, (r) => `${w(r.id, 120)} [${w(r.kind, 40)}] ${oneLine(r.text, t)}\n   why: ${oneLine(r.why, t)}`, `rules${v ? '' : ' (-v for up to 2000)'}`));
  return 0;
}

// Frozen history (lib/frozen.ts): a link with a closed producer, or between two frozen tickets, is no violation; a cell is over cap only
// when it holds a free ticket with story points.
async function check(ctx: Ctx): Promise<number> {
  const F = await import('../../lib/frozen.ts');
  const d = ctx.db(), cfg = ctx.config(), skip = new Set<unknown>(cfg.ignore_link_kinds || []), model = modelFromDb(ctx), frozen = F.frozenTest(model);
  const sched = new Map((d.all(`SELECT key,owner,sprint FROM schedule WHERE ${CUR}`) as PlaceRow[]).map((r) => [r.key, r])); // the columns this SELECT names
  const sp = new Map((d.all('SELECT key,sp FROM ticket') as Array<{ key: string; sp: number | null }>).map((r) => [r.key, r.sp])); // the columns this SELECT names
  const edges = (d.all('SELECT consumer,producer,kind FROM edge') as EdgeRow[]).filter((e) => !skip.has(e.kind)); // the columns this SELECT names
  let viol = 0; const load = new Map<string, number>(), withFree = new Set<string>();
  for (const [k, s] of sched) { const id = `${s.owner}|${s.sprint}`; load.set(id, (load.get(id) || 0) + (sp.get(k) || 0)); if ((sp.get(k) || 0) > 0 && model.tickets.has(k) && !frozen(k)) withFree.add(id); }
  for (const e of edges) { const c = sched.get(e.consumer), p = sched.get(e.producer); if (!c || !p || !F.linkBinds(model, frozen, e.consumer, e.producer)) continue; if (p.owner === c.owner ? p.sprint > c.sprint : p.sprint >= c.sprint) viol++; }
  const over = [...load].filter(([k, v]) => withFree.has(k) && v > capOf(cfg, k.split('|')[0] as string)).length; // split always returns at least one item
  const ind = (new Map([...sched.keys()].map((k) => [k, 0])) as Dense<string, number>), adj = (new Map([...sched.keys()].map((k) => [k, []])) as Dense<string, string[]>); // read after has(), or with its own keys
  for (const e of edges) if (ind.has(e.consumer) && ind.has(e.producer)) { ind.set(e.consumer, ind.get(e.consumer) + 1); adj.get(e.producer).push(e.consumer); }
  const q = [...ind].filter(([, v]) => v === 0).map((x) => x[0]); let seen = 0;
  while (q.length) { const u = (q.pop() as string); seen++; for (const v of adj.get(u)) { ind.set(v, ind.get(v) - 1); if (!ind.get(v)) q.push(v); } } // q is not empty inside the loop
  const last = [...sched.values()].reduce((m, s) => Math.max(m, s.sprint), -Infinity); // Math.max semantics, without spreading a huge array
  // Tickets with no schedule row are invisible to the schedule-based counts above: verify (and the card) report them as UNPLACED, so
  // the count comes from verify's own predicate (an sp: task is exempt there), never a second copy of the rule.
  const unplaced = (await import('../../lib/verify.ts')).verifyPlan(model).filter((x) => x.code === 'UNPLACED').length;
  const { integrityOf, renderViolation } = await import('../../lib/graph/integrity.ts'), gv = integrityOf(ctx.dir, cfg, (await readItems(ctx)).items).violations;
  for (const x of gv) ctx.io.out(renderViolation(x));
  const loopFree = seen === sched.size, lastSprint = sched.size ? last : 0, code = viol || over || unplaced || !loopFree || gv.some((x) => !x.warning) ? 1 : 0;
  ctx.io.out(`tickets ${sched.size} | links ${edges.length} | strict-rule violations ${viol} | person-sprints over cap ${over} | loop-free ${loopFree} | last sprint ${lastSprint}${unplaced ? ` | unplaced ${unplaced} (plangraph verify lists them)` : ''}`);
  ctx.io.data?.({ tickets: sched.size, links: edges.length, violations: viol, overCap: over, loopFree, lastSprint, unplaced, ...(gv.length ? { integrity: gv.map(renderViolation) } : {}) }, { next: unplaced ? ['plangraph verify'] : [] });
  return code; // CI fails on any violation, and on any unplaced ticket (verify exits 1 on UNPLACED too)
}

async function verify(ctx: Ctx, args: Args<{ 'enforce-min'?: boolean; strict?: boolean }>): Promise<number> {
  const V = await import('../../lib/verify.ts'), R = await import('../../lib/render.ts'), model = modelFromDb(ctx), { items } = await readItems(ctx);
  let sched = model.sched;
  const [file] = args.positionals;
  if (file !== undefined) {
    const rows = readJsonInput(file, 'schedule file');
    if (!Array.isArray(rows)) throw dataError('schedule file must be a JSON array of {item, owner, sprint}');
    sched = new Map((rows as Array<{ item?: unknown; key?: unknown; owner?: unknown; sprint?: unknown } | null>).map((r) => [r?.item ?? r?.key, { owner: r?.owner, sprint: r?.sprint }])) as Model['sched']; // verifyPlan tests every slot (placed) and key (tickets.has)
  }
  // a schedule file is checked against the frozen tickets of the CURRENT schedule: one it moves or drops is FROZEN_MOVED
  const frozen = file === undefined ? undefined : (await import('../../lib/frozen.ts')).frozenSlots(model);
  const v = V.verifyPlan(model, sched, { enforceMin: Boolean(args.values['enforce-min']), strict: Boolean(args.values.strict), items, ...(frozen ? { frozen } : {}) }), limit = verbose(args) ? 200 : 20;
  const errors = v.filter((x) => !x.warn).length; // a BLOCKED row is a warning (exit 0) unless --strict
  ctx.io.data?.({ ok: !errors, warnings: v.length - errors, tickets: model.tickets.size, violations: v.slice(0, limit).map((x) => ({ code: w(x.code), key: w(x.key, 120), detail: dataText(x.detail) })), total: v.length },
    { next: v.length ? nextList([nextCommand(['ticket', [(v[0] as (typeof v)[number]).key], '-v']), file === undefined ? 'plangraph check' : null]) : [] }); // v.length was checked
  if (!v.length) { ctx.io.out(`OK plan valid (${model.tickets.size} tickets)`); return 0; } // every ticket (unplaced sp: tasks included)
  for (const l of R.bound(v.map((x) => `${w(x.code)} ${w(x.key, 120)} ${dataText(x.detail, 1000)}`), { limit })) ctx.io.out(l);
  if (!errors) ctx.io.out(`OK plan valid (${model.tickets.size} tickets, ${v.length} warnings)`);
  return errors ? 1 : 0;
}

// ---- definition of ready: may this ticket be started now? (the rules: lib/ready.ts, shared with blockers and report) ----
// Bulk form: `plangraph ready --person NAME --sprint N` (either filter alone or both, no KEY). The same rules (lib/ready.ts readyScope over
// readySet), one answer: counts first, the ready keys (capped, -v more), each not-ready reason with a few example keys, the freshness note.
// Exit 0 when at least one ticket may start, 1 when none (also when nothing is placed there). --json: every list (capped at 2000) and counts.
const BULK = { ready: 25, readyV: 500, ex: 5, exV: 50, json: 2000 };
async function readyBulk(ctx: Ctx, args: Args<ReadyValues>, R: typeof import('../../lib/ready.ts')): Promise<number> {
  const v = args.values, out = ctx.io.out, model = modelFromDb(ctx), sprintN = (v.sprint as number | undefined); // an integer option
  let owner: string | null | undefined;
  if (v.person !== undefined) {
    const W = await import('../../lib/whatif.ts');
    owner = W.resolvePerson(model, v.person);
    if (owner === null) throw new PlangraphError('USAGE', '--person matches no single person in the plan (exact, case-insensitive or a unique first name)', sprintN === undefined ? {} : { hint: `\`plangraph sprint ${sprintN}\` lists its owners` });
  }
  const snap = v.jira !== undefined ? await loadJiraSnap((v.jira as string)) : null; // a string option
  const { items } = await readItems(ctx), s = R.readyScope(model, { owner, sprint: sprintN } as { owner?: string; sprint?: number }, items, snap); // a null owner threw above; readyScope destructures owner and sprint without defaults, so undefined reads as absent
  const head = [owner === undefined ? '' : w(owner, 60), sprintN === undefined ? '' : `S${sprintN}`].filter(Boolean).join(' ');
  const verb = verbose(args), list = (ks: string[], n: number) => `${ks.slice(0, n).map((k) => w(k, 120)).join(' ')}${ks.length > n ? ` +${ks.length - n} more` : ''}`;
  const verdictOf = (k: string) => w(model.tickets.get(k)?.verdict ?? '');
  const J = <T>(a: T[]) => a.slice(0, BULK.json);
  const data = {
    person: owner === undefined ? null : w(owner, 60), sprint: sprintN ?? null, total: s.keys.length,
    counts: { ready: s.ready.length, done: s.done.length, notReady: s.notReady.length, waiting: s.waiting.length, openItems: s.blocked.length, verdict: s.verdict.length },
    ready: J(s.ready).map((k) => w(k, 120)), done: J(s.done).map((k) => w(k, 120)), notReady: J(s.notReady).map((k) => w(k, 120)), waiting: J(s.waiting).map((k) => w(k, 120)),
    openItems: J(s.blocked).map((b: { key: string; kinds: string[] }) => ({ key: w(b.key, 120), kinds: b.kinds.map((x) => w(x)) })), verdict: J(s.verdict).map((k) => ({ key: w(k, 120), verdict: verdictOf(k) })),
    statuses: snap ? 'jira snapshot' : 'last build',
  };
  const next = nextList([s.ready.length ? nextCommand(['ticket', [s.ready[0]]]) : null, s.notReady.length ? nextCommand(['ready', [s.notReady[0]]]) : null]);
  if (!s.keys.length) { out(`${head}: no placed tickets`); ctx.io.data?.(data, { next: [] }); return 1; }
  const groups = ([['waiting on producers', s.waiting], ['open items', s.blocked.map((b: { key: string }) => b.key)], ['verdict not READY', s.verdict]] as Array<[string, string[]]>).filter(([, ks]) => ks.length); // a literal list of these tuples
  out(`${head}: ready ${s.ready.length} of ${s.keys.length}, done ${s.done.length}, not ready ${s.notReady.length}${groups.length ? ` (${groups.map(([n, ks]) => `${n} ${ks.length}`).join(', ')})` : ''}`);
  out(`ready: ${s.ready.length ? list(s.ready, verb ? BULK.readyV : BULK.ready) : 'none'}`);
  for (const [n, ks] of groups) out(`${n} (${ks.length}): ${list(ks, verb ? BULK.exV : BULK.ex)}`);
  if (verb && s.done.length) out(`done (${s.done.length}): ${list(s.done, BULK.exV)}`);
  if (verb || !snap) out(snap ? '(statuses from the Jira snapshot given)' : '(statuses as of the last build: pass --jira snapshot.json for live ones)');
  ctx.io.data?.(data, { next });
  return s.ready.length ? 0 : 1;
}

async function ready(ctx: Ctx, args: Args<ReadyValues>): Promise<number> {
  const R = await import('../../lib/ready.ts'), [key] = args.positionals, out = ctx.io.out, bulk = args.values.person !== undefined || args.values.sprint !== undefined;
  if (key !== undefined && bulk) throw usage('ready takes a KEY or --person/--sprint, not both');
  if (key === undefined && !bulk) throw usage('ready needs a KEY, or --person NAME and/or --sprint N');
  if (bulk) return readyBulk(ctx, args, R);
  const model = modelFromDb(ctx);
  const data = (o: Record<string, unknown>, next: string[] = []) => ctx.io.data?.({ key: w(key, 120), ...o }, { next });
  // the key argument is printed as one sanitized line: it can be a key taken from the data (units --stale, a next command)
  const k = w(key, 120);
  if (!model.tickets.has(key as string)) { out(`${k}: not an open plan ticket (done, or not in the plan)`); data({ found: false, ready: false, reasons: [] }); return 0; } // key is set: without bulk a KEY is required (checked above)
  const snap = args.values.jira !== undefined ? await loadJiraSnap(args.values.jira) : null;
  const { items } = await readItems(ctx), r = R.readiness(model, key as string, { items, statuses: snap }); // key is set: without bulk a KEY is required (checked above)
  // DONE: its own status is closed, so it is not something to start (a negative answer, exit 1)
  if (r.done) { out(`DONE ${k} (${r.done.by === 'impl' ? 'impl_status done' : `status ${w(r.done.status)}`})`); data({ found: true, ready: false, done: true, reasons: [] }); return 1; }
  // Open-item texts are free text: the reasons name only their kind, and the texts follow in one fence.
  // why: the text lines; reasons: the same facts as structured data for --json (same order); waits and kinds feed the next commands.
  const why: string[] = [], reasons: Array<Record<string, unknown>> = [], texts: string[] = [], waits = ([] as string[]), kinds: string[] = []; // an empty list of this element type
  for (const x of r.reasons) {
    if (x.code === 'VERDICT') { why.push(`readiness verdict is ${w(x.verdict)}`); reasons.push({ code: 'VERDICT', detail: w(x.verdict) }); }
    else if (x.code === 'OPEN_ITEM' && x.from === 'finding') { kinds.push(x.kind); why.push(`open item [${w(x.kind)}]`); reasons.push({ code: 'OPEN_ITEM', kind: w(x.kind) }); texts.push(`[${w(x.kind)}] ${oneLine(x.text, 120)}`); }
    else if (x.code === 'OPEN_ITEM') { why.push(`open item [${w(x.kind)}] (owner ${w(x.owner || '?')})`); reasons.push({ code: 'OPEN_ITEM', kind: w(x.kind), owner: w(x.owner) }); texts.push(`[${w(x.kind)}] ${oneLine(x.text, 120)}`); }
    else {
      const plan = x.place ? `, planned S${x.place.sprint} ${w(x.place.owner, 60)}` : '', st = x.status === null ? null : w(x.status);
      waits.push(x.key);
      reasons.push({ code: 'WAITS', key: w(x.key, 120), status: st, ...(x.place ? { sprint: x.place.sprint, owner: w(x.place.owner, 60) } : {}) });
      why.push(`waits for ${w(x.key, 120)} (${x.impl ? `impl_status ${st}` : st ?? 'no status'}${plan})`);
    }
  }
  // Bounded so the 40-line output bound never cuts the fence: at most 20 reasons and 10 texts (-v: 200 and 100).
  const v = verbose(args), maxWhy = v ? 200 : 20, maxText = v ? 100 : 10;
  if (!why.length) out(`READY TO START ${k}`);
  else {
    ctx.io.outBlock([`NOT READY ${k}`, ...why.slice(0, maxWhy).map((x) => `- ${x}`)]);
    if (why.length > maxWhy) out(`... ${why.length - maxWhy} more reasons (-v for up to 200)`);
    ctx.io.outBlock(fencedList(`ready:${key}`, texts, maxText, (x) => x, 'open-item texts'));
  }
  if (verbose(args) || !snap) out(snap ? '(statuses from the Jira snapshot given)' : '(statuses as of the last build: pass --jira snapshot.json for live ones)');
  data({ found: true, ready: !why.length, reasons: reasons.slice(0, maxWhy), more: Math.max(0, reasons.length - maxWhy), statuses: snap ? 'jira snapshot' : 'last build' },
    why.length ? nextList([...waits.slice(0, 2).map((p) => nextCommand(['ready', [p]])), ...kinds.map((k) => nextCommand(['findings', [k]]))]) : nextList([nextCommand(['ticket', [key]])]));
  return why.length ? 1 : 0;
}

// ---- session card ----
// Session-hook repair (`card --heal`): never throws, never prompts. Only when the plan dir exists inside a git work tree, and only when
// doctor sees a problem (including a driver.target left at an older plugin install), so a healthy setup is not rewritten. It repairs only
// with the user's consent, plangraph.heal in the clone's own git config (lib/driver.ts, decision D3), recorded by init and doctor --fix.
// A clone whose local config already holds the driver (wired before 0.3.0) is grandfathered when plangraph.heal is unset: consent is
// recorded and the repair runs. Any other value disables that: `never` is silent, the rest get the nudge, and the value is left unchanged.
// Without consent nothing is written and the returned line (printed after the card) tells the user the one command that opts in.
async function healMergeDriver(ctx: Ctx): Promise<string | null> {
  try {
    if (!fs.existsSync(ctx.dir)) return null;
    if (makeGit(ctx.dir)('rev-parse', '--is-inside-work-tree').trim() !== 'true') return null;
    const [S, D] = await Promise.all([import('../../lib/store.ts'), import('../../lib/driver.ts')]);
    const common = D.gitCommonDir(ctx.root);
    if (!common) return null;
    const value = D.localConfigValue(common, D.CONSENT_KEY);
    if (value === 'never') return null;
    let consent = D.hasConsent(common);
    if (!consent && value === null && D.localConfigValue(common, 'merge.plangraph-jsonl.driver')) { D.recordConsent(common, pluginVersion()); consent = true; }
    const dir = rel(ctx, ctx.dir);
    if (!S.doctorMergeDriver(ctx.root, { dir, target: path.join(BIN, 'plangraph-merge') }).problems.length) return null;
    if (consent) { await wireMergeDriver(ctx); return null; }
    // dir may come from a committed .plangraphrc: hook output names it only when it is a plain short name.
    const files = S.SAFE_ATTR_DIR.test(dir) && dir.length <= 40 ? `${dir}/*.jsonl` : '*.jsonl files in the plan directory';
    return `plangraph: merge driver not set up in this clone; merges of ${files} conflict until the user runs plangraph doctor --fix`;
  } catch { return null; /* the hook must never fail */ }
}

// One deterministic line for the agent to place under `## Context` in STATUS (never under OpenWolf's injected section). Plan data only.
/** The card line text (also compared by `plangraph doctor` with the line in OpenWolf's STATUS.md). */
export async function cardLineText(ctx: Ctx): Promise<string> {
  needBrain(ctx);
  const { loadModel, CONFIG_MAX } = await import('../../lib/model.ts'), V = await import('../../lib/verify.ts');
  const model = loadModel(ctx.dir, { config: ctx.config() }), h = crypto.createHash('sha256'); let last = 0;
  for (const f of ['config.json', ...SRC_FILES]) {
    let b = '';
    if (f !== 'config.json' && !presentDataFile(path.join(ctx.dir, f))) { h.update(`${f}\0${b.length}\0${b}\0`); continue; } // a symlinked data file is refused
    try { b = readDataCapped(path.join(ctx.dir, f), f === 'config.json' ? CONFIG_MAX : MAX_DATA); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } // O_NOFOLLOW + dev/ino: no symlink, no swap; fs errno errors
    h.update(`${f}\0${b.length}\0${b}\0`);
  }
  for (const f of GRAPH_SRC_FILES) { // a graph file counts only when it is there: a directory without one keeps its 0.3.0 digest
    if (!presentDataFile(path.join(ctx.dir, f))) continue;
    let b = '';
    try { b = readDataCapped(path.join(ctx.dir, f), MAX_DATA); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } // as above: O_NOFOLLOW + dev/ino; fs errno errors
    h.update(`${f}\0${b.length}\0${b}\0`);
  }
  for (const s of model.sched.values()) if (Number.isInteger(s.sprint) && (s.sprint as number) > last) last = (s.sprint as number); // Number.isInteger is the check
  return `plangraph: ${model.tickets.size} tickets, last sprint ${last}, ${V.verifyPlan(model).filter((x) => !x.warn).length} violations @${h.digest('hex').slice(0, 8)}`;
}
async function cardLine(ctx: Ctx): Promise<number> { ctx.io.out(await cardLineText(ctx)); return 0; }

// First-use nudge (hook only, no index): plan data is there but the card cannot be built, so ONE fixed line says what to run. Pure
// lstat/size checks (nothing is opened or read except format.json through the capped reader of checkFormat), no git, no write, no build, no
// text from the data files (only the plan dir, which resolveBrainDir already confined and which is one sanitized line). Anything
// unsafe or odd (symlink, FIFO, directory, huge or unreadable file, bad or newer format.json, anything at the index path) returns null.
async function firstUseLine(ctx: Ctx): Promise<string | null> {
  const { FORMAT_FILE, checkFormat } = await import('../../lib/store.ts'), { CONFIG_MAX } = await import('../../lib/model.ts');
  const lst = (f: string) => { try { return fs.lstatSync(f); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; } }; // fs errno errors
  const dir = lst(ctx.dir);
  if (!dir || !dir.isDirectory()) return null;
  if (lst(path.join(ctx.dir, INDEX_FILE))) return null; // something is at the index path: not "no index" (dangling symlink, FIFO, ...)
  let data = false;
  for (const [f, cap] of ([['config.json', CONFIG_MAX], [FORMAT_FILE, CONFIG_MAX], ...SRC_FILES.map((x) => [x, MAX_DATA])] as Array<[string, number]>)) { // a literal list of these tuples
    const p = path.join(ctx.dir, f), st = lst(p);
    if (!st) continue;
    if (!st.isFile() || st.size > cap) return null;
    try { fs.accessSync(p, fs.constants.R_OK); } catch { return null; }
    if (f === 'config.json' || f === 'tickets.jsonl') data = true;
  }
  if (!data) return null;
  const relDir = rel(ctx, ctx.dir), where = SAFE_ATTR_DIR.test(relDir) && relDir.length <= 40 ? relDir : 'the plan directory', head = `plangraph: plan data found in ${where} but no index: run`;
  try { checkFormat(ctx.dir); return `${head} plangraph build`; } catch { return null; }
}

async function card(ctx: Ctx, args: Args<{ write?: boolean; line?: boolean; heal?: boolean; 'if-present'?: boolean }>): Promise<number> {
  const nudge = args.values.heal ? await healMergeDriver(ctx) : null;
  // Hook only: `card: off` (plugin userConfig, exported as CLAUDE_PLUGIN_OPTION_CARD, or PLANGRAPH_CARD) silences the session-start card
  // and the heal nudge. Healing above still ran; a manual `plangraph card` is never affected.
  if (args.values['if-present'] && [ctx.env.CLAUDE_PLUGIN_OPTION_CARD, ctx.env.PLANGRAPH_CARD].some((v) => String(v ?? '').trim().toLowerCase() === 'off')) return 0;
  const code = await cardBody(ctx, args);
  if (nudge) ctx.io.out(nudge); // last stdout line, after the card
  return code;
}
async function cardBody(ctx: Ctx, args: Args<{ write?: boolean; line?: boolean; heal?: boolean; 'if-present'?: boolean }>): Promise<number> {
  if (args.values.line) return cardLine(ctx);
  const file = dbFile(ctx);
  if (args.values['if-present'] && !fs.existsSync(file)) { const l = await firstUseLine(ctx); if (l) ctx.io.out(l); return 0; }
  const R = await import('../../lib/render.ts'), model = modelFromDb(ctx);
  // Cache-stable: identity is the source fingerprint of the text, STALE comes only from the fingerprint check of ctx.db() (content, not
  // modification times or a clock), so the same data prints the same bytes; in hook mode (--if-present) the card text itself says STALE.
  const h = ctx.db(), meta = { fp: h.fingerprint, stale: Boolean(h.stale), dir: rel(ctx, ctx.dir) };
  const text = `${R.renderCard(model, meta)}\n`;
  if (args.values.write) {
    const dst = path.join(ctx.dir, 'CARD.md');
    precheckTargets(ctx, [dst]); writeState(ctx, dst, text); // a symlink or outside target is REFUSED (exit 4), nothing written
    ctx.io.out(`wrote ${rel(ctx, dst)} (${R.estTokens(text)} est tokens)`);
  } else ctx.io.raw(text);
  return 0;
}

const B = { type: 'boolean' };
export const commands: CommandMap = {
  ticket: { run: ticket, positionals: [1, 1], summary: 'one ticket: size, status, verdict, placement, needs, findings, evidence' },
  neighbors: { run: neighbors, positionals: [1, 2], summary: 'what a ticket needs and what needs it, to a depth (default 1)' },
  chain: { run: chain, positionals: [1, 1], summary: 'longest dependency chain behind a ticket' },
  sprint: { run: sprint, positionals: [1, 1], summary: 'load per person in one sprint' },
  person: { run: person, positionals: [1, 1], summary: "one person's load per sprint" },
  blockers: { run: blockers, positionals: [0, 0], summary: 'tickets whose verdict is not READY' },
  findings: { run: findings, positionals: [0, 1], summary: 'finding counts by kind, or the findings of one kind' },
  rules: { run: rules, positionals: [0, 1], options: { repo: B, max: { type: 'string', missing: '--max needs a whole number from 1 to 30 (up to 200 with -v)' }, topic: { type: 'string', missing: TOPIC_USAGE }, all: B }, summary: 'learned rules by topic; --repo reads OpenWolf rules (--topic WORD, --all adds dated sections)' },
  check: { run: check, positionals: [0, 0], summary: 'strict handoff rule, capacity, loops and unplaced tickets of the current plan (exit 1 on a violation)' },
  verify: { run: verify, positionals: [0, 1], options: { 'enforce-min': B, strict: B }, summary: 'independent plan verifier (exit 1 on a violation; BLOCKED is a warning unless --strict)' },
  ready: { run: ready, positionals: [0, 1], options: { jira: { type: 'string' }, person: { type: 'string' }, sprint: { type: 'integer' } }, summary: 'may this ticket start now? (exit 1 with reasons); --person/--sprint: which of those tickets may start' },
  card: { run: card, positionals: [0, 0], writes: 'file', options: { write: B, line: B, heal: { ...B, writes: ['git-config', 'gitattributes', 'merge-shim'] } }, guard: (v: Record<string, unknown>) => (v['if-present'] ? 'none' : 'soft'), summary: 'short plan summary for a session start' },
};
