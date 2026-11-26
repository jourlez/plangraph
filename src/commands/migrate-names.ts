// plangraph migrate-names [--apply]: the one explicit bridge from the names used before the rename to plangraph (lib/migrate-names.ts has the
// rules). Dry run unless --apply. Never run by a hook or by any other command. Exit 4 when anything was refused, else 0.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readDataCapped } from '../../lib/jsonl.ts';
import { writeAtomicSafe } from '../../lib/fsafe.ts';
import { oneLine } from '../../lib/sanitize.ts';
import { configDir } from '../jira-tenant.ts';
import { BIN } from './shared.ts';
import type { Ctx, Args } from '../context.ts';
import type { CommandMap } from '../registry.ts';
import type { Entry, MigrateFs, MigrateGit } from '../../lib/migrate-names.ts';

const kindOf = (st: fs.Stats): Entry['kind'] => (st.isSymbolicLink() ? 'symlink' : st.isFile() ? 'file' : st.isDirectory() ? 'dir' : 'other');
/** The real file system behind lib/migrate-names.ts: lstat only, reads never follow a symlink, the copy is exclusive and 0600. */
export const realFs = (root: string | null, io: Pick<typeof fs, 'openSync' | 'fchmodSync' | 'writeSync' | 'fsyncSync' | 'closeSync' | 'fstatSync' | 'lstatSync' | 'unlinkSync'> = fs): MigrateFs => ({
  lstat(p) { try { const st = fs.lstatSync(p); return { kind: kindOf(st), size: st.size }; } catch { return null; } },
  read: (p, max) => readDataCapped(p, max),
  copyPrivate(src, dst) {
    const data = readDataCapped(src, 64 * 1024);
    const fd = io.openSync(dst, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    try { io.fchmodSync(fd, 0o600); io.writeSync(fd, data); io.fsyncSync(fd); }
    catch (e) {
      // a failed copy must not leave a partial file that makes the retry see "exists": remove dst, but only when it is still the file this fd created
      try { const a = io.fstatSync(fd), b = io.lstatSync(dst); if (a.ino === b.ino && a.dev === b.dev) io.unlinkSync(dst); } catch { /* dst is gone or replaced: nothing of ours to remove */ }
      throw e;
    } finally { io.closeSync(fd); }
  },
  mkdirPrivate(dir) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); },
  rename(from, to) { fs.renameSync(from, to); },
  write(p, text) { writeAtomicSafe(p, text, root ? { root } : {}); },
});
/** git in `root`, never throwing: the same environment as the merge-driver install (no prompt, no editor). */
const realGit = (root: string): MigrateGit => (args) => {
  try { return { ok: true, out: execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', LC_ALL: 'C' } }) }; }
  catch { return { ok: false, out: '' }; }
};

async function migrateNames(ctx: Ctx, args: Args<{ apply?: boolean }>): Promise<number> {
  const [M, D, S] = await Promise.all([import('../../lib/migrate-names.ts'), import('../../lib/driver.ts'), import('../../lib/store.ts')]);
  const home = ctx.env.HOME || os.homedir(), apply = Boolean(args.values.apply);
  const isRepo = fs.existsSync(path.join(ctx.root, '.git'));
  const plan = M.planMigration({
    home, oldConfigDir: M.oldConfigDir(ctx.env, home), newConfigDir: configDir(ctx.env), root: isRepo ? ctx.root : null,
    fs: realFs(isRepo ? ctx.root : null), git: realGit(ctx.root),
    driverCommand: () => S.mergeDriverCommand(D.ensureStableDriver({ dataDir: D.defaultDataDir(ctx.env), target: path.join(BIN, 'plangraph-merge'), nodePath: process.execPath })),
  });
  const result = apply ? M.applyMigration(plan) : undefined;
  ctx.io.outBlock(M.report(plan, { apply, home, ...(result ? { result } : {}) }).map((l) => oneLine(l, 400)));
  return result?.failed ? 5 : plan.refused.length ? 4 : 0;
}

const WIRING = Object.freeze(['git-config', 'gitattributes', 'merge-shim']);
export const commands: CommandMap = {
  'migrate-names': { run: migrateNames, positionals: [0, 0], writes: 'text', guard: 'none', options: { apply: { type: 'boolean', writes: WIRING } }, summary: 'move state from the old names to the plangraph names: dry run lists changes; --apply copies the user config (jira-sites.json, autopilot.json), renames the rc file and plan directory, rewrites .gitignore and .gitattributes, rewires git config' },
};
