// Audit preparation and Jira: stale refs-update units bundle jira-pull jira-text jira-import.
// Git runs through execFile argv (no shell) with checked refs and repo paths. Untrusted text (summaries, findings, plan sections, Jira
// text) reaches a bundle only inside <untrusted> fences, with every piece bounded. Only jira-pull and jira-text (without --from-json)
// reach the network, through ctx.tracker() (lib/tracker.ts).
import fs from 'node:fs';
import path from 'node:path';
import { readCapped } from '../../lib/jsonl.ts';
import { openStore } from '../../lib/planstore.ts';
import { oneLine, sanitizeText, fence, guardOutput } from '../../lib/sanitize.ts';
import { writeAtomicSafe, assertInside } from '../../lib/fsafe.ts';
import { checkRef, checkRepoPath } from '../../lib/gitsafe.ts';
import { CUR, KEY_RE, MAX_DATA, needBrain, usage, dataError, readJsonInput, loadJiraSnap, jiraErrors, refuseWrite, fenceLines } from './shared.ts';
import type { Ctx, Args } from '../context.ts';
import type { CommandMap } from '../registry.ts';
import { parseSnapshotJsonl, snapshotToJsonl } from '../../lib/tracker.ts';
import type { Snapshot, RawIssue, RawImport, PullOptions } from '../../lib/tracker.ts';
import type { Trust } from '../jira-tenant.ts';
import type { JiraSettings } from '../jira-tenant.ts';
import type { GitDepsExtra, JiraSnapEntry, StaleOpts } from '../../lib/stale.ts';
/** The options that select the stale inputs (stale, refs-update, units). */
type StaleValues = { ref?: string; jira?: string; full?: boolean };

/** A git failure (bad or unknown ref, not a repository) is a DATA error with the first line of git's message, sanitized. */
function gitErrors(e: unknown): never {
  if (e instanceof TypeError && /^invalid git ref|^invalid repo path|^ref_heading/.test(e.message)) throw usage(oneLine(e.message, 200));
  if (e && typeof e === 'object' && 'status' in e && 'stderr' in e) {
    const first = String(e.stderr || '').split('\n').find((l) => l.trim()) || 'git failed';
    throw dataError(`git: ${oneLine(first, 200)}`, 'check --ref and that this is a git repository');
  }
  throw e;
}

// ---- fingerprints: what each verdict was based on, and what changed since ----
async function staleSetup(ctx: Ctx, args: Args<StaleValues>) {
  needBrain(ctx);
  const S = await import('../../lib/stale.ts'), { loadModel } = await import('../../lib/model.ts');
  const cfg = ctx.config(), model = loadModel(ctx.dir, { config: cfg }), v = args.values;
  let ref: string; try { ref = S.resolveRef(cfg as { default_ref?: unknown }, v.ref); } catch (e) { gitErrors(e); } // config.json's default_ref sits in PlanConfig's index signature: lib/model.ts does not name it (concern)
  const jira = (v.jira !== undefined ? await loadJiraSnap(v.jira) : undefined) as Record<string, JiraSnapEntry> | undefined; // every LegacyIssue field fits the looser JiraSnapEntry (the interface only lacks an implicit index signature)
  const deps = S.gitDeps(ctx.root, ref, { jira } as GitDepsExtra); // a fresh instance per command: it caches git reads; gitDeps reads `extra.jira || null`, so an undefined jira acts as an absent one
  const sopts = { ref, heading: cfg.ref_heading, rulesVersion: cfg.brain_rules_version, full: Boolean(v.full) } as StaleOpts; // ref_heading is config text: computeStale uses `heading || DEFAULT_HEADING` and compileHeading refuses a non-string (StaleOpts.heading should be unknown, concern)
  return { S, model, cfg, ref, jira, deps, sopts };
}
async function stale(ctx: Ctx, args: Args<StaleValues & { list?: boolean }>): Promise<number> {
  const { S, model, ref, jira, deps, sopts } = await staleSetup(ctx, args);
  try {
    const res = S.computeStale(model, model.refs, deps, sopts);
    const txt = S.formatStale(res, { list: Boolean(args.values.list), json: false, commit: deps.commit(ref), jiraChecked: !!jira });
    ctx.io.outBlock(String(txt).replace(/\n+$/, '').split('\n'));
  } catch (e) { gitErrors(e); }
  return 0;
}
async function refsUpdate(ctx: Ctx, args: Args<StaleValues>): Promise<number> {
  const { S, model, ref, deps, sopts } = await staleSetup(ctx, args);
  const keys = args.positionals.filter((a) => KEY_RE.test(a));
  let r: ReturnType<typeof S.refsUpdate>, commit: string;
  try { commit = deps.commit(ref); r = S.refsUpdate(model, model.refs, deps, { ...sopts, commit }, keys.length ? keys : null); } catch (e) { gitErrors(e); }
  openStore(ctx).writeKind('ref', r.rows, { precheck: true });
  ctx.io.out(`refs.jsonl updated for ${r.updated?.length ?? keys.length ?? '?'} tickets at ${oneLine(commit, 64)} (ref ${oneLine(ref, 200)}); run \`plangraph build\``);
  return 0;
}

