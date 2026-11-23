// Mechanical .mjs to .ts rename for the TypeScript migration (dev tool, no dependencies).
//   node scripts/ts-migrate.ts [--dry-run] <repo-relative .mjs file>...
// migrate() does two things, in this order (after validating the WHOLE batch: nothing moves unless every file passes):
//   1. `git mv` each file from .mjs to .ts.
//   2. Rewrite references to the renamed files:
//      a. in every tracked CODE file (.mjs .ts .js .cjs .mts and extension-less node shebang files): every quoted literal (single, double or
//         backtick quote, no `${` inside) that starts with ./ or ../ is resolved against the importing file's directory and rewritten when it
//         resolves to a renamed file; a ?query or #hash suffix is kept. That covers import/export-from/bare import/dynamic import (also in a
//         template literal without substitutions), new URL('./x.mjs', import.meta.url), require(), import.meta.resolve() and
//         path.join(root, './x.mjs'), because it keys on the literal, not on the call;
//      b. in every tracked TEXT file except test/fixtures/**: each exact repo-relative path of a renamed file (package.json, knip.json,
//         tsconfig.json, lefthook.yml, .github/**, hooks, plugin manifests, docs, test/golden/**, and plain 'lib/x.mjs' literals in code).
//         A leading ./ counts in docs only; in code it was handled by 2a.
// Never by basename alone: `other/b.mjs` is untouched when `lib/b.mjs` moves; neither are `sub/lib/b.mjs`, `lib/b.mjs.bak` or `lib/b.mjs2`.
// test/fixtures/**, binary files (a NUL byte), symlinks and files over 8 MiB are never touched.
// A file is rewritten only if its bytes are valid UTF-8 (round-trip); otherwise it is left alone and listed in `skipped`, as is a tracked
// file missing from the working tree.
// Deterministic and idempotent: a file whose .mjs is gone but whose .ts exists counts as already renamed (so a rerun after a crash finishes
// the rewrite), and a second call on a finished migration renames and rewrites nothing.
// NOT handled: a path built at run time (path.join(dir, 'b.mjs'), 'b' + '.mjs'), a literal containing ${...}, a reference that is neither a
// quoted literal nor an exact repo-relative path (for example a glob such as src/**/*.mjs); the type check and the tests find those.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const CODE_EXT = new Set(['.mjs', '.ts', '.js', '.cjs', '.mts']);
const MAX_BYTES = 8 << 20;
// a quoted relative literal: single, double or backtick quote, starting with ./ or ../
const RELATIVE_LITERAL = /(['"`])(\.{1,2}\/[^'"`\n]*)\1/g;

const posix = (p: string) => p.split(path.sep).join('/');
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function git(root: string, args: string[]) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26 });
}

function trackedFiles(root: string): string[] {
  return git(root, ['ls-files', '-z']).split('\0').filter(Boolean);
}

function isCode(rel: string, text: string) {
  const ext = path.extname(rel);
  if (ext === '') return text.startsWith('#!') && /^#!.*\bnode\b/.test(text.split('\n', 1)[0] ?? '');
  return CODE_EXT.has(ext);
}

const isFixture = (rel: string) => rel === 'test/fixtures' || rel.startsWith('test/fixtures/');

