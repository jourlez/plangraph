// Helpers shared by the command groups in src/commands/. Commands take (ctx, args), print through ctx.io, return an exit code.
// Heavy library modules are imported on first use inside the command, so a command never pays for modules it does not need.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readCapped, readDataCapped, presentDataFile } from '../../lib/jsonl.mjs';
import { oneLine, fence } from '../../lib/sanitize.mjs';
import { buildModel } from '../../lib/model.mjs';
import { assertInside, writeAtomicSafe } from '../../lib/fsafe.mjs';
import { BrainError, errText } from '../errors.mjs';
import { INDEX_FILE, NO_BRAIN_MESSAGE } from '../db.mjs';
import { hasSteer } from '../../lib/steer.mjs';
/** @typedef {import('../context.mjs').Context} Ctx @typedef {import('../context.mjs').Args} Args */

export { capOf } from '../../lib/model.mjs';
export const BIN = path.join(import.meta.dirname, '../../bin');
export const SEED = path.join(import.meta.dirname, '../../seed/learnings.seed.jsonl');
export const CUR = "version='current'";
export const KEY_RE = /^[A-Z][A-Z0-9]*-\d+$/;
export const MAX_DATA = 64 * 1024 * 1024;
// Every file the index and the open-items list are derived from (the card's freshness line and `card --line` use the same list).
export const SRC_FILES = Object.freeze(['tickets', 'edges', 'schedule', 'evidence', 'findings', 'meta', 'learnings', 'refs', 'open-items'].map((n) => `${n}.jsonl`));

export const dbFile = (/** @type {Ctx} */ ctx) => path.join(ctx.dir, INDEX_FILE);
export const rel = (/** @type {Ctx} */ ctx, /** @type {string} */ p) => path.relative(ctx.root, p) || '.';
export const verbose = (/** @type {Args} */ args) => Boolean(args.values.verbose);
export const isPlaced = (/** @type {any} */ s) => !!s && typeof s.owner === 'string' && s.owner !== '' && Number.isInteger(s.sprint);

/** One fence around already-prepared lines of untrusted text (each line should come from oneLine, so no record spans two lines and no
 * tag can be forged). The nonce is derived from the body, as in lib/integrations/openwolf.mjs, so the same input gives the same bytes and
 * no entry can predict its own fence. The body is never cut here: callers bound the number and length of lines first. */
/** @param {string} src @param {string[]} lines */
export function fenceLines(src, lines) {
  const body = lines.join('\n');
  return fence(src, body, { src, nonce: crypto.createHash('sha256').update(body).digest('hex').slice(0, 8), max: body.length + 16 });
}
/** The same fence as fenceLines, as an array of single lines for ctx.io.outBlock (an item may hold an intended second line). */
/** @param {string} src @param {string[]} lines */
export const fenceBlock = (src, lines) => fenceLines(src, lines).split('\n');
/** Lines for a capped list, one output line each: the fence (opener, body lines, closing tag) around the first `max` items, then
 * `... N more <what>` OUTSIDE the fence when some were left out. */
/** @template T @param {string} src @param {T[]} items @param {number} max @param {(item: T) => string} line @param {string} what */
export function fencedList(src, items, max, line, what) {
  if (!items.length) return [];
  const out = fenceBlock(src, items.slice(0, max).map(line));
  if (items.length > max) out.push(`... ${items.length - max} more ${what}`);
  return out;
}

// ---------- exact follow-up commands (the `next` array of the --json envelope) ----------
// A data value (a key, an owner, a kind) is used only when it is shell-safe as is: bare letters, digits and `:._/-`, or a short name
// with single spaces, which is double-quoted. Anything else drops the whole command (no escaping games with untrusted text).
const BARE = /^[A-Za-z0-9][A-Za-z0-9:._\/-]{0,119}$/, SPACED = /^[A-Za-z0-9][A-Za-z0-9._-]*(?: [A-Za-z0-9._-]+){1,5}$/;
export const shellArg = (/** @type {unknown} */ s) => { const t = typeof s === 'string' || typeof s === 'number' ? String(s) : ''; return BARE.test(t) ? t : t.length <= 60 && SPACED.test(t) ? `"${t}"` : null; };
/** `brain <words>`: a plain string word is our own literal; a word given as [value] is data and must pass shellArg. null when unsafe. */
/** @param {Array<string | unknown[]>} words */
export function nextCommand(words) {
  const out = [];
  for (const x of words) { const a = Array.isArray(x) ? shellArg(x[0]) : x; if (a === null) return null; out.push(a); }
  return `brain ${out.join(' ')}`;
}
/** A string our own library composed (a rule detail, a fix) for --json data: one sanitized line, capped, `<untrusted` neutralized,
 * other characters (such as `<=`) kept. Names that came straight from data use oneLine instead. */
