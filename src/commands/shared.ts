// Helpers shared by the command groups in src/commands/. Commands take (ctx, args), print through ctx.io, return an exit code.
// Heavy library modules are imported on first use inside the command, so a command never pays for modules it does not need.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readCapped, readDataCapped, presentDataFile } from '../../lib/jsonl.ts';
import { oneLine, fence } from '../../lib/sanitize.ts';
import { buildModel } from '../../lib/model.ts';
import { assertInside, writeAtomicSafe } from '../../lib/fsafe.ts';
import { PlangraphError, errText } from '../errors.ts';
import { INDEX_FILE, NO_PLANGRAPH_MESSAGE } from '../db.ts';
import { hasSteer } from '../../lib/steer.ts';
import type { Ctx, Args } from '../context.ts';
import type { Model, Ticket, Edge, ScheduleRow, PlanRecord } from '../../lib/model.ts';
import { parseSnapshotJsonl, toLegacyMap } from '../../lib/tracker.ts';
import type { LegacyIssue } from '../../lib/tracker.ts';
import type { CapacityRow } from '../../lib/graph/files.ts';
import type { OpenItem } from '../../lib/openitems.ts';
/** A Map that the code reads only with keys it holds (built from the same key list, or checked with has() first): get() is never undefined. */
export type Dense<K, V> = Omit<Map<K, V>, 'get'> & { get(key: K): V };

export { capOf } from '../../lib/model.ts';
export const BIN = path.join(import.meta.dirname, '../../bin');
export const SEED = path.join(import.meta.dirname, '../../seed/learnings.seed.jsonl');
export const CUR = "version='current'";
export const KEY_RE = /^[A-Z][A-Z0-9]*-\d+$/;
export const MAX_DATA = 64 * 1024 * 1024;
// Every file the index and the open-items list are derived from (the card's freshness line and `card --line` use the same list).
export const SRC_FILES = Object.freeze(['tickets', 'edges', 'schedule', 'evidence', 'findings', 'meta', 'learnings', 'refs', 'open-items'].map((n) => `${n}.jsonl`));
/** The seven graph files (the same list as GRAPH_FILES in lib/graph/files.ts, which a test pins; a literal here keeps that module off the start-up path).
 * Kept apart from SRC_FILES: a graph file adds to the card digest only when it is present, so a directory without one keeps its 0.3.0 digest. */
export const GRAPH_SRC_FILES = Object.freeze(['people', 'sprints', 'epics', 'repos', 'capacity', 'links', 'xrefs'].map((n) => `${n}.jsonl`));

export const dbFile = (ctx: Ctx): string => path.join(ctx.dir, INDEX_FILE);
export const rel = (ctx: Ctx, p: string): string => path.relative(ctx.root, p) || '.';
export const verbose = (args: Args): boolean => Boolean(args.values.verbose);
export const isPlaced = (s: { owner?: unknown; sprint?: unknown } | null | undefined): s is { owner: string; sprint: number } => !!s && typeof s.owner === 'string' && s.owner !== '' && Number.isInteger(s.sprint);

/** One fence around already-prepared lines of untrusted text (each line should come from oneLine, so no record spans two lines and no
 * tag can be forged). The nonce is derived from the body, as in lib/integrations/openwolf.ts, so the same input gives the same bytes and
 * no entry can predict its own fence. The body is never cut here: callers bound the number and length of lines first. */
export function fenceLines(src: string, lines: string[]): string {
  const body = lines.join('\n');
  return fence(src, body, { src, nonce: crypto.createHash('sha256').update(body).digest('hex').slice(0, 8), max: body.length + 16 });
}
/** The same fence as fenceLines, as an array of single lines for ctx.io.outBlock (an item may hold an intended second line). */
export const fenceBlock = (src: string, lines: string[]): string[] => fenceLines(src, lines).split('\n');
/** Lines for a capped list, one output line each: the fence (opener, body lines, closing tag) around the first `max` items, then
 * `... N more <what>` OUTSIDE the fence when some were left out. */
export function fencedList<T>(src: string, items: T[], max: number, line: (item: T) => string, what: string): string[] {
  if (!items.length) return [];
  const out = fenceBlock(src, items.slice(0, max).map(line));
  if (items.length > max) out.push(`... ${items.length - max} more ${what}`);
  return out;
}

