// Safe file writes: root confinement (realpath based), symlink refusal, durable temp+fsync+rename.
// Node built-ins only. No printing, no process.exit. Does not create parent directories.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** @type {(code: string, message: string) => Error & { code: string }} */
const fail = (code, message) => Object.assign(new Error(message), { code });
/** @param {string} m */
const outside = (m) => fail('OUTSIDE_REPO', m);

// realpathSync.native asks the OS for the real spelling (on a case-insensitive volume such as default macOS, a differently-cased path to the
// same place resolves to one spelling), where the JS realpathSync keeps the caller's case.
const realpath = fs.realpathSync.native;
const dangling = () => outside('path contains a dangling symlink');

// Resolve target (which may not exist yet) through real paths and require it to be inside root. Returns the real path of target.
// Walks the path one component at a time with lstat (existsSync follows links, so it cannot tell a dangling link from a missing name):
// a symlink component is resolved with realpath and a DANGLING (or looping) one is refused, because writing "through" it would create
// its target wherever it points; the first component that does not exist ends the walk and the rest is appended lexically.
/** @param {string} root @param {string} target @returns {string} */
export function assertInside(root, target) {
  const r = realpath(root);
  const abs = path.resolve(target), top = path.parse(abs).root;
  const parts = abs.slice(top.length).split(path.sep).filter(Boolean);
  let cur = realpath(top), i = 0;
  for (; i < parts.length; i++) {
    const next = path.join(cur, parts[i]); let st;
    try { st = fs.lstatSync(next); } catch (/** @type {any} */ e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') break; throw e; }
    if (st.isSymbolicLink()) {
      try { cur = realpath(next); } catch (/** @type {any} */ e) { if (e.code === 'ENOENT' || e.code === 'ELOOP' || e.code === 'ENOTDIR') throw dangling(); throw e; }
    } else cur = next;
  }
  const real = path.join(realpath(cur), ...parts.slice(i)); // the existing prefix gets the OS spelling (case) too
  if (real !== r && !real.startsWith(r + path.sep)) throw outside(`path is outside the repository: ${path.relative(r, real).slice(0, 80)}`);
  return real;
}

// Absolute brain directory for dir under root. Rejects absolute dirs and anything escaping root
// (lexically or through a symlink). Returns the LEXICAL absolute path, not the real one: confinement is only enforced later, and only when
// the caller passes { root } to writeAtomicSafe (which re-checks with assertInside at write time). Resolving here is advisory.
// The name also reaches .gitattributes (`<dir>/*.jsonl merge=...`, one pattern per line) and printed lines, so a control character,
// any whitespace (a newline would start a new attribute line) or a gitattributes pattern/comment/quote character is refused with code
// BAD_DIR_NAME; the message never echoes the name.
const BAD_DIR_CHARS = /[\u0000- \u007F-\u009F\s*?[\]\\!#"]/u;
/** @param {string} root @param {string} dir @returns {string} */
export function resolveBrainDir(root, dir) {
  if (BAD_DIR_CHARS.test(String(dir))) throw fail('BAD_DIR_NAME', 'brain directory name has a character that is not allowed (whitespace, control characters and * ? [ ] \\ ! # " are refused)');
  const bad = () => outside(`brain directory is outside the repository: ${String(dir).slice(0, 80)}`);
  if (path.isAbsolute(dir)) throw bad();
  const abs = path.resolve(root, dir);
  const rel = path.relative(path.resolve(root), abs);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw bad();
  try { assertInside(root, abs); } catch (/** @type {any} */ e) { if (e.code === 'OUTSIDE_REPO') throw bad(); throw e; }
  return abs;
}

/** @param {string} file */
const refuseSymlink = (file) => {
  try { if (fs.lstatSync(file).isSymbolicLink()) throw fail('SYMLINK', `refusing to write through a symlink: ${path.basename(file)}`); }
  catch (/** @type {any} */ e) { if (e.code !== 'ENOENT') throw e; }
};

/** @param {string} dir */
function syncDir(dir) {
  if (process.platform === 'win32') return; // fsync on a directory fd is unsupported there
  let dfd;
  try { dfd = fs.openSync(dir, 'r'); fs.fsyncSync(dfd); }
  catch (/** @type {any} */ e) { if (e.code !== 'EINVAL' && e.code !== 'ENOTSUP') throw e; } // exotic filesystems
  finally { if (dfd !== undefined) fs.closeSync(dfd); }
}

// The temp file is created 0644 (minus the umask) and renamed over the target, so a rename resets the target's mode and owner to that;
// fine for these shared data files, which are never meant to carry special modes. A leftover temp from a crash is never reused or removed.
// Known behavior for the CLI wiring: a symlinked target (e.g. the repo .gitignore written by init) is refused with code SYMLINK, so
// callers should catch it and print a clear message instead of a stack trace.
/** @param {string} file @param {string} text @param {{ root?: string }} [opts] */
export function writeAtomicSafe(file, text, { root } = {}) {
  if (root) assertInside(root, file);
  refuseSymlink(file);
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    const fd = fs.openSync(tmp, 'wx', 0o644);
    try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    // Re-validate right before the rename. rename(2) replaces a symlink itself rather than following it,
    // so this is defense in depth, not the only guard.
    refuseSymlink(file);
    fs.renameSync(tmp, file);
  } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
  syncDir(path.dirname(file));
}
