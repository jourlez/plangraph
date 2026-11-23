#!/usr/bin/env node
// Differential baseline harness: records what the plugin does today so a later change (the TypeScript migration) can prove it behaves the same.
//   node scripts/baseline.ts capture --out DIR [--data DIR]    record every observation as one JSON file per id under DIR
//   node scripts/baseline.ts compare --a DIR --b DIR           print `same: N`, `differing: M` and one line per differing id (exit 1 when M > 0)
//   node scripts/baseline.ts bench [--runs N]                  print `median_ms: X` and `runs: N`: the warm median of `brain card --if-present`
//                                                                on the plan fixture (one untimed warm-up run first; N defaults to 30)
// Observations: (a) a CLI matrix built from `brain explain --json` (each command plain, -v, --json, with a bad flag, with a bad argument,
// and on an empty and a legacy repository), (b) the SessionStart hook, the merge driver and a scripted MCP stdio session, (c) library
// probes with canned inputs. Every child runs with a fixed HOME, TZ=UTC and LC_ALL=C. Output is normalized (see normalizeOutput) so that
// the planned file-extension rename (.mjs to .ts) is the only accepted difference.
// NOT covered: the Python solver (own tests), live network calls (Jira is only probed over a stub fetch), the real clock.
// `--data DIR` is a real brain directory: it is copied to a temporary directory first and the original is never written.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRAIN = path.join(PLUGIN, 'bin/brain');
const MERGE = path.join(PLUGIN, 'bin/brain-merge');
const MCP = path.join(PLUGIN, 'mcp/brain-mcp.ts');
const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };

interface MatrixEntry { id: string; args: string[]; fixture: 'plan' | 'empty' | 'legacy' }
interface Probe { id: string; run: () => unknown | Promise<unknown> }

/** The environment of every child: fixed HOME, TZ and locale, no brain-specific variables from the caller.
 * @param {string} home @returns {Record<string, string>} */
function childEnv(home: string) {
  return { PATH: process.env.PATH ?? '', HOME: home, CLAUDE_PLUGIN_DATA: path.join(home, 'data'), BRAIN_DIR: '', SOURCE_DATE_EPOCH: '1795305600', LC_ALL: 'C', TZ: 'UTC', NO_COLOR: '1', ...GIT_ENV };
}

// ---------------------------------------------------------------------------------------------------------------- normalization
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Make an output comparable across runs and across the planned rename: every `.mjs`, `.ts` or `.js` extension becomes `.EXT`, every
 * absolute temporary or repository path prefix becomes `<ROOT>` (the tail of the path is kept), and the host's node version and
 * solver runtime line are masked (they are not behavior under test).
 * @param {string} text @param {string[]} [roots] extra absolute directories to mask, besides the plugin directory and temp locations
 * @returns {string}
 */
export function normalizeOutput(text: string, roots: string[] = []) {
  let s = String(text);
  const known = [...new Set([...roots, PLUGIN, fs.realpathSync(PLUGIN), os.tmpdir(), fs.realpathSync(os.tmpdir())].filter((r) => r && r !== '/'))].sort((a, b) => b.length - a.length);
  for (const r of known) s = s.split(r).join('<ROOT>');
  s = s.replace(/(?:\/private)?\/var\/folders\/[^/\s"']+\/[^/\s"']+\/T\/[^/\s"'<>]+/g, '<ROOT>').replace(/\/tmp\/[A-Za-z0-9._-]+/g, '<ROOT>');
  s = s.replace(new RegExp(`${escapeRe('<ROOT>')}(?:/<ROOT>)+`, 'g'), '<ROOT>');
  s = s.replace(/node v\d+\.\d+\.\d+/g, 'node vX').replace(/solver runtime: [^\n\\]*/g, 'solver runtime: X');
  return s.replace(/\.(mjs|ts|js)\b/g, '.EXT');
}

