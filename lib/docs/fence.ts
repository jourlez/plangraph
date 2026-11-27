// Minimal fencing and text helpers for generated documents. Everything that came from a tracker, a repository or a person is
// sanitized, capped and (for blocks) wrapped in an <untrusted> fence; text with a URL, host, email or token is withheld.
import crypto from 'node:crypto';
import { fence, fenceInline, oneLine, sanitizeText } from '../sanitize.ts';
import { hasD24 } from './policy.ts';

export const WITHHELD = '[withheld: contains a URL, host, email or token]';
export const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
export const hash8 = (s: string): string => crypto.createHash('sha256').update(s).digest('hex').slice(0, 8);

/** An id as one table-safe line. Not withheld: a D24 value in an id is a source defect the build scan must stop. */
export const idText = (s: unknown): string => { const t = oneLine(s, 80).replaceAll('|', '/'); return /\s/.test(t) ? fenceInline(String(s ?? '').replaceAll('|', '/'), 80) : t; };
/** A short piece of text (title, name) as one line; withheld when it holds D24 material. */
export function short(s: unknown, max = 100): string {
  const t = oneLine(s, max).replaceAll('|', '/');
  return hasD24(t) ? WITHHELD : t;
}
/** A block of external text inside one fence, as lines. Withheld when it holds D24 material. */
export function fencedLines(src: string, text: unknown, max = 400): string[] {
  const raw = sanitizeText(text, { max: Infinity });
  const body = hasD24(raw) ? WITHHELD : raw;
  const label = oneLine(src, 60);
  return fence(label, body, { src: label, nonce: hash8(body), max }).split('\n');
}
/** Stable file-name part for an id: readable slug plus a hash of the exact id (ids differing only in case stay apart). */
export function slugName(id: string): string {
  const s = id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return `${s === '' ? 'x' : s}-${hash8(id)}`;
}
