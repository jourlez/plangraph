// Plan mutation and safety: whatif schedule-load export build init migrate doctor.
// Index writes open their own writable handle (src/db.ts openIndex, readOnly false); text writes are atomic and confined to the repo.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { readCapped } from '../../lib/jsonl.ts';
import { oneLine } from '../../lib/sanitize.ts';
import { PlangraphError } from '../errors.ts';
import { buildIndex, openIndex, stampFingerprint, stampContent, sidecarsOf, TABLES, INDEX_FILE, SIDECARS } from '../db.ts';
import { checkRepoPath } from '../../lib/gitsafe.ts';
import { NODE_FLOOR, nodeSupported } from '../floor.js';
import { claudeSnippet } from '../../lib/steer.ts';
import { resolveTenant, loadRegistry, repoKey, approveAlias, isAliasName } from '../jira-tenant.ts';
import { siteTag } from '../../lib/tracker.ts';
import { BIN, CUR, SEED, claudeSteer, dbFile, rel, verbose, usage, dataError, readJsonInput, modelFromDb, readItems, capOf, wireMergeDriver, recordHealConsent, precheckTargets, writeState, refuseWrite, nextCommand, nextList, dataText } from './shared.ts';
import type { Ctx, Args } from '../context.ts';
import type { CommandMap } from '../registry.ts';
import type { TableSpec } from '../db.ts';
import type { Model } from '../../lib/model.ts';
import type { JiraSettings } from '../jira-tenant.ts';
import type { MoveRequest } from '../../lib/whatif.ts';
import type { DetectedTool } from '../../lib/integrations/detect.ts';
/** One row of a schedule file for schedule-load (checked field by field before use). */
interface SlotRow { item: string; owner: string; sprint: number }
type WhatifLib = typeof import('../../lib/whatif.ts');
/** The options of whatif (see `commands` below), as parse() gives them. */
type WhatifValues = { to?: string; sprint?: number; earlier?: boolean; 'owner-change'?: boolean; slip?: boolean; strict?: boolean; 'apply-plan'?: boolean; write?: boolean;
  relieve?: string; find?: boolean };

// ---- reassignment safety ----
// --json data of a dry run: the move, the broken rules (bounded like the text), the repair suggestion; next: the --apply-plan dry run of
// the same move when one exists (allowed, or a repair was found) and the ticket in detail. Untrusted strings are one sanitized line.
const HARD = new Set(['UNKNOWN_TICKET', 'UNKNOWN_PERSON', 'SAME_SLOT', 'OUT_OF_RANGE']);
const FLAGS = ['earlier', 'owner-change', 'slip', 'strict'] as const;
function whatifData(r: ReturnType<WhatifLib['whatif']>, key: string, v: WhatifValues, limit: number) {
  const mv = r.ripple?.[0], g = r.suggestion, s = (x: unknown, n = 60) => oneLine(x ?? '', n);
  const data = {
    key: s(key, 120), ok: r.ok, to: mv ? { owner: s(mv.to.owner), sprint: mv.to.sprint } : null,
    reasons: r.reasons.slice(0, limit).map((x) => ({ code: s(x.code, 40), key: s(x.key, 120), detail: dataText(x.detail), ...(x.fix ? { fix: dataText(x.fix) } : {}), ...(x.warn ? { warn: true } : {}) })),
    more: Math.max(0, r.reasons.length - limit), ripple: (r.ripple || []).length,
    suggestion: g ? (g.none ? { none: true } : { owner: s(g.owner), sprint: g.sprint, shifts: g.shifts, ownerChanges: g.ownerChanges, ...(g.flags ? { flags: g.flags } : {}) }) : null,
  };
  const known = !r.reasons.some((x) => x.code === 'UNKNOWN_TICKET');
  const repairable = (r.ok || (g && !g.none)) && !r.reasons.some((x) => HARD.has(x.code)) && (v.sprint === undefined || v.sprint >= 0);
  // a suggestion was searched with slip allowed: its --apply-plan runs the same search (--slip), or it would not find the same repair
  const need = (f: typeof FLAGS[number]) => v[f] || (f === 'slip' && !r.ok && g && !g.none);
  const apply = repairable ? nextCommand(['whatif', [key], ...(v.to !== undefined ? ['--to', [v.to]] : []), ...(v.sprint !== undefined ? ['--sprint', String(v.sprint)] : []), ...FLAGS.filter(need).map((f) => `--${f}`), '--apply-plan']) : null;
  return { data, next: nextList([apply, known ? nextCommand(['ticket', [key], '-v']) : null]) };
}
// --relieve PERSON --sprint N: a read-only search (lib/whatif.ts relieve) for the smallest valid set of single-ticket moves that brings that
// cell to <= cap; it prints the exact `plangraph whatif` dry-run command of each move and never writes (--to, --apply-plan, --write refused).
// Exit 0 when relief was found or none is needed, 1 when none was found. Names and keys are one sanitized line; commands are shell-safe.
function relieveCmd(ctx: Ctx, args: Args<WhatifValues>, W: WhatifLib, model: Model): number {
  const v = args.values, out = ctx.io.out, sprint = (v.sprint as number), s = (x: unknown, n = 60) => oneLine(x ?? '', n); // whatif checked --sprint before the call
  const person = W.resolvePerson(model, v.relieve as string); // whatif calls relieveCmd only when --relieve was given
  if (person === null) throw new PlangraphError('USAGE', '--relieve matches no single person in the plan (exact, case-insensitive or a unique first name)', { hint: `\`plangraph sprint ${sprint}\` lists its owners` });
  const r = W.relieve(model, { person, sprint }, { allowEarlier: Boolean(v.earlier), allowOwnerChange: Boolean(v['owner-change']) });
  const cmd = (m: ReturnType<WhatifLib['relieve']>['moves'][number]) => nextCommand(['whatif', [m.key], ...(m.to.owner !== m.from.owner ? ['--to', [m.to.owner]] : []), '--sprint', String(m.to.sprint)]);
  const limit = verbose(args) ? 100 : 15, keys = verbose(args) ? 50 : 5;
  for (const line of W.renderRelieve(r, { cmd, limit, keys, name: (x: unknown) => s(x), key: (x: unknown) => s(x, 120) })) out(line);
  const flags = (['earlier', 'owner-change'] as const).filter((f) => !v[f] && !(f === 'earlier' && sprint <= r.first)); // no earlier sprint than first_sprint
  const retry = flags.map((f) => nextCommand(['whatif', '--relieve', [person], '--sprint', String(sprint), ...FLAGS.filter((g) => v[g] && g !== 'strict').map((g) => `--${g}`), `--${f}`]));
  const rs = (a: ReturnType<WhatifLib['relieve']>['reasons']) => a.map((x) => ({ code: x.code, keys: x.keys.slice(0, 2000).map((k: unknown) => s(k, 120)), ...(x.code === 'NOT_ENOUGH' ? { freeable: x.freeable, needed: x.needed } : {}), ...(x.code === 'NO_ROOM' ? { room: x.room, needed: x.needed } : {}) }));
  ctx.io.data?.({
    relieve: { person: s(person), sprint }, status: r.status, load: r.load, cap: r.cap, after: r.after, slip: r.slip, ownerChanges: r.ownerChanges, order: r.order, searchComplete: r.searchComplete, budget: r.budget, nodes: r.nodes, allowed: r.allowed,
    moves: r.moves.map((m) => ({ key: s(m.key, 120), sp: m.sp, from: { owner: s(m.from.owner), sprint: m.from.sprint }, to: { owner: s(m.to.owner), sprint: m.to.sprint }, command: cmd(m) })), reasons: rs(r.reasons),
  }, { next: nextList(r.status === 'relief' ? r.moves.map(cmd) : r.status === 'no_relief' ? retry : []) });
  return r.status === 'no_relief' ? 1 : 0;
}

