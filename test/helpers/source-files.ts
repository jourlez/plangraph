// The one definition of "a plugin source file" for tests that walk the tree, whatever the extension: .mjs and .ts, plus the plain-JavaScript files in src/ (the
// Node floor guard and the two entry points). A walker that filters on one extension silently finds nothing after the rename.
import fs from 'node:fs';
import path from 'node:path';

/** rel: posix path relative to the repo root */
export const isSourceFile = (rel: string): boolean => /\.(mjs|ts)$/.test(rel) || /^src\/[^/]+\.js$/.test(rel);

/** Source files under the given directories (recursive), as posix paths relative to `root`, sorted. */
export function sourceFilesIn(root: string, dirs: string[]): string[] {
  const out: string[] = [];
  for (const d of dirs) {
    for (const f of fs.readdirSync(path.join(root, d), { recursive: true, encoding: 'utf8' })) {
      const rel = `${d}/${f.split(path.sep).join('/')}`;
      if (isSourceFile(rel) && fs.statSync(path.join(root, rel)).isFile()) out.push(rel);
    }
  }
  return out.sort();
}
