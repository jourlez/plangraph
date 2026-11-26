// Stable merge-driver shim. git config must point at a path that survives plugin updates (Claude Code deletes old versioned
// plugin-cache directories), so it points at a shim in a stable data directory that reads the CURRENT target at run time.
// No process.exit. Writes only under dataDir (or its ~/.cache fallback), except recordConsent (the clone's local git config, see the end). Prints only defaultDataDir's one fallback line (below).
// Trust model: the data directory is a code-execution trust root, because whoever can write driver.node, driver.target or
// bin/plangraph-merge runs code as the user at the next merge. ensureStableDriver therefore creates the data dir and bin/ 0700,
// and REFUSES (never silently chmods) an existing data dir or bin/ that is a symlink, is not owned by the current user, or is
// group/world writable. On win32 the ownership and mode checks are skipped (POSIX modes are not meaningful there; the shim
// itself is POSIX sh and is not supported on Windows). Only the final path components are checked, not their parents.
// Decision D19: Claude Code creates $CLAUDE_PLUGIN_DATA with the default directory mode, so 775 under umask 002. defaultDataDir
// therefore does not use a group- or world-writable CLAUDE_PLUGIN_DATA: it prints one stderr line and returns ~/.cache/plangraph
// (created 0700 and checked by ensureStableDriver like any data dir); the other directory is never changed (bin/plangraph-solve-run
// applies the same rule to its venv base).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeAtomicSafe } from './fsafe.ts';
import { makeGit } from './gitsafe.ts';

// git runs drivers via sh with the user's environment, where `node` may not be on PATH: the node binary is recorded too.
// Failure contract: whenever the real driver cannot run, print ONE stderr line and exit 2 (never 0, 126 or 127).
// File contents are only ever expanded inside double quotes, so a hostile path cannot inject shell syntax.
const SHIM = `#!/bin/sh
d="$(dirname "$0")/.."
u() { echo "plangraph: merge driver unavailable ($1): run 'plangraph doctor --fix'" >&2; exit 2; }
[ -s "$d/driver.target" ] || u "driver.target missing or empty"
[ -s "$d/driver.node" ] || u "driver.node missing or empty"
t=$(cat "$d/driver.target" 2>/dev/null) || u "driver.target unreadable"
n=$(cat "$d/driver.node" 2>/dev/null) || u "driver.node unreadable"
[ -n "$t" ] || u "driver.target empty"
[ -n "$n" ] || u "driver.node empty"
[ -r "$t" ] || u "target not readable"
[ -x "$n" ] || u "node not executable"
exec "$n" "$t" "$@"
`;

export function defaultDataDir(env: Record<string, string | undefined> = process.env, home: string = os.homedir(), warn: (line: string) => void = (l) => { process.stderr.write(`${l}\n`); }): string {
  const p = env.CLAUDE_PLUGIN_DATA, fallback = path.join(home, '.cache', 'plangraph');
  if (!p || !path.isAbsolute(p)) return fallback;
  if (p !== fallback && othersCanWrite(p)) { warn(`plangraph: CLAUDE_PLUGIN_DATA (${p}) is group or world writable; using ${fallback} instead`); return fallback; }
  return p;
}

// True for a real directory (not a symlink) with group or world write (decision D19). Anything else, including a missing path, is false:
// ensureStableDriver then creates it or refuses it with its reason.
function othersCanWrite(dir: string): boolean {
  if (process.platform === 'win32') return false;
  const st = fs.lstatSync(dir, { throwIfNoEntry: false });
  return !!st && st.isDirectory() && (st.mode & 0o022) !== 0;
}

