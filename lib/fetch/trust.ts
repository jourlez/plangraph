// lib/fetch/trust.ts: the local list of fetch targets the user trusts. It lives OUTSIDE the work tree (CLAUDE_PLUGIN_DATA when set, else the
// user config directory: PLANGRAPH_CONFIG_DIR, $XDG_CONFIG_HOME/plangraph, ~/.config/plangraph), one file per repository, keyed by the real path of
// the repository root, mode 0600. A repository cannot commit its own trust: a target named only by committed config is never fetched until it is
// here, so a hostile repository cannot point the user's credentials at a target of its choice. A symlinked or oversized file trusts nothing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { writeAtomicSafe } from '../fsafe.ts';
import { readCapped } from '../jsonl.ts';

type Env = Readonly<Record<string, string | undefined>>;
// `<sys>:<target>`: a system name, a colon, then a target made of plain characters (no URL, no `..`, no control character).
const TARGET_RE = /^[a-z][a-z0-9-]{0,23}:[A-Za-z0-9._#@/-][A-Za-z0-9._#@/ -]{0,199}$/;
const targetOk = (t: unknown): t is string => typeof t === 'string' && TARGET_RE.test(t) && !t.includes('..') && !t.includes('://') && t === t.trim();

/** The directory that holds the trust lists: CLAUDE_PLUGIN_DATA (absolute), else the user config directory. */
function trustDir(env: Env = process.env): string {
  const data = env.CLAUDE_PLUGIN_DATA;
  if (data && path.isAbsolute(data)) return path.join(data, 'trust');
  const base = env.PLANGRAPH_CONFIG_DIR ? path.resolve(env.PLANGRAPH_CONFIG_DIR) : path.join(env.XDG_CONFIG_HOME ? env.XDG_CONFIG_HOME : path.join(env.HOME || os.homedir(), '.config'), 'plangraph');
  return path.join(base, 'trust');
}
const realOf = (root: string): string => { try { return fs.realpathSync(root); } catch { return path.resolve(root); } };
/** The trust file of one repository: `<trustDir>/<sha256 of the real root, 24 hex>.json`. */
export const trustFile = (root: string, env: Env = process.env): string => path.join(trustDir(env), `${createHash('sha256').update(realOf(root)).digest('hex').slice(0, 24)}.json`);

function load(root: string, env: Env): string[] {
  try {
    const j: unknown = JSON.parse(readCapped(trustFile(root, env), 1024 * 1024, { follow: false }));
    if (!j || typeof j !== 'object' || Array.isArray(j) || (j as { root?: unknown }).root !== realOf(root)) return [];
    const t = Object.hasOwn(j, 'targets') ? (j as { targets: unknown }).targets : null;
    return Array.isArray(t) && t.every(targetOk) ? t : []; // one bad entry makes the whole file untrusted
  } catch { return []; }
}

/** True only when `target` is recorded exactly for this repository root. A missing, symlinked or damaged file trusts nothing. */
export function isTrusted(root: string, target: string, env: Env = process.env): boolean {
  return targetOk(target) && load(root, env).includes(target);
}

/** Record a target (idempotent, sorted); returns the file written. Throws on a malformed target. */
export function trust(root: string, target: string, env: Env = process.env): string {
  if (!targetOk(target)) throw new Error('trust: "target" must be <system>:<target> with plain characters');
  const list = [...new Set([...load(root, env), target])].sort();
  const f = trustFile(root, env);
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  writeAtomicSafe(f, `${JSON.stringify({ root: realOf(root), targets: list })}\n`, { mode: 0o600 });
  return f;
}

/** The exact line the user must run to trust a target. */
export const trustLine = (target: string): string => `plangraph trust ${target}`;