// ---- Jira (read-only) ----
/** The tenant decision of this project: throws bad_config for an unknown auth.mode before any credential helper runs. The Trust it mints is
 * what every networked tracker member requires. */
async function jiraTrust(ctx: Ctx): Promise<{ cfg: JiraSettings; trust: Trust }> {
  const T = await import('../jira-tenant.ts');
  const committed = ctx.config().jira as JiraSettings | undefined; // config.json's jira block: PlanConfig does not type it (concern)
  try { const t = T.resolveTenant(committed, ctx.root, ctx.env); return { cfg: t.jira, trust: t.trust }; } catch (e) { return jiraErrors(e); }
}
/** A file the user named as output (snapshot, text dir): written atomically, a symlink refused; not confined to the repository. Mode 0600:
 * Jira data stays private to the user on a shared host. */
function writeOutput(file: string, text: string): void {
  try { writeAtomicSafe(file, text, { mode: 0o600 }); } catch (e) { refuseWrite(e); }
}
function readSnapshotText(file: string): string {
  try { return readCapped(file, MAX_DATA); } catch { throw dataError(`cannot read the snapshot ${oneLine(path.basename(file), 80)}`, 'check the --out path'); }
}
async function jiraPull(ctx: Ctx, args: Args<{ out?: string; full?: boolean }>): Promise<number> {
  const out = args.values.out, full = Boolean(args.values.full);
  if (!out) throw usage('needs --out <file.jsonl>');
  const { cfg, trust } = await jiraTrust(ctx), tracker = ctx.tracker();
  let previous = null;
  if (!full && fs.existsSync(out)) { try { previous = parseSnapshotJsonl(readSnapshotText(out)); } catch { previous = null; } }
  let r: Awaited<ReturnType<typeof tracker.pull>>;
  try { r = await tracker.pull(trust, { jql: cfg.jql, previous, full, sprintField: cfg.sprint_field, fullReconcileEvery: cfg.full_reconcile_every } as PullOptions); } catch (e) { jiraErrors(e); } // pull destructures with defaults, so an undefined sprintField or fullReconcileEvery acts as an absent one
  ctx.io.out(r.summary);
  if (!r.ok) return 2; // never write a partial snapshot
  writeOutput(out, snapshotToJsonl(r.snapshot));
  return 0;
}
async function jiraImport(ctx: Ctx, args: Args<{ out?: string }>): Promise<number> {
  const out = args.values.out, files = args.positionals;
  if (!files.length || !out) throw usage('usage: plangraph jira-import FILE... --out snapshot.jsonl');
  try {
    let snap = fs.existsSync(out) ? parseSnapshotJsonl(readSnapshotText(out)) : null, imported = 0, dropped = 0; const changed = new Set<string>();
    for (const f of files) {
      const r = ctx.tracker().importIssues(snap, readJsonInput(f, 'issue file') as RawImport, { sprintField: (await import('../jira-tenant.ts')).effectiveJira(ctx.config().jira as JiraSettings | undefined, ctx.root, ctx.env).sprint_field, now: ctx.now }); // the importer tests every field; jira block as above; no tenant (and no auth.mode check) is needed offline
      snap = r.snapshot; imported += r.imported; dropped += r.dropped; for (const k of r.changedKeys) changed.add(k);
    }
    writeOutput(out, snapshotToJsonl((snap as Snapshot))); // files is not empty (checked above), so the loop set snap
    ctx.io.out(`imported ${imported} issue(s) from ${files.length} file(s) (changed ${changed.size}, dropped ${dropped}); snapshot now ${(snap as Snapshot).issues.length} issues, partial`); // set by the loop, as above
  } catch (e) { jiraErrors(e); }
  return 0;
}
async function jiraText(ctx: Ctx, args: Args<{ out?: string; 'from-json'?: string }>): Promise<number> {
  const out = args.values.out, from = args.values['from-json'];
  const keys = args.positionals.filter((a) => KEY_RE.test(a));
  if (!keys.length || !out) throw usage('usage: plangraph jira-text KEY... --out DIR [--from-json FILE]');
  fs.mkdirSync(out, { recursive: true });
  try {
    if (from !== undefined) {
      const j = readJsonInput(from, 'issue file');
      for (const k of keys) writeOutput(path.join(out, `${k}.txt`), ctx.tracker().renderIssue(k, (j && typeof j === 'object' && Object.hasOwn(j, k) ? (j as Record<string, unknown>)[k] : j) as RawIssue)); // an object: checked on this line; renderIssue tests every field
      ctx.io.out(`wrote ${keys.length} files`);
      return 0;
    }
    const { trust } = await jiraTrust(ctx);
    for (const k of keys) writeOutput(path.join(out, `${k}.txt`), await ctx.tracker().fetchIssueText(trust, k));
  } catch (e) { jiraErrors(e); }
  ctx.io.out(`wrote ${keys.length} files to ${oneLine(out, 200)}`);
  return 0;
}

