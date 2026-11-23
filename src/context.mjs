// Context: the capabilities a command gets, instead of globals. Built once per run by the shell (src/cli.mjs or a test).
// Directory precedence matches bin/brain: --dir, else env BRAIN_DIR (when non-empty), else {"dir": "..."} in <root>/.brainrc, else .brain.
// Unlike bin/brain, the directory is confined to the repository (lib/fsafe.mjs resolveBrainDir): absolute or escaping dirs are REFUSED.
import fs from 'node:fs';
import path from 'node:path';
import { makeGit } from '../lib/gitsafe.mjs';
import { readCapped, readStreamCapped } from '../lib/jsonl.mjs';
import { resolveBrainDir } from '../lib/fsafe.mjs';
import { sourceNow } from '../lib/clock.mjs';
import { BrainError } from './errors.mjs';
import { openIndex, INDEX_FILE } from './db.mjs';

// IO: out(line) takes exactly ONE line (src/cli.mjs makeCollector: a line break is a programmer error); outBlock(lines) is the explicit
// multi-line form (an array of single lines, such as a fence block); raw(text) is prepared text printed as is (card, bundle).
/** @typedef {{ out(line: string): void, outBlock?(lines: string[]): void, err(line: string): void, raw?(text: string): void, data?(d: unknown, opts?: { next?: string[] }): void }} IO */
/** @typedef {{ readonly isTTY: boolean, read(max: number): string }} Stdin */
/** @typedef {{ values: Record<string, any>, positionals: string[] }} Args */
/** @typedef {{ root: string, dir: string, cwd: string, config(): Record<string, any>, env: Record<string, string|undefined>,
 *   io: IO & { raw(text: string): void, outBlock(lines: string[]): void }, git(...args: string[]): string, now(): Date, stdin: Stdin,
 *   db(): import('./db.mjs').IndexHandle, fresh(): { fp: string, built: string|null } | null, flags: Record<string, unknown>, [Symbol.dispose](): void }} Context */
/** @typedef {{ cwd?: string, env?: Record<string, string|undefined>, flags?: Record<string, unknown>, io?: IO, now?: () => Date, root?: string,
 *   git?: (root: string) => (...args: string[]) => string, stdin?: Stdin }} ContextOptions */

const RC_MAX = 64 * 1024, CONFIG_MAX = 1024 * 1024;

// Small JSON object file: capped, regular files only; missing -> undefined. Messages are fixed and never echo the content.
/** @param {string} file @param {string} label @param {number} max @returns {Record<string, any> | undefined} */
function readJsonObject(file, label, max) {
  let text;
  try { text = readCapped(file, max); }
  catch (/** @type {any} */ e) {
    if (e.code === 'ENOENT') return undefined;
    if (e.code === 'TOO_LARGE' || e.code === 'NOT_A_FILE') throw new BrainError('DATA', `${label}: ${e.message}`, { cause: e });
    throw e;
  }
  let v;
  try { v = JSON.parse(text.replace(/^﻿/, '')); } catch (e) { throw new BrainError('DATA', `${label}: not valid JSON`, { cause: e }); }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new BrainError('DATA', `${label}: must be a JSON object`);
  return v;
}

// The repository root: the nearest ancestor of cwd holding a `.git` entry (a directory, or the file of a linked worktree or submodule),
// as its real path, which is what `git rev-parse --show-toplevel` answers in those layouts, without starting a process (about 12 ms).
// With GIT_DIR or GIT_WORK_TREE set the layout is the environment's, so git itself is asked. No repository: cwd.
/** @param {string} cwd @param {(root: string) => (...args: string[]) => string} gitFactory @param {Record<string, string | undefined>} env */
function findRoot(cwd, gitFactory, env) {
  if (env.GIT_DIR || env.GIT_WORK_TREE) {
    try { return gitFactory(cwd)('rev-parse', '--show-toplevel').trim() || cwd; } catch { return cwd; }
  }
  for (let d = path.resolve(cwd); ; d = path.dirname(d)) {
    try { fs.lstatSync(path.join(d, '.git')); return fs.realpathSync.native(d); } catch { /* not here */ }
    if (path.dirname(d) === d) return cwd;
  }
}

