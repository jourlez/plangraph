// Companion tools: integrations (detection, files only), sp-ingest and sp-link (superpowers plans and ledgers: read-only on superpowers
// files; writes only brain JSONL, canonical, atomic, confined to the repo), learn --from-wolf (one OpenWolf rule into learnings.jsonl).
// Errors of sp-ingest, sp-link and learn print one `error: ...` line and exit 2 (a refused write target: symlink, not a regular file or
// outside the repository, exits 4); nothing is written unless every file was computed, validated and pre-checked first.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJsonl, parseJsonl } from '../../lib/jsonl.mjs';
import { oneLine, fence } from '../../lib/sanitize.mjs';
import { assertInside } from '../../lib/fsafe.mjs';
import { checkRepoPath, makeGit } from '../../lib/gitsafe.mjs';
import { BrainError } from '../errors.mjs';
import { verbose, usage, needBrain, precheckTargets, writeState, refuseWrite } from './shared.mjs';
/** @typedef {import('../context.mjs').Context} Ctx @typedef {import('../context.mjs').Args} Args */

// ---- companion tools ----
/** @param {Ctx} ctx @param {Args} args */
async function integrations(ctx, args) {
  const { detectTools } = await import('../../lib/integrations/detect.mjs'), out = ctx.io.out, v = verbose(args);
  const r = detectTools({ root: ctx.root, home: ctx.env.HOME || os.homedir(), env: ctx.env });
  const { ledgerLayoutOf } = await import('../../lib/integrations/superpowers.mjs');
  // Evidence strings are `installed: KEY`, `enabled: KEY in LABEL`, `enabled, not installed: KEY in LABEL` (lib/integrations/detect.mjs).
  const scope = (/** @type {string} */ label) => (label.startsWith('project settings.local') ? 'local' : label.split(' ')[0]);
  const keysOf = (/** @type {any} */ t, /** @type {RegExp} */ re) => t.evidence.map((/** @type {string} */ e) => re.exec(e)).filter(Boolean);
  for (const t of r.tools) {
    let line = `${oneLine(t.name, 40)}: `;
    const inst = keysOf(t, /^installed: (\S+)$/).map((/** @type {any} */ m) => `installed ${oneLine(m[1])}`);
    const en = keysOf(t, /^enabled: (\S+) in (.+)$/).map((/** @type {any} */ m) => `${oneLine(scope(m[2]), 20)} enables ${oneLine(m[1])}`);
    const notInst = keysOf(t, /^enabled, not installed: (\S+) in (.+)$/).map((/** @type {any} */ m) => `${oneLine(m[1])} (${oneLine(scope(m[2]), 20)})`);
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
    out(`always-on token budget, ${r.budget.items[0].source}, not a live measurement:`);
    for (const i of r.budget.items) out(`  ${i.name} ${i.tokens}`);
    out(`  total ${r.budget.total}`);
  }
  return 0;
}

// ---- superpowers ----
/** Any failure of these commands becomes one `error:` line (the first line of the message, plus `(+N more)` for aggregated errors),
 * exit 2, as before; a refused write target exits 4. A typed BrainError keeps its message and exit code. */
