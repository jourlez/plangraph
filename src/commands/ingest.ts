// plangraph ingest git [--repo ID] [--since DAYS] [--full]: mine git history into cache/git.jsonl (module facts) and cache/git.cursor,
// both 0600 and git-ignored caches. ingest links [--repo ID]: touches links from commit messages and pull request observations. ingest docs
// [PATH...] and ingest requirements DOC [--prune]: decision and requirement nodes from documents. The one writer command of ingest: every
// subcommand writes. Prints summary lines and codes, never history or document text.
import fs from 'node:fs';
import path from 'node:path';
import { readCapped, parseJsonl } from '../../lib/jsonl.ts';
import { readIdentityMap } from '../../lib/identity.ts';
import { openStore } from '../../lib/planstore.ts';
import { oneLine } from '../../lib/sanitize.ts';
import { needBrain, usage } from './shared.ts';
import type { Ctx, Args } from '../context.ts';
import type { CommandMap } from '../registry.ts';
import type { Node } from '../../lib/store2/pg.ts';

type Opts = { repo?: string; since?: number; full?: boolean; prune?: boolean };
const REPO_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

const MAX_DOC_READ = 1024 * 1024;
const MAX_LINES = 20;
const DOC_DIRS = ['docs/adr', 'docs/decisions', 'doc/adr', 'adr'];

async function git(ctx: Ctx, args: Args<Opts>): Promise<number> {
  const { repo, since, full } = args.values;
  if (args.positionals.length !== 1) throw usage('usage: plangraph ingest git [--repo ID] [--since DAYS] [--full]');
  if (repo !== undefined && !REPO_ID.test(repo)) throw usage('--repo: an id of letters, digits and . _ : - (at most 64)');
  needBrain(ctx);
  const { ingestGit } = await import('../../lib/history/git.ts'); // loaded on first use: the miner is not on the start-up path
  const res = await ingestGit(ctx, { ...(repo !== undefined ? { repo } : {}), ...(since !== undefined ? { since } : {}), ...(full ? { full: true } : {}), identity: readIdentityMap(ctx.dir) });
  ctx.io.out(`ingested ${res.written} modules from ${res.commits} commits (${res.incremental ? 'incremental' : 'full'})`);
  return 0;
}

// ---- links ----
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const sorted = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