// ---------------------------------------------------------------------------------------------------------------- the CLI matrix
function brainRun(args: string[], cwd: string, env: Record<string, string>) {
  const r = spawnSync(process.execPath, [BRAIN, ...args], { cwd, env, encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? `signal ${r.signal ?? 'none'}`, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

interface CommandInfo { name: string; positionals: [number, number | null]; options: Array<{ name: string }>; writes: string }
/** The registry as `brain explain --json` reports it. @returns {CommandInfo[]} */
function listCommands(): CommandInfo[] {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-explain-'));
  try {
    const r = brainRun(['explain', '--json'], home, childEnv(home));
    return JSON.parse(r.stdout).data.commands;
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
}
const COMMANDS = listCommands();

// Placeholders resolved per capture (a real brain directory has other keys): @KEY@ a ticket key, @PERSON@ an owner, @SPRINT@ a sprint
// number, @BRAINDIR@ the brain directory of the fixture.
/** Valid positional arguments for the commands that need some; every other command takes none. */
const GOOD_ARGS = Object.freeze({ bundle: ['@KEY@'], chain: ['@KEY@'], neighbors: ['@KEY@'], person: ['@PERSON@'], sprint: ['@SPRINT@'], ticket: ['@KEY@'], 'schedule-load': ['baseline-old', '@BRAINDIR@/schedule.jsonl'] });
/** Hand-picked invocations with option values, run on the plan fixture. */
const EXTRA = Object.freeze([
  ['ready', '@KEY@'], ['ready', '--person', '@PERSON@'], ['ready', '--sprint', '@SPRINT@'], ['findings', 'risk'], ['rules', '--repo'], ['rules', '--all'],
  ['stale', '--list'], ['stale', '--full'], ['verify', '--enforce-min'], ['forecast', '--seed', '3'], ['simulate', '--runs', '50', '--seed', '2'],
  ['whatif', '@KEY@', '--sprint', '2'], ['whatif', '@KEY@', '--to', '@PERSON@'], ['whatif', '@KEY@', '--find'], ['whatif', '--relieve', '@PERSON@', '--sprint', '@SPRINT@'], ['whatif', '@KEY@', '--slip'],
  ['neighbors', '@KEY@', '2'], ['bundle', '@KEY@', '--ref', 'HEAD'], ['units', '--keys', '@KEY@'], ['units', '--stale'], ['card', '--line'], ['card', '--write'], ['card', '--heal'], ['doctor', '--fix'],
  ['open-items', '--mine'], ['open-items', '--suggest-from-status'], ['migrate', '--write'], ['report', '--as-of', '2026-01-01'], ['export'], ['sp-ingest'], ['sp-link', '@KEY@'], ['refs-update', '--full'],
].map((a) => Object.freeze([...a])));

const slug = (a: readonly string[]) => a.join('.').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');

function buildMatrix() {
  const m: MatrixEntry[] = [];
  const add = (fixture: MatrixEntry['fixture'], tag: string, args: string[]) => m.push({ id: `cli.${fixture}.${tag}`, args, fixture });
  for (const c of COMMANDS) {
    const [min, max] = c.positionals;
    const good = (GOOD_ARGS as Record<string, string[]>)[c.name] ?? Array.from({ length: min }, () => 'x'); // as Record: GOOD_ARGS is looked up by command name
    const tooMany = max === null ? ['T-0-bad'] : Array.from({ length: max + 1 }, () => 'x');
    for (const [tag, rest] of [['plain', []], ['v', ['-v']], ['json', ['--json']], ['badflag', ['--no-such-flag']]]) add('plan', `${c.name}.${tag}`, [c.name, ...good, ...rest]);
    add('plan', `${c.name}.badarg`, [c.name, ...tooMany]);
    if (min > 0) add('plan', `${c.name}.missing`, [c.name]);
    // a missing index, and a data format from before format.json, with the same valid arguments
    for (const fx of ((['empty', 'legacy']) as const)) { add(fx, `${c.name}.plain`, [c.name, ...good]); add(fx, `${c.name}.json`, [c.name, ...good, '--json']); }
  }
  for (const a of EXTRA) add('plan', slug(a), [...a]);
  // global flags without a command, and an unknown command
  for (const a of [[], ['--help'], ['--version'], ['no-such-command'], ['explain', 'ticket'], ['explain', 'no-such-command']]) add('empty', `global.${slug(a) || 'none'}`, a);
  const seen = new Set();
  for (const e of m) { if (seen.has(e.id)) throw new Error(`duplicate matrix id ${e.id}`); seen.add(e.id); }
  return m;
}
/** Every command `brain explain --json` lists, plain, with -v and --json, with error paths, plus hand-picked option runs. @type {MatrixEntry[]} */
export const MATRIX: MatrixEntry[] = buildMatrix();

// ---------------------------------------------------------------------------------------------------------------- fixtures
/** Build the plan fixture once: a git repository with a built brain (test/helpers/cli-fixture.ts). @returns {Promise<string>} */
async function planFixture() {
  const { fixture } = await import('../test/helpers/cli-fixture.ts');
  const d = await fixture();
  fs.rmSync(path.join(d, 'big.jsonl'), { force: true }); // 8 MiB, only for size-limit tests: not worth copying per run
  return d;
}

/** @param {string} dir a repository with one empty commit */
function gitInit(dir: string) {
  const g = (...a: string[]) => spawnSync('git', a, { cwd: dir, env: { ...process.env, ...GIT_ENV }, stdio: 'ignore' });
  g('init', '-q', '-b', 'main'); fs.writeFileSync(path.join(dir, 'README.md'), 'baseline fixture\n'); g('add', '-A'); g('commit', '-qm', 'init');
}
const clone = (from: string, to: string) => fs.cpSync(from, to, { recursive: true, mode: fs.constants.COPYFILE_FICLONE });

/**
 * @param {string} work @param {string} planSrc @param {string | undefined} dataDir
 * @returns {{ plan: string, empty: string, legacy: string, vars: Record<string, string>, brainDir: string }} template roots (each holds `repo/`); vars are the placeholder values
 */
function buildTemplates(work: string, planSrc: string, dataDir: string | undefined): { plan: string; empty: string; legacy: string; vars: Record<string, string>; brainDir: string } {
  const plan = path.join(work, 'tpl-plan'), empty = path.join(work, 'tpl-empty'), legacy = path.join(work, 'tpl-legacy');
  fs.mkdirSync(path.join(empty, 'repo'), { recursive: true }); gitInit(path.join(empty, 'repo'));
  clone(planSrc, path.join(legacy, 'repo')); fs.rmSync(path.join(legacy, 'repo/.brain/format.json'), { force: true });
  let vars = { KEY: 'T-3', PERSON: 'Ana', SPRINT: '1' }, brainDir = '.brain';
  if (dataDir) {
    // the owner's directory is copied first and never touched again; commands run against the copy
    fs.mkdirSync(path.join(plan, 'repo'), { recursive: true }); gitInit(path.join(plan, 'repo'));
    clone(dataDir, path.join(plan, 'repo/data')); brainDir = 'data'; // inside the repository: the CLI refuses a brain directory outside it
    try {
      const first = fs.readFileSync(path.join(plan, 'repo/data/tickets.jsonl'), 'utf8').split('\n').find((l) => l.trim());
      const t = first ? JSON.parse(first) : {};
      vars = { KEY: String(t.key ?? 'T-1'), PERSON: String(t.v2_owner || 'Ana'), SPRINT: String(t.v2_sprint || 1) };
    } catch { /* keep the synthetic defaults */ }
  } else clone(planSrc, path.join(plan, 'repo'));
  return { plan, empty, legacy, vars, brainDir };
}

// ---------------------------------------------------------------------------------------------------------------- hook, merge driver, MCP
const HOOK = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'hooks/hooks.json'), 'utf8')).hooks.SessionStart[0].hooks[0];
const hookHome = (root: string) => { const h = path.join(root, '.baseline-home'); fs.mkdirSync(h, { recursive: true }); return h; };

/**
 * Run the SessionStart command of hooks/hooks.json (no shell, ${CLAUDE_PLUGIN_ROOT} substituted) with `root` as the working directory.
 * @param {string} root @returns {{ code: number, out: string, err: string }}
 */
export function runHook(root: string): { code: number; out: string; err: string } {
  const r = spawnSync(HOOK.command, HOOK.args.map((a: string) => a.replace('${CLAUDE_PLUGIN_ROOT}', PLUGIN)), { cwd: root, env: childEnv(hookHome(root)), encoding: 'utf8', timeout: 60000 });
  return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
}

const row = (key: string, o: Record<string, unknown> = {}) => JSON.stringify({ key, summary: `ticket ${key}`, epic: 'E0', sp: 2, jira_status: 'To Do', v2_owner: 'Ana', v2_sprint: 1, verdict: 'READY', ...o });
const lines = (a: string[]) => `${a.join('\n')}\n`;
/**
 * Run bin/brain-merge on three fixed files written into `root`: `clean` edits distinct tickets on each side, `conflict` edits the same
 * field of one ticket differently.
 * @param {string} root @param {'clean' | 'conflict'} [variant] @returns {{ code: number, merged: string }}
 */
export function runMergeDriver(root: string, variant: 'clean' | 'conflict' = 'clean'): { code: number; merged: string } {
  const base = lines([row('T-1'), row('T-2'), row('T-3')]);
  const ours = lines([row('T-1', { sp: 5 }), row('T-2'), row('T-3', variant === 'conflict' ? { summary: 'ours' } : {})]);
  const theirs = lines([row('T-1'), row('T-2', { summary: 'theirs' }), row('T-3', variant === 'conflict' ? { summary: 'theirs' } : {}), row('T-4')]);
  const dir = path.join(root, `.baseline-merge-${variant}`); fs.mkdirSync(dir, { recursive: true });
  const [O, A, B] = ['base', 'ours', 'theirs'].map((n) => path.join(dir, `${n}.jsonl`));
  fs.writeFileSync(O, base); fs.writeFileSync(A, ours); fs.writeFileSync(B, theirs);
  const r = spawnSync(process.execPath, [MERGE, O, A, B, 'tickets.jsonl'], { cwd: root, env: childEnv(hookHome(root)), encoding: 'utf8', timeout: 60000 });
  return { code: r.status ?? -1, merged: fs.readFileSync(A, 'utf8') };
}

/**
 * A scripted stdio session against mcp/brain-mcp.ts: initialize, initialized, tools/list, one tools/call for `ready`.
 * @param {string} root a repository with a brain, used as the working directory @returns {string[]} the responses, one JSON-RPC message per entry
 */
export function runMcpSession(root: string): string[] {
  const msg = (o: object) => JSON.stringify({ jsonrpc: '2.0', ...o });
  const input = lines([
    msg({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'baseline', version: '0' } } }),
    msg({ method: 'notifications/initialized' }),
    msg({ id: 2, method: 'tools/list' }),
    msg({ id: 3, method: 'tools/call', params: { name: 'ready', arguments: { key: 'T-3' } } }),
  ]);
  const r = spawnSync(process.execPath, [MCP], { cwd: root, env: childEnv(hookHome(root)), input, encoding: 'utf8', timeout: 60000 });
  return (r.stdout ?? '').split('\n').filter(Boolean);
}

