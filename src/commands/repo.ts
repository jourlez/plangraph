// plangraph repo link TICKET REPO [--conf N --why T] | link --auto | catalog [PATH] [--write]; plangraph repo scan [PATH] [--all] [--check]: derive repos.jsonl rows from allowlisted files of a git repository (lib/graph/repo.ts has the
// parsers). Reads tracked blobs through `git` only (no script, package manager or other subprocess), never follows a symlink, writes only
// repos.jsonl. --check writes nothing and exits 1 when a row is missing or its fingerprint drifted. --all scans each child directory of PATH that is a repository.
import fs from 'node:fs';
import path from 'node:path';
import { makeGit } from '../../lib/gitsafe.ts';
import { oneLine } from '../../lib/sanitize.ts';
import { isoDay } from '../../lib/clock.ts';
import { openStore } from '../../lib/planstore.ts';
import { MAX_FILE, isScanFile, mergeRow, scanRepo, slugOf } from '../../lib/graph/repo.ts';
import { touchesFor } from '../../lib/graph/touches.ts';
import { parseCatalogInfo } from '../../lib/graph/catalog.ts';
import type { ScanFile, Row } from '../../lib/graph/repo.ts';
import { needBrain, usage } from './shared.ts';
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

type Opts = { all?: boolean; check?: boolean; auto?: boolean; write?: boolean; conf?: number; why?: string };
const TICKET = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,115}$/;
const asStrings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** `repo link TICKET REPO [--conf N --why T]` and `repo link --auto`: `touches` links (trace only), never overwriting an existing link of the pair. */
function link(ctx: Ctx, args: Args<Opts>): number {
  const [, ticket, repoArg] = args.positionals, { auto, conf, why } = args.values;
  needBrain(ctx);
  const store = openStore(ctx);
  const repos = store.readKind('repo', { defaults: false }), links = store.readKind('link', { defaults: false });
  const has = (from: string, to: string): boolean => links.some((l) => l.rel === 'touches' && l.from === from && l.to === to);
  const add: Row[] = [], say: string[] = [];
  if (auto) {
    if (ticket !== undefined || conf !== undefined || why !== undefined) throw usage('repo link --auto takes no TICKET, REPO, --conf or --why');
    const refs = store.readKind('ref', { defaults: false });
    const ids = repos.map((r) => ({ id: String(r.id), paths: Array.isArray(r.paths) ? (r.paths as Array<{ glob: string; sub: string }>) : [] })).filter((r) => r.paths.length);
    for (const ref of [...refs].sort((a, b) => (String(a.key) < String(b.key) ? -1 : 1))) {
      const key = String(ref.key), files = ref.files && typeof ref.files === 'object' && !Array.isArray(ref.files) ? Object.keys(ref.files) : [];
      if (!files.length || !TICKET.test(key)) continue;
      const hit = new Set<string>();
      for (const t of touchesFor({ repos: ids, paths: files }).touches) if (t.possible !== true && t.sub !== undefined) hit.add(t.repo);
      for (const to of [...hit].sort()) if (!has(key, to) && !add.some((l) => l.from === key && l.to === to)) { add.push({ from: key, from_type: 'ticket', rel: 'touches', to, to_type: 'repo', attrs: { conf: 0.7, why: 'files' } }); say.push(`${oneLine(key, 120)} touches ${to} (conf 0.7, files)`); }
    }
  } else {
    if (!ticket || !repoArg) throw usage('usage: plangraph repo link TICKET REPO [--conf N --why T] | repo link --auto');
    if (!TICKET.test(ticket) || ticket.includes('..')) throw usage('repo link needs a ticket key as the first argument');
    if (conf !== undefined && !(conf >= 0 && conf <= 1)) throw usage('--conf must be a number from 0 to 1');
    const to = repoArg.startsWith('repo:') ? repoArg : `repo:${repoArg}`;
    if (!repos.some((r) => r.id === to)) throw usage(`unknown repository ${oneLine(repoArg, 80)}: not in repos.jsonl (run repo scan first)`);
    const known = store.readKind('ticket', { defaults: false }).some((t) => t.key === ticket) || store.readKind('ref', { defaults: false }).some((r) => r.key === ticket);
    if (!known) throw usage(`unknown ticket ${oneLine(ticket, 120)}: not in tickets.jsonl`);
    if (!has(ticket, to)) { add.push({ from: ticket, from_type: 'ticket', rel: 'touches', to, to_type: 'repo', attrs: { conf: conf ?? 1, why: oneLine(why ?? 'manual', 60) } }); say.push(`${oneLine(ticket, 120)} touches ${to}`); }
    else say.push(`${oneLine(ticket, 120)} already touches ${to}, nothing written`);
  }
  if (add.length) store.addRows('link', add, { precheck: true }); // a delta under the store lock: a link another writer added meanwhile is kept
  if (!say.length) ctx.io.out('no missing touches links, nothing written');
  for (const l of say) ctx.io.out(l);
  return 0;
}