/** @param {string} root @param {Record<string, unknown>} flags @param {Record<string, string | undefined>} env */
function brainDir(root, flags, env) {
  let dir = typeof flags.dir === 'string' ? flags.dir : env.BRAIN_DIR || undefined;
  if (dir === undefined) {
    const rc = readJsonObject(path.join(root, '.brainrc'), '.brainrc', RC_MAX);
    if (rc && Object.hasOwn(rc, 'dir')) {
      if (typeof rc.dir !== 'string' || !rc.dir) throw new BrainError('DATA', '.brainrc: "dir" must be a non-empty string');
      dir = rc.dir;
    }
  }
  try { return resolveBrainDir(root, dir ?? '.brain'); }
  catch (/** @type {any} */ e) {
    if (e.code === 'OUTSIDE_REPO') throw new BrainError('REFUSED', 'brain directory is outside the repository', { hint: 'use a relative --dir inside the repository', cause: e });
    if (e.code === 'BAD_DIR_NAME') throw new BrainError('REFUSED', e.message, { hint: 'use a plain relative --dir such as .brain', cause: e });
    throw e;
  }
}

// The single staleness policy of every index-reading command (ctx.db()): an index whose source fingerprint no longer matches the
// text is still answered from, and this one warning goes to stderr, unless the global --if-present is set (the session-start hook
// must stay silent). The handle is query-only in that case.
export const STALE_WARNING = 'STALE: the text files changed since the index was built; run `brain build`';

// An IO given without outBlock (a test sink) gets one that prints each line through out().
const withBlock = (/** @type {IO | undefined} */ io) => (io && !io.outBlock ? { ...io, outBlock: (/** @type {string[]} */ ls) => { for (const l of ls) io.out(l); } } : io);

const processStdin = () => ({
  get isTTY() { return Boolean(process.stdin.isTTY); },
  read: (/** @type {number} */ max) => readStreamCapped(0, max),
});

/** @param {ContextOptions} opts @returns {Context} */
export function makeContext({ cwd = process.cwd(), env = process.env, flags = {}, io, now = () => sourceNow(env), root, git = makeGit, stdin = processStdin() } = {}) {
  root ??= findRoot(cwd, git, env);
  const dir = brainDir(root, flags, env);
  const run = git(root);
  let /** @type {Record<string, any> | undefined} */ cfg, /** @type {import('./db.mjs').IndexHandle | undefined} */ handle;
  const warnStale = (/** @type {import('./db.mjs').IndexHandle} */ h) => { if (h.stale && !flags['if-present']) /** @type {IO} */ (io).err(STALE_WARNING); return h; };
  return Object.freeze({
    root, dir, cwd, env, flags, io: /** @type {Context['io']} */ (withBlock(io)), now, stdin,
    git: (...args) => run(...args), // execFile argv, no shell; callers check refs and paths with lib/gitsafe.mjs
    config: () => (cfg ??= readJsonObject(path.join(dir, 'config.json'), 'config.json', CONFIG_MAX) ?? {}),
    db: () => (handle ??= warnStale(openIndex(path.join(dir, INDEX_FILE), { readOnly: true, dir }))),
    // The `fresh` object of the --json envelope: first 8 hex of the fingerprint of the text now (fp) and of the text the index was
    // built from (built; null for an index without one). null when this run opened no index.
    fresh: () => (handle?.fingerprint ? { fp: handle.fingerprint.slice(0, 8), built: handle.builtFingerprint ? String(handle.builtFingerprint).slice(0, 8) : null } : null),
    [Symbol.dispose]() { handle?.close(); },
  });
}
