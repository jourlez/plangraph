// Companion tools: integrations (detection, files only), sp-ingest and sp-link (superpowers plans and ledgers: read-only on superpowers
// files; writes only plangraph JSONL, canonical, atomic, confined to the repo), learn --from-wolf (one OpenWolf rule into learnings.jsonl).
// Errors of sp-ingest, sp-link and learn print one `error: ...` line and exit 2 (a refused write target: symlink, not a regular file or
// outside the repository, exits 4); nothing is written unless every file was computed, validated and pre-checked first.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../../lib/planstore.ts';
import type { Kind } from '../../lib/planstore.ts';
import { oneLine, fence } from '../../lib/sanitize.ts';
import { assertInside } from '../../lib/fsafe.ts';
import { checkRepoPath, makeGit } from '../../lib/gitsafe.ts';
import { PlangraphError } from '../errors.ts';
import { verbose, usage, needBrain, refuseWrite } from './shared.ts';
import type { Ctx, Args } from '../context.ts';
import type { CommandMap } from '../registry.ts';
import type { BudgetItem } from '../../lib/integrations/detect.ts';
import type { IngestOpts } from '../../lib/integrations/superpowers.ts';
import type { RepoRule } from '../../lib/integrations/openwolf.ts';
/** What spErrors reads of a thrown value (an Error, an aggregated error with `total`, or anything else). */
interface ThrownLike { code?: unknown; message?: unknown; total?: unknown }
type Rec = Record<string, unknown>;

// ---- companion tools ----
async function integrations(ctx: Ctx, args: Args): Promise<number> {
  const { detectTools } = await import('../../lib/integrations/detect.ts'), out = ctx.io.out, v = verbose(args);
  const r = detectTools({ root: ctx.root, home: ctx.env.HOME || os.homedir(), env: ctx.env });
  const { ledgerLayoutOf } = await import('../../lib/integrations/superpowers.ts');
  // Evidence strings are `installed: KEY`, `enabled: KEY in LABEL`, `enabled, not installed: KEY in LABEL` (lib/integrations/detect.ts).
  const scope = (label: string) => (label.startsWith('project settings.local') ? 'local' : label.split(' ')[0]);
  const keysOf = (t: { evidence: string[] }, re: RegExp) => t.evidence.map((e: string) => re.exec(e)).filter(Boolean) as RegExpExecArray[]; // filter(Boolean) dropped the nulls
  for (const t of r.tools) {
    let line = `${oneLine(t.name, 40)}: `;
    const inst = keysOf(t, /^installed: (\S+)$/).map((m) => `installed ${oneLine(m[1])}`);
    const en = keysOf(t, /^enabled: (\S+) in (.+)$/).map((m) => `${oneLine(scope(m[2] as string), 20)} enables ${oneLine(m[1])}`); // group 2 is not optional: it is set in every match
    const notInst = keysOf(t, /^enabled, not installed: (\S+) in (.+)$/).map((m) => `${oneLine(m[1])} (${oneLine(scope(m[2] as string), 20)})`); // group 2 is not optional: it is set in every match
    const miss = notInst.length ? [`enabled but not installed: ${notInst.join(', ')}`] : [];
    if (t.state === 'absent') line += 'absent' + (miss.length ? ` (${miss.join('; ')})` : '');
    else if (t.name === 'openwolf' && t.state === 'protocol-only') line += 'rules only (hooks not registered)';
    else {
      line += oneLine(t.state, 20) + (t.version ? ` ${oneLine(t.version, 64)}` : '');
      // enabled: which key is installed and which layer enables it; any enabled key that is not the installed one is said separately
      if (t.state === 'enabled' || miss.length) line += ` (${[...inst, ...(t.state === 'enabled' ? en : []), ...miss].join('; ')})`;
    }
    out(line);
    if (t.name === 'superpowers' && t.state !== 'absent') out(`  ledger: ${ledgerLayoutOf(t.version).line}`);
    if (v) { for (const e of t.evidence) out(`  evidence: ${oneLine(e, 200)}`); for (const n of t.notes) out(`  note: ${oneLine(n, 200)}`); }
  }
  if (v) {
    out('connector hints (connectors cannot be detected from a shell; match these against your own tool list):');
    for (const h of r.connectorHints) out(`  ${oneLine(h.name, 40)}: ${oneLine(h.glob, 100)} (${oneLine(h.purpose, 100)})`);
    out(`always-on token budget, ${(r.budget.items[0] as BudgetItem).source}, not a live measurement:`); // detect always pushes the plangraph card item, so items is never empty
    for (const i of r.budget.items) out(`  ${i.name} ${i.tokens}`);
    out(`  total ${r.budget.total}`);
  }
  return 0;
}