// ---------------------------------------------------------------------------------------------------------------- library probes
const lib = (p: string) => import(path.join(PLUGIN, p));
/** A stable JSON form: sorted keys, Maps and Sets expanded, errors as code and message. @param {unknown} v @returns {unknown} */
function stable(v: unknown): unknown {
  if (v instanceof Map) return { __map: [...v.entries()].map(([k, x]) => [stable(k), stable(x)]) };
  if (v instanceof Set) return { __set: [...v].map(stable) };
  if (v instanceof Error) return { __error: v.name, code: (v as NodeJS.ErrnoException).code ?? null, message: v.message }; // as ErrnoException: an Error may carry a code
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable((v as Record<string, unknown>)[k])])); // as Record: v is a non-null object here
  if (typeof v === 'number' && !Number.isFinite(v)) return String(v);
  return v === undefined ? null : v;
}
const attempt = async (f: () => unknown) => { try { return await f(); } catch (e) { return e; } };

async function genModel(o: Record<string, unknown> = {}) {
  const { genPlan } = await import(path.join(PLUGIN, 'test/fixtures/gen.ts'));
  const { buildModel } = await lib('lib/model.ts');
  const p = genPlan({ n: 14, people: 3, seed: 9, cap: 8, ...o });
  return { p, model: buildModel(p) };
}
const history = (done: number[]) => done.map((d, i) => ({ sprint: i + 1, planned: 40, done: d, added: 2 }));

