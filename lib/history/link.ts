// lib/history/link.ts: ticket keys in branch names, PR titles, commit messages and PR bodies, ranked by source. Pure, no I/O.
// `keys` holds project prefixes (`ABC`). One precompiled regex per prefix, never a catch-all like [A-Z]+-\d+, so `UTF-8` and `SHA-256` are not
// keys and a project keyed `R` or `D` cannot see requirement or decision ids (`R-a1b2c3` has no digits after the dash).
// All text read here (PR titles, bodies, commit messages) is untrusted DATA. It is matched and never interpreted or echoed; fencing happens
// at print time in the command layer, not here.
import type { CommitFact } from './parse.ts';

export type Source = 'branch' | 'title' | 'commit' | 'body';
export interface Evidence { key: string; source: Source; conf: number }
export interface TicketLink { key: string; repo: string; sources: Source[]; conf: number; prs: number[] }
/** One row of `cache/github.jsonl`, the fields the linker reads (same names lib/graph/github.ts writes). */
export interface PrObservation { number: number; repo?: string; branch?: string; title?: string; body?: string; merged?: boolean; base?: string }
export type LinkCommit = CommitFact & { message?: string; branch?: string; repo?: string };

export const CONF: Record<Source, number> = { branch: 0.95, title: 0.9, commit: 0.75, body: 0.5 };
const CLOSING_FULL = 0.9, CLOSING_OFF_DEFAULT = 0.4, MIN_CONF = 0.5, MAX_TEXT = 20000;
const PREFIX = /^[A-Z][A-Z0-9_]{0,19}$/;
const CLOSING = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)[:\s]+$/i;

const compiled = new WeakMap<ReadonlySet<string>, RegExp[]>();
function patterns(keys: ReadonlySet<string>): RegExp[] {
  let r = compiled.get(keys);
  if (!r) {
    r = [...keys].filter((k) => PREFIX.test(k)).sort().map((k) => new RegExp(`(?<![A-Za-z0-9_])${k}-(\\d{1,9})(?![A-Za-z0-9_])`, 'g'));
    compiled.set(keys, r);
  }
  return r;
}

function scan(text: string | undefined, keys: ReadonlySet<string>): Array<{ key: string; before: string }> {
  if (typeof text !== 'string' || !text) return [];
  const t = text.slice(0, MAX_TEXT), out: Array<{ key: string; before: string }> = [];
  for (const re of patterns(keys)) for (const m of t.matchAll(re)) out.push({ key: m[0], before: t.slice(Math.max(0, m.index - 20), m.index) });
  return out;
}

/** Evidence per key and source. A body key after a closing keyword counts 0.9 when `closing` is true (PR base is the default branch) and 0.4 when
 *  false (GitHub does not link it); a plain body mention is 0.5. Evidence below 0.5 is returned; linkTickets reports it as low. */
export function linkEvidence(input: { branch?: string | undefined; title?: string | undefined; commit?: string | undefined; body?: string | undefined }, keys: ReadonlySet<string>, opts: { closing?: boolean } = {}): Evidence[] {
  const best = new Map<string, Evidence>();
  const add = (key: string, source: Source, conf: number): void => {
    const k = `${key}\0${source}`, o = best.get(k);
    if (!o || conf > o.conf) best.set(k, { key, source, conf });
  };
  for (const s of ['branch', 'title', 'commit'] as const) for (const h of scan(input[s], keys)) add(h.key, s, CONF[s]);
  for (const h of scan(input.body, keys)) add(h.key, 'body', CLOSING.test(h.before) ? (opts.closing ? CLOSING_FULL : CLOSING_OFF_DEFAULT) : CONF.body);
  return [...best.values()].sort((a, b) => b.conf - a.conf || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) || (a.source < b.source ? -1 : 1));
}

const SQUASH = /\(#(\d{1,9})\)\s*$/m;
const ORDER: Source[] = ['branch', 'title', 'commit', 'body'];

export function linkTickets(commits: readonly LinkCommit[], prs: readonly PrObservation[], keys: ReadonlySet<string>, opts: { repo?: string; defaultBranch?: string } = {}): { links: TicketLink[]; low: TicketLink[] } {
  const byNum = new Map<number, PrObservation>();
  for (const p of prs) if (Number.isInteger(p.number) && p.number > 0) byNum.set(p.number, p);
  const acc = new Map<string, TicketLink & { src: Set<Source>; pr: Set<number> }>();
  const put = (repo: string, ev: Evidence[], pr?: number): void => {
    for (const e of ev) {
      const id = `${repo}\0${e.key}`;
      let l = acc.get(id);
      if (!l) acc.set(id, l = { key: e.key, repo, sources: [], conf: 0, prs: [], src: new Set(), pr: new Set() });
      l.src.add(e.source);
      if (e.conf > l.conf) l.conf = e.conf;
      if (pr !== undefined) l.pr.add(pr);
    }
  };
  const prEvidence = (p: PrObservation): Evidence[] => linkEvidence({ branch: p.branch, title: p.title, body: p.body }, keys, { closing: p.base !== undefined && p.base === opts.defaultBranch });
  for (const p of byNum.values()) put(p.repo ?? opts.repo ?? '', prEvidence(p), p.number);
  for (const c of commits) {
    const repo = c.repo ?? opts.repo ?? '';
    put(repo, linkEvidence({ branch: c.branch, commit: c.message }, keys));
    const sq = typeof c.message === 'string' ? SQUASH.exec(c.message.slice(0, MAX_TEXT)) : null, p = sq ? byNum.get(Number(sq[1])) : undefined;
    if (p && p.merged === true) put(p.repo ?? repo, prEvidence(p), p.number); // squash subject `Fix login (#42)`: the PR observation carries the evidence
  }
  const links: TicketLink[] = [], low: TicketLink[] = [];
  for (const l of acc.values()) {
    const out: TicketLink = { key: l.key, repo: l.repo, sources: ORDER.filter((s) => l.src.has(s)), conf: l.conf, prs: [...l.pr].sort((a, b) => a - b) };
    (out.conf >= MIN_CONF ? links : low).push(out);
  }
  const cmp = (a: TicketLink, b: TicketLink): number => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  return { links: links.sort(cmp), low: low.sort(cmp) };
}
