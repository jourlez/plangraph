// Freezes the runtime files of a release (any tree-ish: a tag, or the release commit) into a test fixture directory, so mixed-version
// tests can run the released merge driver and CLI without tags or history (CI checks out one commit only).
// Usage: node scripts/freeze-release.ts <tree-ish> <out-dir>
// It copies bin/, lib/, src/, mcp/, seed/, solver/ and package.json from `git archive <tree-ish>` and writes `TREE` (the git tree id of the
// tree-ish: the squash commit of a release has the same tree id as the release candidate it replaces). Directories it owns inside <out-dir>
// are replaced; nothing else there is touched. Exit 0 done, 2 usage or git failure.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** What a frozen release keeps: the runtime a user runs, nothing that is only needed to develop it. */
export const FROZEN_PATHS = Object.freeze(['bin', 'lib', 'src', 'mcp', 'seed', 'solver', 'package.json']);

/** Freezes `rev` of the repository at `root` into `out`; returns the tree id. Throws an Error with a plain message on any failure. */
export function freeze(root: string, rev: string, out: string): string {
  if (!rev || rev.startsWith('-')) throw new Error('the tree-ish must be a revision, not an option');
  const tree = spawnSync('git', ['rev-parse', '--verify', '--end-of-options', `${rev}^{tree}`], { cwd: root, encoding: 'utf8' });
  if (tree.status !== 0) throw new Error(`not a revision: ${rev}`);
  const tar = spawnSync('git', ['archive', '--format=tar', rev, '--', ...FROZEN_PATHS], { cwd: root, maxBuffer: 1 << 29 });
  if (tar.status !== 0) throw new Error(`git archive failed: ${String(tar.stderr).trim()}`);
  for (const p of FROZEN_PATHS) fs.rmSync(path.join(out, p), { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const x = spawnSync('tar', ['-xf', '-', '-C', out], { input: tar.stdout });
  if (x.status !== 0) throw new Error(`tar failed: ${String(x.stderr).trim()}`);
  const id = tree.stdout.trim();
  fs.writeFileSync(path.join(out, 'TREE'), `${id}\n`);
  return id;
}

if (import.meta.main) {
  const [rev, out] = process.argv.slice(2);
  if (!rev || !out || process.argv.length !== 4) { console.error('usage: node scripts/freeze-release.ts <tree-ish> <out-dir>'); process.exit(2); }
  try { console.log(`frozen ${rev} (tree ${freeze(path.resolve(import.meta.dirname, '..'), rev, path.resolve(out))}) into ${out}`); } catch (e) { console.error((e as Error).message); process.exit(2); }
}
