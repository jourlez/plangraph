// Safe file writes: root confinement (realpath based), symlink refusal, durable temp+fsync+rename.
// Node built-ins only. No printing, no process.exit. Does not create parent directories.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const fail = (code: string, message: string): Error & { code: string } => Object.assign(new Error(message), { code });
const outside = (m: string) => fail('OUTSIDE_REPO', m);

// realpathSync.native asks the OS for the real spelling (on a case-insensitive volume such as default macOS, a differently-cased path to the
// same place resolves to one spelling), where the JS realpathSync keeps the caller's case.
const realpath = fs.realpathSync.native;
const dangling = () => outside('path contains a dangling symlink');

// Resolve target (which may not exist yet) through real paths and require it to be inside root. Returns the real path of target.
// Walks the path one component at a time with lstat (existsSync follows links, so it cannot tell a dangling link from a missing name):
// a symlink component is resolved with realpath and a DANGLING (or looping) one is refused, because writing "through" it would create
// its target wherever it points; the first component that does not exist ends the walk and the rest is appended lexically.
export type SafePath = string & { readonly __brand: 'SafePath' };
export function assertInside(root: string, target: string): SafePath {
  const r = realpath(root);
  const abs = path.resolve(target), top = path.parse(abs).root;
  const parts = abs.slice(top.length).split(path.sep).filter(Boolean);
  let cur = realpath(top), i = 0;
  for (; i < parts.length; i++) {
    const next = path.join(cur, parts[i] as string); let st: fs.Stats; // i < parts.length (loop bound)
    try { st = fs.lstatSync(next); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'ENOTDIR') break; throw e; } // whatever was thrown: read its code
    if (st.isSymbolicLink()) {
      try { cur = realpath(next); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'ELOOP' || (e as NodeJS.ErrnoException).code === 'ENOTDIR') throw dangling(); throw e; } // whatever was thrown: read its code
    } else cur = next;
  }
  const real = path.join(realpath(cur), ...parts.slice(i)); // the existing prefix gets the OS spelling (case) too
  if (real !== r && !real.startsWith(r + path.sep)) throw outside(`path is outside the repository: ${path.relative(r, real).slice(0, 80)}`);
  return real as SafePath; // confinement to root was checked on the line above
}

// Absolute plan directory for dir under root. Rejects absolute dirs and anything escaping root
// (lexically or through a symlink). Returns the LEXICAL absolute path, not the real one: confinement is only enforced later, and only when
// the caller passes { root } to writeAtomicSafe (which re-checks with assertInside at write time). Resolving here is advisory.
// The name also reaches hook output and printed lines, so a control character,
// any whitespace or a pattern, comment or quote character is refused with code
// BAD_DIR_NAME; the message never echoes the name.
const BAD_DIR_CHARS = /[\u0000- \u007F-\u009F\s*?[\]\\!#"]/u;
export function resolveBrainDir(root: string, dir: string): SafePath {
  if (BAD_DIR_CHARS.test(String(dir))) throw fail('BAD_DIR_NAME', 'plan directory name has a character that is not allowed (whitespace, control characters and * ? [ ] \\ ! # " are refused)');
  const bad = () => outside(`plan directory is outside the repository: ${String(dir).slice(0, 80)}`);
  if (path.isAbsolute(dir)) throw bad();
  const abs = path.resolve(root, dir);
  const rel = path.relative(path.resolve(root), abs);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw bad();
  try { assertInside(root, abs); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'OUTSIDE_REPO') throw bad(); throw e; } // whatever was thrown: read its code
  return abs as SafePath; // lexical path checked against root above
}

const refuseSymlink = (file: string, f: typeof fs = fs) => {
  try { if (f.lstatSync(file).isSymbolicLink()) throw fail('SYMLINK', `refusing to write through a symlink: ${path.basename(file)}`); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } // whatever was thrown: read its code
};
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0; // 0 on Windows: the identity checks are the guard there
const same = (a: fs.Stats, b: fs.Stats) => a.dev === b.dev && a.ino === b.ino;
const swapped = (what: string) => fail('SWAPPED', `refusing to write: ${what} changed while it was being written`);

function syncDir(dir: string) {
  if (process.platform === 'win32') return; // fsync on a directory fd is unsupported there
  let dfd: number | undefined;
  try { dfd = fs.openSync(dir, 'r'); fs.fsyncSync(dfd); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EINVAL' && (e as NodeJS.ErrnoException).code !== 'ENOTSUP') throw e; } // exotic filesystems
  finally { if (dfd !== undefined) fs.closeSync(dfd); }
}

// The temp file is created 0644 (minus the umask) and renamed over the target, so a rename resets the target's mode and owner to that;
// fine for these shared data files, which are never meant to carry special modes. `mode` overrides 0644 for private outputs (Jira data: 0600). A leftover temp from a crash is never reused or removed.
// Known behavior for the CLI wiring: a symlinked target (e.g. the repo .gitignore written by init) is refused with code SYMLINK, so
// callers should catch it and print a clear message instead of a stack trace.
// Races (docs/CONTRACT.md, "Symlink and swap races"), closed as far as Node allows without openat:
// - the directory is confirmed once (stat, after the root check) and its dev/ino re-compared after the temp file is created and again right
//   before the rename: a directory swapped for a symlink to elsewhere is refused (SWAPPED);
// - the temp file is created with O_CREAT|O_EXCL|O_NOFOLLOW, so a planted file or symlink at its name is never written through;
// - right before the rename the destination is lstat'ed again (a symlink is refused) and the temp path's lstat must be the open fd (fstat);
// - after the rename the destination's lstat must be the fd we wrote (else SWAPPED: something replaced it in between; the bytes went into
//   the confirmed directory only). rename(2) replaces a symlink at the destination itself, never its target.
// fsImpl (default node:fs) is injectable so a test can swap files at an exact point.
export function writeAtomicSafe(file: string, text: string, { root, fsImpl: f = fs, mode = 0o644 }: { root?: string | undefined; fsImpl?: typeof fs; mode?: number } = {}): void {
  if (root) assertInside(root, file);
  refuseSymlink(file, f);
  const dir = path.dirname(file);
  const dst = f.statSync(dir);
  if (!dst.isDirectory()) throw fail('ENOTDIR', 'parent is not a directory');
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  let fd: number | undefined;
  try {
    fd = f.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, mode);
    const mine = f.fstatSync(fd);
    if (!same(f.statSync(dir), dst)) throw swapped('the directory');
    f.writeFileSync(fd, text); f.fsyncSync(fd);
    // Re-validate right before the rename: the destination (no symlink), the directory and the temp file (still the fd we wrote).
    refuseSymlink(file, f);
    if (!same(f.statSync(dir), dst)) throw swapped('the directory');
    if (!same(f.lstatSync(tmp), mine)) throw swapped('the temp file');
    f.renameSync(tmp, file);
    if (!same(f.lstatSync(file), mine)) throw swapped('the destination');
  } catch (e) {
    try { if (f.lstatSync(tmp).isFile()) f.rmSync(tmp, { force: true }); } catch { /* gone */ } // never remove what we did not create
    throw e;
  } finally { if (fd !== undefined) f.closeSync(fd); }
  syncDir(dir);
}
