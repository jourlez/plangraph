// Generated documents: the generator list, build and check over an injected file interface (no real plan directory needed).
// Each generator output sits in one marker region whose fingerprint covers exactly the facts it prints plus its template version.
import type { Model, PlanConfig } from '../model.ts';
import { cmp, idText } from './fence.ts';
import { policyFromList, policyKey, scanDocs, type DataPolicy, type Known, type Violation } from './policy.ts';
import { checkRegions, fingerprint, injectRegions, type Region, type RefusalReason, type RegionStatus } from './regions.ts';
import type { Ctx, Extras, Generator } from './types.ts';
import { docsOut } from './generators/common.ts';
import { roadmap } from './generators/roadmap.ts';
import { rtm } from './generators/rtm.ts';
import { adrIndex } from './generators/adr-index.ts';
import { status } from './generators/status.ts';
import { architecture } from './generators/architecture.ts';
import { repoPage } from './generators/repo-page.ts';
import { onboarding } from './generators/onboarding.ts';
import { releaseNotes } from './generators/release-notes.ts';

export type { DataPolicy } from './policy.ts';
export type { Generator, Extras } from './types.ts';

/** The file operations a build needs. read is only called for a path that exists. */
export type FsLike = { read(path: string): string; write(path: string, text: string): void; exists(path: string): boolean; mkdirp(dir: string): void };
export type DocsError = Error & { code: 'OUT_OUTSIDE_ROOT' };

export const GENERATORS: readonly Generator[] = [roadmap, rtm, adrIndex, status, architecture, repoPage, onboarding, releaseNotes];

export const policyOf = (cfg: PlanConfig): DataPolicy => policyFromList(((cfg.docs ?? {}) as { include?: unknown }).include);

/** The out directory must be a relative path inside the repository root. */
export function checkOut(cfg: PlanConfig): string {
  const out = docsOut(cfg);
  if (out.startsWith('/') || /^[A-Za-z]:/.test(out) || out.split('/').includes('..') || out.includes('\0') || out === '.' || out === '') {
    throw Object.assign(new Error('docs.out must be a relative path inside the repository'), { code: 'OUT_OUTSIDE_ROOT' as const });
  }
  return out;
}

export type Unit = { gen: string; path: string; title: string; region: Region; body: string };

/** Every document to write, sorted by path. */
export function planDocs(model: Model, cfg: PlanConfig, extras: Extras = {}, generators: readonly Generator[] = GENERATORS): Unit[] {
  const out = checkOut(cfg);
  const policy = policyOf(cfg);
  const units: Unit[] = [];
  for (const g of generators) {
    const keys = g.keys ? g.keys(model, extras) : [undefined];
    for (const key of keys) {
      const c: Ctx = key === undefined ? { extras, cfg, policy } : { extras, cfg, policy, key };
      const body = g.render(model, policy, c);
      const fp = fingerprint([...g.inputs(model, c), `policy:${policyKey(policy)}`], g.v);
      const id = key === undefined ? g.id : `${g.id}.${key}`;
      units.push({ gen: g.id, path: `${out}/${g.out(cfg, key)}`, title: g.title(key), region: { id, fp, v: g.v, body }, body });
    }
  }
  return units.sort((a, b) => cmp(a.path, b.path));
}

/** What the data-class scan must not see in a document under this policy. */
export function knownOf(model: Model, extras: Extras): Known {
  const names = new Set<string>();
  for (const p of model.sched.values()) if (p.owner) names.add(p.owner);
  for (const t of model.tickets.values()) if (t.v2_owner) names.add(t.v2_owner);
  const texts = [...model.tickets.values()].map((t) => t.summary).filter((s): s is string => typeof s === 'string');
  const authors = new Set<string>();
  for (const m of extras.modules ?? []) for (const a of m.authors ?? []) authors.add(a);
  return { names: [...names].sort(), texts: texts.sort(), authors: [...authors].sort() };
}

export type BuildResult = {
  written: string[];
  refused: { path: string; id: string; reason: RefusalReason }[];
  violations: (Violation & { id: string })[];
};

const dirOf = (p: string): string => p.slice(0, p.lastIndexOf('/'));
const head = (title: string): string => `${title}\n`;

/** Build every document. A violation in any document stops the whole build before anything is written. */
export function buildDocs(model: Model, cfg: PlanConfig, fs: FsLike, extras: Extras = {}, opts: { force?: boolean; generators?: readonly Generator[] } = {}): BuildResult {
  const units = planDocs(model, cfg, extras, opts.generators);
  const policy = policyOf(cfg);
  const known = knownOf(model, extras);
  const violations: BuildResult['violations'] = [];
  for (const u of units) for (const v of scanDocs(u.body, policy, known)) violations.push({ ...v, id: u.region.id });
  const res: BuildResult = { written: [], refused: [], violations };
  if (violations.length > 0) return res;
  for (const u of units) {
    const had = fs.exists(u.path);
    const before = had ? fs.read(u.path) : head(u.title);
    const r = injectRegions(before, [u.region], opts.force ? { force: true } : {});
    for (const f of r.refused) res.refused.push({ path: u.path, id: f.id, reason: f.reason });
    if (r.refused.length === 0 && (r.changed.length > 0 || !had)) {
      fs.mkdirp(dirOf(u.path));
      fs.write(u.path, r.text);
      res.written.push(u.path);
    }
  }
  return res;
}

export type CheckRow = { path: string; id: string; status: RegionStatus };
/** Regenerate and compare: every region is fresh, stale, edited or missing. ok is true when all are fresh. */
export function checkDocs(model: Model, cfg: PlanConfig, fs: FsLike, extras: Extras = {}, opts: { generators?: readonly Generator[] } = {}): { ok: boolean; rows: CheckRow[] } {
  const rows: CheckRow[] = [];
  for (const u of planDocs(model, cfg, extras, opts.generators)) {
    if (!fs.exists(u.path)) { rows.push({ path: u.path, id: u.region.id, status: 'missing' }); continue; }
    for (const r of checkRegions(fs.read(u.path), [u.region])) rows.push({ path: u.path, id: r.id, status: r.status });
  }
  return { ok: rows.every((r) => r.status === 'fresh'), rows };
}

/** One line per document: path and generator id, for `docs list`. */
export const listDocs = (model: Model, cfg: PlanConfig, extras: Extras = {}, generators: readonly Generator[] = GENERATORS): string[] =>
  planDocs(model, cfg, extras, generators).map((u) => `${idText(u.path)} ${u.gen}`);
