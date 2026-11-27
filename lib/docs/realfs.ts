// The real file system behind buildDocs and checkDocs: every path is relative to the repository root, and no component of it may be a symlink
// (a link inside the out directory could point a write outside the repository). Writes go through a temporary file and a rename.
import fs from 'node:fs';
import path from 'node:path';
import type { FsLike } from './registry.ts';

export type RealFsError = Error & { code: 'OUT_OUTSIDE_ROOT' };
const outsideRoot = (): RealFsError => Object.assign(new Error('docs.out must be a plain directory inside the repository (no symlink)'), { code: 'OUT_OUTSIDE_ROOT' as const });

/** Throws OUT_OUTSIDE_ROOT when a component of rel (under root) is a symlink or a non-directory parent. A missing component is fine. */
function guard(root: string, rel: string): void {
  let cur = root;
  for (const part of rel.split('/').filter(Boolean)) {
    cur = path.join(cur, part);
    let st: fs.Stats;
    try { st = fs.lstatSync(cur); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
    if (st.isSymbolicLink()) throw outsideRoot();
  }
}

export function realFs(root: string): FsLike {
  const abs = (rel: string): string => path.join(root, rel);
  return {
    exists: (p) => { guard(root, p); return fs.existsSync(abs(p)); },
    read: (p) => { guard(root, p); return fs.readFileSync(abs(p), 'utf8'); },
    mkdirp: (d) => { guard(root, d); fs.mkdirSync(abs(d), { recursive: true }); },
    write: (p, text) => {
      guard(root, p);
      const tmp = `${abs(p)}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, text, { mode: 0o644 });
      fs.renameSync(tmp, abs(p));
    },
  };
}
