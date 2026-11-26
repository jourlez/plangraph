// The `map` and `context` digests (spec 5.5b): small, bounded, deterministic text an agent can afford to read. Pure: a Model plus
// `extras` (the node kinds lib/model.ts does not carry yet: requirements, decisions, repos, teams, history modules) in, lines out.
// No clock (cache age is an input), no I/O, no console. Lead with what an agent cannot discover from the repo: owners and teams,
// requirement counts, decisions, epic progress, hotspots, freshness. Every piece of free text (summaries, titles, commands, names)
// is fenced inline; a bare id that is not a plain token is fenced too, so no instruction can appear unfenced.
import { estTokens, clean, budget } from './render.ts';
import { fenceInline } from './sanitize.ts';
import { isClosed } from './frozen.ts';
import { nodeUri } from './graph/uri.ts';
import type { Model } from './model.ts';

// ---- inputs the controller feeds from the new node kinds and the history cache ----
export interface ReqX { id: string; text?: string; status?: string; /** derived: implemented, verified, orphan */ state?: string; /** ticket keys that satisfy it */ satisfiedBy?: string[] }
export interface DecX { id: string; title?: string; status?: string; date?: string; affects?: string[] }
export interface RepoX { id: string; name?: string; pm?: string; cmds?: Record<string, string>; owners?: string[]; /** tickets that work in this repo */ tickets?: string[]; /** ticket key to the paths its work touches */ touched?: Record<string, string[]> }
export interface TeamX { id: string; name?: string; members?: string[]; owns?: string[] }
export interface ModuleX { repo: string; path: string; commits?: number; churn?: number; authors?: Array<{ person: string; share: number }>; hotspot?: boolean; bus1?: boolean; [extra: string]: unknown }
export interface Extras { requirements?: readonly ReqX[]; decisions?: readonly DecX[]; repos?: readonly RepoX[]; teams?: readonly TeamX[]; modules?: readonly ModuleX[] }
/** fp: the index fingerprint; ageDays: age of the fetch cache in days (null or absent: unknown). */
export interface Fresh { fp?: string; ageDays?: number | null }

interface Line { p: number; text: string }
/** A digest: the lines in fixed section order with a priority each (lower is kept longer), the JSON data, and its default bound. */
export interface Digest { kind: 'map' | 'context'; lines: Line[]; single?: string; data: Record<string, unknown>; maxTokens: number }
export type MapDigest = Digest;
export type ContextDigest = Digest;

export const MAP_BUDGET = 500;
export const CONTEXT_BUDGET = 400;

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const fi = (s: unknown, max = 50): string => fenceInline(s, max);
/** A plain token prints as is; anything else (spaces, brackets, long) is fenced. */
const idTxt = (s: unknown): string => { const v = String(s ?? ''); return /^[\w.:\/@-]{1,40}$/.test(v) ? v : fi(v, 40); };
const hex8 = (fp: unknown): string => String(fp ?? '').replace(/[^0-9a-f]/g, '').slice(0, 8) || 'unbuilt';
const more = (items: string[], limit: number): string => (items.length > limit ? items.slice(0, limit).concat(`+${items.length - limit} more`) : items).join(', ');
/** `pg:<type>/<id>`; requirement, decision and team are not in the core URI grammar yet, so those take the ticket encoding of the id. */
export function uri(type: string, id: string): string | null {
  try { return nodeUri(type, id); } catch { /* type outside the grammar, or a bad id */ }
  try { return `pg:${type}/${nodeUri('ticket', id).slice('pg:ticket/'.length)}`; } catch { return null; }
}
const ref = (type: string, id: string): string => uri(type, id) ?? `pg:${type}/invalid`;
const countBy = (xs: readonly string[]): Array<[string, number]> => { const m = new Map<string, number>(); for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1); return [...m].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0])); };

// The test command an ecosystem uses unless told otherwise: a repo that uses it adds nothing an agent cannot see.
const DEFAULT_TEST: Record<string, string> = { npm: 'npm test', pnpm: 'pnpm test', yarn: 'yarn test', bun: 'bun test', cargo: 'cargo test', go: 'go test ./...', pip: 'pytest', poetry: 'pytest', uv: 'pytest', maven: 'mvn test', gradle: 'gradle test' };
const differs = (r: RepoX): boolean => { const t = r.cmds?.test; return typeof t === 'string' && t !== '' && t !== DEFAULT_TEST[String(r.pm ?? '').toLowerCase()]; };