// ---- superpowers ----
/** Any failure of these commands becomes one `error:` line (the first line of the message, plus `(+N more)` for aggregated errors),
 * exit 2, as before; a refused write target exits 4. A typed PlangraphError keeps its message and exit code. */
export function spErrors(e: unknown): never {
  if (e instanceof PlangraphError) throw e;
  // A refused write target (symlink, not a regular file, outside the repository) is REFUSED (exit 4) per docs/CONTRACT.md.
  if ((e as ThrownLike | null | undefined)?.code === 'SYMLINK' || (e as ThrownLike | null | undefined)?.code === 'OUTSIDE_REPO') refuseWrite(e); // whatever was thrown: read with ?.
  const first = String((e as ThrownLike | null | undefined)?.message ?? e).split('\n')[0] as string; // whatever was thrown: read with ?.; split always returns at least one item
  if (/^refusing to write\b/.test(first)) throw new PlangraphError('REFUSED', oneLine(first, 300), { cause: e });
  throw new PlangraphError('DATA', oneLine(first, 300) + ((e as ThrownLike | null | undefined)?.total as number > 1 ? ` (+${(e as ThrownLike).total as number - 1} more)` : ''), { cause: e }); // unchecked: total of whatever was thrown is compared and subtracted as is (undefined > 1 is false), as before
}
// A superpowers file to READ outside the repository is a data error (exit 2), not a refused write: it is typed here so spErrors can map
// every remaining OUTSIDE_REPO (a write target) to REFUSED.
function readInside(root: string, p: string): string {
  try { return assertInside(root, p); } catch (e) { if ((e as ThrownLike | null | undefined)?.code === 'OUTSIDE_REPO') throw new PlangraphError('DATA', oneLine((e as Error).message, 300), { cause: e }); throw e; } // lib/fsafe.ts throws coded Errors
}
function spFile(ctx: Ctx, arg: string | undefined, what: string): { real: string; rel: string } {
  if (!arg || arg.startsWith('--')) throw new Error(`${what} path missing`);
  const real = readInside(ctx.root, path.resolve(ctx.cwd ?? process.cwd(), arg));
  return { real, rel: checkRepoPath(path.relative(fs.realpathSync.native(ctx.root), real).split(path.sep).join('/')) };
}
const spRead = (ctx: Ctx, kind: Kind, validate?: (r: Rec) => string | null) => openStore(ctx).readValidated(kind, { validate });
// A file the command reads and may then rewrite: a symlinked target is REFUSED (exit 4, nothing written) before it is read, instead of the
// read's own symlink refusal (exit 2), so the contract for write targets holds.
const spReadTarget = (ctx: Ctx, kind: Kind, validate?: (r: Rec) => string | null) => { openStore(ctx).precheck([kind]); return spRead(ctx, kind, validate); };
// next: [[kind, records, old records]]; validate every kind, then write only the ones whose canonical rows changed (one precheck of every target first).
function spWrite(ctx: Ctx, next: Array<[Kind, Rec[], Rec[]]>): number {
  return openStore(ctx).writeChanged(next.map(([kind, rows, old]) => ({ kind, rows, old })), { validate: true });
}