// Atomic write of an executable: write a sibling temp via the safe writer, chmod it, then rename over the destination.
function writeExecutable(file: string, text: string): void {
  const tmp = `${file}.x-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try { writeAtomicSafe(tmp, text); fs.chmodSync(tmp, 0o755); fs.renameSync(tmp, file); }
  catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
}

// Refuse an existing directory that is not private. Returns false when it does not exist. Never chmods.
function checkPrivateDir(dir: string, label: string): boolean {
  let st: fs.Stats;
  try { st = fs.lstatSync(dir); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; } // whatever was thrown: read its code
  const bad = (why: string) => new TypeError(`data directory is not private: ${label} ${why}`);
  if (st.isSymbolicLink()) throw bad(`is a symlink (${dir})`);
  if (!st.isDirectory()) throw bad(`is not a directory (${dir})`);
  if (process.platform === 'win32') return true;
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw bad(`is not owned by the current user (${dir})`);
  if (st.mode & 0o022) throw bad(`is group or world writable, mode ${(st.mode & 0o777).toString(8)} (${dir})`);
  return true;
}

export function ensureStableDriver({ dataDir, target, nodePath = process.execPath }: { dataDir?: string; target?: string; nodePath?: string } = {}): string {
  const abs = (v: unknown): v is string => typeof v === 'string' && v !== '' && path.isAbsolute(v);
  if (!abs(dataDir)) throw new TypeError('dataDir must be an absolute path');
  if (!abs(target)) throw new TypeError('target must be an absolute path');
  if (!abs(nodePath)) throw new TypeError('nodePath must be an absolute path');
  let st: fs.Stats | undefined; try { st = fs.statSync(target); } catch { /* reported below */ }
  if (!st?.isFile()) throw new TypeError(`target must be an existing regular file: ${target}`);
  const bin = path.join(dataDir, 'bin');
  checkPrivateDir(dataDir, 'directory'); checkPrivateDir(bin, 'bin/');
  fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
  // mkdir -p may have created or walked into directories made after the first check: refuse again before anything is written
  if (!checkPrivateDir(dataDir, 'directory') || !checkPrivateDir(bin, 'bin/')) throw new TypeError(`data directory is not private: ${dataDir} could not be created`);
  const shim = path.join(bin, 'plangraph-merge');
  // node FIRST, target LAST: a merge running between the two writes sees a consistent old pair or (new node, old target),
  // which is benign (an older target still runs under a newer node binary). Each write is atomic.
  writeAtomicSafe(path.join(dataDir, 'driver.node'), nodePath + '\n');
  writeAtomicSafe(path.join(dataDir, 'driver.target'), target + '\n');
  writeExecutable(shim, SHIM);
  return shim;
}

// ---------- heal consent (decision D3) ----------
// The SessionStart hook repairs the merge driver only in a clone the user wired. Consent is the key plangraph.heal in the clone's own
// git config (the config file of the git common directory): it is the same file for the hook and for a terminal run, all worktrees of
// the clone share it, it cannot be committed, it moves with the clone, and a new clone at the same path does not inherit it. Only a
// version value counts (what recordConsent writes), so `false`, `off` or any other value never grants healing; `never` declines.
/** The git config key that records the user's consent to heal the merge driver at session start. */
export const CONSENT_KEY = 'plangraph.heal';
const CONSENT_VALUE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** The real path of the git common directory of the repository at cwd (shared by its worktrees); null outside a git repository. */
export function gitCommonDir(cwd: string): string | null {
  try {
    const out = makeGit(cwd)('rev-parse', '--git-common-dir').replace(/\r?\n$/, '');
    return out ? fs.realpathSync(path.resolve(cwd, out)) : null;
  } catch { return null; }
}
/** The value of a key in the local config file of a git common directory; null when unset or unreadable. Includes are not followed. */
export function localConfigValue(commonDir: string, key: string): string | null {
  try { return makeGit(commonDir)('config', '--file', path.join(commonDir, 'config'), '--get', key).replace(/\r?\n$/, ''); } catch { return null; }
}
/** True only when plangraph.heal holds a version (the value recordConsent writes). */
export const hasConsent = (commonDir: string): boolean => CONSENT_VALUE.test(localConfigValue(commonDir, CONSENT_KEY) ?? '');
/** True when plangraph.heal is exactly `never`: no heal and no nudge. */
export const hasDeclined = (commonDir: string): boolean => localConfigValue(commonDir, CONSENT_KEY) === 'never';
/** Record consent: `git config --file <commonDir>/config plangraph.heal <version>` (no shell). */
export function recordConsent(commonDir: string, version: string): void {
  if (!CONSENT_VALUE.test(version)) throw new TypeError(`not a version: ${JSON.stringify(String(version)).slice(0, 40)}`);
  makeGit(commonDir)('config', '--file', path.join(commonDir, 'config'), CONSENT_KEY, version);
}
