// The extras of the new node kinds, loaded in one call so the controller can feed every library (lib/digest.ts, lib/docs, lib/flow) from the same rows:
// requirements, decisions, repos, teams, events, history modules, the link rows and the xref rows. Read from the store and the cache files, never the index,
// so the answer is as current as the text. Each row is a superset of the shapes the libraries name (ReqX, DecX, RepoX, TeamX, ModuleX of lib/digest.ts,
// Requirement, Decision, Repo, Team, TaskEvent of lib/docs/types.ts, RequirementIn, DecisionIn, FlowLink and EventIn of lib/flow), so one value is passed
// to all of them; `docsExtras` converts the two fields on which the shapes differ (a module's `hotspot` and `authors`).
import path from 'node:path';
import { openStore } from './planstore.ts';
import type { StoreCtx } from './planstore.ts';
import { loadModel } from './model.ts';
import type { Model } from './model.ts';
import { readEvents } from './store2/batches.ts';
import { readCapped } from './jsonl.ts';
import { globRe } from './graph/repo.ts';
import { rtm } from './flow/rtm.ts';
import { parseModuleFacts, MODULE_FILE } from './history/module-facts.ts';
import type { ModuleFact } from './history/git.ts';
import type { Extras as DocsExtras } from './docs/types.ts';

type Row = Record<string, unknown>;
export interface ExtraRequirement { id: string; text?: string; status?: string; kind?: string; priority?: string; source?: string; acceptance: string[]; /** ticket keys that satisfy it, from `satisfies` links */ satisfiedBy: string[]; /** the traceability state: orphan, proposed, implemented or verified */ state: string ; [k: string]: unknown }
export interface ExtraDecision { id: string; title?: string; status?: string; date?: string; source?: string; derivation?: string; affects: string[]; supersedes: string[] ; [k: string]: unknown }
export interface ExtraRepo { id: string; name?: string; pm?: string; cmds?: Record<string, string>; commands?: Record<string, string>; owners: string[]; stack: string[]; /** tickets with a `touches` link to the repo */ tickets: string[]; /** ticket key to the paths (ticket refs files) inside this repo */ touched: Record<string, string[]> ; [k: string]: unknown }
export interface ExtraTeam { id: string; name?: string; members: string[]; owns: string[] ; [k: string]: unknown }
export interface ExtraEvent { at: string; seq: number; actor: string; task: string; to: string; by: string; evidence: string[]; note?: string; bh8?: string }
export interface ExtraLink { from: string; from_type: string; rel: string; to: string; to_type: string; [k: string]: unknown }
/** A module fact with an index signature, the form ModuleX of lib/digest.ts takes. */
export type ExtraModule = ModuleFact & Record<string, unknown>;
export interface Extras { requirements: ExtraRequirement[]; decisions: ExtraDecision[]; repos: ExtraRepo[]; teams: ExtraTeam[]; events: ExtraEvent[]; modules: ExtraModule[]; links: ExtraLink[]; xrefs: Row[] }

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const uniq = (xs: Iterable<string>): string[] => [...new Set(xs)].sort(cmp);
const opt = <K extends string>(k: K, v: unknown): { [P in K]?: string } => (typeof v === 'string' && v !== '' ? ({ [k]: v } as { [P in K]?: string }) : {});
const textMap = (v: unknown): Record<string, string> | undefined => (v !== null && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Row).filter((e): e is [string, string] => typeof e[1] === 'string').sort((a, b) => cmp(a[0], b[0]))) : undefined);

