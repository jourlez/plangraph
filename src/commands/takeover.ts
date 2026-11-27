// plangraph takeover [--from STEP] [--skip STEP] [--no-fetch] [--json]: an existing project into the graph, in one resumable pipeline:
// detect, scan, history, docs, plans, fetch, links, identities, build, check, map, docs-build, report. Each step calls the function of its
// own command directly (no subprocess). A checkpoint is committed after each step in cache/takeover.json (0600) through one withTxn
// transaction; a failed step is recorded and the later steps that do not need it still run. A step with no input is skipped silently. The run
// ends with a deterministic gap report: every unknown listed, never guessed, and the questions only the owner can answer. The whole tracker
// history stays in cache/; only planned tickets become committed nodes. Prints codes and counts, never tracker or document text.
import fs from 'node:fs';
import path from 'node:path';
import { readCapped, parseJsonl } from '../../lib/jsonl.ts';
import { oneLine } from '../../lib/sanitize.ts';
import { withTxn } from '../../lib/store2/txn.ts';
import { makeContext } from '../context.ts';
import { openStore } from '../../lib/planstore.ts';
import { loadExtras } from '../../lib/extras.ts';
import { readIdentityMap, proposeIdentities, matchIdentity } from '../../lib/identity.ts';
import { slugOf, globRe } from '../../lib/graph/repo.ts';
import { isShallow } from '../../lib/history/git.ts';
import { MAP_BUDGET } from '../../lib/digest.ts';
import { fenceBlock, needBrain, usage } from './shared.ts';
import { commands as repoCmds } from './repo.ts';
import { commands as ingestCmds } from './ingest.ts';
import { commands as fetchCmds } from './sync-fetch.ts';
import { commands as planCmds } from './plan.ts';
import { commands as queryCmds } from './queries.ts';
import { commands as docsBuildCmds } from './docs-build.ts';
import { commands as mapCmds } from './map.ts';
import { commands as integrationCmds } from './integrations.ts';
import type { Ctx, Args } from '../context.ts';
import type { CommandMap } from '../registry.ts';

const STEPS = ['detect', 'scan', 'history', 'docs', 'plans', 'fetch', 'links', 'identities', 'build', 'check', 'map', 'docs-build', 'report'] as const;
type Step = (typeof STEPS)[number];
interface Checkpoint {
  version: 1; done: string[]; failed: { step: string; reason: string }[]; questions: { id: string; text: string }[];
  /** steps that ran without their input (no network, a shallow clone, --no-fetch): done, but listed so the report can say why */
  skipped?: { step: string; reason: string }[];
  /** a fetch stopped at fetch.max_items or fetch.max_bytes */
  capped?: boolean;
}
const FILE = 'cache/takeover.json';
const NEEDS: Partial<Record<Step, Step>> = { links: 'scan', check: 'build', map: 'build', 'docs-build': 'build' };
const SKIP = Symbol('skip');
type Outcome = void | { skip: string } | typeof SKIP;
type Opts = { from?: string; skip?: string[]; 'no-fetch'?: boolean };
/** Test seam, never set by the shell: a throw from afterStep aborts the run exactly as a kill would (the checkpoint of the finished step is already on disk). */
type Hooks = { afterStep?: (step: string) => void };

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const one = (e: unknown): string => oneLine(String((e as { message?: unknown } | null)?.message ?? e).split('\n')[0], 200);
const call = (cmds: CommandMap, name: string, ctx: Ctx, positionals: string[] = [], values: object = {}): Promise<number> => Promise.resolve((cmds[name] as unknown as { run: (c: Ctx, a: Args) => number | Promise<number> }).run(ctx, { values: values as Record<string, unknown>, positionals }));