/** @param {any} e @returns {never} */
export function spErrors(e) {
  if (e instanceof BrainError) throw e;
  // A refused write target (symlink, not a regular file, outside the repository) is REFUSED (exit 4) per docs/CONTRACT.md.
  if (e?.code === 'SYMLINK' || e?.code === 'OUTSIDE_REPO') refuseWrite(e);
  const first = String(e?.message ?? e).split('\n')[0];
  if (/^refusing to write\b/.test(first)) throw new BrainError('REFUSED', oneLine(first, 300), { cause: e });
  throw new BrainError('DATA', oneLine(first, 300) + (e?.total > 1 ? ` (+${e.total - 1} more)` : ''), { cause: e });
}
// A superpowers file to READ outside the repository is a data error (exit 2), not a refused write: it is typed here so spErrors can map
// every remaining OUTSIDE_REPO (a write target) to REFUSED.
/** @param {string} root @param {string} p */
function readInside(root, p) {
  try { return assertInside(root, p); } catch (/** @type {any} */ e) { if (e?.code === 'OUTSIDE_REPO') throw new BrainError('DATA', oneLine(e.message, 300), { cause: e }); throw e; }
}
/** @param {Ctx} ctx @param {string | undefined} arg @param {string} what */
function spFile(ctx, arg, what) {
  if (!arg || arg.startsWith('--')) throw new Error(`${what} path missing`);
  const real = readInside(ctx.root, path.resolve(ctx.cwd ?? process.cwd(), arg));
  return { real, rel: checkRepoPath(path.relative(fs.realpathSync.native(ctx.root), real).split(path.sep).join('/')) };
}
const spRead = (/** @type {Ctx} */ ctx, /** @type {string} */ f) => readJsonl(path.join(ctx.dir, f));
// A file the command reads and may then rewrite: a symlinked target is REFUSED (exit 4, nothing written) before it is read, instead of the
// read's own symlink refusal (exit 2), so the contract for write targets holds.
const spReadTarget = (/** @type {Ctx} */ ctx, /** @type {string} */ f) => { precheckTargets(ctx, [path.join(ctx.dir, f)]); return spRead(ctx, f); };
// next: [[file, records, old records]]; validate every file, then write only the ones whose canonical text changed.
/** @param {Ctx} ctx @param {Array<[string, any[], any[]]>} next */
async function spWrite(ctx, next) {
  const S = await import('../../lib/store.mjs'), { validators } = await import('../../lib/schema.mjs');
  const out = [];
  for (const [f, recs, old] of next) {
    const text = S.canonFile(recs, S.SCHEMAS[f]); parseJsonl(text, f, { validate: validators[f] });
    if (text !== S.canonFile(old, S.SCHEMAS[f])) out.push([f, text]);
  }
  // Pre-check every target before the first write, so a refusable target (symlink, directory, outside the repo) fails with nothing written.
  // Refusals are REFUSED errors (exit 4); spErrors passes a BrainError through unchanged.
  precheckTargets(ctx, out.map(([f]) => path.join(ctx.dir, f)));
  for (const [f, text] of out) writeState(ctx, path.join(ctx.dir, f), text);
  return out.length;
}