/** The cache of module facts, or none when `ingest git` has not run; a bad line is the build's IngestError, as for the index. */
function readModules(dir: string): ExtraModule[] {
  let text: string;
  try { text = readCapped(path.join(dir, MODULE_FILE), 64 * 1024 * 1024, { follow: false }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
  return parseModuleFacts(text) as ExtraModule[];
}

/** Every extra of a plan directory. `model` is the loaded model when the caller has one (else it is loaded here, for the requirement states). */
export function loadExtras(ctx: StoreCtx, { model }: { model?: Model } = {}): Extras {
  const st = openStore(ctx), rows = (k: Parameters<typeof st.readKind>[0]): Row[] => st.readKind(k, { defaults: false });
  const [linkRows, refRows, xrefRows] = st.readKinds(['link', 'ref', 'xref'], { defaults: false }) as [Row[], Row[], Row[]]; // all three live in the ticket files: parse them once
  const links = linkRows.map((l) => ({ ...l, from: String(l.from), from_type: String(l.from_type), rel: String(l.rel), to: String(l.to), to_type: String(l.to_type) })).sort((a, b) => cmp(`${a.from_type}\0${a.from}\0${a.rel}\0${a.to}`, `${b.from_type}\0${b.from}\0${b.rel}\0${b.to}`));
  const by = (rel: string, fromType: string, toType: string): Map<string, string[]> => { // to -> sources
    const m = new Map<string, string[]>();
    for (const l of links) if (l.rel === rel && l.from_type === fromType && l.to_type === toType) m.set(l.to, [...(m.get(l.to) ?? []), l.from]);
    return m;
  };
  const events: ExtraEvent[] = readEvents(ctx.dir).map((e) => ({ ...e, evidence: strs(e.evidence) }));
  const satisfiers = by('satisfies', 'ticket', 'requirement');
  const reqRows = rows('requirement');
  const states = new Map<string, string>();
  for (const r of rtm(model ?? loadModel(ctx.dir), events, { requirements: reqRows.map((r) => ({ id: String(r.id) })), links })) states.set(r.requirement, r.status);
  const requirements = reqRows.map((r): ExtraRequirement => {
    const id = String(r.id);
    return { id, ...opt('text', r.text), ...opt('status', r.status), ...opt('kind', r.kind), ...opt('priority', r.priority), ...opt('source', r.source), acceptance: strs(r.acceptance), satisfiedBy: uniq(satisfiers.get(id) ?? []), state: states.get(id) ?? 'orphan' };
  }).sort((a, b) => cmp(a.id, b.id));
  const supersedes = new Map<string, string[]>(), affected = new Map<string, string[]>();
  for (const l of links) if (l.from_type === 'decision') { const m = l.rel === 'supersedes' ? supersedes : l.rel === 'affects' ? affected : null; if (m) m.set(l.from, [...(m.get(l.from) ?? []), l.to]); }
  const decisions = rows('decision').map((r): ExtraDecision => {
    const id = String(r.id);
    return { id, ...opt('title', r.title), ...opt('status', r.status), ...opt('date', r.date), ...opt('source', r.source), ...opt('derivation', r.derivation), affects: uniq([...strs(r.affects), ...(affected.get(id) ?? [])]), supersedes: uniq(supersedes.get(id) ?? []) };
  }).sort((a, b) => cmp(a.id, b.id));
  const touches = by('touches', 'ticket', 'repo'), files = new Map<string, string[]>();
  for (const r of refRows) if (r.files !== null && typeof r.files === 'object' && !Array.isArray(r.files)) files.set(String(r.key), Object.keys(r.files as Row).sort(cmp));
  const repos = rows('repo').map((r): ExtraRepo => {
    const id = String(r.id), tickets = uniq(touches.get(id) ?? []), globs = (Array.isArray(r.paths) ? r.paths : []).flatMap((p) => (p !== null && typeof p === 'object' && typeof (p as Row).glob === 'string' ? [globRe((p as Row).glob as string)] : []));
    const touched: Record<string, string[]> = {};
    for (const t of tickets) { const fs = (files.get(t) ?? []).filter((f) => !globs.length || globs.some((g) => g.test(f))); if (fs.length) touched[t] = fs; }
    const cmds = textMap(r.cmds);
    return { id, ...opt('name', r.name), ...opt('pm', r.pm), ...(cmds ? { cmds, commands: cmds } : {}), owners: uniq(strs(r.owners)), stack: uniq([...strs(r.langs), ...strs(r.frameworks), ...strs([r.runtime])]), tickets, touched };
  }).sort((a, b) => cmp(a.id, b.id));
  const members = by('member_of', 'person', 'team');
  const teams = rows('team').map((r): ExtraTeam => { const id = String(r.id); return { id, ...opt('name', r.name), members: uniq([...strs(r.members), ...(members.get(id) ?? [])]), owns: uniq(strs(r.owns)) }; }).sort((a, b) => cmp(a.id, b.id));
  return { requirements, decisions, repos, teams, events, modules: readModules(ctx.dir), links, xrefs: xrefRows };
}

/** The value lib/docs takes: modules in its own shape (`hotspot` the rank of the module among the hot ones, 0 when it is not hot; `authors` person ids). */
export function docsExtras(x: Extras): DocsExtras {
  const hot = x.modules.filter((m) => m.hotspot).sort((a, b) => b.churn - a.churn || cmp(a.repo, b.repo) || cmp(a.path, b.path));
  return {
    requirements: x.requirements, decisions: x.decisions, repos: x.repos, teams: x.teams, events: x.events,
    modules: x.modules.map((m) => ({ repo: m.repo, path: m.path, churn: m.churn, bus1: m.bus1, hotspot: m.hotspot ? hot.length - hot.indexOf(m) : 0, authors: m.authors.map((a) => a.person) })),
  };
}
