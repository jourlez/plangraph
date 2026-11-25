// JSONL reading shared by the CLI and the library modules. One record per line; every problem is reported as file:line.
import fs from 'node:fs';
import path from 'node:path';

import { validators } from './schema.ts';
import type { Rec } from './schema.ts';

const SHOWN = 10, SCAN_LIMIT = 1000;
// Memory is bounded: only the first 10 problems are kept (as .errors, Error objects, each message prefixed file:line:) and .total counts
// every problem found; .message shows those 10 plus "... and N more" ("at least N" when the scan stopped early at 1000 errors).
// A plain string is accepted for one-off callers. opts: { total, atLeast } when the list was truncated by the caller.
export interface JsonlRecord { [key: string]: unknown }
export class IngestError extends AggregateError {
  declare total: number; // `declare`: no class-field initializer at run time
  constructor(errors: string | Array<unknown>, name: string = 'IngestError', { total, atLeast = false }: { total?: number; atLeast?: boolean } = {}) {
    const msgs = (typeof errors === 'string' ? [errors] : errors).slice(0, SHOWN).map((e: unknown) => (e instanceof Error ? e.message : String(e)));
    const all = Math.max(total ?? 0, msgs.length);
    super(msgs.map((m: string) => new Error(m)), msgs.join('\n') + (all > SHOWN ? `\n... and ${atLeast ? 'at least ' : ''}${all - SHOWN} more` : ''));
    this.name = name; this.total = all;
  }
}

// Text -> records. One record per line; BOM, CRLF and blank lines are tolerated. Never echoes file content: a bad line reports only its
// position (the JSON engine's own message embeds a snippet of the line). maxLine is checked BEFORE JSON.parse. Throws IngestError.
// Error memory and CPU are bounded: the first 10 messages are kept, errors are counted, and the scan stops once a 1001st error is seen.
// Peak memory on the VALID path is NOT small: at the 64 MiB file cap it is roughly 10x the file size (read chunks + their concat + the
// decoded string + the parsed objects), so the cap bounds the input, not the process.
export function parseJsonl(text: string, name: string = 'input', { maxLine = 1 << 20, validate }: { maxLine?: number | undefined; validate?: ((r: Rec) => string | null | undefined) | undefined } = {}): JsonlRecord[] {
  const out: JsonlRecord[] = [], errs: string[] = []; let total = 0, stopped = false;
  const src = String(text ?? '').replace(/^\uFEFF/, '');
  const fail = (at: string, msg: string) => { if (total >= SCAN_LIMIT) { stopped = true; return true; } total++; if (errs.length < SHOWN) errs.push(`${at} ${msg}`); return false; };
  for (let pos = 0, i = 0; pos <= src.length && !stopped; i++) {
    let end = src.indexOf('\n', pos); if (end < 0) end = src.length;
    const line = src.slice(pos, end); pos = end + 1;
    if (!line.trim()) continue;
    const at = `${name}:${i + 1}:`;
    // length counts UTF-16 code units, not bytes: in UTF-8 one unit is up to 3 bytes, so a line may be up to ~3x maxLine bytes.
    if (line.length > maxLine) { fail(at, 'line too long'); continue; }
    if (/^(<{7}|={7}|>{7})/.test(line)) { fail(at, 'unresolved git merge conflict marker'); continue; }
    let r: unknown;
    try { r = JSON.parse(line); }
    catch (e) { const m = /position (\d+)/.exec(String((e as Error | undefined)?.message)); fail(at, 'invalid JSON' + (m ? ` at column ${m[1]}` : '')); continue; } // whatever was thrown: read its message
    if (r === null || typeof r !== 'object' || Array.isArray(r)) { fail(at, 'expected a JSON object'); continue; }
    const badMsg = validate ? validate(r as Rec) : null; // r is a non-array non-null object, checked above
    if (badMsg) { fail(at, badMsg); continue; }
    if (!total) out.push(r as JsonlRecord); // same check
  }
  if (total) throw new IngestError(errs, 'IngestError', { total, atLeast: stopped });
  return out;
}

// A plan data file is read only as a regular file inside the plan directory: a symlink (even a dangling one, or one to a file outside the
// repository) is refused before any read, as `plangraph build` does. Returns false when the file is missing, true when it is there.
export function presentDataFile(f: string): boolean {
  let st: fs.Stats; try { st = fs.lstatSync(f); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'ENOTDIR') return false; throw e; } // whatever was thrown: read its code
  if (st.isSymbolicLink()) throw new IngestError(`${path.basename(f)}: is a symlink, not a regular file`);
  return true;
}

// File wrapper: missing file -> []. A symlinked file is refused (presentDataFile). Reads through readCapped (regular files only, total cap maxBytes, default 64 MiB). A file with a known
// schema (tickets.jsonl, ...) is validated; errors always name the file by its base name only (never a path).
export function readJsonl(f: string, { maxBytes = 64 * 1024 * 1024, maxLine, validate }: { maxBytes?: number; maxLine?: number | undefined; validate?: ((r: Rec) => string | null | undefined) | undefined } = {}): JsonlRecord[] {
  if (!presentDataFile(f)) return [];
  const base = path.basename(f), v = validate ?? (Object.hasOwn(validators, base) ? validators[base] : undefined);
  let text: string;
  try { text = readDataCapped(f, maxBytes); }
  catch (e) { if (DATA_REFUSALS.has((e as NodeJS.ErrnoException).code as string)) throw new IngestError(`${base}: ${(e as Error).message}`); throw e; } // whatever was thrown: read its code and message
  return parseJsonl(text, base, { maxLine, validate: v });
}