async function spIngest(ctx: Ctx, args: Args<{ ledger?: string; owner?: string; sprint?: string }>): Promise<number> {
  const v = args.values, out = ctx.io.out, V = verbose(args);
  try {
    const SP = await import('../../lib/integrations/superpowers.ts');
    const [planArg] = args.positionals;
    if (!planArg) throw usage('usage: plangraph sp-ingest PLAN [--ledger FILE|none] [--owner NAME --sprint N]');
    if ((v.owner !== undefined) !== (v.sprint !== undefined)) throw usage('--owner and --sprint go together (seeding a schedule needs both)');
    needBrain(ctx);
    const plan = spFile(ctx, planArg, 'plan');
    const parsed = SP.parsePlan(SP.readSpFile(plan.real, { max: SP.LIMITS.planBytes }), plan.rel);
    const lo = v.ledger; if (lo !== undefined && (!lo || lo.startsWith('--'))) throw usage('--ledger needs a file path or none');
    let files = ([] as string[]); const discovery = ([] as string[]); // an empty list of this element type
    if (lo && lo !== 'none') files = [spFile(ctx, lo, 'ledger').real];
    else if (!lo) {
      let worktrees = ([] as string[]); try { worktrees = makeGit(ctx.root)('worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9)); } catch { /* not a git repo */ } // an empty list of this element type
      const found = SP.findLedgers(ctx.root, { planSlug: parsed.slug, planPath: plan.rel, worktrees, warnings: discovery });
      const perPlan = found.filter((f) => f.layout === 'per-plan');
      files = (perPlan.length ? perPlan : found).map((f) => readInside(f.root, f.path));
    }
    const ledger = SP.mergeLedgers(files.map((f) => SP.parseLedger(SP.readSpFile(f, { max: SP.LIMITS.ledgerBytes }), f)));
    const owner = v.owner, sprintArg = v.sprint;
    if (owner !== undefined && (!owner || owner.startsWith('--') || owner.length > 80 || oneLine(owner, 80) !== owner)) throw usage('--owner needs a plain name (at most 80 characters)');
    if (sprintArg !== undefined && !/^\d{1,4}$/.test(sprintArg)) throw usage('--sprint needs a whole number');
    const names: Record<'tickets' | 'edges' | 'findings' | 'refs' | 'schedule', Kind> = { tickets: 'ticket', edges: 'edge', findings: 'finding', refs: 'ref', schedule: 'schedule' };
    const existing = Object.fromEntries(Object.entries(names).map(([k, kind]) => [k, spReadTarget(ctx, kind)]));
    const r = SP.ingestPlan({ plan: parsed, ledger, existing, owner, sprint: sprintArg !== undefined ? +sprintArg : undefined } as IngestOpts); // ingestPlan destructures owner and sprint without defaults: undefined and absent read the same
    spWrite(ctx, Object.entries(names).map(([k, kind]) => [kind, r[k as keyof typeof names], existing[k]] as [Kind, Rec[], Rec[]])); // k is a key of names; ingestPlan returns one record list per name
    const p = r.report, n = (k: number, w: string) => `${k} ${w}${k === 1 ? '' : 's'}`, extra: string[] = [];
    if (p.unclassified) extra.push(`${n(p.unclassified, 'unclassified ledger line')} (first: line ${p.firstUnclassified})`);
    if (p.removed) extra.push(`removed ${n(p.removed, 'task')} no longer in the plan`);
    if (p.orphanSchedule) extra.push(`${n(p.orphanSchedule, 'schedule row')} for removed tasks left in place`);
    if (p.seeded) extra.push(`scheduled ${n(p.seeded, 'task')}`);
    if (p.warnings.length) extra.push(n(p.warnings.length, 'warning') + (V ? '' : ' (-v lists them)'));
    out(`ingested ${oneLine(p.key, 120)}: ${p.tasks} tasks, ${p.edges} edges, ${p.findings} findings, ${p.statuses} statuses from ledger${p.ledger ? '' : ` (${lo === 'none' ? '--ledger none' : 'no ledger found'}: ${p.kept ? `kept the previous impl_status of ${n(p.kept, 'task')}` : 'no impl_status set'}; plan checkboxes are never read as progress)`}${extra.length ? `; ${extra.join('; ')}` : ''}`);
    for (const w of discovery) out(`warning: ${oneLine(w, 300)}`);
    if (p.seededWithPoints) out(`warning: seeded ${n(p.seeded, 'task')} for ${oneLine(owner, 80)} in sprint ${+(sprintArg as string)}: ${n(p.seededPoints, 'story point')} (capacity is not checked here)`); // seeded only when --sprint was given
    // Parser warnings quote plan and ledger text: untrusted, so printed only inside a fence (research section 6.3).
    // A task hidden inside an HTML comment is silent data loss: that warning is always shown; the rest only with -v.
    const shownPlan = V ? p.planWarnings : p.planWarnings.filter((w) => /swallows a task heading/.test(w));
    if (shownPlan.length) ctx.io.outBlock(fence('sp-plan', shownPlan.join('\n'), { max: 20000 }).split('\n'));
    if (V && p.ledgerWarnings.length) ctx.io.outBlock(fence('sp-ledger', p.ledgerWarnings.join('\n'), { max: 20000 }).split('\n'));
  } catch (e) { spErrors(e); }
  return 0;
}

// `sp-link SP_TICKET --track JIRA_KEY`: one tracked_by xref (xrefs.jsonl row, sys jira) from an sp: ticket to the Jira ticket it tracks, so the two
// are one work item and DOUBLE_PLACED_WORK can tell when both are scheduled. It reads and writes xrefs.jsonl only.
async function spTrack(ctx: Ctx, key: string, jira: string, tasks: string | undefined, planArg: string | undefined): Promise<void> {
  if (planArg !== undefined || tasks !== undefined) throw usage('--track takes the sp: ticket and the Jira key only (no PLAN, no --tasks): plangraph sp-link sp:SLUG/N --track ABC-123');
  needBrain(ctx);
  if (!/^sp:[A-Za-z0-9][A-Za-z0-9._:/-]{0,115}$/.test(key) || key.includes('..')) throw usage('--track needs an sp: ticket (sp:SLUG/N) as the first argument');
  if (!/^[A-Z][A-Z0-9_]{0,23}-\d{1,9}$/.test(jira)) throw usage('--track needs a Jira key such as ABC-123');
  if (!spRead(ctx, 'ticket').some((t) => t.key === key)) throw usage(`unknown ticket ${oneLine(key, 120)}: not in tickets.jsonl`);
  const xrefs = spReadTarget(ctx, 'xref'), jiraSys = (r: Rec) => String(r.sys).split(':')[0] === 'jira';
  if (xrefs.some((r) => r.type === 'ticket' && r.id === key && r.sys === 'jira' && r.xid === jira)) { ctx.io.out(`${oneLine(key, 120)} already tracks ${jira}, nothing written`); return; }
  const mine = xrefs.find((r) => r.type === 'ticket' && r.id === key && jiraSys(r));
  if (mine) throw usage(`${oneLine(key, 120)} already tracks ${oneLine(String(mine.xid), 60)}: one work item is one Jira ticket (edit xrefs.jsonl to change it)`);
  const other = xrefs.find((r) => r.type === 'ticket' && r.sys === 'jira' && r.xid === jira);
  if (other) throw usage(`${jira} is already tracked by ${oneLine(String(other.id), 120)}: one Jira ticket is one work item (edit xrefs.jsonl to change it)`);
  spWrite(ctx, [['xref', [...xrefs, { type: 'ticket', id: key, sys: 'jira', xid: jira }], xrefs]]);
  ctx.io.out(`linked ${oneLine(key, 120)} to ${jira} (tracked_by): keep only one of the two placed in the schedule`);
}

async function spLink(ctx: Ctx, args: Args<{ tasks?: string; track?: string }>): Promise<number> {
  const v = args.values;
  try {
    if (v.track !== undefined) {
      if (!args.positionals[0] || !v.track || v.track.startsWith('--')) throw usage('usage: plangraph sp-link sp:SLUG/N --track ABC-123');
      await spTrack(ctx, args.positionals[0], v.track, v.tasks, args.positionals[1]);
      return 0;
    }
    const SP = await import('../../lib/integrations/superpowers.ts'), { planSection, DEFAULT_HEADING } = await import('../../lib/stale.ts');
    const [key, planArg] = args.positionals;
    if (!key || !planArg) throw usage('usage: plangraph sp-link TICKET PLAN [--tasks 1,3] | sp-link sp:SLUG/N --track ABC-123');
    needBrain(ctx);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(key) || key.includes('..')) throw usage('invalid ticket key');
    if (!spRead(ctx, 'ticket').some((t) => t.key === key)) throw usage(`unknown ticket ${key}: not in tickets.jsonl`);
    const plan = spFile(ctx, planArg, 'plan'), text = SP.readSpFile(plan.real, { max: SP.LIMITS.planBytes });
    const parsed = SP.parsePlan(text, plan.rel), ids = parsed.tasks.map((t) => t.id);
    const want = v.tasks !== undefined ? [...new Set(String(v.tasks || '').split(',').map((x) => x.trim()).filter(Boolean))] : ids;
    if (!want.length) throw usage('--tasks needs a comma-separated list of task ids');
    for (const id of want) if (!ids.includes(id)) throw usage(`task ${oneLine(id, 20)} is not in the plan`);
    const heading = (ctx.config().ref_heading || DEFAULT_HEADING) as string, unmatched = want.filter((id) => !planSection(text, id, heading)).length; // config text: planSection refuses a non-string (compileHeading)
    // refs.jsonl is read with its validator plus one rule of sp-link's own: every entry of "plans" is an object (a data error names the line)
    const { validators } = await import('../../lib/schema.ts'), refsRule = validators['refs.jsonl'] as (r: Rec) => string | null;
    const plansRule = (r: Rec) => refsRule(r) ?? (Array.isArray(r.plans) && r.plans.some((x) => x === null || typeof x !== 'object' || Array.isArray(x)) ? '"plans" must be a list of objects' : null);
    const refs = spReadTarget(ctx, 'ref', plansRule), prev = refs.find((r) => r.key === key) || { key, plans: [], files: {} };
    const have = (id: string) => ((prev.plans || []) as Array<{ plan?: unknown; task?: unknown }>).some((x) => x.plan === plan.rel && String(x.task) === id); // plansRule: plans is absent, null or a list of objects
    const rec = { ...prev, plans: [...((prev.plans || []) as unknown[]), ...want.filter((id) => !have(id)).map((id) => ({ plan: plan.rel, task: id }))] };
    spWrite(ctx, [['ref', [...refs.filter((r) => r.key !== key), rec], refs]]);
    ctx.io.out(`linked ${oneLine(key, 120)} to ${oneLine(plan.rel, 200)}: ${want.length} task${want.length === 1 ? '' : 's'}${unmatched ? `; ${unmatched} not matched by ref_heading (plangraph stale cannot fingerprint them)` : ''}`);
  } catch (e) { spErrors(e); }
  return 0;
}

// ---- OpenWolf: read-through only; the only write is one record into plangraph's own learnings.jsonl, printed fenced ----
const LEARN_USAGE = 'usage: plangraph learn --from-wolf <handle|"text">';
async function learn(ctx: Ctx, args: Args<{ 'from-wolf'?: string }>): Promise<number> {
  const arg = args.values['from-wolf'];
  if (arg === undefined || !arg || arg.startsWith('--')) throw usage(LEARN_USAGE);
  needBrain(ctx);
  try {
    const W = await import('../../lib/integrations/openwolf.ts'), r = W.readWolfFile(ctx.root, 'cerebrum.md'); if (!r.ok) throw usage((r.warning as string)); // a failed read carries its warning
    const list = W.repoRuleList(W.parseCerebrum(r.text), { all: true }); let entry: (typeof list)[number]; // every handle `rules --repo [--all]` can show
    if (/^\d+$/.test(arg.trim())) throw usage('a position number is not accepted (positions shift): use the handle from `plangraph rules --repo` or the exact text');
    if (/^w[0-9a-f]{6}$/.test(arg)) {
      const hits = list.filter((e) => e.handle === arg);
      if (!hits.length) throw usage('no repo rule has that handle (run `plangraph rules --repo`)');
      if (hits.length > 1) throw usage('that handle matches more than one repo rule: promote by its exact text');
      entry = hits[0] as RepoRule; // hits.length is 1: both other cases threw above
    } else {
      const want = oneLine(arg, 2000), hits = list.filter((e) => oneLine(e.text, 2000) === want || (e.date && oneLine(`${e.date} ${e.text}`, 2000) === want));
      if (!hits.length) throw usage('no repo rule has exactly that text (run `plangraph rules --repo`)');
      if (hits.length > 1) throw usage('that text matches more than one repo rule (nothing written)');
      entry = hits[0] as RepoRule; // hits.length is 1: both other cases threw above
    }
    const text = oneLine(entry.text, 500), old = spReadTarget(ctx, 'learning');
    if (old.some((x) => typeof x.text === 'string' && oneLine(x.text, 500) === text)) { ctx.io.out('already present, nothing written'); return 0; }
    let n = 0; for (const x of old) { const m = /^W-(\d{1,9})$/.exec(String(x.id)); if (m) n = Math.max(n, +(m[1] as string)); } // group 1 is not optional: it is set in every match
    const rec = { id: `W-${n + 1}`, kind: 'rule', topic: 'repo', text, why: '', source: 'openwolf:cerebrum' };
    spWrite(ctx, [['learning', [...old, rec], old]]);
    ctx.io.out(`copied repo rule ${oneLine(entry.handle, 20)} to learnings.jsonl as ${oneLine(rec.id, 20)} (kind rule, topic repo, source openwolf:cerebrum); run \`plangraph build\``);
    ctx.io.outBlock(W.fenceWolf('wolf-cerebrum', text).split('\n'));
  } catch (e) { spErrors(e); }
  return 0;
}


export const commands: CommandMap = {
  integrations: { run: integrations, positionals: [0, 0], guard: 'none', summary: 'which companion tools are installed or active (files only)' },
  'sp-ingest': {
    run: spIngest, positionals: [0, 1], writes: 'text', summary: 'superpowers plan + ledger -> tickets, edges, findings, refs (read-only on superpowers files)',
    options: { ledger: { type: 'string', missing: '--ledger needs a file path or none' }, owner: { type: 'string', missing: '--owner needs a plain name (at most 80 characters)' }, sprint: { type: 'string', missing: '--sprint needs a whole number' } },
  },
  'sp-link': { run: spLink, positionals: [0, 2], writes: 'text', options: { tasks: { type: 'string', missing: '--tasks needs a comma-separated list of task ids' }, track: { type: 'string', missing: '--track needs a Jira key such as ABC-123' } }, summary: 'point a ticket at superpowers plan tasks (refs.plans, fingerprinted by `plangraph stale`); --track JIRA_KEY records the Jira ticket an sp: ticket tracks (an xref)' },
  learn: { run: learn, positionals: [0, 0], writes: 'text', guard: 'strict', options: { 'from-wolf': { type: 'string', missing: LEARN_USAGE } }, summary: 'copy ONE repo rule from .wolf/cerebrum.md into learnings.jsonl' },
};

