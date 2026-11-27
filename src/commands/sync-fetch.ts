// plangraph sync-fetch [--sys jira|github|confluence] [--full] [--strict]: read-only requests (GET only, serial, at most 100 items per page) to the
// trackers named in committed config, with the user's own credentials, into the git-ignored cache/<sys>.jsonl (mode 0600) and cache/<sys>.cursor.
// A target named by committed config runs only after `plangraph trust` recorded it locally; an untrusted one is refused with the exact trust
// line. Network errors, rate limits and bad answers change no file and exit 0 (--strict: exit 1). Caps (fetch.max_items, fetch.max_bytes) are
// reported, never silent. Tracker text is never printed here: only counts, codes and capped, scrubbed notes. `sync` stays the compare-only report.
//
// Config read: fetch.github ["owner/repo"], fetch.confluence { space: "<numeric id>", labels: [..] }, fetch.jira { changelog: true }, jira.jql,
// jira.tenant (the alias the observations are filed under), fetch.max_items, fetch.max_bytes.
import fs from 'node:fs';
import path from 'node:path';
import { readCapped, parseJsonl } from '../../lib/jsonl.ts';
import { oneLine } from '../../lib/sanitize.ts';
import { isoDay } from '../../lib/clock.ts';
import { writeAtomicSafe } from '../../lib/fsafe.ts';
import { canonFile } from '../../lib/store.ts';
import { openStore } from '../../lib/planstore.ts';
import { readCursor, writeCursor, scrub } from '../../lib/fetch/cursor.ts';
import { isTrusted, trustLine } from '../../lib/fetch/trust.ts';
import { fetchGithub, DEFAULT_MAX_BYTES, DEFAULT_MAX_ITEMS } from '../../lib/fetch/gh.ts';
import { fetchJira } from '../../lib/fetch/jira.ts';
import { fetchConfluence } from '../../lib/fetch/confluence.ts';
import { sysOk } from '../../lib/graph/files.ts';
import { defaultFetchDeps } from '../fetch-runners.ts';
import { dataError, needBrain, precheckTargets, refuseWrite, usage } from './shared.ts';
import type { FetchDeps } from '../fetch-runners.ts';
import type { Ctx, Args } from '../context.ts';
import type { CommandMap } from '../registry.ts';
import type { Observation } from '../../lib/graph/provider.ts';

type Opts = { sys?: string; full?: boolean; strict?: boolean };
type Obj = Record<string, unknown>;
const SYSTEMS = ['github', 'jira', 'confluence'] as const;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
const KEY_RE = /^[A-Z][A-Z0-9]*-\d+$/;
const MAX_CHANGELOG_KEYS = 200;
const isObj = (x: unknown): x is Obj => x !== null && typeof x === 'object' && !Array.isArray(x);
const posInt = (v: unknown, d: number): number => (Number.isSafeInteger(v) && (v as number) > 0 ? (v as number) : d);
const note = (s: unknown): string => oneLine(scrub(String(s)), 200);
const rowKey = (r: Record<string, unknown>): string => `${String(r.sys)}\0${String(r.xid)}`;