// ---------- exact follow-up commands (the `next` array of the --json envelope) ----------
// A data value (a key, an owner, a kind) is used only when it is shell-safe as is: bare letters, digits and `:._/-`, or a short name
// with single spaces, which is double-quoted. Anything else drops the whole command (no escaping games with untrusted text).
const BARE = /^[A-Za-z0-9][A-Za-z0-9:._\/-]{0,119}$/, SPACED = /^[A-Za-z0-9][A-Za-z0-9._-]*(?: [A-Za-z0-9._-]+){1,5}$/;
export const shellArg = (s: unknown): string | null => { const t = typeof s === 'string' || typeof s === 'number' ? String(s) : ''; return BARE.test(t) ? t : t.length <= 60 && SPACED.test(t) ? `"${t}"` : null; };
/** `plangraph <words>`: a plain string word is our own literal; a word given as [value] is data and must pass shellArg. null when unsafe. */
export function nextCommand(words: Array<string | unknown[]>): string | null {
  const out: string[] = [];
  for (const x of words) { const a = Array.isArray(x) ? shellArg(x[0]) : x; if (a === null) return null; out.push(a); }
  return `plangraph ${out.join(' ')}`;
}
/** A string our own library composed (a rule detail, a fix) for --json data: one sanitized line, capped, `<untrusted` neutralized,
 * other characters (such as `<=`) kept. Names that came straight from data use oneLine instead. */
export const dataText = (s: unknown, max = 200): string => errText(String(s ?? ''), max);
/** The first `max` distinct non-null commands. */
export const nextList = (cmds: Array<string | null | undefined>, max = 3): string[] => [...new Set((cmds.filter(Boolean) as string[]))].slice(0, max); // filter(Boolean) dropped null and undefined

/** No plan directory: exit 2 with `try: plangraph init` (src/errors.ts NO_PLANGRAPH). Throws when ctx.dir is not a directory. */
export function needBrain(ctx: Ctx): void {
  let ok = false; try { ok = fs.statSync(ctx.dir).isDirectory(); } catch { /* missing */ }
  if (!ok) throw new PlangraphError('NO_PLANGRAPH', NO_PLANGRAPH_MESSAGE);
}
// The repo's own CLAUDE.md files (root and .claude/): read only (plangraph never writes them), through readCapped (regular file, 1 MiB), and
// only when the real path stays inside the repository (a symlink leaving it, a directory, an oversized or unreadable file are skipped).
// Nothing from the text is printed: the result is two booleans. A file swapped between the realpath check and the open could be read once.
export function claudeSteer(ctx: Ctx): { exists: boolean; steered: boolean } {
  let exists = false, steered = false;
  for (const f of [path.join(ctx.root, 'CLAUDE.md'), path.join(ctx.root, '.claude', 'CLAUDE.md')]) {
    let text: string; try { assertInside(ctx.root, f); text = readCapped(f, 1024 * 1024); } catch { continue; }
    exists = true; if (hasSteer(text, rel(ctx, ctx.dir))) steered = true;
  }
  return { exists, steered };
}
/** A usage or data error with a long-standing message and no hint (the message already says what to do). */
export const usage = (message: string): PlangraphError => new PlangraphError('USAGE', message);
export const dataError = (message: string, hint?: string): PlangraphError => new PlangraphError('DATA', message, hint ? { hint } : {});

/** A small JSON input file named by the user (schedule.json, issue JSON): capped read, short fixed messages that never echo content. */
export function readJsonInput(file: string, what: string, max: number = MAX_DATA): unknown {
  const shown = oneLine(path.basename(String(file)), 80);
  let text: string;
  try { text = readCapped(file, max); }
  catch (e) { // readCapped's coded refusals
    if ((e as NodeJS.ErrnoException).code === 'TOO_LARGE') throw dataError(`${what} ${shown} is too large`); // fs and the readers throw errno-style errors with a code
    if ((e as NodeJS.ErrnoException).code === 'NOT_A_FILE') throw dataError(`${what} ${shown} is not a regular file`); // fs and the readers throw errno-style errors with a code
    throw dataError(`cannot read ${what} ${shown}`, 'check the path');
  }
  try { return JSON.parse(text.replace(/^﻿/, '')); } catch { throw dataError(`${what} ${shown} is not valid JSON`); }
}

/** The query model read from the index, so schedule-load and whatif --write changes are respected. */
export function modelFromDb(ctx: Ctx): Model {
  const d = ctx.db();
  return buildModel({ tickets: d.all('SELECT * FROM ticket') as Ticket[], edges: d.all('SELECT * FROM edge') as Edge[], schedule: d.all('SELECT * FROM schedule') as ScheduleRow[], config: ctx.config(), findings: d.all('SELECT * FROM finding') as PlanRecord[], evidence: d.all('SELECT * FROM evidence') as PlanRecord[], learnings: d.all('SELECT * FROM learning') as PlanRecord[], capacity: d.older ? [] : d.all('SELECT person, sprint, sp FROM capacity') as CapacityRow[] }); // an index built by 0.3.0 has no capacity table (it opens stale and answers v1 questions) // index rows: the records build wrote, one column each
}

/** open-items.jsonl (capped read; absent -> no items). */
export async function readItems(ctx: Ctx) {
  const OI = await import('../../lib/openitems.ts');
  const f = path.join(ctx.dir, 'open-items.jsonl');
  return { OI, items: presentDataFile(f) ? OI.parseItems(readDataCapped(f, MAX_DATA)) as OpenItem[] : [] }; // a symlink is refused, as in build (also one swapped in); the open-items.jsonl validator makes key and kind strings, owner a string or absent and status a non-empty string; the other OpenItem fields are unchecked (pre-existing)
}

