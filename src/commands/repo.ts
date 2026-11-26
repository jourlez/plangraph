// plangraph repo scan [PATH] [--all] [--check]: derive repos.jsonl rows from allowlisted files of a git repository (lib/graph/repo.ts has the
// parsers). Reads tracked blobs through `git` only (no script, package manager or other subprocess), never follows a symlink, writes only
// repos.jsonl. --check writes nothing and exits 1 when a row is missing or its fingerprint drifted. --all scans each child directory of PATH that is a repository.
import fs from 'node:fs';
import path from 'node:path';
import { makeGit } from '../../lib/gitsafe.ts';
import { oneLine } from '../../lib/sanitize.ts';
import { isoDay } from '../../lib/clock.ts';
import { canonFile, readRecords, SCHEMAS } from '../../lib/store.ts';
import { MAX_FILE, isScanFile, mergeRow, scanRepo, slugOf } from '../../lib/graph/repo.ts';
import type { ScanFile, Row } from '../../lib/graph/repo.ts';
import { needBrain, precheckTargets, usage, writeState } from './shared.ts';
import type { Ctx, Args } from '../context.ts';
import type { CommandMap } from '../registry.ts';

const MAX_REPOS = 200;
const SAFE_GIT = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null']; // a hostile .git/config must not start a program
const isRepoDir = (p: string): boolean => { try { return !fs.lstatSync(p).isSymbolicLink() && fs.lstatSync(path.join(p, '.git')).isDirectory(); } catch { return false; } };

/** Tracked files of one repository: the allowlisted ones read from their blobs, every path for the language count. */
function readRepo(dir: string): { files: ScanFile[]; paths: string[] } {
  const git = makeGit(dir), files: ScanFile[] = [], paths: string[] = [];
  for (const rec of git(...SAFE_GIT, 'ls-files', '-s', '-z').split('\0')) {
    const m = /^(\d{6}) ([0-9a-f]{40}) 0\t([\s\S]+)$/.exec(rec);
    if (!m || m[1] === '120000' || m[1] === '160000') continue; // a symlink or a submodule is never read
    const [, , sha, p] = m as unknown as [string, string, string, string];
    paths.push(p);
    if (!isScanFile(p)) continue;
    if (Number(git(...SAFE_GIT, 'cat-file', '-s', sha)) > MAX_FILE) { files.push({ path: p, sha }); continue; }
    const text = git(...SAFE_GIT, 'cat-file', 'blob', sha);
    files.push({ path: p, sha, text });
  }
  return { files, paths };
}

async function repo(ctx: Ctx, args: Args<{ all?: boolean; check?: boolean }>): Promise<number> {
  const [sub, target] = args.positionals, check = Boolean(args.values.check);
  if (sub !== 'scan') throw usage('repo needs a subcommand: scan [PATH] [--all] [--check]');
  const base = path.resolve(target ?? ctx.root);
  let dirs: string[];
  if (args.values.all) {
    let names: string[] = []; try { names = fs.readdirSync(base).sort(); } catch { throw usage(`cannot read ${oneLine(target ?? '.', 80)}`); }
    dirs = names.map((n) => path.join(base, n)).filter(isRepoDir).slice(0, MAX_REPOS);
    if (!dirs.length) throw usage('--all found no git repository directly under the path');
  } else {
    if (!isRepoDir(base)) throw usage('the path is not a git repository');
    dirs = [base];
  }
  needBrain(ctx);
  const file = path.join(ctx.dir, 'repos.jsonl'), existing = readRecords(ctx.dir, 'repos.jsonl', { defaults: false });
  const people = new Set(readRecords(ctx.dir, 'people.jsonl', { defaults: false }).map((p) => p.id).filter((i): i is string => typeof i === 'string'));
  const day = isoDay(ctx.now());
  const rows = new Map<string, Row>(existing.map((r) => [String(r.id), r])), seen = new Set<string>();
  let drift = 0;
  for (const dir of dirs) {
    const slug = slugOf(path.basename(dir));
    if (!slug) throw usage('the directory name gives no usable repository id');
    const { files, paths } = (() => { try { return readRepo(dir); } catch { throw usage(`cannot read repository ${oneLine(path.basename(dir), 80)}`); } })();
    const { row, warnings } = scanRepo({ slug, files, paths, people });
    const id = row.id as string;
    if (seen.has(id)) throw usage(`two repositories give the id ${id}`);
    seen.add(id);
    for (const w of warnings) ctx.io.err(`warning: ${id}: ${oneLine(w, 120)}`);
    const old = rows.get(id);
    if (check) {
      const same = old !== undefined && old.fp === row.fp;
      if (!same) drift++;
      ctx.io.out(`${id}: ${same ? 'ok' : old ? `drift (fp ${String(old.fp ?? '').slice(0, 8)} -> ${String(row.fp).slice(0, 8)})` : 'missing from repos.jsonl'}`);
      continue;
    }
    rows.set(id, mergeRow(old, { ...row, scanned_at: day }));
    ctx.io.out(`${id}: scanned (fp ${String(row.fp).slice(0, 8)})`);
  }
  if (check) return drift ? 1 : 0;
  precheckTargets(ctx, [file]);
  writeState(ctx, file, canonFile([...rows.values()], SCHEMAS['repos.jsonl']));
  return 0;
}

export const commands: CommandMap = {
  repo: {
    run: repo as never, positionals: [0, 2], writes: 'text', guard: 'strict',
    options: { all: { type: 'boolean' }, check: { type: 'boolean' } },
    summary: 'scan [PATH] [--all] [--check]: derive repos.jsonl rows from manifests, CODEOWNERS and tool versions (git only, no scripts run); --check exits 1 on drift',
  },
};
