// "Which repositories does this ticket touch" (docs/superpowers/plans/2026-11-25-graph-v2-amendment.md section 3.10): a ranked list with `conf` and
// `why`, never a bare answer. Pure: the caller gathers the evidence from the graph and the observation cache. Output is trace information only:
// nothing here is read by blockers, capacity, the solver or verify.
//   high:   an explicit `touches` link or label, or a linked PR or branch in that repository
//   medium: a Jira component mapped to the repository, or two or more sibling tickets of the same epic that touched it
//   low:    keyword or path overlap; dependency closure (flagged `possible`, never counted as touched)
// No signal, a low best, or a tie at the top gives `unknown`/`ask`, never a guess.
import { globRe } from './repo.ts';

type Conf = 'high' | 'medium' | 'low';
interface RepoRef { id: string; name?: string; github?: readonly string[]; deps?: readonly string[]; paths?: ReadonlyArray<{ glob: string; sub: string }> }
export interface TouchInput {
  repos: readonly RepoRef[];
  explicit?: ReadonlyArray<{ repo: string; conf?: Conf; why?: string }>; // links.jsonl `touches` rows and `repo:<slug>` labels
  linked?: readonly string[];                                              // `owner/name` of each GitHub repository with a PR or branch for the ticket
  components?: ReadonlyArray<{ repo: string }>;                            // the repositories the ticket's Jira components map to
  siblings?: ReadonlyMap<string, number>;                                  // repo id to the number of sibling tickets (same epic) that touched it
  words?: readonly string[];                                               // title and label words for keyword overlap
  paths?: readonly string[];                                               // repo-relative paths or globs the ticket names
}
interface Touch { repo: string; sub?: string; conf: Conf; why: string; possible?: boolean }
type Verdict = 'touched' | 'ask' | 'unknown';
export interface TouchResult { verdict: Verdict; touches: Touch[] }

const RANK: Record<Conf, number> = { high: 3, medium: 2, low: 1 };
const MAX_WHY = 60, CLOSURE_DEPTH = 3;
const nodeId = (t: Pick<Touch, 'repo' | 'sub'>): string => (t.sub === undefined ? t.repo : `${t.repo}#${t.sub}`);

/** The monorepo sub-units a path names: the `paths` globs it falls under, most specific (longest glob) only. A ticket path `packages/web/**` names the directory. */
export function subsFor(paths: ReadonlyArray<{ glob: string; sub: string }> | undefined, named: readonly string[]): string[] {
  const hit = new Map<string, number>();
  for (const raw of named) {
    const dir = raw.replace(/\/?\*.*$/, '').replace(/^\.?\//, '');
    if (!dir || dir.includes('..')) continue;
    for (const p of paths ?? []) { const re = globRe(p.glob); if (re.test(`${dir}/`) || re.test(`${dir}/x`)) hit.set(p.sub, Math.max(hit.get(p.sub) ?? 0, p.glob.length)); }
  }
  const best = Math.max(0, ...hit.values());
  return [...hit].filter(([, n]) => n === best).map(([s]) => s).sort();
}

/** Rank the repositories a ticket touches. */
export function touchesFor(input: TouchInput): TouchResult {
  const known = new Map(input.repos.map((r) => [r.id, r] as const));
  const best = new Map<string, Touch>();
  const put = (repo: string, conf: Conf, why: string): void => {
    if (!known.has(repo)) return; // a link to a deleted repository is verify's finding, not an answer here
    const cur = best.get(repo), w = why.slice(0, MAX_WHY);
    if (!cur || RANK[conf] > RANK[cur.conf]) best.set(repo, { repo, conf, why: w });
  };
  for (const e of input.explicit ?? []) put(e.repo, e.conf ?? 'high', e.why ?? 'touches link');
  for (const sys of input.linked ?? []) for (const r of input.repos) if (r.github?.includes(sys)) put(r.id, 'high', `PR or branch in ${sys}`);
  for (const c of input.components ?? []) put(c.repo, 'medium', 'Jira component');
  for (const [repo, n] of input.siblings ?? []) if (n >= 2) put(repo, 'medium', `${n} sibling tickets`);
  const words = new Set((input.words ?? []).map((w) => w.toLowerCase()));
  for (const r of input.repos) {
    const slug = r.id.replace(/^repo:/, '');
    if (slug.length >= 3 && words.has(slug)) put(r.id, 'low', 'keyword');
    else if (r.name !== undefined && r.name.length >= 3 && words.has(r.name.toLowerCase())) put(r.id, 'low', 'keyword');
  }
  // monorepo: a named path refines the repository to its sub-unit (the entry keeps its conf; a path alone is low)
  let items: Touch[] = [];
  for (const t of best.values()) items.push(t);
  for (const r of input.repos) {
    const subs = subsFor(r.paths, input.paths ?? []);
    if (!subs.length) continue;
    const base = best.get(r.id);
    items = items.filter((t) => t.repo !== r.id);
    for (const sub of subs) items.push({ repo: r.id, sub, conf: base?.conf ?? 'low', why: base ? `${base.why}; path` : 'path' });
  }
  // dependency closure: possible only, never counted as touched
  const real = new Set(items.filter((t) => RANK[t.conf] >= RANK.medium).map((t) => t.repo)), seen = new Set(items.map((t) => t.repo));
  let frontier = [...real];
  for (let d = 0; d < CLOSURE_DEPTH && frontier.length; d++) {
    const next: string[] = [];
    for (const id of frontier) for (const dep of known.get(id)?.deps ?? []) if (known.has(dep) && !seen.has(dep)) { seen.add(dep); next.push(dep); items.push({ repo: dep, conf: 'low', why: `possible: depends on ${id}`.slice(0, MAX_WHY), possible: true }); }
    frontier = next;
  }
  items.sort((a, b) => RANK[b.conf] - RANK[a.conf] || (nodeId(a) < nodeId(b) ? -1 : 1));
  const counted = items.filter((t) => t.possible !== true), top = counted[0];
  if (!top || top.conf === 'low') return { verdict: 'unknown', touches: items };
  if (top.conf === 'medium' && counted.filter((t) => t.conf === 'medium').length > 1) return { verdict: 'ask', touches: items }; // a tie: both stay listed
  return { verdict: 'touched', touches: items };
}