/** A Jira snapshot file: .jsonl (current format) or the legacy JSON map. */
export async function loadJiraSnap(file: string): Promise<Record<string, LegacyIssue>> {
  if (/\.jsonl$/.test(file)) {
    let text: string;
    try { text = readCapped(file, MAX_DATA); } catch { throw dataError(`cannot read the Jira snapshot ${oneLine(path.basename(file), 80)}`, 'check the --jira path'); }
    return toLegacyMap(parseSnapshotJsonl(text));
  }
  return readJsonInput(file, 'Jira snapshot') as Record<string, LegacyIssue>; // the legacy JSON map: unchecked (pre-existing), as bin/plangraph read it
}

/** A library error with a fixed vocabulary (JiraError) becomes a typed PlangraphError: credentials, config and network are ENV (3),
 * bad input data is DATA (2). Anything else is rethrown unchanged. */
const JIRA_DATA = new Set(['bad_input', 'bad_snapshot', 'bad_key', 'bad_json', 'bad_jql', 'unbounded_jql', 'bad_fields', 'too_large']);
export function jiraErrors(e: unknown): never {
  if (e instanceof Error && e.name === 'JiraError') throw new PlangraphError(JIRA_DATA.has((e as Error & { code: string }).code) ? 'DATA' : 'ENV', e.message, { cause: e }); // a JiraError has a code
  throw e;
}

/** Install the merge driver through the stable shim in the data dir (see lib/driver.ts for the trust model). The target is the
 * plangraph-merge next to bin/plangraph, so a plugin update that moves the install is repaired by the next run. Throws on failure.
 * consent (init and doctor --fix, commands the user runs): after a successful wiring, record plangraph.heal (recordHealConsent). */
export async function wireMergeDriver(ctx: Ctx, opts: { consent?: boolean } = {}) {
  const [S, D] = await Promise.all([import('../../lib/store.ts'), import('../../lib/driver.ts')]);
  const shim = D.ensureStableDriver({ dataDir: D.defaultDataDir(ctx.env), target: path.join(BIN, 'plangraph-merge'), nodePath: process.execPath });
  const r = S.installMergeDriver(ctx.root, { dir: rel(ctx, ctx.dir), driverPath: shim });
  if (opts.consent) await recordHealConsent(ctx);
  return r;
}
/** The running plugin's version (package.json next to bin/), the value recorded as heal consent. */
export function pluginVersion(): string {
  const v = (JSON.parse(readCapped(path.join(BIN, '..', 'package.json'), 1024 * 1024)) as { version?: unknown }).version; // our own package.json
  if (typeof v !== 'string' || !/^\d+\.\d+\.\d+/.test(v)) throw new TypeError('package.json has no version');
  return v;
}
/** Record the user's consent to heal (plangraph.heal = the plugin version) in the clone's local git config, unless a version is already
 * there. Only for commands the user runs (init, doctor --fix), never from the session hook except for a grandfathered clone. Throws on failure. */
export async function recordHealConsent(ctx: Ctx): Promise<void> {
  const D = await import('../../lib/driver.ts'), common = D.gitCommonDir(ctx.root);
  if (common && !D.hasConsent(common)) D.recordConsent(common, pluginVersion());
}

// ---------- confined state writes ----------
/** A refused write target (symlink, outside the repository) is a REFUSED error (exit 4); anything else is rethrown. */
export function refuseWrite(e: unknown): never {
  if ((e as NodeJS.ErrnoException | undefined)?.code === 'SYMLINK' || (e as NodeJS.ErrnoException | undefined)?.code === 'OUTSIDE_REPO') throw new PlangraphError('REFUSED', `refusing to write: ${oneLine((e as Error).message, 200)} (nothing was written)`, { cause: e }); // lib/fsafe.ts throws coded Errors
  throw e;
}
/** Check every target before the first write, so a refusable one (symlink, directory, outside the repository) fails with nothing written. */
export function precheckTargets(ctx: Ctx, files: string[]): void {
  for (const f of files) {
    let st = null;
    try { st = fs.lstatSync(f); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } // fs throws errno errors
    if (st && !st.isFile()) throw new PlangraphError('REFUSED', `refusing to write ${oneLine(path.basename(f), 80)}: ${st.isSymbolicLink() ? 'it is a symlink' : 'not a regular file'} (nothing was written)`);
    try { assertInside(ctx.root, f); } catch (e) { refuseWrite(e); }
  }
}
/** Atomic write (temp file, fsync, rename) confined to the repository; symlink targets refused. */
export function writeState(ctx: Ctx, file: string, text: string): void {
  try { writeAtomicSafe(file, text, { root: ctx.root }); } catch (e) { refuseWrite(e); }
}
