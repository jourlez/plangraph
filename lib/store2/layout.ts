// File layout of the entity store (spec 4.0 rule 1): nodes/<kind>/<h2>/<slug>~<h8>.pg. Pure string work, no file system access.
// h8 is the first 8 hex of sha256(exact id): ids that differ only in case differ in the hash, so their file names differ even on a
// case-insensitive file system. The slug only makes the name readable; it is never parsed back.
import crypto from 'node:crypto';
import path from 'node:path';

const KIND_RE = /^[a-z][a-z0-9-]{0,39}$/;
const SLUG_MAX = 60;
const sha = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');

/** The first 8 hex of sha256(exact id). */
export const idHash = (id: string): string => sha(id).slice(0, 8);

/** The id lower-cased, every character outside [a-z0-9._-] replaced by `_`, at most 60 characters. */
export const slug = (id: string): string => [...id.toLowerCase()].map((c) => (/[a-z0-9._-]/.test(c) ? c : '_')).slice(0, SLUG_MAX).join('');

export function assertKind(kind: string): string {
  if (!KIND_RE.test(kind)) throw new TypeError('kind must be a lower-case word (a-z, 0-9, dash)');
  return kind;
}

/** `<root>/nodes/<kind>/<h2>/<slug>~<h8>.pg`. */
export function nodePath(root: string, kind: string, id: string): string {
  const h = idHash(id);
  return path.join(root, 'nodes', assertKind(kind), h.slice(0, 2), `${slug(id)}~${h}.pg`);
}

const PREFIX: Readonly<Record<string, string>> = { requirement: 'R', decision: 'D', team: 'TEAM' };

/** A new local id: kind prefix plus 6 hex of sha256(seed), extended by 2 hex per collision (`exists` says an id is taken).
 * The seed is creation input (a source anchor plus its first 40 characters, a source path), never later-edited content. */
export function newId(kind: string, seed: string, exists: (id: string) => boolean = () => false): string {
  const prefix = PREFIX[assertKind(kind)] ?? kind.slice(0, 1).toUpperCase(), h = sha(seed);
  for (let len = 6; len <= h.length; len += 2) { const id = `${prefix}-${h.slice(0, len)}`; if (!exists(id)) return id; }
  throw new Error('no free id for this seed');
}