const NUDGE = 'plangraph: empty graph, run `plangraph ingest` to add a plan';

const isEmpty = (m: Model, x: Extras): boolean => m.tickets.size === 0 && !(x.repos?.length || x.requirements?.length || x.decisions?.length || x.teams?.length || x.modules?.length);

export interface MapOpts { maxTokens?: number; extras?: Extras; fresh?: Fresh; repo?: string; verbose?: boolean }
export function buildMap(model: Model, { maxTokens = MAP_BUDGET, extras = {}, fresh = {}, repo, verbose = false }: MapOpts = {}): MapDigest {
  if (isEmpty(model, extras)) return { kind: 'map', lines: [], single: NUDGE, data: { empty: true }, maxTokens };
  const lines: Line[] = []; const add = (p: number, text: string) => lines.push({ p, text });
  const repos = (extras.repos ?? []).filter((r) => repo === undefined || r.id === repo).slice().sort((a, b) => cmp(a.id, b.id));
  const mods = (extras.modules ?? []).filter((m) => repo === undefined || m.repo === repo);
  const owners = countBy([...model.sched.values()].map((s) => s.owner).filter((o): o is string => typeof o === 'string' && o !== ''));
  add(0, `plangraph map | ${model.tickets.size} tickets, ${extras.repos?.length ?? 0} repos, ${owners.length} ${owners.length === 1 ? 'person' : 'people'}`);

  if (owners.length) add(1, 'owners: ' + more(owners.map(([o, n]) => `${idTxt(o)} ${n}`), 8));
  const teams = (extras.teams ?? []).slice().sort((a, b) => cmp(a.id, b.id));
  if (teams.length) add(2, 'teams: ' + more(teams.map((t) => `${idTxt(t.id)} ${t.members?.length ?? 0}m/${t.owns?.length ?? 0}r`), 5));

  const reqs = extras.requirements ?? [];
  const byStatus = countBy(reqs.map((r) => r.status ?? 'proposed')), byState = countBy(reqs.flatMap((r) => (r.state ? [r.state] : [])));
  if (reqs.length) add(1, `requirements: ${reqs.length} (${byStatus.map(([s, n]) => `${idTxt(s)} ${n}`).join(', ')})` + (byState.length ? `; ${byState.map(([s, n]) => `${idTxt(s)} ${n}`).join(', ')}` : ''));

  const decs = (extras.decisions ?? []).slice().sort((a, b) => cmp(b.date ?? '', a.date ?? '') || cmp(b.id, a.id));
  if (decs.length) { add(2, `decisions: ${decs.length}`); for (const d of decs.slice(0, 3)) add(3, `latest ${idTxt(d.id)} ${fi(d.title ?? '')}`); }

  const ep = new Map<string, { n: number; done: number }>();
  for (const t of model.tickets.values()) { if (typeof t.epic !== 'string' || t.epic === '') continue; const e = ep.get(t.epic) ?? { n: 0, done: 0 }; e.n++; if (isClosed(model, t.key)) e.done++; ep.set(t.epic, e); }
  const epics = [...ep].sort((a, b) => b[1].n - a[1].n || cmp(a[0], b[0]));
  if (epics.length) add(3, 'epics: ' + more(epics.map(([e, v]) => `${idTxt(e)} ${v.done}/${v.n}`), 5));

  const hot = mods.filter((m) => m.hotspot === true).sort((a, b) => (b.churn ?? 0) - (a.churn ?? 0) || cmp(a.repo, b.repo) || cmp(a.path, b.path)).slice(0, 5);
  for (const m of hot) add(4, `hot ${idTxt(m.repo)}:${idTxt(m.path)} churn ${m.churn ?? 0}${m.bus1 ? ' bus1' : ''}`);

  const stack = repos.filter((r) => verbose || differs(r));
  if (stack.length) { add(5, 'stack differs (data from repo):'); for (const r of stack) add(6, `${idTxt(r.id)} test=${fi(r.cmds?.test ?? '', 40)}`); }

  const age = typeof fresh.ageDays === 'number' && Number.isFinite(fresh.ageDays) ? `cache ${Math.max(0, Math.floor(fresh.ageDays))}d old` : 'cache age unknown';
  add(1, `fresh: index ${hex8(fresh.fp)}, ${age}`);

  const data = {
    fp: hex8(fresh.fp), ageDays: fresh.ageDays ?? null, tickets: model.tickets.size,
    owners: owners.map(([o, n]) => ({ id: ref('person', o), n })),
    teams: teams.map((t) => ({ id: ref('team', t.id), members: t.members?.length ?? 0, owns: t.owns?.length ?? 0 })),
    requirements: { total: reqs.length, byStatus: Object.fromEntries(byStatus), byState: Object.fromEntries(byState) },
    decisions: { count: decs.length, latest: decs.slice(0, 3).map((d) => ({ id: ref('decision', d.id), title: fi(d.title ?? '') })) },
    epics: epics.map(([e, v]) => ({ id: ref('epic', e), done: v.done, total: v.n })),
    hotspots: hot.map((m) => ({ repo: ref('repo', m.repo), path: m.path.length > 200 ? fi(m.path, 200) : m.path, churn: m.churn ?? 0, bus1: m.bus1 === true })),
    repos: stack.map((r) => ({ id: ref('repo', r.id), test: fi(r.cmds?.test ?? '', 40) }))
  };
  return { kind: 'map', lines, data, maxTokens };
}

