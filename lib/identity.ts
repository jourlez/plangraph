// Identity map: which plan person a tracker ref is (decision: local, never committed). `cache/identities.json` is mode 0600 inside the plan
// directory; `ref` is `<sys>:<tracker display text>`. Proposals match a display against person ids and names only; an email is never read.
import fs from 'node:fs';
import path from 'node:path';
import { assertInside, writeAtomicSafe } from './fsafe.ts';
import { readCapped } from './jsonl.ts';

export interface IdentityMap { version: 1; byRef: Record<string, string> }
export interface Proposal { ref: string; person: string; conf: 'exact' | 'fuzzy'; why: string }
interface PersonLike { id?: unknown; name?: unknown }
interface Candidates { persons: string[]; conf: 'exact' | 'fuzzy'; why: string }

export const IDENTITY_FILE = 'cache/identities.json';
const MAX_BYTES = 1 << 20;
export const emptyIdentityMap = (): IdentityMap => ({ version: 1, byRef: {} });
const err = (code: string, message: string) => Object.assign(new Error(message), { code });
const lc = (v: unknown): string => (typeof v === 'string' ? v.trim().toLowerCase() : '');

/** The mapped person for a ref, or null. Own properties only. */
export function resolve(map: IdentityMap, ref: string): string | null {
  return Object.hasOwn(map.byRef, ref) && typeof map.byRef[ref] === 'string' ? (map.byRef[ref] as string) : null;
}

/** People a display could be, best tier first: exact (the display is an id or a name), else fuzzy (its first word is an id or a first name).
 * Null when nothing matches. More than one person in the best tier is returned as is: the caller treats it as ambiguous. */
export function matchIdentity(display: string, people: readonly PersonLike[]): Candidates | null {
  const d = lc(display);
  if (!d) return null;
  const first = d.split(/\s+/)[0] as string;
  const ids = people.filter((p): p is PersonLike & { id: string } => typeof p.id === 'string' && p.id !== '');
  const tier = (test: (id: string, name: string) => string | null): { persons: string[]; why: string } | null => {
    const hits = new Map<string, string>();
    for (const p of ids) { const why = test(lc(p.id), lc(p.name)); if (why && !hits.has(p.id)) hits.set(p.id, why); }
    return hits.size ? { persons: [...hits.keys()].sort(), why: [...hits.values()].sort()[0] as string } : null;
  };
  const exact = tier((id, name) => (id === d ? 'id' : name && name === d ? 'name' : null));
  if (exact) return { ...exact, conf: 'exact' };
  const fuzzy = tier((id, name) => (id === first ? 'first name' : name && name.split(/\s+/)[0] === first ? 'first name' : null));
  return fuzzy ? { ...fuzzy, conf: 'fuzzy' } : null;
}

export function proposeIdentities(observed: readonly { ref: string; display: string }[], people: readonly PersonLike[]): Proposal[] {
  const out: Proposal[] = [];
  for (const o of observed) {
    const m = matchIdentity(o.display, people);
    if (m && m.persons.length === 1) out.push({ ref: o.ref, person: m.persons[0] as string, conf: m.conf, why: m.why });
  }
  return out.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
}

const target = (dir: string, file?: string): string => { const f = file ?? path.join(dir, IDENTITY_FILE); assertInside(dir, f); return f; };

/** Reads the map; a missing file is the empty map, a malformed one throws a coded error that names the file. */
export function readIdentityMap(dir: string, file?: string): IdentityMap {
  const f = target(dir, file);
  let text: string;
  try { text = readCapped(f, MAX_BYTES); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return emptyIdentityMap(); throw err('DATA', `identities.json cannot be read: ${(e as Error).message.slice(0, 80)}`); }
  let j: unknown;
  try { j = JSON.parse(text); } catch { throw err('DATA', 'identities.json is not valid JSON'); }
  const o = j as { version?: unknown; byRef?: unknown } | null;
  if (!o || typeof o !== 'object' || o.version !== 1 || !o.byRef || typeof o.byRef !== 'object' || Array.isArray(o.byRef)) throw err('DATA', 'identities.json has an unknown shape or version');
  const byRef: Record<string, string> = {};
  for (const [k, v] of Object.entries(o.byRef)) if (typeof v === 'string' && v) byRef[k] = v;
  return { version: 1, byRef };
}

export function writeIdentityMap(dir: string, map: IdentityMap, file?: string): void {
  const f = target(dir, file);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const byRef: Record<string, string> = {};
  for (const k of Object.keys(map.byRef).sort()) byRef[k] = map.byRef[k] as string;
  writeAtomicSafe(f, `${JSON.stringify({ version: 1, byRef }, null, 2)}\n`, { root: dir, mode: 0o600 });
}