/** Fixed calls of exported library functions with canned inputs. @type {Probe[]} */
export const PROBES: Probe[] = [
  { id: 'verify', run: async () => { const { verifyPlan, summarize } = await lib('lib/verify.ts'); const { model } = await genModel(); return { verify: verifyPlan(model), summary: summarize(model) }; } },
  { id: 'verify-overloaded', run: async () => { const { verifyPlan } = await lib('lib/verify.ts'); const { model } = await genModel({ cap: 2 }); return verifyPlan(model); } },
  { id: 'whatif', run: async () => {
    const { whatif, findSlots, relieve } = await lib('lib/whatif.ts'); const { model } = await genModel();
    return { later: whatif(model, { key: 'T-3', sprint: 4 }), earlier: whatif(model, { key: 'T-9', sprint: 1 }), owner: whatif(model, { key: 'T-3', to: 'Ben' }), find: findSlots(model, 'T-5'), relieve: relieve(model, { person: 'Ana', sprint: 1 }) };
  } },
  { id: 'merge', run: async () => {
    const { mergeJsonl } = await lib('lib/merge.ts'); const { schemaFor } = await lib('lib/store.ts'); const sch = schemaFor('tickets.jsonl');
    const b = lines([row('T-1'), row('T-2')]);
    return {
      clean: mergeJsonl({ base: b, ours: lines([row('T-1', { sp: 8 }), row('T-2')]), theirs: lines([row('T-1'), row('T-2', { summary: 'x' }), row('T-3')]) }, sch, { name: 'tickets.jsonl' }),
      conflict: mergeJsonl({ base: b, ours: lines([row('T-1', { sp: 8 }), row('T-2')]), theirs: lines([row('T-1', { sp: 3 }), row('T-2')]) }, sch, { name: 'tickets.jsonl' }),
    };
  } },
  { id: 'stale', run: async () => {
    const { computeStale, refsUpdate } = await lib('lib/stale.ts'); const { model } = await genModel();
    const dep = (planText: string, stamp: string) => ({ readPlanText: () => planText, listFiles: (_r: string, ps: string[]) => Object.fromEntries(ps.map((p) => [p, 'h1'])), jiraStamp: () => stamp, linkSet: () => [], status: () => 'To Do', commit: () => 'abc1234' });
    const d0 = dep('# Plan\n\n### Task 1: a\nbuild a\n\n### Task 2: b\nbuild b\n', '2026-01-01');
    const rows = [{ key: 'T-1', plans: [{ plan: 'p.md', task: '1' }], files: { 'a.js': 1 }, fp_files: '', jira_updated: '', audited_at: '' }, { key: 'T-2', plans: [{ plan: 'p.md', task: '2' }], files: {}, fp_files: '', jira_updated: '', audited_at: '' }];
    const fresh = refsUpdate(model, rows, d0, { rulesVersion: 1, ref: 'HEAD' });
    const d1 = dep('# Plan\n\n### Task 1: a\nbuild a differently\n\n### Task 2: b\nbuild b\n', '2026-02-01');
    return { fresh, same: computeStale(model, fresh.rows, d0, { rulesVersion: 1, ref: 'HEAD' }), changed: computeStale(model, fresh.rows, d1, { rulesVersion: 1, ref: 'HEAD' }), rules: computeStale(model, fresh.rows, d0, { rulesVersion: 2 }) };
  } },
  { id: 'forecast', run: async () => {
    const { forecast, parseHistory } = await lib('lib/forecast.ts'); const { model } = await genModel();
    const h = history([30, 35, 38, 33, 36, 31, 34, 37]);
    return { thin: forecast({ history: history([30, 35]), remaining: 100 }), flat: forecast({ history: h, remaining: 100, seed: 4, runs: 2000 }), graph: forecast({ history: h, model, seed: 5, runs: 2000 }), parsed: parseHistory(`${h.map((r) => JSON.stringify(r)).join('\n')}\nnot json\n`) };
  } },
  { id: 'jira-normalize-issue', run: async () => {
    const { normalizeIssue } = await lib('lib/jira.ts');
    const raw = { key: 'TST-7', fields: { summary: 'A <b>summary</b>', status: { name: 'In Progress' }, assignee: { displayName: 'Ana Example' }, updated: '2026-01-02T03:04:05.000+0000', resolutiondate: null, customfield_10020: [{ id: 5, name: 'Sprint 5', state: 'active' }], issuelinks: [{ type: { inward: 'is blocked by', outward: 'blocks' }, inwardIssue: { key: 'TST-2' } }, { type: { inward: 'is blocked by', outward: 'blocks' }, outwardIssue: { key: 'TST-9' } }] } };
    return { full: normalizeIssue(raw, { sprintField: 'customfield_10020' }), plain: normalizeIssue(raw), badKey: normalizeIssue({ key: 'nope' }), empty: normalizeIssue({ key: 'TST-1' }), nothing: normalizeIssue(null) };
  } },
  { id: 'jira-credentials', run: async () => {
    const { getCredentialsFor, parseSiteRegistry, siteTag } = await lib('lib/jira.ts');
    const tok = 'baseline-token-0123456789abcdef';
    const calls: string[] = [];
    // a fake secret store: 1Password and the OS keychain answer from here, nothing real is read
    const exec = async (file: string, args: string[]) => {
      calls.push(`${file} ${args.join(' ')}`);
      if (file === 'op') return `op-user@example.invalid:${tok}\n`;
      if (file === 'security' || file === 'secret-tool') { if (args.includes('keychain-svc') || args.includes('project-brain-jira:four.example.invalid')) return `kc-user@example.invalid:${tok}\n`; throw new Error('item not found'); }
      throw new Error(`unexpected ${file}`);
    };
    const parsed = parseSiteRegistry(JSON.stringify({ sites: {
      'One.Example.Invalid': { email_env: 'BL_MAIL', token_env: 'BL_TOKEN' },
      'two.example.invalid': { op_ref: 'op://Vault/Item/token' },
      'three.example.invalid': { keychain: 'keychain-svc' },
      'bad host!': { op_ref: 'nope' },
    } }));
    const registry = parsed.reg;
    const via = (host: string, o: Record<string, unknown>) => attempt(() => getCredentialsFor(host, { exec, platform: 'darwin', registry, ...o }));
    return {
      tag: siteTag('one.example.invalid'), problems: parsed.problems, hosts: Object.keys(registry).sort(),
      registryEnv: await via('one.example.invalid', { env: { BL_MAIL: 'a@example.invalid', BL_TOKEN: tok } }),
      registryEnvMissing: await via('one.example.invalid', { env: {} }),
      registryOp: await via('two.example.invalid', { env: {} }),
      registryKeychain: await via('three.example.invalid', { env: {} }),
      perSite: await via('five.example.invalid', { env: { JIRA_EMAIL__FIVE_EXAMPLE_INVALID: 'b@example.invalid', JIRA_API_TOKEN__FIVE_EXAMPLE_INVALID: tok } }),
      conventionKeychain: await via('four.example.invalid', { env: {} }),
      generic: await via('six.example.invalid', { env: { JIRA_EMAIL: 'c@example.invalid', JIRA_API_TOKEN: tok }, allowGeneric: true }),
      genericRefused: await via('six.example.invalid', { env: { JIRA_EMAIL: 'c@example.invalid', JIRA_API_TOKEN: tok } }),
      none: await via('seven.example.invalid', { env: {}, platform: 'win32' }),
      calls,
    };
  } },
  { id: 'jira-pull-snapshot', run: async () => {
    const { makeClient, pullSnapshot } = await lib('lib/jira.ts');
    const issue = (n: number) => ({ key: `TST-${n}`, fields: { summary: `issue ${n}`, status: { name: n === 2 ? 'Done' : 'To Do' }, assignee: null, updated: `2026-01-0${n}T00:00:00.000+0000`, issuelinks: [] } });
    const log: string[] = [];
    const reply = (body: unknown, status = 200) => ({ status, ok: status < 400, type: 'basic', headers: { get: () => null }, body: null, text: async () => JSON.stringify(body) });
    const fetchImpl = (async (url: string, o: { method: string; body?: string }) => {
      log.push(`${o.method} ${new URL(url).pathname}`);
      if (url.endsWith('/myself')) return reply({ accountId: 'acct-1', timeZone: 'UTC' });
      if (url.endsWith('/search/jql')) { const b = JSON.parse(o.body ?? '{}'); return b.nextPageToken ? reply({ issues: [issue(3)], isLast: true }) : reply({ issues: [issue(1), issue(2)], nextPageToken: 'p2', isLast: false }); }
      return reply({ message: 'unexpected' }, 404);
    }) as unknown as typeof fetch; // a test double: the client calls it with a url string and a plain init
    const client = makeClient({ baseConfig: { mode: 'scoped', cloudId: 'baseline-cloud-0001' }, creds: { email: 'a@example.invalid', token: 'baseline-token-0123456789abcdef' }, fetchImpl, now: () => Date.parse('2026-02-01T00:00:00Z'), sleep: async () => {}, random: () => 0.5 });
    const snap = await attempt(() => pullSnapshot(client, { jql: 'project = TST', pageSize: 2 }));
    return { snap, log };
  } },
];

