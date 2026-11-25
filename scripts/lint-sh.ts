// Runs shellcheck over every tracked shell script (a .sh file or a file whose first line is an sh or bash shebang).
// Without shellcheck on PATH it prints a notice and exits 0; with PLANGRAPH_REQUIRE_TOOLS=1 that is an error (exit 1).
// Usage: npm run lint:sh   (node scripts/lint-sh.ts)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** shellcheck codes accepted per file, each with its reason */
export const EXCLUDE: Readonly<Record<string, { codes: readonly string[]; why: string }>> = Object.freeze({
  'test/smoke.sh': {
    codes: ['SC2010', 'SC2015', 'SC2016', 'SC2034', 'SC2155'],
    why: 'the smoke test uses `check && check || fail name` as its assertion idiom and a throw-away environment; none of these can hide a bug there',
  },
});

/** Whether a first line is a shell shebang. */
export function isShellShebang(first: string): boolean {
  return /^#!\s*\S*\/(env\s+(-S\s+)?)?(ba|da|k|z)?sh\b/.test(first);
}

/** Tracked files that shellcheck should read. */
export function shellFiles(root: string): string[] {
  const ls = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26 });
  if (ls.status !== 0) throw new Error(`git ls-files failed: ${ls.stderr}`);
  return ls.stdout.split('\0').filter((f) => f !== '' && (f.endsWith('.sh') || isShellShebang(firstLine(path.join(root, f)))));
}

function firstLine(file: string): string {
  try {
    const fd = fs.openSync(file, 'r');
    try { const b = Buffer.alloc(120); const n = fs.readSync(fd, b, 0, 120, 0); return b.subarray(0, n).toString('latin1').split('\n')[0] ?? ''; } finally { fs.closeSync(fd); }
  } catch { return ''; }
}

if (import.meta.main) {
  const root = path.join(import.meta.dirname, '..');
  const have = spawnSync('shellcheck', ['--version'], { encoding: 'utf8' });
  if (have.error || have.status !== 0) {
    if (process.env.PLANGRAPH_REQUIRE_TOOLS === '1') { console.error('lint:sh: shellcheck is not installed and PLANGRAPH_REQUIRE_TOOLS=1'); process.exit(1); }
    console.log('lint:sh: shellcheck is not installed, skipped (set PLANGRAPH_REQUIRE_TOOLS=1 to fail instead)');
    process.exit(0);
  }
  let bad = 0;
  const files = shellFiles(root);
  for (const f of files) {
    const ex = EXCLUDE[f];
    const r = spawnSync('shellcheck', [...(ex ? ['--exclude', ex.codes.join(',')] : []), f], { cwd: root, stdio: 'inherit' });
    if (r.status !== 0) bad++;
  }
  console.log(`lint:sh: ${files.length} scripts, ${bad} with findings`);
  process.exit(bad ? 1 : 0);
}
