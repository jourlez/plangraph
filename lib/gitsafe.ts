// lib/gitsafe.ts: refs and paths that come from committed data are untrusted. Pure helpers, no I/O except makeGit.
import { execFileSync, spawn } from 'node:child_process';

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

// Streaming line reader over spawn: no shell, no timeout, no buffering of the whole output. `git` is the executable (argv is everything after
// it, `-C root` included). onLine gets each line without its terminator (delimiter default "\n"; a NUL delimiter suits `-z` output). Output
// over maxBytes (default 64 MiB) kills the child and rejects with code TOO_LARGE; a non-zero exit rejects with the first stderr bytes.
export function spawnLines(git: string, argv: readonly string[], onLine: (line: string) => void, { maxBytes = 64 * 1024 * 1024, delimiter = '\n' }: { maxBytes?: number; delimiter?: string } = {}): Promise<void> {
  const sep = delimiter.charCodeAt(0);
  return new Promise<void>((resolve, reject) => {
    const child = spawn(git, [...argv], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } });
    let total = 0, rest: Buffer = Buffer.alloc(0), stderr = '', done = false;
    const fail = (e: Error) => { if (done) return; done = true; child.kill('SIGKILL'); reject(e); };
    child.stderr.on('data', (d: Buffer) => { if (stderr.length < 400) stderr += d.toString('utf8').slice(0, 400); });
    child.stdout.on('data', (d: Buffer) => {
      if (done) return;
      total += d.length;
      if (total > maxBytes) { fail(Object.assign(new Error(`output over ${maxBytes} bytes`), { code: 'TOO_LARGE' })); return; }
      let buf = rest.length ? Buffer.concat([rest, d]) : d, from = 0, i: number;
      try { while ((i = buf.indexOf(sep, from)) !== -1) { onLine(buf.toString('utf8', from, i)); from = i + 1; } } catch (e) { fail(e as Error); return; }
      rest = from < buf.length ? Buffer.from(buf.subarray(from)) : Buffer.alloc(0);
    });
    child.on('error', (e) => fail(e));
    child.on('close', (code) => {
      if (done) return;
      done = true;
      if (code !== 0) { reject(Object.assign(new Error(`git exited ${code}: ${stderr.trim().slice(0, 200)}`), { code: 'GIT_FAILED' })); return; }
      try { if (rest.length) onLine(rest.toString('utf8')); } catch (e) { reject(e as Error); return; }
      resolve();
    });
  });
}

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
