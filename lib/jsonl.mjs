// JSONL reading shared by the CLI and the library modules. One record per line; every problem is reported as file:line.
import fs from 'node:fs';
import path from 'node:path';

import { validators } from './schema.mjs';

const SHOWN = 10, SCAN_LIMIT = 1000;
// Memory is bounded: only the first 10 problems are kept (as .errors, Error objects, each message prefixed file:line:) and .total counts
// every problem found; .message shows those 10 plus "... and N more" ("at least N" when the scan stopped early at 1000 errors).
// A plain string is accepted for one-off callers. opts: { total, atLeast } when the list was truncated by the caller.
export class IngestError extends AggregateError {
  /** @param {string | Array<unknown>} errors @param {string} [name] @param {{ total?: number, atLeast?: boolean }} [opts] */
  constructor(errors, name = 'IngestError', { total, atLeast = false } = {}) {
    const msgs = (typeof errors === 'string' ? [errors] : errors).slice(0, SHOWN).map((e) => (e instanceof Error ? e.message : String(e)));
    const all = Math.max(total ?? 0, msgs.length);
    super(msgs.map((m) => new Error(m)), msgs.join('\n') + (all > SHOWN ? `\n... and ${atLeast ? 'at least ' : ''}${all - SHOWN} more` : ''));
    this.name = name; this.total = all;
  }
}

// Text -> records. One record per line; BOM, CRLF and blank lines are tolerated. Never echoes file content: a bad line reports only its
// position (the JSON engine's own message embeds a snippet of the line). maxLine is checked BEFORE JSON.parse. Throws IngestError.
// Error memory and CPU are bounded: the first 10 messages are kept, errors are counted, and the scan stops once a 1001st error is seen.
// Peak memory on the VALID path is NOT small: at the 64 MiB file cap it is roughly 10x the file size (read chunks + their concat + the
// decoded string + the parsed objects), so the cap bounds the input, not the process.
/** @param {string} text @param {string} [name] @param {{ maxLine?: number, validate?: (r: any) => string | null | undefined }} [opts] */
export function parseJsonl(text, name = 'input', { maxLine = 1 << 20, validate } = {}) {
  const out = [], errs = []; let total = 0, stopped = false;
  const src = String(text ?? '').replace(/^\uFEFF/, '');
  const fail = (at, msg) => { if (total >= SCAN_LIMIT) { stopped = true; return true; } total++; if (errs.length < SHOWN) errs.push(`${at} ${msg}`); return false; };
  for (let pos = 0, i = 0; pos <= src.length && !stopped; i++) {
    let end = src.indexOf('\n', pos); if (end < 0) end = src.length;
    const line = src.slice(pos, end); pos = end + 1;
    if (!line.trim()) continue;
    const at = `${name}:${i + 1}:`;
    // length counts UTF-16 code units, not bytes: in UTF-8 one unit is up to 3 bytes, so a line may be up to ~3x maxLine bytes.
    if (line.length > maxLine) { fail(at, 'line too long'); continue; }
    if (/^(<{7}|={7}|>{7})/.test(line)) { fail(at, 'unresolved git merge conflict marker'); continue; }
    let r;
    try { r = JSON.parse(line); }
    catch (e) { const m = /position (\d+)/.exec(String(e?.message)); fail(at, 'invalid JSON' + (m ? ` at column ${m[1]}` : '')); continue; }
    if (r === null || typeof r !== 'object' || Array.isArray(r)) { fail(at, 'expected a JSON object'); continue; }
    const badMsg = validate ? validate(r) : null;
    if (badMsg) { fail(at, badMsg); continue; }
    if (!total) out.push(r);
  }
  if (total) throw new IngestError(errs, 'IngestError', { total, atLeast: stopped });
  return out;
}

// A brain data file is read only as a regular file inside the brain directory: a symlink (even a dangling one, or one to a file outside the
// repository) is refused before any read, as `brain build` does. Returns false when the file is missing, true when it is there.
/** @param {string} f @returns {boolean} */
export function presentDataFile(f) {
  let st; try { st = fs.lstatSync(f); } catch (/** @type {any} */ e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return false; throw e; }
  if (st.isSymbolicLink()) throw new IngestError(`${path.basename(f)}: is a symlink, not a regular file`);
  return true;
}

// File wrapper: missing file -> []. A symlinked file is refused (presentDataFile). Reads through readCapped (regular files only, total cap maxBytes, default 64 MiB). A file with a known
// schema (tickets.jsonl, ...) is validated; errors always name the file by its base name only (never a path).
/** @param {string} f @param {{ maxBytes?: number, maxLine?: number, validate?: (r: any) => string | null | undefined }} [opts] */
export function readJsonl(f, { maxBytes = 64 * 1024 * 1024, maxLine, validate } = {}) {
  if (!presentDataFile(f)) return [];
  const base = path.basename(f), v = validate ?? (Object.hasOwn(validators, base) ? validators[base] : undefined);
  let text;
  try { text = readCapped(f, maxBytes); }
  catch (e) { if (e.code === 'TOO_LARGE' || e.code === 'NOT_A_FILE') throw new IngestError(`${base}: ${e.message}`); throw e; }
  return parseJsonl(text, base, { maxLine, validate: v });
}

const CHUNK = 65536;
const tooLarge = (max) => Object.assign(new Error(`file too large (limit ${max} bytes)`), { code: 'TOO_LARGE' });
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Reads an open fd to the end in 64 KiB chunks and stops as soon as more than maxBytes have arrived (never reads it all first).
// A NON-BLOCKING fd that has no data yet (EAGAIN) is retried after a short sleep and gives up with code 'TIMEOUT' after timeoutMs of IDLE
// time: the clock restarts whenever data arrives, so a slow but steady producer is never cut off (the maxBytes cap bounds the total).
// LIMIT: a BLOCKING fd (the usual inherited stdin) never reports EAGAIN, its readSync simply waits, and a blocked readSync cannot be
// interrupted from this thread, so timeoutMs does NOT apply to it. A caller that needs a hard time bound on a blocking stdin must run the
// read in a child process and kill it on its own deadline.
export function readStreamCapped(fd, maxBytes, { timeoutMs = 30000, fsImpl = fs } = {}) {
  const chunks = []; let total = 0; let last = Date.now();
  const buf = Buffer.allocUnsafe(CHUNK); // one reusable read buffer: each chunk is COPIED out, so a tiny read never pins a whole 64 KiB ArrayBuffer
  for (;;) {
    let n;
    try { n = fsImpl.readSync(fd, buf, 0, CHUNK, null); }
    catch (e) {
      if (e.code === 'EAGAIN') { if (Date.now() - last > timeoutMs) throw Object.assign(new Error('timed out'), { code: 'TIMEOUT' }); sleepMs(10); continue; }
      if (e.code === 'EOF') break;
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
// fsImpl (default node:fs) supplies openSync, fstatSync, readSync and closeSync, so a caller can prove it only ever reads.
export function readCapped(file, maxBytes, { fsImpl = fs } = {}) {
  const fd = fsImpl.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));
  try {
    if (!fsImpl.fstatSync(fd).isFile()) throw Object.assign(new Error('not a regular file'), { code: 'NOT_A_FILE' });
    return readStreamCapped(fd, maxBytes, { fsImpl });
  } finally { fsImpl.closeSync(fd); }
}
