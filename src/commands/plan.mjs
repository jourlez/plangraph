// Plan mutation and safety: whatif schedule-load export build init migrate doctor.
// Index writes open their own writable handle (src/db.mjs openIndex, readOnly false); text writes are atomic and confined to the repo.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { readCapped } from '../../lib/jsonl.mjs';
import { oneLine } from '../../lib/sanitize.mjs';
import { BrainError } from '../errors.mjs';
import { buildIndex, openIndex, stampFingerprint, TABLES, INDEX_FILE } from '../db.mjs';
import { checkRepoPath } from '../../lib/gitsafe.mjs';
import { NODE_FLOOR, nodeSupported } from '../floor.mjs';
import { CUR, SEED, dbFile, rel, verbose, usage, dataError, readJsonInput, modelFromDb, wireMergeDriver, precheckTargets, writeState, refuseWrite, nextCommand, nextList, dataText } from './shared.mjs';
/** @typedef {import('../context.mjs').Context} Ctx @typedef {import('../context.mjs').Args} Args */

// ---- reassignment safety ----
// --json data of a dry run: the move, the broken rules (bounded like the text), the repair suggestion; next: the --apply-plan dry run of
// the same move when one exists (allowed, or a repair was found) and the ticket in detail. Untrusted strings are one sanitized line.
const HARD = new Set(['UNKNOWN_TICKET', 'UNKNOWN_PERSON', 'SAME_SLOT', 'OUT_OF_RANGE']);
const FLAGS = ['earlier', 'owner-change', 'slip', 'strict'];
/** @param {any} r @param {string} key @param {Record<string, any>} v @param {number} limit */
function whatifData(r, key, v, limit) {
  const mv = r.ripple?.[0], g = r.suggestion, s = (/** @type {unknown} */ x, n = 60) => oneLine(x ?? '', n);
  const data = {
    key: s(key, 120), ok: r.ok, to: mv ? { owner: s(mv.to.owner), sprint: mv.to.sprint } : null,
    reasons: r.reasons.slice(0, limit).map((/** @type {any} */ x) => ({ code: s(x.code, 40), key: s(x.key, 120), detail: dataText(x.detail), ...(x.fix ? { fix: dataText(x.fix) } : {}), ...(x.warn ? { warn: true } : {}) })),
    more: Math.max(0, r.reasons.length - limit), ripple: (r.ripple || []).length,
    suggestion: g ? (g.none ? { none: true } : { owner: s(g.owner), sprint: g.sprint, shifts: g.shifts, ownerChanges: g.ownerChanges, ...(g.flags ? { flags: g.flags } : {}) }) : null,
  };
  const known = !r.reasons.some((/** @type {any} */ x) => x.code === 'UNKNOWN_TICKET');
  const repairable = (r.ok || (g && !g.none)) && !r.reasons.some((/** @type {any} */ x) => HARD.has(x.code)) && (v.sprint === undefined || v.sprint >= 0);
  // a suggestion was searched with slip allowed: its --apply-plan runs the same search (--slip), or it would not find the same repair
  const need = (/** @type {string} */ f) => v[f] || (f === 'slip' && !r.ok && g && !g.none);
  const apply = repairable ? nextCommand(['whatif', [key], ...(v.to !== undefined ? ['--to', [v.to]] : []), ...(v.sprint !== undefined ? ['--sprint', String(v.sprint)] : []), ...FLAGS.filter(need).map((f) => `--${f}`), '--apply-plan']) : null;
  return { data, next: nextList([apply, known ? nextCommand(['ticket', [key], '-v']) : null]) };
}
/** @param {Ctx} ctx @param {Args} args */
async function whatif(ctx, args) {
  const W = await import('../../lib/whatif.mjs'), model = modelFromDb(ctx), v = args.values, out = ctx.io.out;
  const mv = { key: args.positionals[0], to: v.to, sprint: v.sprint };
  // the schema refuses both at build time; an index built by an older version may still hold them, and whatif must not crash on bad data
  const badSprint = [...model.sched.values()].some((p) => p.sprint != null && !Number.isSafeInteger(p.sprint));
  if (badSprint || [...model.tickets.values()].some((t) => t.sp != null && !(Number.isFinite(t.sp) && t.sp >= 0))) {
    throw dataError('the index holds a sprint that is not a whole number or a negative sp', 'fix schedule.jsonl / tickets.jsonl, then `brain build` (it names the line)');
  }
  const o = { strict: Boolean(v.strict), allowEarlier: Boolean(v.earlier), allowOwnerChange: Boolean(v['owner-change']), allowSlip: Boolean(v.slip) };
  if (!v['apply-plan']) {
    const r = W.whatif(model, mv, o), limit = verbose(args) ? 50 : 8;
    out(dataText(W.renderWhatif(r, { limit }), 4000)); // one line: keys and owners from data cannot start a new line
    const { data, next } = whatifData(r, mv.key, v, limit); ctx.io.data?.(data, { next });
    return r.ok ? 0 : 1;
  }
  const r = W.proposeMove(model, mv, o);
  const why = (r.reasons || []).map((x) => dataText(x && x.code ? `${x.code} ${x.key || ''} ${x.detail || ''}`.trim() : String(x), 400));
  if (!r.ok) { out(`NO PLAN: ${why.join(' | ') || 'no repair found'}`); return 1; }
  out(`PLAN: ${r.moves.length} move(s), ${r.shifted} others shifted, ${r.ownerChanges} owner changes${r.searchComplete === false ? ' (search budget hit: not proven minimal)' : ''}`);
  const first = (/** @type {unknown} */ o) => oneLine(String(o).split(' ')[0], 40);
  for (const m of r.moves) out(`${oneLine(m.key, 120)} ${first(m.from.owner)} S${oneLine(m.from.sprint, 20)} > ${first(m.to.owner)} S${oneLine(m.to.sprint, 20)}`);
  if (!v.write) { out('(dry run: add --write to change the index, then `brain export` to save it as text)'); return 0; }
  const V = await import('../../lib/verify.mjs'), next = W.applyMoves(model.sched, r.moves);
  const before = new Set(V.verifyPlan(model).map((x) => x.code + x.key)), fresh = V.verifyPlan(model, next).filter((x) => !before.has(x.code + x.key));
  if (fresh.length) throw new BrainError('REFUSED', `refusing to write: the verifier found ${fresh.length} new violation(s)`);
  {
    using db = openIndex(dbFile(ctx), { readOnly: false });
    db.exec('BEGIN');
    const up = db.prepare(`UPDATE schedule SET owner=?, sprint=? WHERE ${CUR} AND key=?`);
    for (const m of r.moves) up.run(m.to.owner, m.to.sprint, m.key);
    db.exec('COMMIT');
  }
  out('written to the index; run `brain export` to save it as text');
  return 0;
}

