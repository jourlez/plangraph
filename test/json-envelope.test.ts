// `--json on any command prints the v2 envelope` (docs/CONTRACT.md) holds for EVERY registered command: run through bin/plangraph with --json
// and with --json -v, each on a fresh copy of a small plan, stdout is exactly one JSON envelope {v:2, cmd, ok, exit, data, fresh, next}
// whose exit and ok repeat the process exit code, also when the command printed no text (findings of a plan with none, card --if-present
// without an index) and when it failed (no index, missing credentials, an argument error after --json was seen).
// Not covered: the content of `data` per command (test/contract.test.ts and the goldens), jira-pull with real credentials (no network here).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { registry } from '../src/registry.ts';
import { adoptPlanDir } from './helpers/plan-dir.ts';

const BRAIN = path.join(import.meta.dirname, '../bin/plangraph'), FX = path.join(import.meta.dirname, 'fixtures');
let BASE = '', FIXTURE = '', EMPTY = '';
const GIT = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
const env = () => ({ PATH: process.env.PATH, HOME: path.join(BASE, 'home'), CLAUDE_PLUGIN_DATA: path.join(BASE, 'data'), LC_ALL: 'C', TZ: 'UTC', PLANGRAPH_DIR: '', TMPDIR: BASE, PLANGRAPH_STRICT_OUT: '1', SOURCE_DATE_EPOCH: '1795305600', ...GIT });
const jl = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const put = (root: string, rel: string, text: string) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const run = (cwd: string, args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> => new Promise((resolve) => {
  const p = spawn(process.execPath, [BRAIN, ...args], { cwd, env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; const timer = setTimeout(() => p.kill('SIGKILL'), 60000);
  p.stdout.setEncoding('utf8').on('data', (d: string) => { stdout += d; }); p.stderr.setEncoding('utf8').on('data', (d: string) => { stderr += d; });
  p.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
});

before(async () => {
  BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-jsonenv-')));
  for (const d of ['home', 'data']) fs.mkdirSync(path.join(BASE, d));
  FIXTURE = path.join(BASE, 'fixture'); fs.mkdirSync(FIXTURE);
  const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env: env(), stdio: 'ignore' });
  git(FIXTURE, 'init', '-q');
  assert.equal((await run(FIXTURE, ['init'])).status, 0);
  put(FIXTURE, '.plangraph/tickets.jsonl', jl([{ key: 'T-1', sp: 3, verdict: 'READY', jira_status: 'Done' }, { key: 'T-2', sp: 2, verdict: 'READY' }, { key: 'T-3', sp: 1, verdict: 'BLOCKED' }]));
  put(FIXTURE, '.plangraph/edges.jsonl', jl([{ consumer: 'T-2', producer: 'T-1', kind: 'code' }]));
  put(FIXTURE, '.plangraph/schedule.jsonl', jl([{ key: 'T-1', owner: 'Ana', sprint: 1 }, { key: 'T-2', owner: 'Ana', sprint: 1 }, { key: 'T-3', owner: 'Ben', sprint: 2 }]));
  put(FIXTURE, '.plangraph/history.jsonl', jl([30, 34, 28, 36].map((d, i) => ({ sprint: i + 1, planned: 40, done: d }))));
  put(FIXTURE, 'docs/plan.md', '# Plan\n\n### Task 1: first\nbuild a\n');
  put(FIXTURE, '.plangraph/refs.jsonl', jl([{ key: 'T-1', plans: [{ plan: 'docs/plan.md', task: '1' }], files: {}, fp_files: '', jira_updated: '', audited_at: 'base' }]));
  adoptPlanDir(path.join(FIXTURE, '.plangraph'));
  put(FIXTURE, 'sched.json', JSON.stringify([{ item: 'T-1', owner: 'Ana', sprint: 1 }, { item: 'T-2', owner: 'Ana', sprint: 2 }, { item: 'T-3', owner: 'Ben', sprint: 2 }]));
  put(FIXTURE, 'issue.json', JSON.stringify({ 'T-1': { key: 'T-1', fields: { summary: 's', status: { name: 'Done' } } } }));
  put(FIXTURE, 'batch.json', JSON.stringify({ schema: 'plangraph-ext-batch@1', sys: 'x-demo', observations: [{ xid: 'item-1', type: 'x-demo.item', fields: { state: 'open' }, links: [] }] }));
  put(FIXTURE, 'f.jsonl', jl([{ key: 'T-3', kind: 'late', text: 'x' }]));
  put(FIXTURE, '.wolf/cerebrum.md', fs.readFileSync(path.join(FX, 'openwolf/cerebrum.template.md'), 'utf8'));
  put(FIXTURE, 'docs/superpowers/plans/2026-11-20-widget-export.md', fs.readFileSync(path.join(FX, 'superpowers/plans/2026-11-20-widget-export.md'), 'utf8'));
  git(FIXTURE, 'add', '-A'); git(FIXTURE, 'commit', '-qm', 'base');
  assert.equal((await run(FIXTURE, ['build'])).status, 0);
  EMPTY = path.join(BASE, 'empty'); fs.mkdirSync(EMPTY); git(EMPTY, 'init', '-q');
});
after(() => { if (BASE) fs.rmSync(BASE, { recursive: true, force: true }); });

// Argument shapes per command; '@empty' runs in a git repo without a plan directory.
/** @type {Record<string, string[][]>} */
const SHAPES = {
  ticket: [['T-1'], ['T-404']], neighbors: [['T-2']], chain: [['T-2']], sprint: [['1'], ['99']], person: [['Ana']], blockers: [[]],
  findings: [[], ['gap']], rules: [[], ['--repo']], check: [[]], verify: [[], ['sched.json']], ready: [['T-2'], ['T-404']],
  card: [[], ['--line'], ['--if-present'], ['@empty', '--if-present']], whatif: [['T-2', '--sprint', '2']], 'schedule-load': [['sched.json', 'old']],
  export: [[]], build: [[]], init: [[]], doctor: [[]], stale: [[]], 'refs-update': [[]], units: [['--keys', 'T-1', '--out', 'u']],
  bundle: [['T-1']], 'jira-pull': [['--out', 'snap.jsonl']], 'jira-text': [['T-1', '--out', 'jt', '--from-json', 'issue.json']], 'jira-import': [['issue.json', '--out', 'imp.jsonl']],
  'open-items': [[], ['--findings', 'f.jsonl']], forecast: [[]], simulate: [['--runs', '20']], integrations: [[]],
  'sp-ingest': [['docs/superpowers/plans/2026-11-20-widget-export.md', '--ledger', 'none']], 'sp-link': [['T-1', 'docs/plan.md']],
  learn: [['--from-wolf', 'w000000']], report: [[]], explain: [[], ['ticket'], ['nope']], 'graph-materialize': [[]], fmt: [[]], resolve: [[]], compact: [[]], flow: [['next'], ['brief', 'T-1'], ['status'], ['actions']], 'flow-claim': [['T-404'], ['T-1', '--by', 'ana']], 'flow-progress': [['T-404', '--to', 'in_progress'], ['T-1', '--to', 'in_progress']], 'flow-done': [['T-404', '--evidence', 'test:suite']], 'flow-link': [['T-1', 'jira:u1', 'ABC-1']], map: [[], ['--json']], context: [[], ['--json'], ['--branch']], refresh: [['--quiet'], ['--fast']], 'hook-prompt': [[]], 'githooks-install': [['--dry-run']], docs: [['list'], ['check'], ['export', 'roadmap'], ['export', 'status'], ['export', 'nope']], 'docs-build': [[], ['roadmap', '--force'], ['--commit-ready']], ingest: [['links'], ['docs', 'docs/plan.md'], ['requirements', 'docs/plan.md'], ['git'], ['nope']], 'sync-fetch': [[]], trust: [['nope'], ['github:o/r']], identity: [['propose'], ['list']], 'identity-map': [['jira:u1', 'Nobody'], ['jira:u1', 'Ana']], repo: [['scan'], ['scan', '--check'], ['scan', '--all'], []], sync: [['--plan'], []], import: [['--sys', 'generic', 'batch.json'], ['--sys', 'jira', 'issue.json', '--tenant', 'work'], ['--sys', 'sp', 'docs/plan.md'], ['--sys', 'nope', 'batch.json'], []], graph: [['T-2'], ['T-2', '--depth', '2', '--reverse'], ['T-404'], ['pg:ticket/T-2'], ['T-2', '--rel', 'nope'], ['materialize']],
};
// Failures after --json was seen: no index, a bad positional count, a bad option value.
const FAILURES = [['@empty', 'ticket', 'T-1'], ['@empty', 'check'], ['sprint'], ['sprint', '1', '2'], ['simulate', '--runs', 'x']];

test('the shapes cover every registered command', () => {
  assert.deepEqual([...registry.keys()].filter((n) => !Object.hasOwn(SHAPES, n)), []);
  assert.deepEqual(Object.keys(SHAPES).filter((n) => !registry.has(n)), []);
});

test('--json (plain and -v) prints exactly one v2 envelope on every registered command, failures and empty answers included', async () => {
  const cases = [];
  for (const [name, shapes] of Object.entries(SHAPES)) for (const s of shapes) for (const v of [['--json'], ['--json', '-v']]) cases.push([name, ...s, ...v]);
  for (const f of FAILURES) cases.push([...f, '--json']);
  const bad: string[] = []; let n = 0, failed = 0;
  const one = async (c: string[]) => {
    const inEmpty = c.includes('@empty'), args = c.filter((a) => a !== '@empty'), name = args[0];
    let cwd = EMPTY;
    if (!inEmpty) { cwd = path.join(BASE, `run-${n++}`); fs.cpSync(FIXTURE, cwd, { recursive: true }); }
    const r = await run(cwd, args), what = `plangraph ${args.join(' ')}${inEmpty ? ' (no plangraph)' : ''} -> exit ${r.status}`;
    if (r.status !== 0) failed++;
    let e: { v?: unknown; cmd?: unknown; ok?: unknown; exit?: unknown; data?: unknown; next?: unknown };
    try { e = JSON.parse(r.stdout); } catch { bad.push(`${what}: stdout is not one JSON value: ${JSON.stringify(r.stdout.slice(0, 160))} stderr ${JSON.stringify(r.stderr.slice(0, 160))}`); return; }
    if (r.stdout.trimEnd().split('\n').length !== 1) bad.push(`${what}: more than one stdout line`);
    if (JSON.stringify(Object.keys(e)) !== JSON.stringify(['v', 'cmd', 'ok', 'exit', 'data', 'fresh', 'next'])) bad.push(`${what}: keys ${Object.keys(e)}`);
    if (e.v !== 2 || e.cmd !== name || e.exit !== r.status || e.ok !== (r.status === 0)) bad.push(`${what}: envelope ${JSON.stringify({ v: e.v, cmd: e.cmd, ok: e.ok, exit: e.exit })}`);
    if (!e.data || typeof e.data !== 'object' || !Array.isArray(e.next)) bad.push(`${what}: data/next shape`);
    if (!inEmpty) fs.rmSync(cwd, { recursive: true, force: true });
  };
  const queue = cases.slice();
  await Promise.all(Array.from({ length: 8 }, async () => { while (queue.length) await one((queue.shift() as string[])); })); // the queue is not empty inside the loop
  assert.deepEqual(bad, [], `${bad.length} of ${cases.length}:\n${bad.join('\n')}`);
  assert.ok(failed >= FAILURES.length, 'the failure cases really failed');
});

test('an empty answer is an envelope with empty lines: findings of a plan with no findings, card --if-present with no index', async () => {
  const r = await run(FIXTURE, ['findings', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).data, { lines: [] });
  const c = await run(EMPTY, ['card', '--if-present', '--json']);
  assert.deepEqual([c.status, JSON.parse(c.stdout).data, c.stderr], [0, { lines: [] }, '']);
  const u = await run(FIXTURE, ['nope', '--json']); // an unknown command: cmd is null (never the untrusted name), the error stays on stderr
  assert.equal(u.status, 2);
  assert.deepEqual(JSON.parse(u.stdout), { v: 2, cmd: null, ok: false, exit: 2, data: { lines: [] }, fresh: null, next: [] });
  assert.match(u.stderr, /^error: unknown command nope/);
  const t = await run(FIXTURE, ['findings']); // the text output of an empty answer stays empty
  assert.deepEqual([t.status, t.stdout], [0, '']);
});
