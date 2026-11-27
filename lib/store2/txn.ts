// Staged multi-file writes for the plan directory (spec 4.0 rule 6). `root` is the plan directory.
// withTxn stages every write under <root>/.txn/<id>/, writes a journal (the commit point), renames the staged files into place and removes
// the staging directory. The store lock (lib/store.ts acquireLock, <root>/.txn/lock) is held for the whole call, so two processes in one clone
// serialize. A transaction found on disk at the start of the next call is finished or undone: with a journal it is rolled FORWARD (the rename
// list is idempotent), without one it is rolled BACK (nothing had been applied). Node built-ins and lib/fsafe.ts only.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeAtomicSafe, assertInside } from '../fsafe.ts';
import { readCapped } from '../jsonl.ts';
import { withLock } from '../store.ts';

const TXN = '.txn';
const fail = (code: string, message: string): Error & { code: string } => Object.assign(new Error(message), { code });

export interface Txn {
  /** Stage a whole-file write; the last operation on a path wins. `rel` is relative to the plan directory. */
  write(rel: string, text: string): void;
  /** Stage a removal (a missing file is fine). */
  remove(rel: string): void;
}
/** Failure injection for tests: a throw from a hook leaves the transaction on disk exactly as a kill at that point would. */
export interface TxnHooks { beforeJournal?: () => void; beforeApply?: () => void; afterOp?: (index: number) => void }
/** durable: false skips the fsync of every staged file (a bulk conversion of fixtures, where a crash means starting again); the journal commit point is still written the same way. */
export interface TxnOptions { hooks?: TxnHooks; lock?: { retries?: number; waitMs?: number }; durable?: boolean }
const NO_FSYNC = { ...fs, fsyncSync: (): void => {} } as unknown as typeof fs;
type Op = { op: 'write'; path: string; stage: string } | { op: 'remove'; path: string };
interface Journal { id: string; ops: Op[] }

/** A path relative to the plan directory: no absolute path, no `..`, no empty or NUL part, never inside the staging area. */
function checkRel(rel: string): string {
  if (typeof rel !== 'string' || !rel || rel.includes('\0') || path.isAbsolute(rel)) throw fail('BAD_PATH', 'transaction path must be a relative path inside the plan directory');
  const parts = rel.split(/[\\/]/);
  if (parts.some((p) => !p || p === '.' || p === '..') || parts[0] === TXN) throw fail('BAD_PATH', 'transaction path must be a relative path inside the plan directory');
  return parts.join('/');
}

function applyOp(root: string, dir: string, op: Op): void {
  const dest = path.join(root, op.path);
  if (op.op === 'remove') { assertInside(root, dest); fs.rmSync(dest, { force: true }); return; }
  const staged = path.join(dir, op.stage);
  if (!fs.existsSync(staged)) return; // already renamed by an earlier, interrupted pass
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  assertInside(root, dest);
  try { if (fs.lstatSync(dest).isSymbolicLink()) throw fail('SYMLINK', `refusing to write through a symlink: ${path.basename(dest)}`); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } // whatever was thrown: read its code
  fs.renameSync(staged, dest);
}

function rollForward(root: string, dir: string, journal: Journal, hooks?: TxnHooks): void {
  hooks?.beforeApply?.();
  journal.ops.forEach((op, i) => { applyOp(root, dir, op); hooks?.afterOp?.(i); });
  fs.rmSync(dir, { recursive: true, force: true });
}

function recoverLocked(root: string): void {
  const base = path.join(root, TXN);
  let names: string[];
  try { names = fs.readdirSync(base).sort(); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; } // whatever was thrown: read its code
  for (const n of names) {
    const dir = path.join(base, n);
    let st: fs.Stats; try { st = fs.lstatSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue; // the lock file
    let journal: Journal | null = null;
    try { journal = JSON.parse(readCapped(path.join(dir, 'journal.json'), 16 << 20, { follow: false })) as Journal; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw fail('BAD_JOURNAL', `transaction ${n} has an unreadable journal; remove .txn/${n} by hand after checking the plan files`); } // an unreadable journal is never guessed at
    if (journal) rollForward(root, dir, journal);
    else fs.rmSync(dir, { recursive: true, force: true }); // never committed: roll back
  }
}

const lockOpts = (o?: TxnOptions) => ({ retries: o?.lock?.retries ?? 1500, waitMs: o?.lock?.waitMs ?? 20 });
const lockPath = (root: string): string => { fs.mkdirSync(path.join(root, TXN), { recursive: true }); return path.join(root, TXN, 'lock'); };

/** Finish or undo an interrupted transaction (called by every withTxn; commands call it at start-up). */
export function recoverTxn(root: string, opts?: TxnOptions): void {
  if (!fs.existsSync(path.join(root, TXN))) return;
  withLock(lockPath(root), () => recoverLocked(root), lockOpts(opts));
}

export function withTxn(root: string, fn: (tx: Txn) => void, opts?: TxnOptions): void {
  withLock(lockPath(root), () => {
    recoverLocked(root);
    const id = `${Date.now().toString(36)}-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
    const dir = path.join(root, TXN, id);
    fs.mkdirSync(dir);
    const ops = new Map<string, { op: 'write'; text: string } | { op: 'remove' }>();
    const list: Op[] = [];
    try { // a failure here (fn threw, bad path, symlink) applied nothing: remove the staging directory
      fn({
        write(rel, text) { ops.set(checkRel(rel), { op: 'write', text: String(text) }); },
        remove(rel) { ops.set(checkRel(rel), { op: 'remove' }); },
      });
      let i = 0;
      for (const p of [...ops.keys()].sort()) {
        const o = ops.get(p) as { op: 'write'; text: string } | { op: 'remove' };
        const dest = path.join(root, p);
        assertInside(root, dest); // refuse an escaping or dangling path before anything is staged for it
        if (o.op === 'remove') { list.push({ op: 'remove', path: p }); continue; }
        try { if (fs.lstatSync(dest).isSymbolicLink()) throw fail('SYMLINK', `refusing to write through a symlink: ${path.basename(dest)}`); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } // whatever was thrown: read its code
        const stage = `f${i++}`;
        writeAtomicSafe(path.join(dir, stage), o.text, opts?.durable === false ? { root, fsImpl: NO_FSYNC } : { root });
        list.push({ op: 'write', path: p, stage });
      }
    } catch (e) { fs.rmSync(dir, { recursive: true, force: true }); throw e; }
    opts?.hooks?.beforeJournal?.(); // test seam: a throw here leaves the staged directory behind, as a kill would
    const journal: Journal = { id, ops: list };
    writeAtomicSafe(path.join(dir, 'journal.json'), `${JSON.stringify(journal)}\n`, { root }); // the commit point
    rollForward(root, dir, journal, opts?.hooks);
  }, lockOpts(opts));
}
