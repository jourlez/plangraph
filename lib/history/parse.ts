// lib/history/parse.ts: `git log -M --numstat -z` output to commit facts. Pure, no I/O.
// Format asked of git (LOG_FORMAT): each commit starts with a \x01 header `<sha>\t<epoch>\t<email>` ended by NUL, then numstat entries each
// ended by NUL; a rename entry is `<a>\t<d>\t` NUL old NUL new NUL. Tokens are read by state, so a path can never be mistaken for a header.
// The email (mailmap applied by git, %aE) becomes a hash ref and is never kept. Paths with control characters are dropped (data, never printed).
import crypto from 'node:crypto';

export const LOG_FORMAT = '%x01%H%x09%at%x09%aE';
export interface FileFact { path: string; added: number; deleted: number; renamedFrom?: string }
export interface CommitFact { sha: string; at: string; author: string; files: FileFact[] }

/** `git:` plus 16 hex of the sha256 of the lowercased, trimmed email. The email is hashed here and never stored. */
export const emailRef = (email: string): string => `git:${crypto.createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 16)}`;

const HEADER = /^\x01([0-9a-f]{40}|[0-9a-f]{64})\t(\d{1,12})\t([^\0]*)$/;
const NUMSTAT = /^(\d+|-)\t(\d+|-)\t([^]*)$/;
const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]');
const MAX_PATH = 500;
const okPath = (p: string): boolean => p.length > 0 && p.length <= MAX_PATH && !CONTROL.test(p);
export const isoSeconds = (epoch: number): string => new Date(epoch * 1000).toISOString().replace('.000Z', 'Z');

/** Incremental reader: push() one NUL-delimited token at a time (a streaming log), finish() for the commits in input order. */
export class LogParser {
  readonly commits: CommitFact[] = [];
  private cur: CommitFact | null = null;
  private renameOf: { a: number; d: number; from?: string } | null = null;
  push(tok: string): void {
    if (this.renameOf) {
      const r = this.renameOf;
      if (r.from === undefined) { r.from = tok; return; }
      this.renameOf = null;
      if (this.cur && okPath(r.from) && okPath(tok)) this.cur.files.push({ path: tok, added: r.a, deleted: r.d, renamedFrom: r.from });
      return;
    }
    if (tok.startsWith('\x01')) {
      const h = HEADER.exec(tok);
      this.cur = h ? { sha: h[1] as string, at: isoSeconds(Number(h[2])), author: emailRef(h[3] as string), files: [] } : null;
      if (this.cur) this.commits.push(this.cur);
      return;
    }
    const t = tok.startsWith('\n') ? tok.slice(1) : tok;
    if (!t) return;
    const m = NUMSTAT.exec(t);
    if (!m || !this.cur) return;
    const a = m[1] === '-' ? 0 : Number(m[1]), d = m[2] === '-' ? 0 : Number(m[2]), p = m[3] as string;
    if (p === '') { this.renameOf = { a, d }; return; }
    if (okPath(p)) this.cur.files.push({ path: p, added: a, deleted: d });
  }
}

export function parseLog(text: string): CommitFact[] {
  const p = new LogParser();
  for (const tok of text.split('\0')) p.push(tok);
  return p.commits;
}