// ---- audit preparation: bundles and units, so agents read one prepared file instead of exploring ----
// Bounds per ticket: summary 300 chars, 50 findings of 500 chars, plan sections 20000 chars each, 50 file names, Jira text 32000 chars
// (read capped at 1 MiB). A bundle on stdout takes at most 100 keys (`plangraph units` writes larger sets to files).
const isLink = (f: string): boolean => { try { return fs.lstatSync(f).isSymbolicLink(); } catch { return false; } };
const MAX_TEXT = 1024 * 1024, MAX_BUNDLE_KEYS = 100, MAX_FINDINGS = 50, MAX_FILES = 50, PLAN_CHARS = 20000, JIRA_CHARS = 32000;
async function bundler(ctx: Ctx, args: Args<{ ref?: string; text?: string }>): Promise<(key: string) => string> {
  const { compileHeading } = await import('../../lib/gitsafe.ts'), { planSection, DEFAULT_HEADING } = await import('../../lib/stale.ts');
  const d = ctx.db(), heading = (ctx.config().ref_heading || DEFAULT_HEADING) as string, textDir = args.values.text; // config text: compileHeading below refuses a non-string
  let ref: string;
  try { ref = checkRef(args.values.ref ?? 'HEAD'); compileHeading(heading); } catch (e) { gitErrors(e); }
  const shownRef = oneLine(ref, 200), w = (x: unknown, n = 60) => oneLine(x, n);
  return (key: string) => {
    const k = oneLine(key, 120); // keys can come from data (units --stale): one sanitized line in every header
    const t = d.get('SELECT * FROM ticket WHERE key=?', key) as Record<string, unknown> | undefined; if (!t) return `# ${k}: not in the plan\n`; // row or none; read through w() and oneLine()
    const s = d.get(`SELECT owner,sprint FROM schedule WHERE ${CUR} AND key=?`, key) as { owner: unknown; sprint: unknown } | undefined; // the columns this SELECT names
    let md = `\n\n=============== TICKET ${k} | ${w(t.sp, 20)} SP | plan ${s ? `S${s.sprint} ${w(s.owner)}` : 'n/a'} | earlier verdict ${w(t.verdict, 40)}\n`;
    const needs = d.all(`SELECT e.producer,e.kind,s.sprint,s.owner FROM edge e LEFT JOIN schedule s ON s.key=e.producer AND s.${CUR} WHERE e.consumer=? ORDER BY s.sprint`, key) as Array<Record<string, unknown>>; // the columns this SELECT names
    md += `Needs (producer, plan position, kind): ${needs.map((n) => `${w(n.producer, 120)} S${n.sprint}/${w(n.owner)}[${w(n.kind, 40)}]`).join('; ') || 'none'}\n`;
    const fs_ = d.all('SELECT kind,text FROM finding WHERE key=?', key) as Array<{ kind: unknown; text: unknown }>; // the columns this SELECT names
    const lines = [`Summary: ${oneLine(t.summary ?? '', 300)}`, ...fs_.slice(0, MAX_FINDINGS).map((f) => `Finding [${w(f.kind, 40)}]: ${oneLine(f.text, 500)}`)];
    md += `${fenceLines(`ticket:${key}`, lines)}\n`;
    if (fs_.length > MAX_FINDINGS) md += `... ${fs_.length - MAX_FINDINGS} more findings (plangraph findings KIND)\n`;
    const r = d.get('SELECT * FROM ref WHERE key=?', key) as { plans: string; files: string } | undefined; // build stores both as JSON text (PREP)
    if (r) {
      for (const p of JSON.parse(r.plans) as Array<{ plan?: unknown; task?: unknown }>) { // unchecked: iterated without Array.isArray (pre-existing)
        const label = `${w(p.plan, 200)} task ${w(p.task, 40)}`;
        try {
          const text = ctx.git('show', '--end-of-options', `${ref}:${checkRepoPath(p.plan)}`);
          const sec = planSection(text, p.task, heading);
          md += `\n--- PLAN ${label} ---\n${sec ? fence('plan', sec, { src: `plan:${p.plan}`, max: PLAN_CHARS }) : '(section not found)'}\n`;
        } catch { md += `\n--- PLAN ${label}: file not readable at ${shownRef} ---\n`; }
      }
      const files = Object.keys(JSON.parse(r.files));
      if (files.length) md += `\nFiles it modifies: ${files.slice(0, MAX_FILES).map((f) => w(f, 200)).join(', ')}${files.length > MAX_FILES ? ` (+${files.length - MAX_FILES} more)` : ''}\n`;
    }
    if (textDir !== undefined && KEY_RE.test(key)) { // a key from data never builds a path; the file must stay inside --text
      const f = path.join(textDir, `${key}.txt`);
      if (fs.existsSync(f) || isLink(f)) {
        let txt = null; try { assertInside(textDir, f); txt = readCapped(f, MAX_TEXT); } catch { /* reported below */ }
        md += txt === null ? `\n--- JIRA TEXT ${k}: not readable (not a regular file, or over 1 MiB) ---\n` : `\n--- JIRA TEXT ${k} ---\n${fence('jira', txt, { src: `jira:${key}`, max: JIRA_CHARS })}\n`;
      }
    }
    return md;
  };
}
async function bundle(ctx: Ctx, args: Args<{ ref?: string; text?: string }>): Promise<number> {
  const keys = [...new Set(args.positionals.filter((a) => KEY_RE.test(a)))];
  if (keys.length > MAX_BUNDLE_KEYS) throw usage(`bundle takes at most ${MAX_BUNDLE_KEYS} keys (got ${keys.length}); use \`plangraph units\` for larger sets`);
  const text = await bundler(ctx, args);
  ctx.io.raw(keys.map(text).join('')); // prepared text, bounded per ticket and by the key cap; not cut by the 40-line output bound
  return 0;
}
async function units(ctx: Ctx, args: Args<StaleValues & { keys?: string; 'keys-file'?: string; stale?: boolean; size?: number; text?: string; out?: string; 'tokens-per-unit'?: number }>): Promise<number> {
  const v = args.values; let keys: string[] = [];
  if (v.keys !== undefined) keys = v.keys.split(',').map((x: string) => x.trim()).filter(Boolean);
  else if (v['keys-file'] !== undefined) {
    let raw: string; try { raw = readCapped(v['keys-file'], MAX_DATA); } catch { throw dataError(`cannot read ${sanitizeText(path.basename(v['keys-file']), { max: 80 })}`, 'check the --keys-file path'); }
    keys = raw.split(/\s+/).filter(Boolean);
  } else if (v.stale) {
    const { S, model, jira, deps, sopts } = await staleSetup(ctx, args);
    try {
      const res = S.computeStale(model, model.refs, deps, sopts);
      const done = new Set(jira ? Object.keys(jira).filter((k) => (jira[k] as JiraSnapEntry).status === 'Done') : []); // k comes from Object.keys(jira)
      keys = S.staleKeys(res, done).sort();
    } catch (e) { gitErrors(e); }
  } else throw usage('give --keys, --keys-file or --stale');
  keys = keys.filter((k: string) => KEY_RE.test(k)); // ticket keys only, as bundle: a key from data or a file never becomes a path
  const out = v.out; if (!out) throw usage('--out <dir> is required');
  const text = await bundler(ctx, args);
  fs.mkdirSync(out, { recursive: true });
  const size = v.size ?? 5, list = ([] as Array<{ id: string; keys: string[] }>); // an empty list of this element type
  for (let i = 0; i < keys.length; i += size) {
    const id = `u${String(list.length + 1).padStart(3, '0')}`, g = keys.slice(i, i + size);
    writeOutput(path.join(out, `${id}.md`), guardOutput(`# Unit ${id}: tickets to audit\n${g.map(text).join('')}`)); // a file agents read
    writeOutput(path.join(out, `${id}.in.json`), JSON.stringify(g)); list.push({ id, keys: g });
  }
  writeOutput(path.join(out, 'units.json'), JSON.stringify(list));
  const per = v['tokens-per-unit'] ?? 130000;
  ctx.io.out(`${keys.length} tickets -> ${list.length} units in ${oneLine(out, 200)}. Cost preview: ${list.length} units x ${per.toLocaleString()} tokens (measured on a large project) = about ${(list.length * per / 1e6).toFixed(1)} million tokens. Nothing was sent anywhere.`);
  return 0;
}