// ---- keep the current plan under an archive name, load a new one (index only; `brain export` saves it as text) ----
/** @param {Ctx} ctx @param {Args} args */
function scheduleLoad(ctx, args) {
  const [file, archive] = args.positionals;
  if (!archive || archive === 'current' || archive.length > 200) throw usage('archive name must be non-empty, at most 200 characters and not "current"');
  const rows = readJsonInput(file, 'schedule file');
  if (!Array.isArray(rows) || !rows.every((r) => r && typeof r === 'object' && typeof r.item === 'string' && typeof r.owner === 'string' && Number.isSafeInteger(r.sprint))) {
    throw dataError('schedule file must be a JSON array of {item, owner, sprint} (strings and a whole sprint number)');
  }
  using db = openIndex(dbFile(ctx), { readOnly: false });
  if (db.get('SELECT COUNT(*) c FROM schedule WHERE version=?', archive).c) throw usage(`archive name already used: ${oneLine(archive, 80)}`);
  const people = new Set(db.all("SELECT DISTINCT v2_owner o FROM ticket WHERE v2_owner<>''").map((r) => r.o));
  const bad = [...new Set(rows.map((r) => r.owner))].filter((o) => people.size && !people.has(o));
  if (bad.length) throw dataError(`schedule has owners that are not people in the plan: ${bad.slice(0, 10).map((o) => oneLine(o, 60)).join(', ')}${bad.length > 10 ? ` (+${bad.length - 10} more)` : ''}`);
  db.exec('BEGIN');
  try {
    db.prepare(`UPDATE schedule SET version=? WHERE ${CUR}`).run(archive);
    const ins = db.prepare("INSERT INTO schedule(version,key,owner,sprint) VALUES('current',?,?,?)");
    for (const r of rows) ins.run(r.item, r.owner, r.sprint);
    db.exec('COMMIT');
  } catch (/** @type {any} */ e) { db.exec('ROLLBACK'); throw dataError(`schedule file could not be loaded: ${oneLine(String(e.message).split('\n')[0], 160)}`); }
  ctx.io.out(`loaded as current; previous plan kept as ${oneLine(archive, 200)}; run \`brain export\` to save it as text`);
  return 0;
}