// --find: every slot KEY may move to with no violation anywhere (lib/whatif.ts findSlots), ranked; read-only, bounded (FIND_MAX tries).
// Exit 0 when at least one slot is valid, 1 when none (or the key is not in the plan). Names and keys are one sanitized line.
function findCmd(ctx: Ctx, args: Args<WhatifValues>, W: WhatifLib, model: Model, key: string): number {
  const v = args.values, s = (x: unknown, n = 60) => oneLine(x ?? '', n);
  const r = W.findSlots(model, key, { allowEarlier: Boolean(v.earlier), allowOwnerChange: Boolean(v['owner-change']), strict: Boolean(v.strict) });
  const cmd = (x: ReturnType<WhatifLib['findSlots']>['slots'][number]) => nextCommand(['whatif', [key], ...(x.sameOwner ? [] : ['--to', [x.owner]]), '--sprint', String(x.sprint)]);
  for (const line of W.renderFind(r, { cmd, top: verbose(args) ? 20 : 5, name: (x: unknown) => s(x), key: (x: unknown) => s(x, 120) })) ctx.io.out(line);
  ctx.io.data?.({
    key: s(key, 120), status: r.status, from: r.from ? { owner: s(r.from.owner), sprint: r.from.sprint } : null, tried: r.tried, valid: r.valid, allowed: r.allowed, searchComplete: r.searchComplete,
    slots: r.slots.slice(0, 200).map((x) => ({ owner: s(x.owner), sprint: x.sprint, slip: x.slip, sameOwner: x.sameOwner, load: x.load, cap: x.cap, ...(x.warn ? { warn: true } : {}), command: cmd(x) })),
    reasons: Object.fromEntries(Object.entries(r.reasons).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([c, n]) => [s(c, 40), n])),
  }, { next: nextList(r.slots.slice(0, 3).map(cmd)) });
  return r.status === 'found' ? 0 : 1;
}