function readState(dir: string): Checkpoint {
  const empty: Checkpoint = { version: 1, done: [], failed: [], questions: [] };
  try {
    const j = JSON.parse(readCapped(path.join(dir, FILE), 1 << 20, { follow: false })) as Partial<Checkpoint>;
    if (j.version !== 1 || !Array.isArray(j.done) || !Array.isArray(j.failed) || !Array.isArray(j.questions)) return empty;
    const s: Checkpoint = { version: 1, done: j.done.filter((x): x is string => typeof x === 'string'), failed: j.failed.filter((f) => typeof f?.step === 'string' && typeof f?.reason === 'string'), questions: j.questions.filter((q) => typeof q?.id === 'string' && typeof q?.text === 'string') };
    if (Array.isArray(j.skipped)) s.skipped = j.skipped.filter((f) => typeof f?.step === 'string' && typeof f?.reason === 'string');
    if (j.capped === true) s.capped = true;
    return s;
  } catch { return empty; }
}
function saveCheckpoint(dir: string, s: Checkpoint): void {
  const norm: Checkpoint = { version: 1, done: STEPS.filter((x) => s.done.includes(x)), failed: [...s.failed].sort((a, b) => cmp(a.step, b.step)), questions: [...s.questions].sort((a, b) => cmp(a.id, b.id)), ...(s.skipped?.length ? { skipped: [...s.skipped].sort((a, b) => cmp(a.step, b.step)) } : {}), ...(s.capped ? { capped: true } : {}) };
  const text = `${JSON.stringify(norm, null, 2)}\n`;
  const file = path.join(dir, FILE);
  try { if (fs.readFileSync(file, 'utf8') === text) return; } catch { /* not written yet */ }
  withTxn(dir, (tx) => tx.write(FILE, text));
  fs.chmodSync(file, 0o600);
}

/** A context for one step: its own index handle (the build replaces the index file mid-run), output captured, the test seams carried over. */
function stepCtx(ctx: Ctx, lines: string[], errs: string[], data: unknown[]): Ctx & { [Symbol.dispose](): void } {
  const fresh = makeContext({ cwd: ctx.cwd ?? ctx.root, env: ctx.env, flags: ctx.flags, root: ctx.root, now: ctx.now, io: { out: (l) => { lines.push(l); }, err: (l) => { errs.push(l); }, data: (d) => { data.push(d); } } });
  return Object.assign(Object.create(null), fresh, { fetchDeps: (ctx as Ctx & { fetchDeps?: unknown }).fetchDeps, git: ctx.git }) as Ctx & { [Symbol.dispose](): void };
}

const isRepoDir = (p: string): boolean => { try { return !fs.lstatSync(p).isSymbolicLink() && fs.lstatSync(path.join(p, '.git')).isDirectory(); } catch { return false; } };
const mdIn = (dir: string, re: RegExp): string[] => { try { return fs.readdirSync(dir).filter((n) => re.test(n)).sort().map((n) => path.join(dir, n)); } catch { return []; } };
const relOf = (ctx: Ctx, abs: string): string => path.relative(ctx.root, abs).split(path.sep).join('/');
const repoId = (ctx: Ctx): string => `repo:${slugOf(path.basename(ctx.root)) ?? 'self'}`;
const CODEOWNERS = ['CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS'];
const hasCodeowners = (ctx: Ctx): boolean => CODEOWNERS.some((f) => { try { return fs.statSync(path.join(ctx.root, f)).isFile(); } catch { return false; } });

/** Tracker assignees seen in the observation cache (cache/*.jsonl), one per ref, sorted. Tracker text: only ever printed fenced. */
function observedAssignees(dir: string): { ref: string; display: string }[] {
  const seen = new Map<string, string>();
  let names: string[] = []; try { names = fs.readdirSync(path.join(dir, 'cache')).filter((n) => n.endsWith('.jsonl') && n !== 'git.jsonl').sort(); } catch { /* no cache */ }
  for (const n of names) {
    let text = ''; try { text = readCapped(path.join(dir, 'cache', n), 64 * 1024 * 1024, { follow: false }); } catch { continue; }
    let rows: Record<string, unknown>[] = []; try { rows = parseJsonl(text, `cache/${n}`, {}) as Record<string, unknown>[]; } catch { continue; }
    for (const r of rows) {
      const f = r.fields; const who = f && typeof f === 'object' && typeof (f as { assignee?: unknown }).assignee === 'string' ? (f as { assignee: string }).assignee.trim() : '';
      if (who && typeof r.sys === 'string') seen.set(`${r.sys}:${who}`, who);
    }
  }
  return [...seen].map(([ref, display]) => ({ ref, display })).sort((a, b) => cmp(a.ref, b.ref));
}
function identityQuestions(ctx: Ctx): { id: string; text: string }[] {
  const people = openStore(ctx).readKind('person', { defaults: false }), map = readIdentityMap(ctx.dir);
  const obs = observedAssignees(ctx.dir).filter((o) => map.byRef[o.ref] === undefined);
  const props = new Map(proposeIdentities(obs, people).map((p) => [p.ref, p]));
  return obs.map((o) => {
    const p = props.get(o.ref), amb = (matchIdentity(o.display, people)?.persons.length ?? 0) > 1;
    return { id: `identity:${oneLine(o.ref, 120)}`, text: p ? `confirm ${oneLine(o.ref, 120)} is ${oneLine(p.person, 60)} (${p.conf}, ${p.why}): plangraph identity-map REF PERSON` : amb ? `${oneLine(o.ref, 120)} matches several people: pick one with plangraph identity-map REF PERSON` : `${oneLine(o.ref, 120)} matches no plan person: add the person or map it with plangraph identity-map REF PERSON` };
  });
}