export const dataText = (/** @type {unknown} */ s, max = 200) => errText(String(s ?? ''), max);
/** The first `max` distinct non-null commands. */
export const nextList = (/** @type {Array<string | null | undefined>} */ cmds, max = 3) => [...new Set(/** @type {string[]} */ (cmds.filter(Boolean)))].slice(0, max);

/** No brain directory: exit 2 with `try: brain init` (src/errors.mjs NO_BRAIN). Throws when ctx.dir is not a directory. */
/** @param {Ctx} ctx */
export function needBrain(ctx) {
  let ok = false; try { ok = fs.statSync(ctx.dir).isDirectory(); } catch { /* missing */ }
  if (!ok) throw new BrainError('NO_BRAIN', NO_BRAIN_MESSAGE);
}
// The repo's own CLAUDE.md files (root and .claude/): read only (brain never writes them), through readCapped (regular file, 1 MiB), and
// only when the real path stays inside the repository (a symlink leaving it, a directory, an oversized or unreadable file are skipped).
// Nothing from the text is printed: the result is two booleans. A file swapped between the realpath check and the open could be read once.
/** @param {Ctx} ctx @returns {{ exists: boolean, steered: boolean }} */
export function claudeSteer(ctx) {
  let exists = false, steered = false;
  for (const f of [path.join(ctx.root, 'CLAUDE.md'), path.join(ctx.root, '.claude', 'CLAUDE.md')]) {
    let text; try { assertInside(ctx.root, f); text = readCapped(f, 1024 * 1024); } catch { continue; }
    exists = true; if (hasSteer(text, rel(ctx, ctx.dir))) steered = true;
  }
  return { exists, steered };
}
/** A usage or data error with a long-standing message and no hint (the message already says what to do). */
export const usage = (/** @type {string} */ message) => new BrainError('USAGE', message);
/** @type {(message: string, hint?: string) => BrainError} */
export const dataError = (message, hint) => new BrainError('DATA', message, hint ? { hint } : {});

/** Newest mtime (ms) of the source files in dir, 0 when none exists. */
/** @param {string} dir @param {readonly string[]} [files] */
export function sourceMtime(dir, files = SRC_FILES) {
  let m = 0;
  for (const f of files) { try { m = Math.max(m, fs.statSync(path.join(dir, f)).mtimeMs); } catch { /* absent */ } }
  return m;
}

/** A small JSON input file named by the user (schedule.json, issue JSON): capped read, short fixed messages that never echo content. */
/** @param {string} file @param {string} what @param {number} [max] @returns {any} */
export function readJsonInput(file, what, max = MAX_DATA) {
  const shown = oneLine(path.basename(String(file)), 80);
  let text;
  try { text = readCapped(file, max); }
  catch (/** @type {any} */ e) {
    if (e.code === 'TOO_LARGE') throw dataError(`${what} ${shown} is too large`);
    if (e.code === 'NOT_A_FILE') throw dataError(`${what} ${shown} is not a regular file`);
    throw dataError(`cannot read ${what} ${shown}`, 'check the path');
  }
  try { return JSON.parse(text.replace(/^﻿/, '')); } catch { throw dataError(`${what} ${shown} is not valid JSON`); }
}

/** The query model read from the index, so schedule-load and whatif --write changes are respected. */
/** @param {Ctx} ctx */
export function modelFromDb(ctx) {
  const d = ctx.db();
  return buildModel({ tickets: d.all('SELECT * FROM ticket'), edges: d.all('SELECT * FROM edge'), schedule: d.all('SELECT * FROM schedule'), config: ctx.config(), findings: d.all('SELECT * FROM finding'), evidence: d.all('SELECT * FROM evidence'), learnings: d.all('SELECT * FROM learning') });
}