const B = { type: 'boolean' }, S = { type: 'string' };
export const commands: CommandMap = {
  stale: { run: stale, positionals: [0, 0], options: { ref: S, jira: S, list: B, full: B }, summary: 'which verdicts no longer match their inputs (plan text, files, Jira, links, rules)' },
  'refs-update': { run: refsUpdate, positionals: [0, Infinity], writes: 'text', guard: 'strict', options: { ref: S, jira: S, full: B }, summary: 'record fresh input fingerprints in refs.jsonl (all tickets, or the keys given)' },
  units: { run: units, positionals: [0, 0], writes: 'file', options: { keys: S, 'keys-file': S, stale: B, jira: S, ref: S, full: B, size: { type: 'integer', min: 1, max: 1000 }, text: S, out: S, 'tokens-per-unit': { type: 'integer', min: 0, max: 100000000 } }, summary: 'audit units (bundles plus input lists) for agents' },
  bundle: { run: bundle, positionals: [0, Infinity], guard: 'none', options: { ref: S, text: S }, summary: 'one ticket per section: row, plan task text, needs with positions, findings, Jira text' },
  'jira-pull': { run: jiraPull, positionals: [0, 0], writes: 'file', guard: 'none', options: { out: S, full: B }, summary: 'read-only Jira snapshot (delta by default; credentials from env, 1Password or keychain)' },
  'jira-text': { run: jiraText, positionals: [0, Infinity], writes: 'file', guard: 'none', options: { out: S, 'from-json': S }, summary: 'full description and comments of tickets as text files (read-only)' },
  'jira-import': { run: jiraImport, positionals: [0, Infinity], writes: 'file', guard: 'none', options: { out: S }, summary: 'merge issue JSON fetched elsewhere into a snapshot (no credentials, no network)' },
};