type Ran = { code: number; lines: string[]; errs: string[]; data: unknown[] };
async function run(ctx: Ctx, cmds: CommandMap, name: string, positionals: string[] = [], values: object = {}): Promise<Ran> {
  const lines: string[] = [], errs: string[] = [], data: unknown[] = [];
  const sc = stepCtx(ctx, lines, errs, data);
  try { return { code: await call(cmds, name, sc, positionals, values), lines, errs, data }; } finally { sc[Symbol.dispose]?.(); }
}
const must = (r: Ran, what: string): void => { if (r.code !== 0) throw new Error(`${what} exited ${r.code}${r.errs[0] ? `: ${oneLine(r.errs[0], 160)}` : r.lines.at(-1) ? `: ${oneLine(r.lines.at(-1) as string, 160)}` : ''}`); };

interface Run { ctx: Ctx; state: Checkpoint; opts: Opts }
type Body = (r: Run) => Promise<Outcome>;
const BODIES: Record<Step, Body> = {
  async detect({ ctx }) { must(await run(ctx, planCmds, 'init'), 'init'); },
  async scan({ ctx }) {
    must(await run(ctx, repoCmds, 'repo', ['scan', ctx.root]), 'repo scan');
    let kids: string[] = []; try { kids = fs.readdirSync(ctx.root).filter((n) => n !== 'node_modules' && isRepoDir(path.join(ctx.root, n))); } catch { /* unreadable */ }
    if (kids.length) must(await run(ctx, repoCmds, 'repo', ['scan', ctx.root], { all: true }), 'repo scan --all');
  },
  async history({ ctx }) {
    if (isShallow(ctx.git)) return { skip: 'shallow clone' };
    must(await run(ctx, ingestCmds, 'ingest', ['git'], { repo: repoId(ctx) }), 'ingest git');
  },
  async docs({ ctx }) {
    const reqs = [...mdIn(path.join(ctx.root, 'docs', 'requirements'), /\.md$/i), ...mdIn(path.join(ctx.root, 'docs'), /^(requirements|prd)[^/]*\.md$/i), ...mdIn(ctx.root, /^(requirements|prd)[^/]*\.md$/i)].slice(0, 20);
    const adr = ['docs/adr', 'docs/decisions', 'doc/adr', 'adr'].some((d) => { try { return fs.statSync(path.join(ctx.root, d)).isDirectory(); } catch { return false; } });
    if (!reqs.length && !adr) return SKIP;
    if (adr) must(await run(ctx, ingestCmds, 'ingest', ['docs']), 'ingest docs');
    for (const f of reqs) must(await run(ctx, ingestCmds, 'ingest', ['requirements', relOf(ctx, f)]), 'ingest requirements');
  },
  async plans({ ctx }) {
    const plans = mdIn(path.join(ctx.root, 'docs', 'superpowers', 'plans'), /\.md$/i).slice(0, 50);
    if (!plans.length) return SKIP;
    let bad: string | undefined;
    for (const f of plans) { try { must(await run(ctx, integrationCmds, 'sp-ingest', [relOf(ctx, f)]), 'sp-ingest'); } catch (e) { bad ??= one(e); } }
    if (bad) throw new Error(bad);
  },
  async fetch(r) {
    if (r.opts['no-fetch']) return { skip: 'no-fetch' };
    const res = await run(r.ctx, fetchCmds, 'sync-fetch', [], { strict: true });
    if (res.lines.some((l) => l.startsWith('nothing to fetch'))) return { skip: 'no tracker configured' };
    const d = res.data[0] as { capped?: boolean } | undefined;
    if (d?.capped) r.state.capped = true;
    if (res.code !== 0) return { skip: 'tracker not reachable or not trusted' };
  },
  async links({ ctx }) {
    const st = openStore(ctx), repos = st.readKind('repo', { defaults: false }).map((x) => String(x.id));
    if (!repos.length || !(st.readKind('ticket', { defaults: false }).length + st.readKind('ref', { defaults: false }).length)) return SKIP;
    const id = repos.includes(repoId(ctx)) ? repoId(ctx) : repos.length === 1 ? repos[0] : undefined;
    if (!id) return SKIP;
    must(await run(ctx, ingestCmds, 'ingest', ['links'], { repo: id }), 'ingest links');
  },
  async identities(r) {
    needBrain(r.ctx);
    const q = identityQuestions(r.ctx);
    r.state.questions = [...r.state.questions.filter((x) => !x.id.startsWith('identity:')), ...q];
    if (!q.length) return SKIP;
  },
  async build({ ctx }) { must(await run(ctx, planCmds, 'build'), 'build'); },
  async check({ ctx }) { must(await run(ctx, queryCmds, 'check'), 'check'); },
  async map({ ctx }) {
    const res = await run(ctx, mapCmds, 'map');
    must(res, 'map');
    const tokens = Math.ceil(res.lines.join('\n').length / 4);
    if (tokens > MAP_BUDGET) throw new Error(`map is ${tokens} estimated tokens, over ${MAP_BUDGET}`);
  },
  async 'docs-build'({ ctx }) { must(await run(ctx, docsBuildCmds, 'docs-build'), 'docs-build'); },
  async report() { /* printed by the command after the loop */ },
};