async function whatif(ctx: Ctx, args: Args<WhatifValues>): Promise<number> {
  const v = args.values, key = args.positionals[0];
  if (v.relieve !== undefined) {
    if (key !== undefined) throw usage('whatif takes a KEY or --relieve NAME, not both');
    if (v.to !== undefined || v['apply-plan'] || v.write) throw usage('--relieve is a dry run: --to, --apply-plan and --write are not supported (it prints the whatif command of each move)');
    if (v.sprint === undefined) throw usage('--relieve needs --sprint N');
  } else if (key === undefined) throw usage('whatif needs a KEY, or --relieve NAME --sprint N');
  if (v.find && (v.relieve !== undefined || v.to !== undefined || v.sprint !== undefined || v['apply-plan'] || v.write)) throw usage('--find is a dry run over every slot of KEY: --to, --sprint, --relieve, --apply-plan and --write are not supported (it prints the whatif command of each slot)');
  const W = await import('../../lib/whatif.ts'), model = modelFromDb(ctx), out = ctx.io.out;
  const mv = { key, to: v.to, sprint: v.sprint };
  // the schema refuses both at build time; an index built by an older version may still hold them, and whatif must not crash on bad data
  const badSprint = [...model.sched.values()].some((p) => p.sprint != null && !Number.isSafeInteger(p.sprint));
  if (badSprint || [...model.tickets.values()].some((t) => t.sp != null && !(Number.isFinite(t.sp) && t.sp >= 0))) {
    throw dataError('the index holds a sprint that is not a whole number or a negative sp', 'fix schedule.jsonl / tickets.jsonl, then `plangraph build` (it names the line)');
  }
  if (v.relieve !== undefined) return relieveCmd(ctx, args, W, model);
  if (v.find) return findCmd(ctx, args, W, model, (key as string)); // a KEY is required without --relieve (checked above)
  const o = { strict: Boolean(v.strict), allowEarlier: Boolean(v.earlier), allowOwnerChange: Boolean(v['owner-change']), allowSlip: Boolean(v.slip) };
  if (!v['apply-plan']) {
    const r = W.whatif(model, mv as MoveRequest, o), limit = verbose(args) ? 50 : 8; // key is defined past the --relieve return (checked above); whatif reads to and sprint with != null and ??, so undefined reads as absent
    out(dataText(W.renderWhatif(r, { limit }), 4000)); // one line: keys and owners from data cannot start a new line
    const { data, next } = whatifData(r, mv.key as string, v, limit); ctx.io.data?.(data, { next }); // key is defined past the --relieve return (checked above)
    return r.ok ? 0 : 1;
  }
  const r = W.proposeMove(model, mv as MoveRequest, o); // as for whatif above: key is defined here, to and sprint are read with != null and ??
  const why = (r.reasons || []).map((x) => dataText(x && x.code ? `${x.code} ${x.key || ''} ${x.detail || ''}`.trim() : String(x), 400));
  if (!r.ok) { out(`NO PLAN: ${why.join(' | ') || 'no repair found'}`); return 1; }
  out(`PLAN: ${r.moves.length} move(s), ${r.shifted} others shifted, ${r.ownerChanges} owner changes${r.searchComplete === false ? ' (search budget hit: not proven minimal)' : ''}`);
  const first = (o: unknown) => oneLine(String(o).split(' ')[0], 40);
  for (const m of r.moves) out(`${oneLine(m.key, 120)} ${first(m.from.owner)} S${oneLine(m.from.sprint, 20)} > ${first(m.to.owner)} S${oneLine(m.to.sprint, 20)}`);
  if (!v.write) { out('(dry run: add --write to change the index, then `plangraph export` to save it as text)'); return 0; }
  const V = await import('../../lib/verify.ts'), next = W.applyMoves(model.sched, r.moves);
  const before = new Set(V.verifyPlan(model).map((x) => x.code + x.key)), fresh = V.verifyPlan(model, next).filter((x) => !before.has(x.code + x.key));
  if (fresh.length) throw new PlangraphError('REFUSED', `refusing to write: the verifier found ${fresh.length} new violation(s)`);
  {
    using db = openIndex(dbFile(ctx), { readOnly: false });
    db.exec('BEGIN');
    const up = db.prepare(`UPDATE schedule SET owner=?, sprint=? WHERE ${CUR} AND key=?`);
    for (const m of r.moves) up.run(m.to.owner, m.to.sprint, m.key);
    stampContent(db); // a legitimate index write: the content digest follows it
    db.exec('COMMIT');
  }
  out('written to the index; run `plangraph export` to save it as text');
  return 0;
}

// ---- keep the current plan under an archive name, load a new one (index only; `plangraph export` saves it as text) ----
async function scheduleLoad(ctx: Ctx, args: Args): Promise<number> {
  const [file, archive] = args.positionals;
  if (!archive || archive === 'current' || archive.length > 200) throw usage('archive name must be non-empty, at most 200 characters and not "current"');
  const rows = readJsonInput(file as string, 'schedule file'); // positionals is [2, 2]: parse() refused any other count
  if (!Array.isArray(rows) || !rows.every((r: { item?: unknown; owner?: unknown; sprint?: unknown } | null) => r && typeof r === 'object' && typeof r.item === 'string' && typeof r.owner === 'string' && Number.isSafeInteger(r.sprint))) {
    throw dataError('schedule file must be a JSON array of {item, owner, sprint} (strings and a whole sprint number)');
  }
  // frozen history (lib/frozen.ts): a frozen ticket of the current plan keeps its slot; a schedule that moves or drops one is refused
  // before the index is opened for writing (no override flag: unfreeze the ticket in the data first)
  const F = await import('../../lib/frozen.ts'), at = new Map((rows as SlotRow[]).map((r) => [r.item, r])); // every row was checked above
  const moved = [...F.frozenSlots(modelFromDb(ctx))].filter(([k, f]) => { const r = at.get(k); return !r || r.owner !== f.owner || r.sprint !== f.sprint; }).map(([k]) => k).sort();
  if (moved.length) throw new PlangraphError('REFUSED', `refusing to load: the schedule moves ${moved.length} frozen ticket${moved.length === 1 ? '' : 's'} (${moved.slice(0, 10).map((k) => oneLine(k, 60)).join(' ')}${moved.length > 10 ? ` +${moved.length - 10} more` : ''}); a frozen ticket keeps its slot`, { hint: '`plangraph verify FILE` lists each one (FROZEN_MOVED)' });
  using db = openIndex(dbFile(ctx), { readOnly: false });
  if ((db.get('SELECT COUNT(*) c FROM schedule WHERE version=?', archive) as { c: number }).c) throw usage(`archive name already used: ${oneLine(archive, 80)}`); // COUNT(*) returns one row
  const people = new Set((db.all("SELECT DISTINCT v2_owner o FROM ticket WHERE v2_owner<>''") as Array<{ o: unknown }>).map((r) => r.o)); // the columns this SELECT names
  const bad = [...new Set((rows as SlotRow[]).map((r) => r.owner))].filter((o) => people.size && !people.has(o)); // checked above
  if (bad.length) throw dataError(`schedule has owners that are not people in the plan: ${bad.slice(0, 10).map((o) => oneLine(o, 60)).join(', ')}${bad.length > 10 ? ` (+${bad.length - 10} more)` : ''}`);
  db.exec('BEGIN');
  try {
    db.prepare(`UPDATE schedule SET version=? WHERE ${CUR}`).run(archive);
    const ins = db.prepare("INSERT INTO schedule(version,key,owner,sprint) VALUES('current',?,?,?)");
    for (const r of rows as SlotRow[]) ins.run(r.item, r.owner, r.sprint); // checked above
    stampContent(db); // a legitimate index write: the content digest follows it
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw dataError(`schedule file could not be loaded: ${oneLine(String((e as Error).message).split('\n')[0], 160)}`); } // node:sqlite throws an Error
  ctx.io.out(`loaded as current; previous plan kept as ${oneLine(archive, 200)}; run \`plangraph export\` to save it as text`);
  return 0;
}