/** Merge observations into cache/<file>.jsonl (upsert on sys and xid), the same cache `import` writes: git-ignored, 0600, canonical order. */
async function mergeCache(ctx: Ctx, file: string, fresh: readonly Observation[], day: string): Promise<void> {
  const { OBS_COLUMNS, obsProblem, MAX_OBSERVATIONS } = await import('../../lib/graph/provider.ts');
  const cache = path.join(ctx.dir, 'cache'), f = path.join(cache, `${file}.jsonl`);
  const old = new Map<string, Obj>();
  try {
    const text = fs.existsSync(f) ? readCapped(f, 64 * 1024 * 1024, { follow: false }) : '';
    for (const r of parseJsonl(text, `cache/${file}.jsonl`, { validate: obsProblem })) old.set(rowKey(r), r);
  } catch (e) { throw dataError(`cache/${file}.jsonl: ${note((e as Error)?.message)}`, 'delete the cache file and fetch again'); }
  const merged = new Map(old);
  for (const o of fresh) merged.set(rowKey(o as unknown as Obj), { ...o, seen: day } as unknown as Obj);
  if (merged.size > MAX_OBSERVATIONS) throw dataError(`the cache would hold more than ${MAX_OBSERVATIONS} observations`, 'delete the cache file and fetch again');
  const body = canonFile([...merged.values()], { order: [...OBS_COLUMNS], id: rowKey });
  // no ignoreCache here: a hook reaches this code and never writes a tracked file; `init` and `import` write the cache/ ignore line
  precheckTargets(ctx, [f]);
  try { const st = fs.lstatSync(cache); if (!st.isDirectory()) throw new Error('not a directory'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw dataError('the cache path is not a directory'); fs.mkdirSync(cache, { mode: 0o700 }); }
  try { writeAtomicSafe(f, body, { root: ctx.root, mode: 0o600 }); } catch (e) { refuseWrite(e); }
}

async function normalize(sys: string, input: unknown, tenant: string, day: string): Promise<Observation[]> {
  const { providerOf } = await import('../../lib/graph/provider.ts');
  const p = providerOf(sys);
  if (!p) throw new Error(`no provider ${sys}`);
  return p.normalize(input, { tenant, now: day, prev: new Map() }).observations as Observation[];
}

async function syncFetch(ctx: Ctx, args: Args<Opts>): Promise<number> {
  const { sys, full, strict } = args.values;
  if (sys !== undefined && !(SYSTEMS as readonly string[]).includes(sys)) throw usage('--sys: one of jira, github, confluence');
  needBrain(ctx);
  const cfg = ctx.config() as { fetch?: unknown; jira?: unknown };
  const fetchCfg: Obj = isObj(cfg.fetch) ? cfg.fetch : {}, jiraCfg: Obj = isObj(cfg.jira) ? cfg.jira : {};
  const maxItems = posInt(fetchCfg.max_items, DEFAULT_MAX_ITEMS), maxBytes = posInt(fetchCfg.max_bytes, DEFAULT_MAX_BYTES);
  const deps: FetchDeps = (ctx as Ctx & { fetchDeps?: FetchDeps }).fetchDeps ?? defaultFetchDeps(ctx); // fetchDeps: a test seam, never set by the shell
  const day = isoDay(ctx.now()), at = ctx.now().toISOString();
  const alias = typeof jiraCfg.tenant === 'string' && sysOk(`jira:${jiraCfg.tenant}`) ? jiraCfg.tenant : '';
  let failed = 0, capped = false, did = 0;
  const tracked = (f: string): boolean => { try { ctx.git('--literal-pathspecs', 'ls-files', '--error-unmatch', '--', path.relative(ctx.root, f)); return true; } catch { return false; } }; // a committed cursor is repository-controlled
  const say = (l: string): void => ctx.io.out(l);
  const fail = (l: string): void => { failed++; say(l); };

  const gate = (target: string): boolean => {
    if (isTrusted(ctx.root, target, ctx.env)) return true;
    failed++;
    say(`refused ${oneLine(target, 120)}: not trusted yet; to allow it run:`);
    say(trustLine(oneLine(target, 200)));
    return false;
  };
  const report = (target: string, status: string, n: number, notes: readonly string[]): void => {
    say(`${oneLine(target, 120)}: ${n} item(s) (${status})`);
    for (const t of notes.slice(0, 10)) say(note(t));
    if (notes.some((t) => /fetch\.max_(items|bytes) \d+ reached/.test(t))) capped = true;
  };
  const tenantOf = (what: string): string | null => {
    try { return deps.atlassian.tenant(); } catch (e) { fail(`${what}: ${note((e as Error)?.message)}`); return null; }
  };

  if (sys === undefined || sys === 'github') {
    for (const repo of Array.isArray(fetchCfg.github) ? fetchCfg.github : []) {
      if (typeof repo !== 'string' || !REPO_RE.test(repo) || repo.includes('..')) { fail('invalid github target in config fetch.github (skipped)'); continue; }
      did++;
      const target = `github:${repo}`;
      if (!gate(target)) continue;
      const cur = full ? null : readCursor(ctx.dir, target, tracked);
      const res = await fetchGithub(deps.github(), { repo, ...(cur?.watermark ? { since: cur.watermark } : {}), ...(cur?.etag ? { etag: cur.etag } : {}), ...(cur?.page ? { page: cur.page } : {}), ...(full ? { full: true } : {}), maxItems, maxBytes });
      if (res.status === 'soft') { fail(`${target}: ${res.notes.map(note).join('; ')}`); continue; }
      if (res.status === 'not-modified') { report(target, 'not modified', 0, res.notes); continue; }
      if (res.status === 'retry-after') failed++;
      const obs = await normalize('github', { repo, prs: res.rows }, alias, day);
      if (obs.length) await mergeCache(ctx, 'github', obs, day);
      writeCursor(ctx.dir, { sys: target, watermark: res.next.watermark, etag: res.next.etag, page: res.next.page, at }, tracked);
      report(target, res.status, obs.length, res.notes);
    }
  }

  const jql = typeof jiraCfg.jql === 'string' ? jiraCfg.jql.trim() : '';
  if (sys === 'jira' || (sys === undefined && (jql !== '' || isObj(fetchCfg.jira)))) {
    did++;
    const tenant = !alias || !jql ? null : tenantOf('jira');
    if (!alias || !jql) fail('jira: set jira.tenant (an alias) and jira.jql in config.json to fetch');
    else if (tenant !== null && gate(`jira:${tenant}`)) {
      const target = `jira:${tenant}`, sysName = `jira:${alias}`, cur = full ? null : readCursor(ctx.dir, sysName, tracked);
      const changelog = isObj(fetchCfg.jira) && fetchCfg.jira.changelog === true
        ? openStore(ctx).readKind('ticket', { defaults: false }).map((t) => String(t.key)).filter((k) => KEY_RE.test(k)).sort().slice(0, MAX_CHANGELOG_KEYS) : undefined;
      const res = await fetchJira(await deps.atlassian.runner(), { jql, ...(cur?.watermark ? { watermark: cur.watermark } : {}), tenant: alias, ...(changelog ? { changelog } : {}), maxItems, maxBytes });
      if (res.status === 'soft' || res.status === 'aborted') fail(`${target}: ${res.notes.map(note).join('; ')}`);
      else {
        if (res.status === 'retry-after') failed++;
        const obs = res.issues.length ? await normalize('jira', { issues: res.issues }, alias, day) : [];
        if (obs.length) await mergeCache(ctx, 'jira', obs, day);
        const tr = res.transitions?.observations.length ? await normalize('generic', res.transitions, alias, day) : [];
        if (tr.length) await mergeCache(ctx, 'generic', tr, day);
        writeCursor(ctx.dir, { sys: sysName, watermark: res.nextWatermark, etag: '', page: '', at }, tracked);
        report(target, res.status, obs.length, res.notes);
      }
    }
  }

  const conf = isObj(fetchCfg.confluence) ? fetchCfg.confluence : null;
  if ((sys === undefined || sys === 'confluence') && (conf || sys === 'confluence')) {
    did++;
    const space = conf && (typeof conf.space === 'string' || typeof conf.space === 'number') ? String(conf.space) : '';
    if (!alias || !/^\d{1,20}$/.test(space)) fail('confluence: set jira.tenant (an alias) and fetch.confluence.space (a numeric space id) in config.json to fetch');
    else {
      const tenant = tenantOf('confluence');
      if (tenant !== null && gate(`confluence:${tenant}/${space}`)) {
        const target = `confluence:${tenant}/${space}`, sysName = `confluence:${alias}/${space}`, cur = full ? null : readCursor(ctx.dir, sysName, tracked);
        const labels = Array.isArray(conf?.labels) ? (conf.labels as unknown[]).filter((l): l is string => typeof l === 'string') : [];
        const res = await fetchConfluence(await deps.atlassian.runner(), { space, labels, ...(cur?.page ? { cursor: cur.page } : {}), ...(full ? { full: true } : {}), maxItems, maxBytes });
        if (res.status === 'soft') fail(`${target}: ${res.notes.map(note).join('; ')}`);
        else {
          if (res.status === 'retry-after') failed++;
          const obs = res.rows.length ? await normalize('confluence', { space, pages: res.rows }, alias, day) : [];
          if (obs.length) await mergeCache(ctx, 'confluence', obs, day);
          writeCursor(ctx.dir, { sys: sysName, watermark: '', etag: '', page: res.next, at }, tracked);
          report(target, res.status, obs.length, res.notes);
        }
      }
    }
  }

  if (!did) { say('nothing to fetch: name targets in config.json (fetch.github, jira.jql with jira.tenant, fetch.confluence)'); return 0; }
  say(`caps: fetch.max_items ${maxItems}, fetch.max_bytes ${maxBytes}${capped ? ' (reached, see above)' : ''}`);
  ctx.io.data?.({ failed, capped, max_items: maxItems, max_bytes: maxBytes }, { next: [] });
  return strict && failed ? 1 : 0;
}

const B = { type: 'boolean' };
export const commands: CommandMap = {
  'sync-fetch': {
    run: syncFetch as never, positionals: [0, 0], writes: 'file', guard: 'soft',
    options: { sys: { type: 'string' }, full: B, strict: B },
    summary: '[--sys jira|github|confluence] [--full] [--strict]: read-only fetch of the trusted targets in config.json into the git-ignored cache (0600) with cursors; untrusted targets are refused with the `plangraph trust` line; --strict exits 1 on a failed fetch',
  },
};