/** Every unknown, one line each, sorted: nothing here is guessed. */
function gapReport(ctx: Ctx, state: Checkpoint): string[] {
  const gaps: string[] = [];
  if (!hasCodeowners(ctx)) gaps.push('no CODEOWNERS');
  const sk = (s: string): string | undefined => state.skipped?.find((x) => x.step === s)?.reason;
  const cfg = ctx.config() as { fetch?: unknown; jira?: { jql?: unknown } };
  const targets = cfg.fetch && typeof cfg.fetch === 'object' && Object.keys(cfg.fetch).length > 0 || (typeof cfg.jira?.jql === 'string' && cfg.jira.jql.trim() !== '');
  if (!targets || sk('fetch')) gaps.push(sk('fetch') === 'no-fetch' ? 'no tracker access (fetch skipped by --no-fetch)' : 'no tracker access');
  if (isShallow(ctx.git)) gaps.push('shallow clone');
  if (state.capped) gaps.push('tracker history beyond the fetch caps');
  let x: ReturnType<typeof loadExtras> | undefined;
  try { x = loadExtras(ctx); } catch { /* an unreadable plan is a failed step, listed below */ }
  if (x) {
    const unmapped = x.modules.filter((m) => m.authors.some((a) => a.person === 'other')).length;
    if (unmapped) gaps.push(`unmapped authors: ${unmapped} module(s) with commits by authors that map to no person`);
    const open = x.requirements.filter((q) => q.status !== 'dropped' && q.satisfiedBy.length === 0).length;
    if (open) gaps.push(`requirements without tasks: ${open}`);
    let files: string[] = []; try { files = ctx.git('ls-files').split('\n').filter(Boolean); } catch { /* no repository */ }
    const dangling = x.decisions.filter((d) => d.affects.some((g) => { try { const re = globRe(g); return !files.some((f) => re.test(f)); } catch { return true; } })).length;
    if (dangling) gaps.push(`decisions with dangling affects: ${dangling}`);
  }
  for (const f of state.failed) gaps.push(`step ${f.step} failed: ${oneLine(f.reason, 160)}`);
  return [...new Set(gaps)].sort(cmp);
}