// ---- text <-> index ----
const EXPORT: Array<[string, string]> = [['ticket', 'key'], ['schedule', 'version,key'], ['edge', 'consumer,producer'], ['evidence', 'key,source,rowid'], ['finding', 'key,kind,text'], ['meta', 'k']];
async function exportText(ctx: Ctx): Promise<number> {
  const S = await import('../../lib/store.ts'), file = dbFile(ctx);
  const targets = EXPORT.map(([t]) => path.join(ctx.dir, (TABLES.get(t) as TableSpec).file)); // EXPORT names TABLES' own tables
  precheckTargets(ctx, targets);
  const texts: Array<[string, string]> = [];
  {
    using d = openIndex(file, { readOnly: true, dir: ctx.dir });
    // A stale index means the text was edited after the build: exporting would silently overwrite those edits with the older index.
    // (schedule-load and whatif --write change only the index, so the fingerprint still matches and export goes ahead.)
    if (d.stale) throw dataError('the index is stale: the text files changed since it was built, and export would overwrite them', 'run `plangraph build` first (it reads the text), then export');
    for (const [t, order] of EXPORT) {
      const { file: fn } = (TABLES.get(t) as TableSpec); // EXPORT names TABLES' own tables
      const rows = (d.all(`SELECT * FROM ${t} ORDER BY ${order}`) as Array<Record<string, unknown>>).map((row) => { // one object per row
        // NULL in a known column means the field was absent: it stays absent. `extra` holds unknown fields and the exact values a column could
        // not keep (an explicit null, a number in a text column), which win over the column (src/db.ts rowOf).
        const { extra, ...known } = row; const r: Record<string, unknown> = Object.create(null); // null-prototype: a stored "__proto__" key stays a plain key
        for (const [k, v] of Object.entries(known)) if (v !== null) r[k] = v;
        if (extra != null) { const o = JSON.parse(extra as string); for (const k of Object.keys(o)) Object.defineProperty(r, k, { value: o[k], enumerable: true, writable: true, configurable: true }); } // extra is TEXT: build wrote canonical JSON there
        return r;
      });
      texts.push([path.join(ctx.dir, fn), S.canonFile(rows, S.SCHEMAS[fn])]);
    }
  }
  for (const [f, text] of texts) writeState(ctx, f, text);
  stampFingerprint(file, ctx.dir); // the index is current with the text it just wrote: the next query is not stale
  ctx.io.out('exported canonical text (learnings.jsonl and refs.jsonl are edited or generated separately)');
  return 0;
}

async function build(ctx: Ctx): Promise<number> {
  ctx.config(); // config.json is not an index source, but a bad one is refused here exactly as by every reader (exit 2)
  const r = buildIndex(ctx);
  ctx.io.out(`built ${rel(ctx, r.file)}: ${r.counts.ticket} tickets, ${r.counts.edge} links, ${r.counts.evidence} evidence rows, ${r.counts.finding} findings, ${r.counts.learning} learnings`);
  const { integrityOf, renderViolation } = await import('../../lib/graph/integrity.ts'); // the build above already refused a bad graph file (exit 2); a violation here is reported, never fatal
  for (const v of integrityOf(ctx.dir, ctx.config(), (await readItems(ctx)).items).violations) ctx.io.err(renderViolation(v));
  return 0;
}