// read refusals that name the file (base name only) as a data error
export const DATA_REFUSALS = new Set(['TOO_LARGE', 'NOT_A_FILE', 'SYMLINK', 'SWAPPED']);
const CHUNK = 65536;
const tooLarge = (max: number) => Object.assign(new Error(`file too large (limit ${max} bytes)`), { code: 'TOO_LARGE' });
const sleepMs = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Reads an open fd to the end in 64 KiB chunks and stops as soon as more than maxBytes have arrived (never reads it all first).
// A NON-BLOCKING fd that has no data yet (EAGAIN) is retried after a short sleep and gives up with code 'TIMEOUT' after timeoutMs of IDLE
// time: the clock restarts whenever data arrives, so a slow but steady producer is never cut off (the maxBytes cap bounds the total).
// LIMIT: a BLOCKING fd (the usual inherited stdin) never reports EAGAIN, its readSync simply waits, and a blocked readSync cannot be
// interrupted from this thread, so timeoutMs does NOT apply to it. A caller that needs a hard time bound on a blocking stdin must run the
// read in a child process and kill it on its own deadline.
export function readStreamCapped(fd: number, maxBytes: number, { timeoutMs = 30000, fsImpl = fs }: { timeoutMs?: number; fsImpl?: typeof fs } = {}): string {
  const chunks: Buffer[] = []; let total = 0; let last = Date.now();
  const buf = Buffer.allocUnsafe(CHUNK); // one reusable read buffer: each chunk is COPIED out, so a tiny read never pins a whole 64 KiB ArrayBuffer
  for (;;) {
    let n: number;
    try { n = fsImpl.readSync(fd, buf, 0, CHUNK, null); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EAGAIN') { if (Date.now() - last > timeoutMs) throw Object.assign(new Error('timed out'), { code: 'TIMEOUT' }); sleepMs(10); continue; }
      if ((e as NodeJS.ErrnoException).code === 'EOF') break;
      throw e;
    }
    if (!n) break;
    last = Date.now(); total += n; if (total > maxBytes) throw tooLarge(maxBytes);
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Opens the file once, refuses anything that is not a regular file (FIFO, device, directory), and reads that same fd with a cap,
// so a growing file, /dev/zero or a symlink to either cannot bypass the limit. O_NONBLOCK keeps a writer-less FIFO from hanging the open.
// fsImpl (default node:fs) supplies lstatSync, openSync, fstatSync, readSync and closeSync, so a caller can prove it only ever reads.
// follow (default true, for files a person names on the command line): the final component may be a symlink. follow: false is for plangraph
// DATA files (readDataCapped): lstat first and refuse a symlink (code SYMLINK), open with O_NOFOLLOW (a symlink swapped in after the lstat
// fails the open: ELOOP, refused as SYMLINK; Windows has no O_NOFOLLOW, the next check is the guard there), then compare the fstat of the
// opened fd with that lstat (dev and inode): any file that existed while the original did (a rename over it, a hard link to an outside file)
// has another inode, so it is refused (code SWAPPED) before a single byte is read. A file created only after the original was DELETED can get
// the same inode number back (ext4 and overlayfs reuse it at once), so the change time is compared too: a recreated file has a new ctime
// (no unprivileged process can set it) unless it falls in the timestamp granularity of the original's last change. That part is a
// heuristic, not a guarantee. plangraph never changes a data file in place (every write is a rename), so a ctime change in that window is a swap.
// Residual: a swap of an INTERMEDIATE directory component between the lstat and the open is not detectable without openat (docs/CONTRACT.md).
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const err = (code: string, m: string) => Object.assign(new Error(m), { code });
export function readCapped(file: string, maxBytes: number, { fsImpl = fs, follow = true }: { fsImpl?: typeof fs; follow?: boolean } = {}): string {
  let pre: fs.Stats | null = null;
  if (!follow) {
    pre = fsImpl.lstatSync(file); // ENOENT propagates: a missing file is the caller's business
    if (pre.isSymbolicLink()) throw err('SYMLINK', 'is a symlink, not a regular file');
  }
  let fd: number;
  try { fd = fsImpl.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0) | (follow ? 0 : NOFOLLOW)); }
  catch (e) { if (!follow && ((e as NodeJS.ErrnoException).code === 'ELOOP' || (e as NodeJS.ErrnoException).code === 'EMLINK')) throw err('SYMLINK', 'is a symlink, not a regular file'); throw e; }
  try {
    const st = fsImpl.fstatSync(fd);
    if (!st.isFile()) throw err('NOT_A_FILE', 'not a regular file');
    if (pre && (st.dev !== pre.dev || st.ino !== pre.ino || st.ctimeMs !== pre.ctimeMs)) throw err('SWAPPED', 'file was replaced while it was opened');
    return readStreamCapped(fd, maxBytes, { fsImpl });
  } finally { fsImpl.closeSync(fd); }
}
/** readCapped for plan data files: never follows a symlink and refuses a file swapped between the check and the open (see above). */
export const readDataCapped = (file: string, maxBytes: number, opts: { fsImpl?: typeof fs } = {}): string => readCapped(file, maxBytes, { ...opts, follow: false });