async function takeover(ctx: Ctx, args: Args<Opts>): Promise<number> {
  const { from, skip = [], 'no-fetch': noFetch } = args.values;
  if (args.positionals.length !== 0) throw usage('usage: plangraph takeover [--from STEP] [--skip STEP] [--no-fetch]');
  const known = (s: string): boolean => (STEPS as readonly string[]).includes(s);
  if (from !== undefined && !known(from)) throw usage(`--from: one of ${STEPS.join(' ')}`);
  for (const s of skip) if (!known(s)) throw usage(`--skip: one of ${STEPS.join(' ')}`);
  const hooks = (ctx as Ctx & { takeoverHooks?: Hooks }).takeoverHooks;
  fs.mkdirSync(ctx.dir, { recursive: true });
  const state = readState(ctx.dir), say = (l: string): void => ctx.io.out(l);
  const firstUndone = STEPS.findIndex((s) => !state.done.includes(s));
  const start = from !== undefined ? STEPS.indexOf(from as Step) : firstUndone === -1 ? STEPS.length : firstUndone;
  const failedNow = new Set<string>();
  for (const step of STEPS.slice(start)) {
    if (skip.includes(step) || (from === undefined && state.done.includes(step))) continue;
    if (step === 'report') continue; // the report is always printed, below
    state.done = state.done.filter((s) => s !== step); state.failed = state.failed.filter((f) => f.step !== step); if (state.skipped) state.skipped = state.skipped.filter((f) => f.step !== step);
    const need = NEEDS[step];
    let line: string;
    if (need !== undefined && (failedNow.has(need) || state.failed.some((f) => f.step === need))) {
      state.failed.push({ step, reason: `needs ${need}` }); failedNow.add(step); line = `${step}: failed (needs ${need})`;
    } else {
      try {
        const out = await BODIES[step]({ ctx, state, opts: { ...(noFetch ? { 'no-fetch': true } : {}) } });
        state.done.push(step);
        if (out && out !== SKIP) { (state.skipped ??= []).push({ step, reason: out.skip }); line = `${step}: skipped (${out.skip})`; } else line = out === SKIP ? '' : `${step}: ok`;
      } catch (e) { state.failed.push({ step, reason: one(e) }); failedNow.add(step); line = `${step}: failed (${one(e)})`; }
    }
    saveCheckpoint(ctx.dir, state);
    if (line) say(line);
    hooks?.afterStep?.(step);
  }
  // the report: gaps and owner questions, computed from the files as they are now
  const gaps = gapReport(ctx, state);
  const base = state.questions.filter((q) => q.id !== 'tracker-access');
  const needTracker = gaps.some((g) => g.startsWith('no tracker access'));
  state.questions = needTracker ? [...base, { id: 'tracker-access', text: 'give plangraph tracker access: name the targets in config.json, trust them with `plangraph trust`, and sign in to gh or the Atlassian tenant' }] : base;
  state.failed = state.failed.filter((f) => f.step !== 'report');
  if (!state.done.includes('report') && !state.failed.length) state.done.push('report');
  saveCheckpoint(ctx.dir, state);
  say(`gaps: ${gaps.length}`);
  for (const g of gaps) say(`- ${g}`);
  say(`questions: ${state.questions.length}`);
  if (state.questions.length) ctx.io.outBlock(fenceBlock('takeover-questions', [...state.questions].sort((a, b) => cmp(a.id, b.id)).map((q) => `${q.id}: ${q.text}`)));
  ctx.io.data?.({ done: state.done, failed: state.failed, skipped: state.skipped ?? [], gaps, questions: [...state.questions].sort((a, b) => cmp(a.id, b.id)) }, { next: [] });
  return 0;
}

const B = { type: 'boolean' };
export const commands: CommandMap = {
  takeover: {
    run: takeover as never, positionals: [0, 0], writes: 'text', guard: 'strict',
    options: { from: { type: 'string' }, skip: { type: 'string', multiple: true }, 'no-fetch': B },
    summary: '[--from STEP] [--skip STEP] [--no-fetch]: resumable pipeline (detect, scan, history, docs, plans, fetch, links, identities, build, check, map, docs-build, report) with checkpoints in cache/takeover.json and a gap report of every unknown plus the questions only the owner can answer',
  },
};