// ---- text <-> index ----
const EXPORT = [['ticket', 'key'], ['schedule', 'version,key'], ['edge', 'consumer,producer'], ['evidence', 'key,source,rowid'], ['finding', 'key,kind,text'], ['meta', 'k']];
/** @param {Ctx} ctx */
async function exportText(ctx) {
  const S = await import('../../lib/store.mjs'), file = dbFile(ctx);
  const targets = EXPORT.map(([t]) => path.join(ctx.dir, /** @type {import('../db.mjs').TableSpec} */ (TABLES.get(t)).file));
  precheckTargets(ctx, targets);
  const texts = [];
  {
    using d = openIndex(file, { readOnly: true, dir: ctx.dir });
    // A stale index means the text was edited after the build: exporting would silently overwrite those edits with the older index.
    // (schedule-load and whatif --write change only the index, so the fingerprint still matches and export goes ahead.)
    if (d.stale) throw dataError('the index is stale: the text files changed since it was built, and export would overwrite them', 'run `brain build` first (it reads the text), then export');
    for (const [t, order] of EXPORT) {
      const { file: fn } = /** @type {import('../db.mjs').TableSpec} */ (TABLES.get(t));
      const rows = d.all(`SELECT * FROM ${t} ORDER BY ${order}`).map((row) => {
        // NULL in a known column means the field was absent: it stays absent. `extra` holds unknown fields and the exact values a column could
        // not keep (an explicit null, a number in a text column), which win over the column (src/db.mjs rowOf).
        const { extra, ...known } = row; const r = Object.create(null); // null-prototype: a stored "__proto__" key stays a plain key
        for (const [k, v] of Object.entries(known)) if (v !== null) r[k] = v;
        if (extra != null) { const o = JSON.parse(extra); for (const k of Object.keys(o)) Object.defineProperty(r, k, { value: o[k], enumerable: true, writable: true, configurable: true }); }
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

/** @param {Ctx} ctx */
function build(ctx) {
  const r = buildIndex(ctx);
  ctx.io.out(`built ${rel(ctx, r.file)}: ${r.counts.ticket} tickets, ${r.counts.edge} links, ${r.counts.evidence} evidence rows, ${r.counts.finding} findings, ${r.counts.learning} learnings`);
  return 0;
}

// ---- set-up ----
const CONFIG = {
  _doc: 'Constraints for brain-solve and brain check. Capacity is points per person per sprint.',
  first_sprint: 1, end_sprint: 12, caps: { default: 40 }, min_per_sprint: {}, minimize_load_of: '', default_ref: 'HEAD', brain_rules_version: 1, closed_statuses: ['Done'],
  frozen_statuses: ['Done'], ignore_link_kinds: [], time_limit_seconds: 300, workers: 8,
  stage_order: ['end_sprint', 'shortfall', 'load_of', 'peak_load', 'owner_changes'],
  ref_heading: '^#{2,3} Task {id}:', jira: { base_url: '', jql: '' },
};
/** @param {Ctx} ctx */
async function init(ctx) {
  const S = await import('../../lib/store.mjs'), dir = ctx.dir, cfg = path.join(dir, 'config.json'), fmt = path.join(dir, S.FORMAT_FILE);
  precheckTargets(ctx, [fmt]); // a symlinked format.json (even a dangling one) is REFUSED (exit 4) before anything is written
  fs.mkdirSync(dir, { recursive: true });
  const missing = (/** @type {string} */ f) => !fs.existsSync(f), gi = path.join(dir, '.gitignore'), /** @type {string[]} */ changes = [];
  const existing = !missing(cfg) || !missing(path.join(dir, 'tickets.jsonl')); // a brain that was set up before: init must not read as a first set-up
  precheckTargets(ctx, [gi]);
  if (missing(cfg)) writeState(ctx, cfg, `${JSON.stringify(CONFIG, null, 2)}\n`);
  const dst = path.join(dir, 'learnings.jsonl');
  if (missing(dst) && fs.existsSync(SEED)) writeState(ctx, dst, readCapped(SEED, 1024 * 1024));
  // Only ADD the line init needs: every user line in an existing .gitignore stays, in order, byte for byte; nothing is written when it is there.
  const old = missing(gi) ? null : readCapped(gi, 1024 * 1024);
  if (old === null) { writeState(ctx, gi, '*.sqlite\n'); changes.push('created .gitignore with *.sqlite'); }
  else if (!old.split(/\r?\n/).some((l) => l.trim() === '*.sqlite')) {
    writeState(ctx, gi, `${old}${old === '' || old.endsWith('\n') ? '' : old.includes('\r\n') ? '\r\n' : '\n'}*.sqlite${old.includes('\r\n') ? '\r\n' : '\n'}`); changes.push('added *.sqlite to .gitignore');
  }
  for (const [t] of EXPORT) { const f = path.join(dir, /** @type {import('../db.mjs').TableSpec} */ (TABLES.get(t)).file); if (missing(f)) { writeState(ctx, f, ''); changes.push(`created ${/** @type {import('../db.mjs').TableSpec} */ (TABLES.get(t)).file}`); } }
  if (missing(fmt)) { try { S.writeFormat(dir, { format_version: S.FORMAT_VERSION, min_reader: S.FORMAT_VERSION }); changes.push('created format.json'); } catch (e) { refuseWrite(e); } }
  try { await wireMergeDriver(ctx); } catch (/** @type {any} */ e) { ctx.io.err(`merge driver not installed: ${oneLine(String(e.message).split('\n')[0], 200)}; run \`brain doctor --fix\` inside a git repo`); }
  if (existing) { ctx.io.out(`already initialised: ${rel(ctx, dir)} (${changes.length ? changes.join('; ') : 'no changes'})`); return 0; }
  ctx.io.out(`initialised ${rel(ctx, dir)}: edit config.json, then add tickets.jsonl, edges.jsonl and schedule.jsonl (see the plugin README), then \`brain build\``);
  return 0;
}

/** @param {Ctx} ctx @param {Args} args */
async function migrate(ctx, args) {
  const S = await import('../../lib/store.mjs'); let r;
  try { r = S.runMigration(ctx.dir, { write: Boolean(args.values.write) }); } catch (e) { refuseWrite(e); } // a symlinked target or lock: exit 4
  ctx.io.out(r.pending ? `${r.from}->${r.to}: ${r.steps.flatMap((/** @type {any} */ x) => x.files).join(' ')} ${r.written ? '(applied)' : '(dry run, use --write)'}` : 'up to date');
  return 0;
}

// ---- doctor: data format, merge driver, node, solver runtime; warnings never change the exit code ----
/** @param {Ctx} ctx @param {Args} args */
async function doctor(ctx, args) {
  const S = await import('../../lib/store.mjs'), out = ctx.io.out, dir = rel(ctx, ctx.dir); let bad = 0;
  const f = S.readFormat(ctx.dir);
  out(`data format v${f.format_version}${f.legacy ? ' (legacy: run `brain migrate --write`)' : ''}; tool supports v${S.FORMAT_VERSION}`); if (f.legacy) bad++;
  let dm = S.doctorMergeDriver(ctx.root, { dir }), wireErr = '';
  if (dm.problems.length && args.values.fix) {
    try { await wireMergeDriver(ctx); } catch (/** @type {any} */ e) { wireErr = oneLine(String(e.message).split('\n')[0], 200); }
    dm = S.doctorMergeDriver(ctx.root, { dir });
  }
  out(dm.problems.length ? `merge driver: ${dm.problems.join('; ')}` : 'merge driver: ok'); bad += dm.problems.length;
  if (wireErr) { out(`merge driver not installed: ${wireErr}`); if (!dm.problems.length) bad++; }
  const idx = trackedIndex(ctx);
  if (idx) { out(`tracked index: ${idx} is committed; untrack it with \`git rm --cached ${idx}\``); bad++; }
  const nodeOk = nodeSupported(process.versions.node);
  out(`node ${process.version}: ${nodeOk ? 'ok' : `too old (needs >= ${NODE_FLOOR})`}`); if (!nodeOk) bad++;
  const uv = spawnSync('uv', ['--version'], { encoding: 'utf8', timeout: 10000 });
  out(`solver runtime: ${uv.status === 0 ? 'uv found (brain-solve-run will use it)' : 'uv not found (brain-solve-run falls back to a python3.10-3.14 venv)'}`);
  await doctorWarnings(ctx);
  return bad ? 1 : 0;
}
// The index is derived and machine-local (init writes `*.sqlite` to the brain dir's .gitignore): a committed one goes stale for everyone
// else and can be tampered with in a commit. Returns its repo-relative path when git tracks it, else '' (also outside a git repository).
// Literal pathspec, argv only: the brain dir name never acts as a glob or an option.
/** @param {Ctx} ctx */
function trackedIndex(ctx) {
  const relIdx = path.relative(ctx.root, path.join(ctx.dir, INDEX_FILE)).split(path.sep).join('/');
  try { return ctx.git('--literal-pathspecs', 'ls-files', '-z', '--', checkRepoPath(relIdx)) ? oneLine(relIdx, 200) : ''; } catch { return ''; }
}
/** @type {(out: (line: string) => void, found: string[], max: number, line: (x: string) => string) => void} */
const listMore = (out, found, max, line) => { for (const x of found.slice(0, max)) out(line(x)); if (found.length > max) out(`  ... and ${found.length - max} more`); };
// Files and JSON only, no process, no network.
/** @param {Ctx} ctx */
async function doctorWarnings(ctx) {
  const out = ctx.io.out, DIR = ctx.dir, ROOT = ctx.root;
  // Conflict-marker scan: at most 20 .jsonl files, 64 MiB in total, lstat only (symlinks and non-regular files are never followed or read).
  // A file that does not fit the remaining budget is reported, not silently ignored.
  const markers = /** @type {string[]} */ ([]), skipped = []; let budget = 64 * 1024 * 1024, more = 0;
  try {
    const names = fs.readdirSync(DIR).filter((n) => n.endsWith('.jsonl')).sort(); let scanned = 0;
    for (const f of names) {
      let st; try { st = fs.lstatSync(path.join(DIR, f)); } catch { continue; }
      if (!st.isFile()) continue;
      if (scanned >= 20) { more++; continue; }
      scanned++;
      if (st.size > budget) { skipped.push(f); continue; }
      let text; try { text = readCapped(path.join(DIR, f), budget); } catch { continue; }
      budget -= st.size;
      text.split('\n').forEach((l, i) => { if (/^(<{7}|={7}|>{7})/.test(l)) markers.push(`${oneLine(f, 60)}:${i + 1}`); });
    }
  } catch { /* no brain directory yet */ }
  listMore(out, markers, 5, (m) => `warning: unresolved conflict marker ${m} (GitKraken Desktop may ignore the merge driver; resolve it, then run \`brain build\`)`);
  for (const f of skipped) out(`warning: skipped (too large): ${oneLine(f, 60)}`);
  if (more) out(`  ... and ${more} more .jsonl files not scanned (the scan reads at most 20)`);
  const strays = [];
  for (const d of [ROOT, path.join(ROOT, 'docs'), path.join(ROOT, '.claude')]) {
    try { for (const n of fs.readdirSync(d).sort()) if (n.endsWith('.original.md') && fs.lstatSync(path.join(d, n)).isFile()) strays.push(path.relative(ROOT, path.join(d, n))); } catch { /* absent */ }
  }
  listMore(out, strays, 5, (s) => `warning: stray file ${oneLine(s, 80)} (left by caveman-compress; delete it or restore it)`);
  const { detectTools } = await import('../../lib/integrations/detect.mjs');
  const tools = Object.fromEntries(detectTools({ root: ROOT, home: ctx.env.HOME || os.homedir(), env: ctx.env }).tools.map((t) => [t.name, t]));
  const sp = tools.superpowers; if (sp.state !== 'absent') out(`superpowers: ${oneLine(sp.state, 20)}${sp.version ? ` ${oneLine(sp.version, 64)}` : ''}`);
  const gk = tools.gitkraken; if (gk.state !== 'absent') out(`gitkraken: ${oneLine(gk.state, 20)}${gk.version ? ` ${oneLine(gk.version, 64)}` : ''}: ${oneLine(gk.notes.find((/** @type {string} */ n) => n.startsWith('logs every prompt')) ?? '', 200)}`);
  if (tools.openwolf.state === 'protocol-only') out('warning: openwolf: rules only: its hooks are not registered');
}

const B = { type: 'boolean' };
export const commands = {
  whatif: { run: whatif, positionals: [1, 1], writes: 'index', options: { to: { type: 'string' }, sprint: { type: 'integer' }, earlier: B, 'owner-change': B, slip: B, strict: B, 'apply-plan': B, write: B }, summary: 'dry run of one reassignment or move (exit 1 when unsafe); --apply-plan [--write] repairs' },
  'schedule-load': { run: scheduleLoad, positionals: [2, 2], writes: 'index', summary: 'keep the current plan under an archive name and load a new schedule into the index' },
  export: { run: exportText, positionals: [0, 0], writes: 'text', guard: 'strict', summary: 'index -> canonical text (stable order, diffable)' },
  build: { run: build, positionals: [0, 0], writes: 'index', summary: 'text -> index (atomic; stores the source fingerprint)' },
  init: { run: init, positionals: [0, 0], writes: 'text', guard: 'none', summary: 'create the brain directory, config, generic learnings and the merge driver' },
  migrate: { run: migrate, positionals: [0, 0], writes: 'text', guard: 'none', options: { write: B }, summary: 'upgrade the data format (dry run unless --write)' },
  doctor: { run: doctor, positionals: [0, 0], guard: 'none', options: { fix: B }, summary: 'data format, merge driver, node and solver runtime checks (exit 1 on a problem)' },
};