// ---- context ----
// A glob over repo paths: `**` crosses directories, `*` and `?` do not. A pattern with no wildcard also matches everything below it.
function globMatch(glob: string, p: string): boolean {
  const g = glob.replace(/^\.\//, '');
  if (!/[*?]/.test(g)) return p === g || p.startsWith(g.endsWith('/') ? g : g + '/');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i] as string;
    if (c === '*') { if (g[i + 1] === '*') { i++; if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*'; } else re += '[^/]*'; }
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`).test(p);
}

/** The ticket key a branch name mentions (case-insensitive, whole key only: `ABC-1` never matches inside `ABC-12`), else null. Longest key wins. */
export function ticketFromBranch(branch: string, keys: Iterable<string>): string | null {
  const b = String(branch ?? '').toUpperCase();
  const alnum = /[A-Z0-9]/;
  for (const k of [...keys].sort((x, y) => y.length - x.length || cmp(x, y))) {
    const K = k.toUpperCase(); if (!K) continue;
    for (let at = b.indexOf(K); at >= 0; at = b.indexOf(K, at + 1)) {
      if (!alnum.test(b[at - 1] ?? '-') && !alnum.test(b[at + K.length] ?? '-')) return k;
    }
  }
  return null;
}

export interface ContextOpts { maxTokens?: number; extras?: Extras; repo?: string; verbose?: boolean }
/** target: a ticket key, or null when no task was detected. */
export function buildContext(model: Model, target: string | null, { maxTokens = CONTEXT_BUDGET, extras = {}, repo }: ContextOpts = {}): ContextDigest {
  const one = (text: string): ContextDigest => ({ kind: 'context', lines: [], single: text, data: { none: true }, maxTokens });
  if (isEmpty(model, extras)) return one(NUDGE);
  if (target === null) return one('plangraph: no task detected, pass a ticket key: `plangraph context KEY`');
  const t = model.tickets.get(target);
  if (!t) return one(`plangraph: no ticket ${idTxt(target)} in the graph`);
  const lines: Line[] = []; const add = (p: number, text: string) => lines.push({ p, text });
  const pl = model.sched.get(target);
  const owner = pl?.owner || '', sprint = pl?.sprint;
  add(0, `context ${idTxt(target)} ${fi(t.summary ?? '', 60)} | ${owner ? 'owner ' + idTxt(owner) : 'unowned'} | ${Number.isInteger(sprint) ? 'S' + sprint : 'unplaced'}${typeof t.sp === 'number' ? ` | ${t.sp}sp` : ''}`);
  const blockers = (model.prods.get(target) ?? []).filter((k) => !isClosed(model, k));
  add(1, 'blockers: ' + (blockers.length ? more(blockers.map(idTxt), 5) : 'none'));

  const repos = (extras.repos ?? []).filter((r) => (repo === undefined || r.id === repo) && (r.tickets?.includes(target) || r.touched?.[target] !== undefined)).sort((a, b) => cmp(a.id, b.id));
  const touched = (r: RepoX): string[] => (r.touched?.[target] ?? []).slice().sort(cmp);
  for (const r of repos) {
    const cmds = ['test', 'build'].filter((k) => typeof r.cmds?.[k] === 'string' && r.cmds[k] !== '');
    add(2, `repo ${idTxt(r.id)} data:${cmds.length ? ' ' + cmds.map((k) => `${k}=${fi(r.cmds?.[k], 40)}`).join(' ') : ' no commands'}`);
  }
  const reqs = (extras.requirements ?? []).filter((r) => r.satisfiedBy?.includes(target)).sort((a, b) => cmp(a.id, b.id));
  for (const r of reqs) add(2, `req ${idTxt(r.id)} ${idTxt(r.status ?? 'proposed')} ${fi(r.text ?? '', 60)}`);

  const paths = repos.flatMap((r) => touched(r).map((p) => ({ repo: r.id, path: p })));
  const decs = (extras.decisions ?? []).filter((d) => (d.affects ?? []).some((g) => paths.some((x) => globMatch(g, x.path)))).sort((a, b) => cmp(a.id, b.id));
  for (const d of decs) add(3, `decision ${idTxt(d.id)} ${idTxt(d.status ?? 'proposed')} ${fi(d.title ?? '', 60)}`);

  const mods = (extras.modules ?? []).filter((m) => paths.some((x) => x.repo === m.repo && x.path === m.path) && (m.hotspot === true || m.bus1 === true)).sort((a, b) => cmp(a.repo, b.repo) || cmp(a.path, b.path));
  for (const m of mods) add(3, `hotspot ${idTxt(m.repo)}:${idTxt(m.path)}${m.bus1 ? ' bus1' : ''}`);

  const ask: string[] = [];
  const push = (p: string) => { if (p && !ask.includes(p)) ask.push(p); };
  for (const r of repos) for (const o of (r.owners ?? []).slice().sort(cmp)) push(o);
  for (const m of (extras.modules ?? []).filter((m) => paths.some((x) => x.repo === m.repo && x.path === m.path)).sort((a, b) => cmp(a.repo, b.repo) || cmp(a.path, b.path))) for (const a of (m.authors ?? []).slice().sort((x, y) => y.share - x.share || cmp(x.person, y.person)).slice(0, 2)) push(a.person);
  if (ask.length) add(2, 'ask: ' + more(ask.map(idTxt), 4));

  const data = {
    ticket: ref('ticket', target), summary: fi(t.summary ?? '', 60), owner: owner ? ref('person', owner) : null, sprint: Number.isInteger(sprint) ? sprint : null,
    blockers: blockers.map((k) => ref('ticket', k)),
    repos: repos.map((r) => ({ id: ref('repo', r.id), commands: Object.fromEntries(['test', 'build'].filter((k) => typeof r.cmds?.[k] === 'string').map((k) => [k, fi(r.cmds?.[k], 40)])), data_from_repo: true })),
    requirements: reqs.map((r) => ({ id: ref('requirement', r.id), status: r.status ?? 'proposed', text: fi(r.text ?? '', 60) })),
    decisions: decs.map((d) => ({ id: ref('decision', d.id), title: fi(d.title ?? '', 60) })),
    hotspots: mods.map((m) => ({ repo: ref('repo', m.repo), path: m.path.length > 200 ? fi(m.path, 200) : m.path, bus1: m.bus1 === true })),
    ask: ask.map((p) => ref('person', p))
  };
  return { kind: 'context', lines, data, maxTokens };
}

export const mapJson = (d: MapDigest): Record<string, unknown> => d.data;
export const contextJson = (d: ContextDigest): Record<string, unknown> => d.data;

/** Text under the bound: lines drop whole, least important first (priority-0 lines stay), and one final line says how many were omitted. */
export function render(d: Digest, maxTokens: number = d.maxTokens): { text: string; omitted: number } {
  if (d.single !== undefined) return { text: clean(d.single), omitted: 0 };
  const join = (ls: Line[]) => ls.map((l) => l.text).join('\n');
  const all = clean(join(d.lines));
  if (estTokens(all + '\n') <= maxTokens) return { text: all, omitted: 0 };
  const order = d.lines.map((l, i) => ({ ...l, i })).sort((a, b) => a.p - b.p || a.i - b.i);
  const kept: typeof order = [];
  for (const l of order) {
    const cand = kept.concat(l), dropped = order.length - cand.length;
    if (l.p > 0 && estTokens(`${join(cand.slice().sort((a, b) => a.i - b.i))}\nomitted ${dropped}, narrow with --repo or -v\n`) > maxTokens) break;
    kept.push(l);
  }
  const dropped = order.length - kept.length;
  const text = join(kept.sort((a, b) => a.i - b.i)) + (dropped ? `\nomitted ${dropped}, narrow with --repo or -v` : '');
  return { text: clean(budget(text, Math.max(1, maxTokens)).text), omitted: dropped };
}