// ---- set-up ----
const CONFIG = {
  _doc: 'Constraints for plangraph-solve and plangraph check. Capacity is points per person per sprint.',
  first_sprint: 1, end_sprint: 12, caps: { default: 40 }, min_per_sprint: {}, minimize_load_of: '', default_ref: 'HEAD', brain_rules_version: 1, closed_statuses: ['Done'],
  frozen_statuses: ['Done'], ignore_link_kinds: [], time_limit_seconds: 300, workers: 8,
  stage_order: ['end_sprint', 'shortfall', 'load_of', 'peak_load', 'owner_changes'],
  ref_heading: '^#{2,3} Task {id}:', jira: { base_url: '', jql: '' },
};
// The plan dir's .gitignore lines: the derived index and the sidecar files SQLite may leave beside it (a committed journal is replayed into
// the index by SQLite; src/db.ts SIDECARS). A line counts as present when a line of the file equals it after trimming.
const INDEX_PATTERN = '*.sqlite';
const IGNORE_LINES = Object.freeze([INDEX_PATTERN, ...SIDECARS.map((s) => INDEX_PATTERN + s)]);
const missingIgnoreLines = (text: string) => { const have = new Set(text.split(/\r?\n/).map((l) => l.trim())); return IGNORE_LINES.filter((l) => !have.has(l)); };
async function init(ctx: Ctx): Promise<number> {
  const S = await import('../../lib/store.ts'), dir = ctx.dir, cfg = path.join(dir, 'config.json'), fmt = path.join(dir, S.FORMAT_FILE);
  precheckTargets(ctx, [fmt]); // a symlinked format.json (even a dangling one) is REFUSED (exit 4) before anything is written
  fs.mkdirSync(dir, { recursive: true });
  const missing = (f: string) => !fs.existsSync(f), gi = path.join(dir, '.gitignore'), changes: string[] = [];
  const existing = !missing(cfg) || !missing(path.join(dir, 'tickets.jsonl')); // a plangraph that was set up before: init must not read as a first set-up
  precheckTargets(ctx, [gi]);
  if (missing(cfg)) writeState(ctx, cfg, `${JSON.stringify(CONFIG, null, 2)}\n`);
  const dst = path.join(dir, 'learnings.jsonl');
  if (missing(dst) && fs.existsSync(SEED)) writeState(ctx, dst, readCapped(SEED, 1024 * 1024));
  // Only ADD the lines init needs (the index and its SQLite sidecars): every user line in an existing .gitignore stays, in order, byte for
  // byte; the missing lines are appended in IGNORE_LINES order with the file's own line ending; nothing is written when all are there.
  const old = missing(gi) ? null : readCapped(gi, 1024 * 1024);
  if (old === null) { writeState(ctx, gi, `${IGNORE_LINES.join('\n')}\n`); changes.push(`created .gitignore with ${IGNORE_LINES.join(', ')}`); }
  else {
    const add = missingIgnoreLines(old);
    if (add.length) {
      const eol = old.includes('\r\n') ? '\r\n' : '\n';
      writeState(ctx, gi, `${old}${old === '' || old.endsWith('\n') ? '' : eol}${add.map((l) => l + eol).join('')}`); changes.push(`added ${add.join(', ')} to .gitignore`);
    }
  }
  for (const [t] of EXPORT) { const f = path.join(dir, (TABLES.get(t) as TableSpec).file); if (missing(f)) { writeState(ctx, f, ''); changes.push(`created ${(TABLES.get(t) as TableSpec).file}`); } } // EXPORT names TABLES' own tables
  if (missing(fmt)) { try { S.writeFormat(dir, { format_version: S.FORMAT_VERSION, min_reader: S.FORMAT_VERSION }); changes.push('created format.json'); } catch (e) { refuseWrite(e); } }
  try { await wireMergeDriver(ctx, { consent: true }); } catch (e) { ctx.io.err(`merge driver not installed: ${oneLine(String((e as Error).message).split('\n')[0], 200)}; run \`plangraph doctor --fix\` inside a git repo`); } // whatever was thrown: String() of its message
  if (existing) ctx.io.out(`already initialised: ${rel(ctx, dir)} (${changes.length ? changes.join('; ') : 'no changes'})`);
  else ctx.io.out(`initialised ${rel(ctx, dir)}: edit config.json, then add tickets.jsonl, edges.jsonl and schedule.jsonl (see the plugin README), then \`plangraph build\``);
  // Print-only: plangraph never writes a repo's CLAUDE.md. Shown until a CLAUDE.md carries the steer.
  if (!claudeSteer(ctx).steered) ctx.io.outBlock(["suggested lines for this repo's CLAUDE.md (printed only, nothing written):", ...claudeSnippet(rel(ctx, dir))]);
  return 0;
}

async function migrate(ctx: Ctx, args: Args<{ write?: boolean }>): Promise<number> {
  const S = await import('../../lib/store.ts'); let r: ReturnType<typeof S.runMigration>;
  try { r = S.runMigration(ctx.dir, { write: Boolean(args.values.write) }); } catch (e) { refuseWrite(e); } // a symlinked target or lock: exit 4
  ctx.io.out(r.pending ? `${r.from}->${r.to}: ${r.steps.flatMap((x) => x.files).join(' ')} ${r.written ? '(applied)' : '(dry run, use --write)'}` : 'up to date');
  return 0;
}

