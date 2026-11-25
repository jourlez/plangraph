// Context: the capabilities a command gets, instead of globals. Built once per run by the shell (src/cli.ts or a test).
// Directory precedence matches bin/brain: --dir, else env PLANGRAPH_DIR (when non-empty), else {"dir": "..."} in <root>/.brainrc, else .brain.
// Unlike bin/brain, the directory is confined to the repository (lib/fsafe.ts resolveBrainDir): absolute or escaping dirs are REFUSED.
import fs from 'node:fs';
import path from 'node:path';
import { makeGit } from '../lib/gitsafe.ts';
import { readCapped, readStreamCapped } from '../lib/jsonl.ts';
import { resolveBrainDir } from '../lib/fsafe.ts';
import { readConfig } from '../lib/model.ts';
import { sourceNow } from '../lib/clock.ts';
import { BrainError } from './errors.ts';
import { openIndex, INDEX_FILE } from './db.ts';
import type { IndexHandle } from './db.ts';
import type { PlanConfig } from '../lib/model.ts';

// IO: out(line) takes exactly ONE line (src/cli.ts makeCollector: a line break is a programmer error); outBlock(lines) is the explicit
// multi-line form (an array of single lines, such as a fence block); raw(text) is prepared text printed as is (card, bundle).
export interface IO { out(line: string): void; outBlock?(lines: string[]): void; err(line: string): void; raw?(text: string): void; data?(d: unknown, opts?: { next?: string[] }): void }
export interface Stdin { readonly isTTY: boolean; read(max: number): string }
/** The parsed command line of one command. `values` holds what src/args.ts parse() produced for the command's option spec (string, boolean,
 * number, or an array of them for a `multiple` option); a handler names the options it reads in V. */
export interface Args<V extends object = Record<string, unknown>> { values: V; positionals: string[] }
type GitRun = (...args: string[]) => string;
/** The capabilities a command gets (built by makeContext): exactly the members the commands use. */
export interface Ctx {
  root: string; dir: string; cwd?: string; config(): PlanConfig; env: Record<string, string | undefined>;
  io: IO & { raw(text: string): void; outBlock(lines: string[]): void }; git: GitRun; now(): Date; stdin: Stdin;
  db(): IndexHandle; flags: Record<string, unknown>;
}
/** What the shell (src/cli.ts) may also use of a context: the --json `fresh` object and disposal; a test double may omit both. */
export type ShellCtx = Ctx & { fresh?(): { fp: string; built: string | null } | null; [Symbol.dispose]?(): void };
export interface ContextOptions { cwd?: string; env?: Record<string, string | undefined>; flags?: Record<string, unknown>; io?: IO; now?: () => Date; root?: string;
  git?: (root: string) => GitRun; stdin?: Stdin }

const RC_MAX = 64 * 1024;

// Small JSON object file: capped, regular files only; missing -> undefined. Messages are fixed and never echo the content.
function readJsonObject(file: string, label: string, max: number): Record<string, unknown> | undefined {
  let text: string;
  try { text = readCapped(file, max); }
  catch (e) { // readCapped throws an Error with a code (an fs errno or its own refusal)
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; // fs and the readers throw errno-style errors with a code
    if ((e as NodeJS.ErrnoException).code === 'TOO_LARGE' || (e as NodeJS.ErrnoException).code === 'NOT_A_FILE') throw new BrainError('DATA', `${label}: ${(e as Error).message}`, { cause: e }); // fs and the readers throw errno-style errors with a code
    throw e;
  }
  let v: unknown;
  try { v = JSON.parse(text.replace(/^﻿/, '')); } catch (e) { throw new BrainError('DATA', `${label}: not valid JSON`, { cause: e }); }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new BrainError('DATA', `${label}: must be a JSON object`);
  return v as Record<string, unknown>; // a non-null, non-array object: checked on the line above
}

// config.json through the one reader of lib/model.ts (64 KiB, regular file, no symlink, JSON object); its IngestError becomes a DATA error
// (exit 2) with the same fixed base-name message, so every command refuses a bad config the same way.
function configOf(dir: string): PlanConfig {
  try { return readConfig(path.join(dir, 'config.json')); }
  catch (e) { if ((e as Error | undefined)?.name === 'IngestError') throw new BrainError('DATA', (e as Error).message, { cause: e }); throw e; } // whatever was thrown: an IngestError is an Error
}