/** open-items.jsonl (capped read; absent -> no items). */
/** @param {Ctx} ctx */
export async function readItems(ctx) {
  const OI = await import('../../lib/openitems.mjs');
  const f = path.join(ctx.dir, 'open-items.jsonl');
  return { OI, items: presentDataFile(f) ? OI.parseItems(readDataCapped(f, MAX_DATA)) : [] }; // a symlink is refused, as in build (also one swapped in)
}

/** A Jira snapshot file: .jsonl (current format) or the legacy JSON map. */
/** @param {string} file */
export async function loadJiraSnap(file) {
  const J = await import('../../lib/jira.mjs');
  if (/\.jsonl$/.test(file)) {
    let text;
    try { text = readCapped(file, MAX_DATA); } catch { throw dataError(`cannot read the Jira snapshot ${oneLine(path.basename(file), 80)}`, 'check the --jira path'); }
    return J.toLegacyMap(J.parseSnapshotJsonl(text));
  }
  return readJsonInput(file, 'Jira snapshot');
}

/** A library error with a fixed vocabulary (JiraError) becomes a typed BrainError: credentials, config and network are ENV (3),
 * bad input data is DATA (2). Anything else is rethrown unchanged. */
const JIRA_DATA = new Set(['bad_input', 'bad_snapshot', 'bad_key', 'bad_json', 'bad_jql', 'unbounded_jql', 'bad_fields', 'too_large']);
/** @param {any} e @returns {never} */
export function jiraErrors(e) {
  if (e instanceof Error && e.name === 'JiraError') throw new BrainError(JIRA_DATA.has(/** @type {any} */ (e).code) ? 'DATA' : 'ENV', e.message, { cause: e });
  throw e;
}

/** Install the merge driver through the stable shim in the data dir (see lib/driver.mjs for the trust model). The target is the
 * brain-merge next to bin/brain, so a plugin update that moves the install is repaired by the next run. Throws on failure. */
/** @param {Ctx} ctx */
export async function wireMergeDriver(ctx) {
  const [S, D] = await Promise.all([import('../../lib/store.mjs'), import('../../lib/driver.mjs')]);
  const shim = D.ensureStableDriver({ dataDir: D.defaultDataDir(ctx.env), target: path.join(BIN, 'brain-merge'), nodePath: process.execPath });
  return S.installMergeDriver(ctx.root, { dir: rel(ctx, ctx.dir), driverPath: shim });
}

// ---------- confined state writes ----------
/** A refused write target (symlink, outside the repository) is a REFUSED error (exit 4); anything else is rethrown. */
/** @param {any} e @returns {never} */
export function refuseWrite(e) {
  if (e?.code === 'SYMLINK' || e?.code === 'OUTSIDE_REPO') throw new BrainError('REFUSED', `refusing to write: ${oneLine(e.message, 200)} (nothing was written)`, { cause: e });
  throw e;
}
/** Check every target before the first write, so a refusable one (symlink, directory, outside the repository) fails with nothing written. */
/** @param {Ctx} ctx @param {string[]} files */
export function precheckTargets(ctx, files) {
  for (const f of files) {
    let st = null;
    try { st = fs.lstatSync(f); } catch (/** @type {any} */ e) { if (e.code !== 'ENOENT') throw e; }
    if (st && !st.isFile()) throw new BrainError('REFUSED', `refusing to write ${oneLine(path.basename(f), 80)}: ${st.isSymbolicLink() ? 'it is a symlink' : 'not a regular file'} (nothing was written)`);
    try { assertInside(ctx.root, f); } catch (e) { refuseWrite(e); }
  }
}
/** Atomic write (temp file, fsync, rename) confined to the repository; symlink targets refused. */
/** @param {Ctx} ctx @param {string} file @param {string} text */
export function writeState(ctx, file, text) {
  try { writeAtomicSafe(file, text, { root: ctx.root }); } catch (e) { refuseWrite(e); }
}