/** `repo catalog [PATH] [--write]`: the repository's catalog-info.yaml seed (spec.owner to owners); a dry run unless --write. */
function catalog(ctx: Ctx, args: Args<Opts>): number {
  const base = path.resolve(args.positionals[1] ?? ctx.root);
  if (!isRepoDir(base)) throw usage('the path is not a git repository');
  needBrain(ctx);
  const store = openStore(ctx), rows = store.readKind('repo', { defaults: false });
  const people = new Set(store.readKind('person', { defaults: false }).map((p) => p.id).filter((i): i is string => typeof i === 'string'));
  const slug = slugOf(path.basename(base));
  if (!slug) throw usage('the directory name gives no usable repository id');
  const file = (() => { try { return readRepo(base).files.find((f) => f.path === 'catalog-info.yaml'); } catch { throw usage(`cannot read repository ${oneLine(path.basename(base), 80)}`); } })();
  const seed = parseCatalogInfo(file?.text ?? '', people), id = `repo:${slug}`, old = rows.find((r) => r.id === id);
  const owners = [...new Set([...asStrings(old?.owners), ...(seed.owners ?? [])])].sort();
  const added = (seed.owners ?? []).filter((o) => !asStrings(old?.owners).includes(o));
  ctx.io.out(`${id}: ${seed.owners?.length ? `owners ${seed.owners.join(', ')} from catalog-info.yaml` : 'no owner in catalog-info.yaml'}${args.values.write ? '' : ' (dry run, nothing written)'}`);
  if (!args.values.write || !added.length) return 0;
  const next: Row = old ? { ...old, owners } : { id, name: seed.name ?? slug, owners, src: 'catalog' };
  if (old && old.role === undefined && seed.role !== undefined) next.role = seed.role;
  store.addRows('repo', [next], { precheck: true });
  return 0;
}

async function repo(ctx: Ctx, args: Args<Opts>): Promise<number> {
  const [sub, target] = args.positionals, check = Boolean(args.values.check);
  if (sub === 'link') return link(ctx, args);
  if (sub === 'catalog') return catalog(ctx, args);
  if (sub !== 'scan') throw usage('repo needs a subcommand: scan [PATH] [--all] [--check] | link TICKET REPO | link --auto | catalog [--write]');
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
  const store = openStore(ctx), existing = store.readKind('repo', { defaults: false });
  const people = new Set(store.readKind('person', { defaults: false }).map((p) => p.id).filter((i): i is string => typeof i === 'string'));
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
  store.writeKind('repo', [...rows.values()], { precheck: true });
  return 0;
}

export const commands: CommandMap = {
  repo: {
    run: repo as never, positionals: [0, 3], writes: 'text', guard: 'strict',
    options: { all: { type: 'boolean' }, check: { type: 'boolean' }, auto: { type: 'boolean' }, write: { type: 'boolean' }, conf: { type: 'number', min: 0, max: 1 }, why: { type: 'string' } },
    summary: 'scan [PATH] [--all] [--check]: derive repos.jsonl rows from manifests, CODEOWNERS and tool versions (git only, no scripts run); --check exits 1 on drift; link TICKET REPO [--conf N --why T] | link --auto: record touches links; catalog [PATH] [--write]: owners from catalog-info.yaml',
  },
};
