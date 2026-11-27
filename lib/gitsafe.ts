// lib/gitsafe.ts: refs and paths that come from committed data are untrusted. Pure helpers, no I/O except makeGit.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9_.\/@^~{}+-]*$/; // never starts with '-', no spaces, no ':' (path separator in `ref:path`)
export type SafeRef = string & { readonly __brand: 'SafeRef' };
export function checkRef(ref: unknown): SafeRef {
  if (typeof ref !== 'string' || ref.length > 200 || !SAFE_REF.test(ref) || ref.includes('..')) throw new TypeError(`invalid git ref: ${JSON.stringify(String(ref)).slice(0, 60)}`);
  return ref as SafeRef; // the guards above proved a safe string
}
export function checkRepoPath(p: unknown): string {
  if (typeof p !== 'string' || !p || p.length > 500 || /[\u0000-\u001f\u007f]/.test(p) || p.startsWith('/') || p.startsWith('-') || p.split('/').includes('..')) throw new TypeError(`invalid repo path: ${JSON.stringify(String(p)).slice(0, 60)}`);
  return p;
}
export const makeGit = (root: string, { timeoutMs = 30000 }: { timeoutMs?: number } = {}): ((...args: string[]) => string) => (...args: string[]) =>
  execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 1 << 28, timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } });

// Heading template grammar (not a regex): optional leading ^, literal text and '#', fixed `#{a}` runs, at most ONE variable `#{a,b}` run
// (a < b), and exactly one {id}.
// Anything else is rejected, so config can never inject a backtracking pattern.
export interface HeadingMatcher { find(text: string, id: unknown): { start: number; end: number } | null; nextIndex(text: string): number }
export function compileHeading(template: unknown): HeadingMatcher {
  if (typeof template !== 'string' || template.length > 200) throw new TypeError('ref_heading: must be a string of at most 200 characters');
  const m = /^(\^?)((?:[A-Za-z0-9 :.\-_]|#(?:\{\d{1,2}(?:,\d{1,2})?\})?)*)\{id\}([A-Za-z0-9 :.\-_]*)$/.exec(template);
  if (!m) throw new TypeError('ref_heading: only literal text, #{a,b} repetitions and one {id} are allowed (for example "^#{2,3} Task {id}:")');
  let variable = 0;
  for (const q of template.matchAll(/#\{(\d{1,2})(?:,(\d{1,2}))?\}/g)) {
    if (q[2] !== undefined && +(q[1] as string) > +q[2]) throw new TypeError('ref_heading: #{a,b} needs a <= b'); // group 1 (\d{1,2}) is not optional
    if (q[2] !== undefined && +(q[1] as string) < +q[2]) variable++; // group 1 (\d{1,2}) is not optional
  }
  // Two variable-width runs of '#' (even with literal text between them) let the regex engine try every split of a long run of '#':
  // with three of them, about 2 s per 1000 '#' of plan text. One is linear (at most 99 steps per position).
  if (variable > 1) throw new TypeError('ref_heading: at most one #{a,b} repetition with a < b is allowed');
  const re = (s: string) => s.replace(/#(?:\{(\d{1,2})(?:,(\d{1,2}))?\})?/g, (_: string, a: string | undefined, b: string | undefined) => (a ? `#{${a}${b ? ',' + b : ''}}` : '#')).replace(/[.\-_ :]/g, (c: string) => (c === ' ' ? ' ' : '\\' + c));
  const head = re(m[2] as string), tail = re(m[3] as string), anchored = m[1] === '^' ? '^' : ''; // groups 2 and 3 are starred, not optional: they always participate (maybe empty)
  let prefix: RegExp;
  try { prefix = new RegExp(`${anchored}${head}`, 'm'); new RegExp(`${anchored}${head}x${tail}`, 'm'); } catch { throw new TypeError('ref_heading: template does not compile to a valid pattern'); }
  return {
    find(text: string, id: unknown): { start: number; end: number } | null {
      const safe = String(id).replace(/[^A-Za-z0-9]/g, (c: string) => '\\' + c);
      const rx = new RegExp(`${anchored}${head}${safe}${tail}`, 'm'); // head/tail contain only literals and bounded '#' runs: no nested quantifiers
      const hit = rx.exec(text); return hit ? { start: hit.index, end: hit.index + hit[0].length } : null;
    },
    // Index of the next heading of the same shape (the literal text before {id}) in `text`, or -1.
    nextIndex: (/** @type {string} */ text) => text.search(prefix),
  };
}

/** The real path of the git common directory of the repository at cwd (shared by its worktrees); null outside a git repository. */
export function gitCommonDir(cwd: string): string | null {
  try {
    const out = makeGit(cwd)('rev-parse', '--git-common-dir').replace(/\r?\n$/, '');
    return out ? fs.realpathSync(path.resolve(cwd, out)) : null;
  } catch { return null; }
}
