// A private temp dir for a test that runs the real Claude Code binary: the binary makes its own work dirs (`e-XXXXXX`, with a `sealed`
// subdirectory of mode 000) under TMPDIR and leaves them behind. Point TMPDIR at `tmpdir` (inside this dir) and call remove() in a
// finally: it makes every DIRECTORY inside this dir traversable and writable again (u+rwx, symlinks never followed) and deletes the dir.
// It only ever touches the dir it created (an mkdtemp under os.tmpdir() with the given prefix), never anything outside it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** @param {string} prefix @returns {{ dir: string, tmpdir: string, remove(): void }} */
export function sealedTmp(prefix) {
  const base = fs.realpathSync(os.tmpdir()), dir = fs.mkdtempSync(path.join(base, prefix)), tmpdir = path.join(dir, 'tmp');
  fs.mkdirSync(tmpdir);
  const remove = () => {
    if (path.dirname(dir) !== base || !path.basename(dir).startsWith(prefix)) throw new Error('sealedTmp: refusing to remove a dir it did not create');
    const open = (/** @type {string} */ d) => {
      let st; try { st = fs.lstatSync(d); } catch { return; }
      if (!st.isDirectory()) return; // files and symlinks: removed by rmSync below, never followed or chmodded
      try { fs.chmodSync(d, st.mode | 0o700); } catch { /* not ours: rmSync reports it */ }
      for (const n of fs.readdirSync(d)) open(path.join(d, n));
    };
    open(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { dir, tmpdir, remove };
}
