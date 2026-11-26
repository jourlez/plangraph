// lib/fetch/trust.ts: the local list of fetch targets the user trusts (cache/trusted.json, mode 0600, git-ignored). A target named only by
// committed config is never fetched until it is here: a hostile repository cannot point the user's credentials at a target of its choice.
import fs from 'node:fs';
import path from 'node:path';
import { writeAtomicSafe } from '../fsafe.ts';

// `<sys>:<target>`: a system name, a colon, then a target made of plain characters (no URL, no `..`, no control character).
const TARGET_RE = /^[a-z][a-z0-9-]{0,23}:[A-Za-z0-9._#@/-][A-Za-z0-9._#@/ -]{0,199}$/;
const targetOk = (t: unknown): t is string => typeof t === 'string' && TARGET_RE.test(t) && !t.includes('..') && !t.includes('://') && t === t.trim();
const fileOf = (dir: string): string => path.join(dir, 'cache', 'trusted.json');

function load(dir: string): string[] {
  try {
    const j: unknown = JSON.parse(fs.readFileSync(fileOf(dir), 'utf8'));
    const t = j && typeof j === 'object' && !Array.isArray(j) && Object.hasOwn(j, 'targets') ? (j as { targets: unknown }).targets : null;
    return Array.isArray(t) && t.every(targetOk) ? t : []; // one bad entry makes the whole file untrusted
  } catch { return []; }
}

/** True only when `target` is recorded exactly. A missing or damaged file trusts nothing. */
export function isTrusted(dir: string, target: string): boolean {
  return targetOk(target) && load(dir).includes(target);
}

/** Record a target (idempotent, sorted). Throws on a malformed target. */
export function trust(dir: string, target: string): void {
  if (!targetOk(target)) throw new Error('trust: "target" must be <system>:<target> with plain characters');
  const list = [...new Set([...load(dir), target])].sort();
  const f = fileOf(dir);
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  writeAtomicSafe(f, `${JSON.stringify({ targets: list })}\n`, { mode: 0o600 });
}

/** The exact line the user must run to trust a target. */
export const trustLine = (target: string): string => `plangraph trust ${target}`;