async function links(ctx: Ctx, args: Args<Opts>): Promise<number> {
  if (args.positionals.length !== 1) throw usage('usage: plangraph ingest links [--repo ID]');
  const { repo } = args.values;
  if (repo !== undefined && !REPO_ID.test(repo)) throw usage('--repo: an id of letters, digits and . _ : - (at most 64)');
  needBrain(ctx);
  const store = openStore(ctx);
  const repos = store.readKind('repo', { defaults: false }).map((r) => ({ id: str(r.id), github: Array.isArray(r.github) ? r.github.filter((g): g is string => typeof g === 'string') : [] })).filter((r) => r.id);
  const tickets = new Set([...store.readKind('ticket', { defaults: false }), ...store.readKind('ref', { defaults: false })].map((t) => str(t.key)).filter(Boolean));
  const want = repo === undefined ? undefined : repo.startsWith('repo:') ? repo : `repo:${repo}`;
  const slug = path.basename(ctx.root).toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  const target = want ?? (repos.length === 1 ? repos[0]?.id : repos.find((r) => r.id === `repo:${slug}`)?.id);
  if (!target) throw usage(repos.length ? 'several repositories in repos.jsonl: name one with --repo ID' : 'no repository in repos.jsonl: run `plangraph repo scan` first, or name one with --repo ID');
  if (!repos.some((r) => r.id === target)) throw usage(`unknown repository ${oneLine(target, 80)}: not in repos.jsonl`);

  const cfg = ctx.config() as { project_keys?: unknown; history?: { window_days?: unknown } };
  const fromCfg = Array.isArray(cfg.project_keys) ? cfg.project_keys.filter((k): k is string => typeof k === 'string') : [];
  const keys = new Set(fromCfg.length ? fromCfg : [...tickets].map((k) => k.replace(/-\d+$/, '')));
  const win = Number.isSafeInteger(cfg.history?.window_days) && (cfg.history?.window_days as number) > 0 ? (cfg.history?.window_days as number) : 365;

  const { readLinkCommits } = await import('../../lib/history/git.ts');
  const { linkTickets } = await import('../../lib/history/link.ts');
  const { obsProblem } = await import('../../lib/graph/provider.ts');
  const commits = await readLinkCommits(ctx, { since: new Date(ctx.now().getTime() - win * 86400000) });
  const prs: Array<{ number: number; repo?: string; branch?: string; title?: string; body?: string; merged?: boolean }> = [];
  const gh = path.join(ctx.dir, 'cache', 'github.jsonl');
  let ghText = ''; try { ghText = readCapped(gh, 64 * 1024 * 1024, { follow: false }); } catch { /* no cache yet */ }
  const prRepo = new Map<number, string>();
  for (const r of parseJsonl(ghText, 'cache/github.jsonl', { validate: obsProblem })) {
    if (r.type !== 'x-github.pr') continue;
    const m = /^([^#]+)#(\d+)$/.exec(str(r.xid)), f = (r.fields ?? {}) as Record<string, unknown>;
    if (!m) continue;
    const number = Number(m[2]), own = repos.find((x) => x.github.includes(m[1] as string))?.id;
    prRepo.set(number, own ?? target);
    prs.push({ number, repo: own ?? target, branch: str(f.branch), title: str(f.title), ...(typeof f.body === 'string' ? { body: f.body } : {}), merged: f.state === 'merged' });
  }
  const res = linkTickets(commits.map((c) => ({ ...c, repo: target })), prs, keys, { repo: target });

  const old = store.readKind('link', { defaults: false });
  const has = (from: string, to: string): boolean => old.some((l) => l.rel === 'touches' && l.from === from && l.to === to);
  const add = [] as Array<Record<string, unknown>>;
  let unknown = 0;
  for (const l of res.links) {
    if (!tickets.has(l.key)) { unknown++; continue; }
    if (has(l.key, l.repo) || add.some((a) => a.from === l.key && a.to === l.repo)) continue;
    const why = oneLine([...l.sources, ...l.prs.map((n) => `pr ${n}`)].join('+'), 60);
    add.push({ from: l.key, from_type: 'ticket', rel: 'touches', to: l.repo, to_type: 'repo', attrs: { conf: Math.round(l.conf * 100) / 100, why } });
  }
  if (add.length) store.writeKind('link', [...old, ...add], { precheck: true });
  const lows = res.low.filter((l) => tickets.has(l.key));
  unknown += res.low.length - lows.length;
  ctx.io.out(`linked ${add.length} ticket(s) to ${oneLine(target, 80)} from ${commits.length} commits and ${prs.length} pull requests`);
  for (const l of lows.slice(0, MAX_LINES)) ctx.io.out(`LOW_CONF ${oneLine(l.key, 40)} ${oneLine(l.repo, 80)} ${Math.round(l.conf * 100) / 100} (${l.sources.join('+')})`);
  if (lows.length > MAX_LINES) ctx.io.out(`truncated ${lows.length - MAX_LINES} LOW_CONF line(s)`);
  if (unknown) ctx.io.out(`${unknown} key(s) not in the plan skipped`);
  return 0;
}

// ---- documents ----
/** A document the user named, as a repo-relative posix path and its text. Outside the repository, a URL, a symlink leaving it or a non-file is a usage error. */
function readDoc(ctx: Ctx, arg: string): { rel: string; text: string } {
  const base = ctx.cwd ?? ctx.root;
  const fail = (): never => { throw usage(`cannot read ${oneLine(arg, 80)}: not a file inside the repository`); };
  let real: string, root: string;
  try { real = fs.realpathSync(path.resolve(base, arg)); root = fs.realpathSync(ctx.root); } catch { return fail(); }
  const rel = path.relative(root, real);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return fail();
  let text: string;
  try { text = readCapped(real, MAX_DOC_READ); } catch { return fail(); }
  return { rel: rel.split(path.sep).join('/'), text };
}
function docFiles(ctx: Ctx, args: string[]): string[] {
  const base = ctx.cwd ?? ctx.root, out: string[] = [];
  const list = args.length ? args : DOC_DIRS.filter((d) => fs.existsSync(path.resolve(ctx.root, d)));
  for (const a of list) {
    const abs = path.resolve(args.length ? base : ctx.root, a);
    let isDir = false; try { isDir = fs.statSync(abs).isDirectory(); } catch { /* reported by readDoc */ }
    if (isDir) out.push(...fs.readdirSync(abs).filter((n) => n.endsWith('.md')).sort().map((n) => path.join(abs, n)));
    else out.push(abs);
  }
  return [...new Set(out)];
}
const adrNumber = (source: unknown): number | null => { const m = /^(?:adr[-_ ]?)?0*(\d+)/i.exec(path.posix.basename(str(source))); return m ? Number(m[1]) : null; };
const linkKey = (l: unknown): string => JSON.stringify(l);

async function docs(ctx: Ctx, args: Args<Opts>): Promise<number> {
  if (args.values.prune) throw usage('--prune goes with `ingest requirements DOC`');
  needBrain(ctx);
  const { parseAdrDoc } = await import('../../lib/ingest/adr.ts');
  const { readNodeKind, writeNodeKind } = await import('../../lib/ingest/write.ts');
  const existing = new Map(readNodeKind(ctx, 'decision').map((n) => [n.id, n] as const));
  const next = new Map<string, Node>(), say: string[] = [], supers: Array<{ adr: string; link: { rel: string; to: string } }> = [];
  for (const arg of args.positionals.slice(1).length ? args.positionals.slice(1) : []) void arg;
  for (const file of docFiles(ctx, args.positionals.slice(1))) {
    const { rel, text } = readDoc(ctx, file);
    const r = parseAdrDoc(text, rel);
    for (const p of r.problems) say.push(`${p.code} ${oneLine(rel, 100)}`);
    if (!r.node) continue;
    const old = existing.get(r.node.id);
    next.set(r.node.id, old?.links ? { ...r.node, links: old.links } : r.node);
    if (r.supersededBy) supers.push(r.supersededBy);
  }
  const all = [...existing.values(), ...next.values()];
  const missing = new Set<string>();
  for (const s of supers) {
    const n = Number(/(\d+)$/.exec(s.adr)?.[1]);
    const tgt = all.map((x) => next.get(x.id) ?? x).find((x) => adrNumber(x.source) === n && x.id !== s.link.to);
    if (!tgt) { missing.add(s.adr); continue; }
    const cur = (next.get(tgt.id) ?? tgt) as Node, ls = Array.isArray(cur.links) ? cur.links as unknown[] : [];
    if (!ls.some((l) => linkKey(l) === linkKey(s.link))) next.set(tgt.id, { ...cur, links: [...ls, s.link] });
  }
  const c = { created: 0, changed: 0, same: 0 };
  for (const n of [...next.values()].sort((a, b) => sorted(a.id, b.id))) c[writeNodeKind(ctx, 'decision', n)]++;
  ctx.io.out(`ingested ${next.size} decision(s) (created ${c.created}, changed ${c.changed}, same ${c.same})`);
  for (const l of say.slice(0, MAX_LINES)) ctx.io.out(l);
  for (const a of [...missing].sort()) ctx.io.out(`SUPERSEDER_MISSING ${oneLine(a, 20)}`);
  return 0;
}

async function requirements(ctx: Ctx, args: Args<Opts>): Promise<number> {
  if (args.positionals.length !== 2) throw usage('usage: plangraph ingest requirements DOC [--prune]');
  needBrain(ctx);
  const { parseRequirementsDoc } = await import('../../lib/ingest/requirements.ts');
  const { readNodeKind, writeNodeKind } = await import('../../lib/ingest/write.ts');
  const { rel, text } = readDoc(ctx, args.positionals[1] as string);
  const r = parseRequirementsDoc(text, rel);
  const existing = new Map(readNodeKind(ctx, 'requirement').map((n) => [n.id, n] as const));
  const c = { created: 0, changed: 0, same: 0 }, ids = new Set<string>();
  for (const n of r.nodes) {
    ids.add(n.id);
    const old = existing.get(n.id);
    const merged: Node = old ? { ...old, ...n, status: old.status === 'dropped' || old.status === undefined ? 'proposed' : old.status } : n;
    if (old && n.acceptance === undefined) delete merged.acceptance;
    c[writeNodeKind(ctx, 'requirement', merged)]++;
  }
  const mine = (n: Node): boolean => typeof n.source === 'string' && (n.source === rel || n.source.startsWith(`${rel}#`));
  const gone = [...existing.values()].filter((n) => mine(n) && !ids.has(n.id) && n.status !== 'dropped');
  ctx.io.out(`ingested ${r.nodes.length} requirement(s) (created ${c.created}, changed ${c.changed}, same ${c.same})`);
  for (const p of r.problems) ctx.io.out(`${p.code} ${oneLine(rel, 100)}`);
  if (args.values.prune) { for (const n of gone) writeNodeKind(ctx, 'requirement', { ...n, status: 'dropped' }); if (gone.length) ctx.io.out(`dropped ${gone.length}`); } else if (gone.length) ctx.io.out(`${gone.length} requirement(s) missing from the document, kept (run with --prune to drop them)`);
  return 0;
}

async function ingest(ctx: Ctx, args: Args<Opts>): Promise<number> {
  const [sub] = args.positionals;
  if (sub === 'git') return git(ctx, args);
  if (sub === 'links') return links(ctx, args);
  if (sub === 'docs') return docs(ctx, args);
  if (sub === 'requirements') return requirements(ctx, args);
  throw usage(`usage: plangraph ingest git|links|docs|requirements (unknown subcommand ${oneLine(sub, 20)})`);
}

export const commands: CommandMap = {
  ingest: {
    run: ingest as never, positionals: [1, Infinity], writes: 'text', guard: 'strict',
    options: { repo: { type: 'string' }, since: { type: 'integer', min: 1, max: 36500 }, full: { type: 'boolean' }, prune: { type: 'boolean' } },
    summary: 'git [--repo ID] [--since DAYS] [--full]: mine git history into local module facts (cache/git.jsonl, 0600), a shallow clone is refused; links [--repo ID]: touches links from commit and pull request ticket keys (conf >= 0.5, lower as LOW_CONF); docs [PATH...]: decision nodes from ADRs; requirements DOC [--prune]: requirement nodes from a document',
  },
};
