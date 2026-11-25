// Checks what `git archive HEAD` (the release tarball and the plugin install both ship it) contains: nothing that must stay private or local,
// and every file the plugin needs to start. Usage: node scripts/check-package.ts   (exit 1 on a forbidden or a missing path)
import { spawnSync } from 'node:child_process';
import path from 'node:path';

/** directory names that never ship */
const FORBIDDEN_DIRS = new Set(['.baseline', '.superpowers', 'node_modules', 'coverage']);
/** files the installed plugin cannot start without */
export const REQUIRED = Object.freeze(['.claude-plugin/plugin.json', 'bin/plangraph', 'src/entry.js', 'hooks/hooks.json', 'LICENSE', 'README.md']);

/** Whether one archive path is forbidden: a forbidden directory anywhere in it, a sqlite or db file (with journal suffixes), or a .env file (not .env.example). */
function forbidden(p: string): boolean {
  const parts = p.split('/'), base = parts[parts.length - 1] ?? '';
  if (parts.slice(0, -1).some((d) => FORBIDDEN_DIRS.has(d)) || FORBIDDEN_DIRS.has(base)) return true;
  if (/\.(sqlite3?|db)(-wal|-shm|-journal)?$/i.test(base)) return true;
  return /^\.env(\..+)?$/.test(base) && !/\.(example|sample)$/.test(base);
}

/** Forbidden and missing paths of an archive listing (directory entries ending in / are ignored). */
export function checkArchive(paths: readonly string[]): { forbidden: string[]; missing: string[] } {
  const files = paths.map((p) => p.replace(/^\.\//, '')).filter((p) => p !== '' && !p.endsWith('/'));
  const set = new Set(files);
  return { forbidden: files.filter(forbidden), missing: REQUIRED.filter((r) => !set.has(r)) };
}

if (import.meta.main) {
  const root = path.join(import.meta.dirname, '..');
  const tar = spawnSync('git', ['archive', '--format=tar', 'HEAD'], { cwd: root, maxBuffer: 1 << 29 });
  if (tar.status !== 0) { console.error(`git archive failed: ${String(tar.stderr).trim()}`); process.exit(2); }
  const ls = spawnSync('tar', ['-tf', '-'], { input: tar.stdout, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (ls.status !== 0) { console.error(`tar -t failed: ${ls.stderr.trim()}`); process.exit(2); }
  const r = checkArchive(ls.stdout.split('\n'));
  for (const f of r.forbidden) console.error(`forbidden in the archive: ${f}`);
  for (const f of r.missing) console.error(`missing from the archive: ${f}`);
  if (r.forbidden.length || r.missing.length) process.exit(1);
  console.log('package contents ok');
}