// ---------------------------------------------------------------------------------------------------------------- capture and compare
const fileFor = (outDir: string, id: string) => path.join(outDir, `${id}.json`);

/**
 * Record every observation under `outDir`, one normalized JSON file per id. `dataDir`, when given, is copied to a temporary
 * directory first and never modified; the plan-fixture runs then use the copy as their brain directory.
 * @param {{ root: string, outDir: string, dataDir?: string }} opts `root` is the plugin directory (the harness always runs the plugin it lives in)
 * @returns {Promise<{ count: number }>}
 */
export async function captureAll({ root, outDir, dataDir }: { root: string; outDir: string; dataDir?: string | undefined }): Promise<{ count: number }> {
  if (path.resolve(root) !== PLUGIN) throw new Error(`captureAll runs the plugin it lives in (${PLUGIN}), not ${root}`);
  fs.rmSync(outDir, { recursive: true, force: true }); fs.mkdirSync(outDir, { recursive: true });
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-')));
  const home = path.join(work, 'home'); fs.mkdirSync(home);
  const env = childEnv(home);
  let count = 0, planSrc = '';
  const save = (id: string, value: unknown) => { fs.writeFileSync(fileFor(outDir, id), normalizeOutput(`${JSON.stringify(value, null, 2)}\n`, [work, os.homedir()])); count++; };
  try {
    planSrc = await planFixture();
    const tpl = buildTemplates(work, planSrc, dataDir);
    const writes = new Map(COMMANDS.map((c) => [c.name, c.writes !== 'none' || c.name === 'card' || c.name === 'doctor']));
    let n = 0;
    for (const e of MATRIX) {
      const cmd = e.args[0] ?? '';
      // a command that may write runs on a fresh copy; a read-only one shares the template (nothing it does is kept by the next run)
      const tplRoot = tpl[e.fixture];
      const live = writes.get(cmd) || e.args.some((a) => /^--(write|fix|heal|apply-plan)$/.test(a)) ? (() => { const d = path.join(work, `run-${n++}`); clone(tplRoot, d); return d; })() : tplRoot;
      const cwd = path.join(live, 'repo');
      const sub = (a: string) => a.replace(/@KEY@/g, tpl.vars.KEY).replace(/@PERSON@/g, tpl.vars.PERSON).replace(/@SPRINT@/g, tpl.vars.SPRINT).replace(/@BRAINDIR@/g, tpl.brainDir);
      const runEnv = dataDir && e.fixture === 'plan' ? { ...env, BRAIN_DIR: tpl.brainDir } : env;
      const r = brainRun(e.args.map(sub), cwd, runEnv);
      save(e.id, { id: e.id, fixture: e.fixture, args: e.args, code: r.code, stdout: r.stdout, stderr: r.stderr });
      if (live !== tplRoot) fs.rmSync(live, { recursive: true, force: true });
    }
    for (const p of PROBES) save(`probe.${p.id}`, { id: p.id, result: stable(await attempt(() => p.run())) });
    // hook, merge driver and MCP session, each on its own copy of the synthetic plan fixture (also when --data is given)
    const copyPlan = () => { const d = path.join(work, `run-${n++}`); clone(planSrc, path.join(d, 'repo')); return path.join(d, 'repo'); };
    const hookRoot = copyPlan(); save('hook.session-start', { id: 'hook', ...runHook(hookRoot) });
    const hookAgain = copyPlan(); fs.rmSync(path.join(hookAgain, '.brain'), { recursive: true, force: true }); save('hook.session-start-no-brain', { id: 'hook-no-brain', ...runHook(hookAgain) });
    for (const variant of ((['clean', 'conflict']) as const)) save(`merge-driver.${variant}`, { id: `merge-driver-${variant}`, ...runMergeDriver(copyPlan(), variant) });
    save('mcp.session', { id: 'mcp', responses: runMcpSession(copyPlan()) });
  } finally { fs.rmSync(work, { recursive: true, force: true }); if (planSrc) fs.rmSync(planSrc, { recursive: true, force: true }); }
  return { count };
}