// The repository root: the nearest ancestor of cwd holding a `.git` entry (a directory, or the file of a linked worktree or submodule),
// as its real path, which is what `git rev-parse --show-toplevel` answers in those layouts, without starting a process (about 12 ms).
// With GIT_DIR or GIT_WORK_TREE set the layout is the environment's, so git itself is asked. No repository: cwd.
function findRoot(cwd: string, gitFactory: (root: string) => GitRun, env: Record<string, string | undefined>): string {
  if (env.GIT_DIR || env.GIT_WORK_TREE) {
    try { return gitFactory(cwd)('rev-parse', '--show-toplevel').trim() || cwd; } catch { return cwd; }
  }
  for (let d = path.resolve(cwd); ; d = path.dirname(d)) {
    try { fs.lstatSync(path.join(d, '.git')); return fs.realpathSync.native(d); } catch { /* not here */ }
    if (path.dirname(d) === d) return cwd;
  }
}

function brainDir(root: string, flags: Record<string, unknown>, env: Record<string, string | undefined>): string {
  let dir = typeof flags.dir === 'string' ? flags.dir : env.PLANGRAPH_DIR || undefined;
  if (dir === undefined) {
    const rc = readJsonObject(path.join(root, '.brainrc'), '.brainrc', RC_MAX);
    if (rc && Object.hasOwn(rc, 'dir')) {
      if (typeof rc.dir !== 'string' || !rc.dir) throw new BrainError('DATA', '.brainrc: "dir" must be a non-empty string');
      dir = rc.dir;
    }
  }
  try { return resolveBrainDir(root, dir ?? '.brain'); }
  catch (e) { // lib/fsafe.ts throws an Error with a code
    if ((e as NodeJS.ErrnoException).code === 'OUTSIDE_REPO') throw new BrainError('REFUSED', 'brain directory is outside the repository', { hint: 'use a relative --dir inside the repository', cause: e }); // fs and the readers throw errno-style errors with a code
    if ((e as NodeJS.ErrnoException).code === 'BAD_DIR_NAME') throw new BrainError('REFUSED', (e as Error).message, { hint: 'use a plain relative --dir such as .brain', cause: e }); // fs and the readers throw errno-style errors with a code
    throw e;
  }
}

// The single staleness policy of every index-reading command (ctx.db()): an index whose source fingerprint no longer matches the
// text is still answered from, and this one warning goes to stderr, unless the global --if-present is set (the session-start hook
// must stay silent). The handle is query-only in that case.
export const STALE_WARNING = 'STALE: the text files changed since the index was built; run `brain build`';

// An IO given without outBlock (a test sink) gets one that prints each line through out().
const withBlock = (io: IO | undefined) => (io && !io.outBlock ? { ...io, outBlock: (ls: string[]) => { for (const l of ls) io.out(l); } } : io);

const processStdin = (): Stdin => ({
  get isTTY() { return Boolean(process.stdin.isTTY); },
  read: (max: number) => readStreamCapped(0, max),
});

export function makeContext({ cwd = process.cwd(), env = process.env, flags = {}, io, now = () => sourceNow(env), root, git = makeGit, stdin = processStdin() }: ContextOptions = {}): Ctx & { cwd: string; fresh(): { fp: string; built: string | null } | null; [Symbol.dispose](): void } {
  root ??= findRoot(cwd, git, env);
  const dir = brainDir(root, flags, env);
  const run = git(root);
  let cfg: PlanConfig | undefined, handle: IndexHandle | undefined;
  const warnStale = (h: IndexHandle) => { if (h.stale && !flags['if-present']) (io as IO).err(STALE_WARNING); return h; }; // a command that opens the index runs with an io
  return Object.freeze({
    root, dir, cwd, env, flags, io: (withBlock(io) as Ctx['io']), now, stdin, // the shell always passes an io with raw(); withBlock adds outBlock
    git: (...args: string[]) => run(...args), // execFile argv, no shell; callers check refs and paths with lib/gitsafe.ts
    config: () => (cfg ??= configOf(dir)),
    db: () => (handle ??= warnStale(openIndex(path.join(dir, INDEX_FILE), { readOnly: true, dir }))),
    // The `fresh` object of the --json envelope: first 8 hex of the fingerprint of the text now (fp) and of the text the index was
    // built from (built; null for an index without one). null when this run opened no index.
    fresh: () => (handle?.fingerprint ? { fp: handle.fingerprint.slice(0, 8), built: handle.builtFingerprint ? String(handle.builtFingerprint).slice(0, 8) : null } : null),
    [Symbol.dispose]() { handle?.close(); },
  });
}