/** `files`: repo-relative .mjs paths */
export function migrate(files: string[], opts: { root: string; dryRun?: boolean }): { renamed: string[]; rewritten: string[]; skipped: string[] } {
  const root = path.resolve(opts.root);
  const dryRun = opts.dryRun === true;
  const wanted = [...new Set(files.map((f) => posix(path.normalize(f))))].sort();
  for (const f of wanted) {
    if (!f.endsWith('.mjs') || path.isAbsolute(f) || f.startsWith('..')) throw new Error(`ts-migrate: not a repo-relative .mjs path: ${f}`);
  }
  const renamed: string[] = [];
  /** old paths whose rename is done (now or earlier) */ const migrated = new Set<string>();
  const before = new Set(trackedFiles(root));
  // validate the whole batch first: nothing may move unless every file passes
  const toMove: string[] = [];
  for (const f of wanted) {
    const target = `${f.slice(0, -'.mjs'.length)}.ts`;
    if (before.has(f)) {
      if (before.has(target) || fs.existsSync(path.join(root, target))) throw new Error(`ts-migrate: ${target} already exists`);
      toMove.push(f);
    } else if (!before.has(target)) {
      throw new Error(`ts-migrate: not a tracked file: ${f}`);
    }
    migrated.add(f); // a target already tracked with no source: renamed by an earlier run, still rewrite what points at it
  }
  for (const f of toMove) {
    if (!dryRun) git(root, ['mv', '--', f, `${f.slice(0, -'.mjs'.length)}.ts`]);
    renamed.push(f);
  }
  if (migrated.size === 0) return { renamed: [], rewritten: [], skipped: [] };

  // dry run: nothing moved, so the files still sit at their old names
  const current = dryRun ? [...before] : trackedFiles(root);
  const oldNames = [...migrated].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  const pathRe = new RegExp(`(?<![A-Za-z0-9_./-])(\\.\\/)?(${oldNames.map(escapeRe).join('|')})(?![A-Za-z0-9_-])(?!\\.[A-Za-z0-9])`, 'g');
  const toTs = (p: string) => `${p.slice(0, -'.mjs'.length)}.ts`;

  const rewritten: string[] = [], skipped: string[] = [];
  for (const rel of current.sort()) {
    if (isFixture(rel)) continue;
    const abs = path.join(root, rel);
    let st: fs.Stats;
    try { st = fs.lstatSync(abs); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') { skipped.push(rel); continue; } // tracked but deleted from the working tree
      throw e;
    }
    if (!st.isFile() || st.size > MAX_BYTES) continue;
    const buf = fs.readFileSync(abs);
    if (buf.subarray(0, 8000).includes(0)) continue; // binary
    const text = buf.toString('utf8');
    const code = isCode(rel, text);
    // a rename keeps the directory, so the importing file's current directory is where its specifiers resolve
    const dir = path.posix.dirname(rel);
    let out = text;
    if (code) {
      out = out.replace(RELATIVE_LITERAL, (all, quote, lit) => {
        if (lit.includes('${')) return all;
        const cut = lit.search(/[?#]/), spec = cut < 0 ? lit : lit.slice(0, cut), suffix = cut < 0 ? '' : lit.slice(cut);
        const resolved = path.posix.normalize(path.posix.join(dir, spec));
        return migrated.has(resolved) ? `${quote}${toTs(spec)}${suffix}${quote}` : all;
      });
    }
    out = out.replace(pathRe, (all, dot, p) => {
      // a leading ./ is a root-relative doc path; in code it is a specifier relative to the importing file (step 2a owns those)
      if (dot !== undefined) return code ? all : `${dot}${toTs(p)}`;
      return toTs(p); // the lookbehind already rejects the tail of a longer path such as ../lib/b.mjs or sub/lib/b.mjs
    });
    if (out !== text) {
      if (!Buffer.from(text, 'utf8').equals(buf)) { skipped.push(rel); continue; } // not valid UTF-8: a rewrite would corrupt it
      if (!dryRun) fs.writeFileSync(abs, out);
      rewritten.push(rel);
    }
  }
  return { renamed: renamed.sort(), rewritten: rewritten.sort(), skipped: skipped.sort() };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const files = args.filter((a) => a !== '--dry-run');
  if (files.length === 0 || files.some((a) => a.startsWith('-'))) {
    console.error('usage: node scripts/ts-migrate.ts [--dry-run] <repo-relative .mjs file>...');
    process.exit(2);
  }
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: process.cwd(), encoding: 'utf8' }).trim();
    const cwdRel = posix(path.relative(root, process.cwd()));
    const repoRel = files.map((f) => posix(path.join(cwdRel, f)));
    const r = migrate(repoRel, { root, dryRun });
    console.log(`${dryRun ? 'would rename' : 'renamed'} ${r.renamed.length} file(s), ${dryRun ? 'would rewrite' : 'rewrote'} ${r.rewritten.length} file(s)`);
    for (const f of r.rewritten) console.log(`  ${f}`);
    for (const f of r.skipped) console.log(`  skipped (not valid UTF-8, or missing from the working tree): ${f}`);
  } catch (e) {
    console.error((e as Error).message); // whatever was thrown
    process.exit(1);
  }
}