// ---- doctor: data format, merge driver, node, solver runtime; warnings never change the exit code ----
// `doctor --fix --alias NAME`: the user approves the alias for THIS repository. It needs a terminal on stdin (an agent that follows a printed hint
// has none) and a typed host, and writes nothing before the confirmation. Returns false when the user did not confirm.
async function approveAliasHere(ctx: Ctx, name: string): Promise<boolean> {
  if (!isAliasName(name)) throw usage(`--alias needs an alias name (ALIAS_RE ^[a-z][a-z0-9_-]{0,31}$)`);
  if (Object.keys(ctx.env).some((k) => k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_'))) throw usage('doctor --fix --alias refuses to run inside Claude Code: approve it in your own terminal outside Claude Code; nothing was written (docs/JIRA.md, Approving an alias)');
  if (!ctx.stdin.isTTY) throw usage(`doctor --fix --alias needs an interactive terminal on stdin: the user approves an alias there; nothing was written (docs/JIRA.md, Approving an alias)`);
  const reg = loadRegistry(ctx.env), entry = Object.hasOwn(reg.aliases, name) ? reg.aliases[name] : undefined;
  if (!entry) throw usage(`alias ${name} is not defined in ${reg.file}; add it under "aliases" first (docs/JIRA.md, Keep the tenant out of the repository, portably)`);
  const key = repoKey(ctx.root);
  if (!key) throw usage(`alias ${name} can be approved only inside a git repository; this directory is not one`);
  let host = ''; try { host = entry.base_url ? new URL(entry.base_url).host.toLowerCase() : String(entry.cloud_id || '').toLowerCase(); } catch { host = ''; }
  const expect = host || name;
  ctx.io.out(`approve alias ${name} for the repository ${oneLine(ctx.root, 200)}`);
  ctx.io.out(`alias ${name} points at ${host ? oneLine(host, 200) : '(no host: the credentials only)'}; approving lets this repository's jira-pull use the credentials you bound to it`);
  ctx.io.out(`type ${oneLine(expect, 200)} to approve, anything else to cancel:`);
  let typed = '';
  try { typed = String(ctx.stdin.readTty ? ctx.stdin.readTty(256) : ctx.stdin.readLine ? ctx.stdin.readLine(256) : ctx.stdin.read(256)).trim().toLowerCase(); } // the real stdin reads /dev/tty, never fd 0
  catch { throw usage('doctor --fix --alias could not open the terminal (/dev/tty) to read your answer; nothing was written'); }
  if (typed !== expect.toLowerCase()) { ctx.io.out(`alias ${name} not approved; nothing was written`); return false; }
  try { approveAlias(ctx.env, name, key); } catch (e) { throw usage(oneLine(String((e as Error).message).split('\n')[0], 300)); } // a JiraError: its message names the file or the alias
  ctx.io.out(`alias ${name} approved for this repository`);
  return true;
}
async function doctor(ctx: Ctx, args: Args<{ fix?: boolean; alias?: string }>): Promise<number> {
  const S = await import('../../lib/store.ts'), out = ctx.io.out, dir = rel(ctx, ctx.dir); let bad = 0;
  if (args.values.alias !== undefined) {
    if (!args.values.fix) throw usage('--alias goes with --fix: plangraph doctor --fix --alias NAME');
    if (!(await approveAliasHere(ctx, args.values.alias))) return 1;
  }
  const f = S.readFormat(ctx.dir);
  ctx.config(); // a bad config.json is refused (exit 2) exactly as by every reader, after the data-format check
  out(`data format v${f.format_version}${f.legacy ? ' (legacy: run `plangraph migrate --write`)' : ''}; tool supports v${S.FORMAT_VERSION}`); if (f.legacy) bad++;
  const target = path.join(BIN, 'plangraph-merge'); // the running plugin's driver: a shim left at another install is a problem
  let dm = S.doctorMergeDriver(ctx.root, { dir, target }), wireErr = '', consentErr = '';
  if (dm.problems.length && args.values.fix) {
    try { await wireMergeDriver(ctx, { consent: true }); } catch (e) { wireErr = oneLine(String((e as Error).message).split('\n')[0], 200); } // whatever was thrown: String() of its message
    dm = S.doctorMergeDriver(ctx.root, { dir, target });
  } else if (args.values.fix) {
    // Already wired (by hand, or before 0.3.0): `doctor --fix` run by the user is the consent the session hook needs to keep it healed.
    try { await recordHealConsent(ctx); } catch (e) { consentErr = oneLine(String((e as Error).message).split('\n')[0], 200); } // whatever was thrown: String() of its message
  }
  out(dm.problems.length ? `merge driver: ${dm.problems.join('; ')}` : 'merge driver: ok'); bad += dm.problems.length;
  if (wireErr) { out(`merge driver not installed: ${wireErr}`); if (!dm.problems.length) bad++; }
  if (consentErr) { out(`merge driver: consent to heal not recorded: ${consentErr}`); bad++; }
  const idx = trackedIndex(ctx);
  if (idx) { out(`tracked index: ${idx} is committed; untrack it with \`git rm --cached ${idx}\``); bad++; }
  doctorSidecars(ctx);
  const nodeOk = nodeSupported(process.versions.node);
  out(`node ${process.version}: ${nodeOk ? 'ok' : `too old (needs >= ${NODE_FLOOR})`}`); if (!nodeOk) bad++;
  const uv = spawnSync('uv', ['--version'], { encoding: 'utf8', timeout: 10000 });
  out(`solver runtime: ${uv.status === 0 ? 'uv found (plangraph-solve-run will use it)' : 'uv not found (plangraph-solve-run falls back to a python3.10-3.14 venv)'}`);
  doctorJira(ctx);
  await doctorGraph(ctx);
  await doctorWarnings(ctx);
  return bad ? 1 : 0;
}
// Graph files, info only (never changes the exit code): a duplicate id left by a merge is explained instead of refused; violations are counted and
// listed by `plangraph check`; nothing is printed for a directory without graph files.
async function doctorGraph(ctx: Ctx): Promise<void> {
  const out = ctx.io.out, { integrityOf } = await import('../../lib/graph/integrity.ts');
  let r: ReturnType<typeof integrityOf>;
  try { r = integrityOf(ctx.dir, ctx.config(), (await readItems(ctx)).items); } catch (e) {
    const dup = e instanceof Error && e.name === 'IngestError' ? String(e.message).split('\n').filter((l) => l.startsWith('DUPLICATE_NODE ')) : [];
    if (!dup.length) throw e;
    for (const l of dup) out(oneLine(l.slice('DUPLICATE_NODE '.length), 300));
    return;
  }
  if (r.violations.length) out(`graph integrity: ${r.violations.length} violation${r.violations.length === 1 ? '' : 's'}; run \`plangraph check\` to list them`);
  if (r.files.ext) out(`ext ignored ${r.files.ext}`);
  const cfg = ctx.config();
  listMore(out, r.files.capacity.filter((c) => c.sp !== capOf(cfg, c.person)).map((c) => `warning: capacity.jsonl: ${oneLine(c.person, 60)} sprint ${c.sprint} has ${c.sp} sp but config.json caps say ${capOf(cfg, c.person)}`), 5, (l) => l);
}
// Jira status line, info only (never changes the exit code, no network, no process, no secret read or printed): says whether `plangraph jira-pull`
// is set up, so nobody has to guess. The Atlassian connector (MCP) is separate: `plangraph` never uses it, `plangraph integrations` cannot see it.
function doctorJira(ctx: Ctx): void {
  const out = ctx.io.out, env = ctx.env || {};
  let committed: JiraSettings | undefined; try { committed = ctx.config().jira as JiraSettings | undefined; } catch { return; /* a bad config is reported by the data checks */ } // config.json's jira block: PlanConfig does not type it
  let t: ReturnType<typeof resolveTenant>;
  try { t = resolveTenant(committed, ctx.root, env); } catch (e) {
    if (e instanceof Error && e.name === 'JiraError' && ['bad_config', 'bad_input'].includes((e as Error & { code: string }).code)) out(`jira: invalid config: ${oneLine(e.message, 160)}; \`plangraph jira-pull\` refuses it (fix config.json "jira" or your projects entry; see docs/JIRA.md)`); // a JiraError has a code
    return;
  }
  const { jira: j, tenant, mode, registry: reg, entry: e, allowGeneric } = t;
  const set = (k: string) => String(env[k] || '').trim() !== '';
  if (t.aliasProblem) out(`warning: ${oneLine(t.aliasProblem, 300)}; \`plangraph jira-pull\` refuses it`);
  if (!j.jql && !j.cloud_id && !j.base_url) { out('jira: not configured (config.json "jira" is empty): `plangraph jira-pull` is off; see docs/JIRA.md. The Atlassian connector is separate and `plangraph` never uses it'); return; }
  const tag = tenant ? siteTag(tenant) : '';
  let cred: string;
  if (!tenant) cred = 'tenant unknown (base_url or cloud_id missing)';
  else if (e) cred = `bound by registry (${e.token_env ? `${e.token_env} ${set(e.token_env) ? 'set' : 'MISSING'}` : e.op_ref ? 'op ref' : 'keychain'})`;
  else if (set(`JIRA_API_TOKEN__${tag}`) || set(`JIRA_OP_REF__${tag}`)) cred = `bound by env JIRA_*__${tag}`;
  else if (allowGeneric) cred = set('JIRA_EMAIL') && set('JIRA_API_TOKEN') ? 'generic env JIRA_EMAIL + JIRA_API_TOKEN set' : set('JIRA_OP_REF') ? 'generic env JIRA_OP_REF set' : 'no credentials in env (OS keychain not checked)';
  else cred = `NO credential bound to ${tenant}: add it to ${reg.file} or set JIRA_EMAIL__${tag} and JIRA_API_TOKEN__${tag}`;
  out(`jira: ${mode}, tenant ${tenant || '?'}${t.alias ? ` (alias ${t.alias})` : ''}, jql ${j.jql ? 'set' : 'missing'}, ${cred}`);
  if (tenant) out(`jira connector: use the Atlassian connector only if getAccessibleAtlassianResources lists ${tenant === (j.cloud_id || '').toLowerCase() ? `cloud id ${tenant}` : tenant}; otherwise use \`plangraph jira-pull\` (read-only) and make no Jira write`);
  for (const p of reg.problems) out(`warning: ${oneLine(p, 160)} (${reg.file})`);
}
// The index is derived and machine-local (init writes `*.sqlite` and its sidecar patterns to the plan dir's .gitignore): a committed one goes stale for everyone
// else and can be tampered with in a commit. Returns its repo-relative path when git tracks it, else '' (also outside a git repository).
// Literal pathspec, argv only: the plan dir name never acts as a glob or an option.
function trackedIndex(ctx: Ctx, name: string = INDEX_FILE): string {
  const relIdx = path.relative(ctx.root, path.join(ctx.dir, name)).split(path.sep).join('/');
  try { return ctx.git('--literal-pathspecs', 'ls-files', '-z', '--', checkRepoPath(relIdx)) ? oneLine(relIdx, 200) : ''; } catch { return ''; }
}
// Warnings only (the exit code is unchanged): a SQLite sidecar beside the index (every index command refuses it; `plangraph build` removes a
// regular one), a committed sidecar (a journal in git is replayed by SQLite into whoever's index sits beside it, if plangraph did not refuse it),
// and a plangraph-dir .gitignore that lacks the sidecar lines (`plangraph init` appends them). Names come from constants, never from the directory.
function doctorSidecars(ctx: Ctx): void {
  const out = ctx.io.out, base = path.join(ctx.dir, INDEX_FILE), shown = (p: string) => oneLine(path.relative(ctx.root, p).split(path.sep).join('/'), 200);
  try { for (const [p] of sidecarsOf(base)) out(`warning: ${shown(p)}: a SQLite journal file beside the index; every index command refuses it until \`plangraph build\` removes it`); } catch { /* unreadable: skip */ }
  for (const s of SIDECARS) { const t = trackedIndex(ctx, INDEX_FILE + s); if (t) out(`warning: tracked journal: ${t} is committed; untrack it with \`git rm --cached ${t}\``); }
  const gi = path.join(ctx.dir, '.gitignore');
  let text = null; try { text = readCapped(gi, 1024 * 1024, { follow: false }); } catch { /* missing or refused */ }
  if (text !== null && missingIgnoreLines(text).some((l) => l !== INDEX_PATTERN)) {
    out(`warning: ${shown(gi)} does not ignore the SQLite journal files (${IGNORE_LINES.slice(1).join(', ')}): run \`plangraph init\` to add the missing lines`);
  }
}
const listMore = (out: (line: string) => void, found: string[], max: number, line: (x: string) => string): void => { for (const x of found.slice(0, max)) out(line(x)); if (found.length > max) out(`  ... and ${found.length - max} more`); };
// Files and JSON only, no process, no network.
async function doctorWarnings(ctx: Ctx): Promise<void> {
  const out = ctx.io.out, DIR = ctx.dir, ROOT = ctx.root;
  // Conflict-marker scan: at most 20 .jsonl files, 64 MiB in total, lstat only (symlinks and non-regular files are never followed or read).
  // A file that does not fit the remaining budget is reported, not silently ignored.
  const markers = ([] as string[]), skipped: string[] = []; let budget = 64 * 1024 * 1024, more = 0; // an empty list of this element type
  try {
    const names = fs.readdirSync(DIR).filter((n) => n.endsWith('.jsonl')).sort(); let scanned = 0;
    for (const f of names) {
      let st: fs.Stats; try { st = fs.lstatSync(path.join(DIR, f)); } catch { continue; }
      if (!st.isFile()) continue;
      if (scanned >= 20) { more++; continue; }
      scanned++;
      if (st.size > budget) { skipped.push(f); continue; }
      let text: string; try { text = readCapped(path.join(DIR, f), budget); } catch { continue; }
      budget -= st.size;
      text.split('\n').forEach((l, i) => { if (/^(<{7}|={7}|>{7})/.test(l)) markers.push(`${oneLine(f, 60)}:${i + 1}`); });
    }
  } catch { /* no plan directory yet */ }
  listMore(out, markers, 5, (m) => `warning: unresolved conflict marker ${m} (GitKraken Desktop may ignore the merge driver; resolve it, then run \`plangraph build\`)`);
  for (const f of skipped) out(`warning: skipped (too large): ${oneLine(f, 60)}`);
  if (more) out(`  ... and ${more} more .jsonl files not scanned (the scan reads at most 20)`);
  const strays: string[] = [];
  for (const d of [ROOT, path.join(ROOT, 'docs'), path.join(ROOT, '.claude')]) {
    try { for (const n of fs.readdirSync(d).sort()) if (n.endsWith('.original.md') && fs.lstatSync(path.join(d, n)).isFile()) strays.push(path.relative(ROOT, path.join(d, n))); } catch { /* absent */ }
  }
  listMore(out, strays, 5, (s) => `warning: stray file ${oneLine(s, 80)} (left by caveman-compress; delete it or restore it)`);
  const { detectTools } = await import('../../lib/integrations/detect.ts');
  const tools = Object.fromEntries(detectTools({ root: ROOT, home: ctx.env.HOME || os.homedir(), env: ctx.env }).tools.map((t) => [t.name, t])) as Record<'superpowers' | 'gitkraken' | 'openwolf', DetectedTool>; // without `names`, detectTools reports each of its five known tools, these three included
  const sp = tools.superpowers; if (sp.state !== 'absent') out(`superpowers: ${oneLine(sp.state, 20)}${sp.version ? ` ${oneLine(sp.version, 64)}` : ''}`);
  const gk = tools.gitkraken; if (gk.state !== 'absent') out(`gitkraken: ${oneLine(gk.state, 20)}${gk.version ? ` ${oneLine(gk.version, 64)}` : ''}: ${oneLine(gk.notes.find((n: string) => n.startsWith('logs every prompt')) ?? '', 200)}`);
  if (tools.openwolf.state === 'protocol-only') out('warning: openwolf: rules only: its hooks are not registered');
  // Info only (never a failure, never a write): a CLAUDE.md exists but does not steer plan questions to plangraph.
  // Info only: OpenWolf's STATUS.md carries a plangraph line that is not the one `plangraph card --line` prints now (the handoff is older than the
  // data). Only when OpenWolf is active or protocol-only (disabled injects nothing); STATUS.md is read through readWolfFile (capped, no
  // symlink) and nothing from it is printed. Any failure (no plan data, an unreadable file) skips the check silently.
  if (tools.openwolf.state === 'active' || tools.openwolf.state === 'protocol-only') {
    try {
      const W = await import('../../lib/integrations/openwolf.ts'), st = W.readWolfFile(ROOT, 'STATUS.md'), seen = st.ok ? W.statusBrainLine(st.text) : null;
      if (seen !== null) { const { cardLineText } = await import('./queries.ts'); if (seen !== await cardLineText(ctx)) out('info: OpenWolf STATUS.md mentions an older plangraph line: run /handoff'); }
    } catch { /* no plan data or an unreadable file: nothing to compare */ }
  }
  const cs = claudeSteer(ctx); if (cs.exists && !cs.steered) out('info: CLAUDE.md does not steer plan questions to plangraph: `plangraph init` prints a 3-line snippet to add (nothing is written)');
}

const B = { type: 'boolean' };
const WIRING: readonly string[] = ['git-config', 'gitattributes', 'merge-shim']; // what wireMergeDriver writes (src/registry.ts SIDE_WRITES)
export const commands: CommandMap = {
  whatif: { run: whatif, positionals: [0, 1], writes: 'index', options: { to: { type: 'string' }, sprint: { type: 'integer' }, earlier: B, 'owner-change': B, slip: B, strict: B, 'apply-plan': B, write: B, relieve: { type: 'string' }, find: B }, summary: 'dry run of one reassignment or move (exit 1 when unsafe); --apply-plan [--write] repairs; --relieve NAME --sprint N: fewest moves to get under cap; KEY --find: every valid slot, ranked (both read-only)' },
  'schedule-load': { run: scheduleLoad, positionals: [2, 2], writes: 'index', summary: 'keep the current plan under an archive name and load a new schedule into the index' },
  export: { run: exportText, positionals: [0, 0], writes: 'text', guard: 'strict', summary: 'index -> canonical text (stable order, diffable)' },
  build: { run: build, positionals: [0, 0], writes: 'index', summary: 'text -> index (atomic; stores the source fingerprint)' },
  init: { run: init, positionals: [0, 0], writes: 'text', also: WIRING, guard: 'none', summary: 'create the plan directory, config, generic learnings and the merge driver' },
  migrate: { run: migrate, positionals: [0, 0], writes: 'text', guard: 'none', options: { write: B }, summary: 'upgrade the data format (dry run unless --write)' },
  doctor: { run: doctor, positionals: [0, 0], guard: 'none', options: { fix: { ...B, writes: WIRING }, alias: { type: 'string' } }, summary: 'data format, merge driver, node and solver runtime checks (exit 1 on a problem)' },
};