/** @param {Ctx} ctx @param {Args} args */
async function spIngest(ctx, args) {
  const v = args.values, out = ctx.io.out, V = verbose(args);
  try {
    const SP = await import('../../lib/integrations/superpowers.mjs');
    const [planArg] = args.positionals;
    if (!planArg) throw usage('usage: brain sp-ingest PLAN [--ledger FILE|none] [--owner NAME --sprint N]');
    if ((v.owner !== undefined) !== (v.sprint !== undefined)) throw usage('--owner and --sprint go together (seeding a schedule needs both)');
    needBrain(ctx);
    const plan = spFile(ctx, planArg, 'plan');
    const parsed = SP.parsePlan(SP.readSpFile(plan.real, { max: SP.LIMITS.planBytes }), plan.rel);
    const lo = v.ledger; if (lo !== undefined && (!lo || lo.startsWith('--'))) throw usage('--ledger needs a file path or none');
    let files = /** @type {string[]} */ ([]); const discovery = /** @type {string[]} */ ([]);
    if (lo && lo !== 'none') files = [spFile(ctx, lo, 'ledger').real];
    else if (!lo) {
      let worktrees = /** @type {string[]} */ ([]); try { worktrees = makeGit(ctx.root)('worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9)); } catch { /* not a git repo */ }
      const found = SP.findLedgers(ctx.root, { planSlug: parsed.slug, planPath: plan.rel, worktrees, warnings: discovery });
      const perPlan = found.filter((f) => f.layout === 'per-plan');
      files = (perPlan.length ? perPlan : found).map((f) => readInside(f.root, f.path));
    }
    const ledger = SP.mergeLedgers(files.map((f) => SP.parseLedger(SP.readSpFile(f, { max: SP.LIMITS.ledgerBytes }), f)));
    const owner = v.owner, sprintArg = v.sprint;
    if (owner !== undefined && (!owner || owner.startsWith('--') || owner.length > 80 || oneLine(owner, 80) !== owner)) throw usage('--owner needs a plain name (at most 80 characters)');
    if (sprintArg !== undefined && !/^\d{1,4}$/.test(sprintArg)) throw usage('--sprint needs a whole number');
    const names = { tickets: 'tickets.jsonl', edges: 'edges.jsonl', findings: 'findings.jsonl', refs: 'refs.jsonl', schedule: 'schedule.jsonl' };
    const existing = Object.fromEntries(Object.entries(names).map(([k, f]) => [k, spReadTarget(ctx, f)]));
    const r = SP.ingestPlan({ plan: parsed, ledger, existing, owner, sprint: sprintArg !== undefined ? +sprintArg : undefined });
    await spWrite(ctx, Object.entries(names).map(([k, f]) => [f, /** @type {any} */ (r)[k], existing[k]]));
    const p = r.report, n = (/** @type {number} */ k, /** @type {string} */ w) => `${k} ${w}${k === 1 ? '' : 's'}`, extra = [];
    if (p.unclassified) extra.push(`${n(p.unclassified, 'unclassified ledger line')} (first: line ${p.firstUnclassified})`);
    if (p.removed) extra.push(`removed ${n(p.removed, 'task')} no longer in the plan`);
    if (p.orphanSchedule) extra.push(`${n(p.orphanSchedule, 'schedule row')} for removed tasks left in place`);
    if (p.seeded) extra.push(`scheduled ${n(p.seeded, 'task')}`);
    if (p.warnings.length) extra.push(n(p.warnings.length, 'warning') + (V ? '' : ' (-v lists them)'));
    out(`ingested ${oneLine(p.key, 120)}: ${p.tasks} tasks, ${p.edges} edges, ${p.findings} findings, ${p.statuses} statuses from ledger${p.ledger ? '' : ` (${lo === 'none' ? '--ledger none' : 'no ledger found'}: ${p.kept ? `kept the previous impl_status of ${n(p.kept, 'task')}` : 'no impl_status set'}; plan checkboxes are never read as progress)`}${extra.length ? `; ${extra.join('; ')}` : ''}`);
    for (const w of discovery) out(`warning: ${oneLine(w, 300)}`);
    if (p.seededWithPoints) out(`warning: seeded ${n(p.seeded, 'task')} for ${oneLine(owner, 80)} in sprint ${+sprintArg}: ${n(p.seededPoints, 'story point')} (capacity is not checked here)`);
    // Parser warnings quote plan and ledger text: untrusted, so printed only inside a fence (research section 6.3).
    // A task hidden inside an HTML comment is silent data loss: that warning is always shown; the rest only with -v.
    const shownPlan = V ? p.planWarnings : p.planWarnings.filter((w) => /swallows a task heading/.test(w));
    if (shownPlan.length) ctx.io.outBlock(fence('sp-plan', shownPlan.join('\n'), { max: 20000 }).split('\n'));
    if (V && p.ledgerWarnings.length) ctx.io.outBlock(fence('sp-ledger', p.ledgerWarnings.join('\n'), { max: 20000 }).split('\n'));
  } catch (e) { spErrors(e); }
  return 0;
}

/** @param {Ctx} ctx @param {Args} args */
async function spLink(ctx, args) {
  const v = args.values;
  try {
    const SP = await import('../../lib/integrations/superpowers.mjs'), { planSection, DEFAULT_HEADING } = await import('../../lib/stale.mjs');
    const [key, planArg] = args.positionals;
    if (!key || !planArg) throw usage('usage: brain sp-link TICKET PLAN [--tasks 1,3]');
    needBrain(ctx);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(key) || key.includes('..')) throw usage('invalid ticket key');
    if (!spRead(ctx, 'tickets.jsonl').some((t) => t.key === key)) throw usage(`unknown ticket ${key}: not in tickets.jsonl`);
    const plan = spFile(ctx, planArg, 'plan'), text = SP.readSpFile(plan.real, { max: SP.LIMITS.planBytes });
    const parsed = SP.parsePlan(text, plan.rel), ids = parsed.tasks.map((t) => t.id);
    const want = v.tasks !== undefined ? [...new Set(String(v.tasks || '').split(',').map((x) => x.trim()).filter(Boolean))] : ids;
    if (!want.length) throw usage('--tasks needs a comma-separated list of task ids');
    for (const id of want) if (!ids.includes(id)) throw usage(`task ${oneLine(id, 20)} is not in the plan`);
    const heading = ctx.config().ref_heading || DEFAULT_HEADING, unmatched = want.filter((id) => !planSection(text, id, heading)).length;
    const refs = spReadTarget(ctx, 'refs.jsonl'), prev = refs.find((r) => r.key === key) || { key, plans: [], files: {} };
    const have = (/** @type {string} */ id) => (prev.plans || []).some((/** @type {any} */ x) => x && x.plan === plan.rel && String(x.task) === id);
    const rec = { ...prev, plans: [...(prev.plans || []), ...want.filter((id) => !have(id)).map((id) => ({ plan: plan.rel, task: id }))] };
    await spWrite(ctx, [['refs.jsonl', [...refs.filter((r) => r.key !== key), rec], refs]]);
    ctx.io.out(`linked ${oneLine(key, 120)} to ${oneLine(plan.rel, 200)}: ${want.length} task${want.length === 1 ? '' : 's'}${unmatched ? `; ${unmatched} not matched by ref_heading (brain stale cannot fingerprint them)` : ''}`);
  } catch (e) { spErrors(e); }
  return 0;
}

// ---- OpenWolf: read-through only; the only write is one record into brain's own learnings.jsonl, printed fenced ----
const LEARN_USAGE = 'usage: brain learn --from-wolf <handle|"text">';
/** @param {Ctx} ctx @param {Args} args */
async function learn(ctx, args) {
  const arg = args.values['from-wolf'];
  if (arg === undefined || !arg || arg.startsWith('--')) throw usage(LEARN_USAGE);
  needBrain(ctx);
  try {
    const W = await import('../../lib/integrations/openwolf.mjs'), r = W.readWolfFile(ctx.root, 'cerebrum.md'); if (!r.ok) throw usage(/** @type {string} */ (r.warning));
    const list = W.repoRuleList(W.parseCerebrum(r.text), { all: true }); let entry; // every handle `rules --repo [--all]` can show
    if (/^\d+$/.test(arg.trim())) throw usage('a position number is not accepted (positions shift): use the handle from `brain rules --repo` or the exact text');
    if (/^w[0-9a-f]{6}$/.test(arg)) {
      const hits = list.filter((e) => e.handle === arg);
      if (!hits.length) throw usage('no repo rule has that handle (run `brain rules --repo`)');
      if (hits.length > 1) throw usage('that handle matches more than one repo rule: promote by its exact text');
      entry = hits[0];
    } else {
      const want = oneLine(arg, 2000), hits = list.filter((e) => oneLine(e.text, 2000) === want || (e.date && oneLine(`${e.date} ${e.text}`, 2000) === want));
      if (!hits.length) throw usage('no repo rule has exactly that text (run `brain rules --repo`)');
      if (hits.length > 1) throw usage('that text matches more than one repo rule (nothing written)');
      entry = hits[0];
    }
    const text = oneLine(entry.text, 500), old = spReadTarget(ctx, 'learnings.jsonl');
    if (old.some((x) => typeof x.text === 'string' && oneLine(x.text, 500) === text)) { ctx.io.out('already present, nothing written'); return 0; }
    let n = 0; for (const x of old) { const m = /^W-(\d{1,9})$/.exec(String(x.id)); if (m) n = Math.max(n, +m[1]); }
    const rec = { id: `W-${n + 1}`, kind: 'rule', topic: 'repo', text, why: '', source: 'openwolf:cerebrum' };
    await spWrite(ctx, [['learnings.jsonl', [...old, rec], old]]);
    ctx.io.out(`copied repo rule ${oneLine(entry.handle, 20)} to learnings.jsonl as ${oneLine(rec.id, 20)} (kind rule, topic repo, source openwolf:cerebrum); run \`brain build\``);
    ctx.io.outBlock(W.fenceWolf('wolf-cerebrum', text).split('\n'));
  } catch (e) { spErrors(e); }
  return 0;
}


export const commands = {
  integrations: { run: integrations, positionals: [0, 0], guard: 'none', summary: 'which companion tools are installed or active (files only)' },
  'sp-ingest': {
    run: spIngest, positionals: [0, 1], writes: 'text', summary: 'superpowers plan + ledger -> tickets, edges, findings, refs (read-only on superpowers files)',
    options: { ledger: { type: 'string', missing: '--ledger needs a file path or none' }, owner: { type: 'string', missing: '--owner needs a plain name (at most 80 characters)' }, sprint: { type: 'string', missing: '--sprint needs a whole number' } },
  },
  'sp-link': { run: spLink, positionals: [0, 2], writes: 'text', options: { tasks: { type: 'string', missing: '--tasks needs a comma-separated list of task ids' } }, summary: 'point a ticket at superpowers plan tasks (refs.plans, fingerprinted by `brain stale`)' },
  learn: { run: learn, positionals: [0, 0], writes: 'text', guard: 'strict', options: { 'from-wolf': { type: 'string', missing: LEARN_USAGE } }, summary: 'copy ONE repo rule from .wolf/cerebrum.md into learnings.jsonl' },
};

