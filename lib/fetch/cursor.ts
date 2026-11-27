// lib/fetch/cursor.ts: the per-system fetch cursor, cache/<sys>.cursor, mode 0600 (D24: a cache file, git-ignored). Plus scrub(), the one
// place that removes secret-looking environment values from text a fetcher is about to return or print.
import fs from 'node:fs';
import path from 'node:path';
import { writeAtomicSafe } from '../fsafe.ts';
import { readCapped } from '../jsonl.ts';
import { sysOk } from '../graph/files.ts';

export interface Cursor { sys: string; watermark: string; etag: string; page: string; at: string }
const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|CREDENTIAL)/i;

/** The file of a system: `github:owner/repo` becomes `github_owner_repo`, so one name is one file. */
function fileOf(dir: string, sys: string): string | null {
  if (typeof sys !== 'string' || !sysOk(sys)) return null;
  return path.join(dir, 'cache', `${sys.replace(/[:/]/g, '_')}.cursor`);
}
const isStr = (x: unknown): x is string => typeof x === 'string';

/** Asks git whether a path is tracked (the plan directory is in the repository: a committed cursor is repository-controlled). */
export type Tracked = (file: string) => boolean;

/** The stored cursor, or null when the file is absent, unreadable, a symlink, tracked by git, or not a cursor (a bad file never stops a fetch: it starts again). */
export function readCursor(dir: string, sys: string, tracked?: Tracked): Cursor | null {
  const f = fileOf(dir, sys);
  if (!f) return null;
  try {
    if (tracked?.(f)) return null;
    const j: unknown = JSON.parse(readCapped(f, 64 * 1024, { follow: false }));
    if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
    const o = j as Record<string, unknown>;
    if (![o.sys, o.watermark, o.etag, o.page, o.at].every(isStr) || o.sys !== sys) return null;
    return { sys: o.sys as string, watermark: o.watermark as string, etag: o.etag as string, page: o.page as string, at: o.at as string };
  } catch { return null; }
}

/** Write the cursor atomically with mode 0600; false (nothing written) when the file is a symlink or tracked by git. Throws on a bad `sys` (a programming error, not a network one). */
export function writeCursor(dir: string, c: Cursor, tracked?: Tracked): boolean {
  const f = fileOf(dir, c.sys);
  if (!f) throw new Error('cursor: "sys" is not a system name');
  try { if (fs.lstatSync(f).isSymbolicLink()) return false; } catch { /* absent: fine */ }
  if (tracked?.(f)) return false;
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  writeAtomicSafe(f, `${JSON.stringify({ sys: c.sys, watermark: c.watermark, etag: c.etag, page: c.page, at: c.at })}\n`, { mode: 0o600 });
  return true;
}

/** Replace the value of every secret-looking environment variable (name has TOKEN, SECRET, PASSWORD, API_KEY or CREDENTIAL; 8+ characters) by `***`. */
export function scrub(s: string): string {
  let out = String(s);
  for (const [k, v] of Object.entries(process.env)) if (v && v.length >= 8 && SECRET_NAME.test(k)) out = out.split(v).join('***');
  return out;
}
