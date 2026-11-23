// Pick the tests worth running for a set of staged files: every test whose import closure (transitive, through lib, src, mcp,
// scripts and bin files) contains a staged file, a staged test itself, and the always-on smoke tests (golden and cli-core).
// Used by the lefthook pre-commit hook. Tests that reach code by path (spawning bin/brain, reading files) have no import edge;
// locally the two smoke tests cover those paths and CI runs the full suite. The result always contains the smoke tests, so
// the piped `xargs node --test` never receives empty input (which would run the whole suite).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SMOKE = /^test\/(golden|cli-core)\.test\.[cm]?[jt]s$/;
const TEST_FILE = /^test\/.+\.test\.[cm]?[jt]s$/;
const EXTS = ['.mjs', '.js', '.ts', '.mts', '.cjs', '.cts'];
const SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"`])(\.{1,2}(?:\/[^'"`\n]*)?)\1/g;

const norm = (p: string) => path.posix.normalize(p.split(path.sep).join('/'));

// Files a specifier could mean: extension swaps (./x.mjs may be a staged x.ts), an added extension, and directory index files.
const variants = (spec: string, importer: string) => {
  const bare = spec.replace(/[?#].*$/, '');
  const resolved = path.posix.join(path.posix.dirname(importer), bare).replace(/\/$/, '');
  const out = new Set([resolved]);
  const ext = path.posix.extname(resolved);
  if (EXTS.includes(ext)) for (const e of EXTS) out.add(resolved.slice(0, -ext.length) + e);
  else for (const e of EXTS) { out.add(resolved + e); out.add(`${resolved}/index${e}`); }
  return [...out];
};

export function relatedTests(staged: string[], allTests: string[], readFile: (f: string) => unknown): string[] {
  const stagedSet = new Set(staged.map(norm));
  const edges = new Map<string, string[][] | null>(); // file -> candidate-file lists, one per specifier; null when unreadable
  const edgesOf = (f: string): string[][] | null => {
    if (edges.has(f)) return edges.get(f) as string[][] | null; // has() above
    let list: string[][] | null = null;
    try { list = [...String(readFile(f)).matchAll(SPEC)].map((m) => variants(m[2], f)); } catch { /* not a readable file */ }
    edges.set(f, list);
    return list;
  };
  const reaches = (test: string) => {
    const seen = new Set([test]), stack = [test];
    while (stack.length) {
      for (const cands of edgesOf(stack.pop() as string) ?? []) { // stack.length was tested
        for (const c of cands) {
          if (stagedSet.has(c)) return true;
          if (!seen.has(c) && edgesOf(c) !== null) { seen.add(c); stack.push(c); }
        }
      }
    }
    return false;
  };
  const out = new Set<string>();
  for (const t of allTests.map(norm)) if (SMOKE.test(t) || stagedSet.has(t) || reaches(t)) out.add(t);
  return [...out].sort();
}

function listTests(dir: string): string[] {
  const found: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.posix.join(dir, e.name);
    if (e.isDirectory()) found.push(...listTests(p));
    else if (TEST_FILE.test(p)) found.push(p);
  }
  return found;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = path.resolve(import.meta.dirname, '..');
  process.chdir(root);
  const rel = process.argv.slice(2).map((f) => norm(path.isAbsolute(f) ? path.relative(root, f) : f));
  const picked = relatedTests(rel, listTests('test'), (f: string) => fs.readFileSync(f, 'utf8'));
  process.stdout.write(picked.join(' ') + (picked.length ? '\n' : ''));
}