/**
 * Compare two capture directories by normalized content (a file missing on one side counts as differing, so a different number of
 * entries is reported by id). Throws when a path is not a directory or a directory holds no .json file: an empty comparison proves nothing.
 * @param {string} a @param {string} b @returns {{ same: number, differing: string[] }}
 */
export function compareDirs(a: string, b: string): { same: number; differing: string[] } {
  for (const d of [a, b]) if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) throw new Error(`not a directory: ${path.basename(d)}`);
  const ids = (d: string) => fs.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
  const read = (d: string, id: string) => { try { return normalizeOutput(fs.readFileSync(fileFor(d, id), 'utf8')); } catch { return null; } };
  const na = ids(a).length, nb = ids(b).length;
  if (!na || !nb) throw new Error(`no captured files in ${na ? 'the second' : 'the first'} directory`);
  const all = [...new Set([...ids(a), ...ids(b)])].sort();
  const differing = all.filter((id) => read(a, id) !== read(b, id));
  return { same: all.length - differing.length, differing };
}

// ---------------------------------------------------------------------------------------------------------------- startup benchmark
/** @param {number[]} xs a non-empty list @returns {number} */
const median = (xs: number[]): number => { const s = xs.toSorted((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/**
 * Startup benchmark (the spec's budget: warm median at most 15 ms over the pre-migration median). Builds the plan fixture once, runs
 * `node bin/brain card --if-present` once untimed (so a compile cache, when the entry enables one, is warm), then `runs` timed times.
 * @param {{ runs: number, runOnce?: (cwd: string, env: Record<string, string>) => { code: number | string } }} opts runOnce: injectable for tests
 * @returns {Promise<{ median: number, samples: number[] }>} milliseconds
 */
export async function bench({ runs, runOnce = (cwd: string, env: Record<string, string>) => brainRun(['card', '--if-present'], cwd, env) }: { runs: number; runOnce?: (cwd: string, env: Record<string, string>) => { code: number | string } }): Promise<{ median: number; samples: number[] }> {
  if (!Number.isSafeInteger(runs) || runs < 1) throw new Error('bench: --runs must be a whole number of at least 1');
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-bench-')));
  let planSrc = '';
  try {
    planSrc = await planFixture();
    const home = path.join(work, 'home'); fs.mkdirSync(home);
    const env = childEnv(home), cwd = path.join(work, 'repo');
    clone(planSrc, cwd);
    const warm = runOnce(cwd, env);
    if (warm.code !== 0) throw new Error(`bench: brain card --if-present exited ${warm.code} on the plan fixture`);
    const samples: number[] = [];
    for (let i = 0; i < runs; i++) { const t = process.hrtime.bigint(); runOnce(cwd, env); samples.push(Number(process.hrtime.bigint() - t) / 1e6); }
    return { median: median(samples), samples };
  } finally { fs.rmSync(work, { recursive: true, force: true }); if (planSrc) fs.rmSync(planSrc, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------------------------------------------------------- command line
const opt = (argv: string[], name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'capture') {
    const out = opt(rest, 'out'); const data = opt(rest, 'data');
    if (!out) { process.stderr.write('usage: baseline.ts capture --out DIR [--data DIR]\n'); process.exit(2); }
    const { count } = await captureAll({ root: PLUGIN, outDir: path.resolve(out), dataDir: data ? fs.realpathSync(data) : undefined });
    process.stdout.write(`captured: ${count}\n`);
  } else if (cmd === 'compare') {
    const a = opt(rest, 'a'), b = opt(rest, 'b');
    if (!a || !b) { process.stderr.write('usage: baseline.ts compare --a DIR --b DIR\n'); process.exit(2); }
    let r: ReturnType<typeof compareDirs>;
    try { r = compareDirs(path.resolve(a), path.resolve(b)); } catch (e) { process.stderr.write(`compare: ${(e as Error).message}\nusage: baseline.ts compare --a DIR --b DIR\n`); process.exit(2); } // as Error: whatever compareDirs threw
    process.stdout.write(`same: ${r.same}\ndiffering: ${r.differing.length}\n${r.differing.map((id) => `  ${id}\n`).join('')}`);
    process.exitCode = r.differing.length ? 1 : 0;
  } else if (cmd === 'bench') {
    const raw = opt(rest, 'runs') ?? '30', runs = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(runs) || runs < 1) { process.stderr.write('usage: baseline.ts bench [--runs N]   (N a whole number of at least 1)\n'); process.exit(2); }
    const r = await bench({ runs });
    process.stdout.write(`median_ms: ${r.median.toFixed(1)}\nruns: ${r.samples.length}\n`);
  } else { process.stderr.write('usage: baseline.ts capture|compare|bench ...\n'); process.exit(2); }
}
