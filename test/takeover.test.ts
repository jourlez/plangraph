// `takeover` on a scripted project: git history, CODEOWNERS, an ADR folder, a requirements document, one superpowers plan and recorded fetch fixtures
// served by an injected runner (ctx.fetchDeps). No network, no gh, no process but git.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeContext } from '../src/context.ts';
import { commands } from '../src/commands/takeover.ts';
import { makeRepo, ANA, BEN } from './helpers/gitrepo.ts';
import { trust } from '../lib/fetch/trust.ts';
import { readNodeKind } from '../lib/ingest/write.ts';
import { openStore } from '../lib/planstore.ts';
import { loadExtras } from '../lib/extras.ts';
import type { Runner } from '../lib/fetch/gh.ts';

const bases: string[] = [];
after(() => { for (const b of bases) fs.rmSync(b, { recursive: true, force: true }); });
const fx = (...p: string[]): string => fs.readFileSync(new URL(`./fixtures/${p.join('/')}`, import.meta.url), 'utf8');
const NOW = new Date('2023-12-20T00:00:00Z');

const jiraPages = (): Runner => {
  const pages = ['jira-p1.http', 'jira-p2.http'].map((n) => fx('fetch', n)); let i = 0;
  return async () => ({ code: 0, out: pages[Math.min(i++, pages.length - 1)] as string, err: '' });
};
const offline: Runner = async () => ({ code: 1, out: '', err: 'network unreachable' });
/** A tracker of `n` tickets served 100 per page (the shape of the recorded jira fixtures). */
const bigTracker = (n: number): Runner => async (argv) => {
  const q = new URLSearchParams((argv.at(-1) ?? '').split('?')[1] ?? ''), at = Number((q.get('nextPageToken') ?? 'p0').slice(1)), from = at * 100;
  const issues = Array.from({ length: Math.min(100, n - from) }, (_, k) => ({ key: `BIG-${from + k + 1}`, fields: { summary: `Issue ${from + k + 1}`, status: { name: 'To Do' }, updated: '2026-11-01T10:00:00.000+0000', issuelinks: [] } }));
  const last = from + 100 >= n;
  return { code: 0, out: `HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ issues, ...(last ? {} : { nextPageToken: `p${at + 1}` }), isLast: last })}`, err: '' };
};

interface Opts { runner?: Runner; config?: object; shallow?: boolean }
function project({ runner = jiraPages(), config = {}, shallow = false }: Opts = {}) {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-takeover-'))); bases.push(parent);
  const root = path.join(parent, 'widgets');
  const repo = makeRepo({ dir: root });
  repo.commit({ who: ANA, message: 'ABC-1 add api', files: {
    'package.json': JSON.stringify({ name: 'widgets', scripts: { test: 'node --test' }, dependencies: { express: '^4.0.0' } }, null, 2),
    'CODEOWNERS': 'src/api/ @team-api\n',
    'src/api/handler.ts': 'export const a = 1;\n', 'src/core/store.ts': 'export const s = 1;\n',
    'docs/adr/0001-use-postgres.md': '---\nstatus: accepted\ndate: 2024-03-02\naffects: [src/api/**, gone/**]\n---\n# 1. Use PostgreSQL\n\n## Decision\n\nWe use PostgreSQL.\n',
    'docs/requirements.md': fx('ingest', 'requirements.md'),
    'docs/superpowers/plans/2026-11-20-widget-export.md': fx('superpowers', 'plans', '2026-11-20-widget-export.md'),
  } });
  for (let i = 0; i < 6; i++) repo.commit({ who: i % 2 ? BEN : ANA, message: `ABC-${(i % 3) + 1} change ${i}`, files: { 'src/api/handler.ts': `export const a = ${i + 2};\n`, 'src/core/store.ts': `export const s = ${i + 2};\n` } });
  if (shallow) { // a clone with its history cut off: .git/shallow names the cut commit
    const head = repo.git('rev-parse', 'HEAD').trim();
    fs.writeFileSync(path.join(root, '.git', 'shallow'), `${head}\n`);
  }
  const dir = path.join(root, '.plangraph'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ jira: { tenant: 'acme', jql: 'project = ABC' }, ...config }));
  trust(dir, 'jira:cloud-1234');
  const out: string[] = [], err: string[] = [], data: unknown[] = [];
  const hooks: { afterStep?: (s: string) => void } = {};
  const fetchDeps = { github: () => offline, atlassian: { tenant: () => 'cloud-1234', runner: async () => runner } };
  const ctx = { ...makeContext({ cwd: root, env: process.env, now: () => NOW, io: { out: (l) => out.push(l), err: (l) => err.push(l), data: (d) => data.push(d) } }), fetchDeps, takeoverHooks: hooks } as never;
  const go = (values: object = {}) => (commands.takeover as { run: (c: never, a: never) => Promise<number> }).run(ctx, { values, positionals: [] } as never);
  const state = () => JSON.parse(fs.readFileSync(path.join(dir, 'cache', 'takeover.json'), 'utf8')) as { done: string[]; failed: { step: string; reason: string }[]; questions: { id: string; text: string }[]; skipped?: { step: string; reason: string }[]; capped?: boolean };
  return { root, dir, ctx, out, err, data, hooks, go, state, repo };
}

const snapshot = (root: string): Map<string, string> => {
  const m = new Map<string, string>();
  const walk = (d: string): void => { for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = path.join(d, e.name), rel = path.relative(root, p).split(path.sep).join('/');
    if (rel === '.git' || rel.startsWith('.plangraph/.txn')) continue;
    if (e.isDirectory()) walk(p); else m.set(rel, crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'));
  } };
  walk(root); return m;
};

test('takeover is a writer command named takeover with no positionals', () => {
  assert.equal(commands.takeover?.writes, 'text');
  assert.equal(commands.takeover?.guard, 'strict');
  assert.deepEqual(commands.takeover?.positionals, [0, 0]);
});

test('a full run: stack facts, module facts, decisions, requirements, a plan with links and a map under its bound', async () => {
  const p = project();
  assert.equal(await p.go(), 0, p.out.join('\n'));
  const s = p.state();
  assert.deepEqual(s.failed, [], p.out.join('\n'));
  assert.deepEqual(s.done, ['detect', 'scan', 'history', 'docs', 'plans', 'fetch', 'links', 'identities', 'build', 'check', 'map', 'docs-build', 'report']);
  assert.equal(fs.statSync(path.join(p.dir, 'cache', 'takeover.json')).mode & 0o777, 0o600);
  const x = loadExtras(p.ctx);
  const repo = x.repos.find((r) => r.id === 'repo:widgets');
  assert.ok(repo, 'a repo row with the stack facts');
  assert.ok(repo.stack.length > 0 || repo.pm, JSON.stringify(repo));
  assert.ok(x.modules.some((m) => m.path === 'src/api/handler.ts'), 'module facts');
  assert.equal(readNodeKind(p.ctx, 'decision').length, 1);
  assert.ok(readNodeKind(p.ctx, 'requirement').length >= 4);
  assert.ok(openStore(p.ctx).readKind('ticket', { defaults: false }).length > 0, 'the plan became tickets');
  assert.ok(fs.existsSync(path.join(p.root, 'docs', 'plangraph')), 'docs.out written');
  assert.ok(fs.existsSync(path.join(p.dir, 'cache', 'jira.jsonl')), 'tracker history stays in cache/');
  const d = p.data.at(-1) as { gaps: string[]; questions: { id: string }[] };
  assert.ok(d.gaps.some((g) => g.startsWith('requirements without tasks')), d.gaps.join('|'));
  assert.ok(d.gaps.some((g) => g.startsWith('decisions with dangling affects')), d.gaps.join('|'));
  assert.ok(!d.gaps.includes('no CODEOWNERS'));
  assert.ok(d.questions.some((q) => q.id.startsWith('identity:')), 'the tracker assignee needs an owner confirmation');
});

test('a re-run changes nothing: every file is byte-equal', async () => {
  const p = project();
  await p.go();
  const before = snapshot(p.root);
  assert.equal(await p.go(), 0);
  assert.deepEqual([...snapshot(p.root)], [...before]);
  // every step again, from the first: still byte-equal (no random names, no build timestamps)
  assert.equal(await p.go({ from: 'detect' }), 0);
  const after = snapshot(p.root);
  for (const [f, h] of before) if (!f.endsWith('.sqlite')) assert.equal(after.get(f), h, f);
  assert.deepEqual([...after.keys()], [...before.keys()]);
});

test('a run killed after history resumes at the next step', async () => {
  const p = project();
  p.hooks.afterStep = (s) => { if (s === 'history') throw new Error('killed'); };
  await assert.rejects(p.go(), /killed/);
  assert.deepEqual(p.state().done, ['detect', 'scan', 'history']);
  assert.ok(fs.existsSync(path.join(p.dir, 'cache', 'git.jsonl')));
  p.hooks.afterStep = (s) => { p.out.push(`ran ${s}`); };
  p.out.length = 0;
  assert.equal(await p.go(), 0);
  const ran = p.out.filter((l) => l.startsWith('ran ')).map((l) => l.slice(4));
  assert.equal(ran[0], 'docs');
  assert.ok(!ran.includes('detect') && !ran.includes('scan') && !ran.includes('history'));
  assert.equal(p.state().done.at(-1), 'report');
});

test('--from reruns from the named step; --skip leaves a step out', async () => {
  const p = project();
  await p.go({ skip: ['docs-build'] });
  assert.ok(!fs.existsSync(path.join(p.root, 'docs', 'plangraph')));
  assert.ok(!p.state().done.includes('docs-build'));
  p.out.length = 0;
  await p.go({ from: 'docs-build' });
  assert.ok(p.state().done.includes('docs-build'));
  assert.ok(fs.existsSync(path.join(p.root, 'docs', 'plangraph')));
});

test('with no network fetch is recorded as skipped and the rest completes', async () => {
  const p = project({ runner: offline });
  assert.equal(await p.go(), 0);
  const s = p.state();
  assert.deepEqual(s.failed, [], p.out.join('\n'));
  assert.ok(s.skipped?.some((x) => x.step === 'fetch'));
  assert.ok(s.done.includes('map') && s.done.includes('report'));
  assert.ok(!fs.existsSync(path.join(p.dir, 'cache', 'jira.jsonl')));
  const d = p.data.at(-1) as { gaps: string[]; questions: { id: string }[] };
  assert.ok(d.gaps.includes('no tracker access'));
  assert.ok(d.questions.some((q) => q.id === 'tracker-access'));
});

test('--no-fetch skips the tracker without a request', async () => {
  let calls = 0;
  const p = project({ runner: async () => { calls++; return { code: 1, out: '', err: '' }; } });
  await p.go({ 'no-fetch': true });
  assert.equal(calls, 0);
  assert.ok(p.state().skipped?.some((x) => x.step === 'fetch' && x.reason === 'no-fetch'));
});

test('a failed step is recorded and the later independent steps still run; a retry resumes there', async () => {
  const p = project();
  fs.chmodSync(path.join(p.root, 'docs', 'requirements.md'), 0o000); // unreadable: ingest requirements fails
  await p.go();
  const s = p.state();
  assert.deepEqual(s.failed.map((f) => f.step), ['docs']);
  assert.ok(s.done.includes('build') && s.done.includes('map'));
  assert.ok(s.done.includes('plans'));
  assert.ok(!s.done.includes('docs'));
  fs.chmodSync(path.join(p.root, 'docs', 'requirements.md'), 0o644);
  fs.writeFileSync(path.join(p.root, 'docs', 'requirements.md'), fx('ingest', 'requirements.md'));
  p.out.length = 0;
  await p.go();
  assert.deepEqual(p.state().failed, []);
  assert.ok(p.state().done.includes('docs'));
});

test('a shallow clone ends with the gap `shallow clone` and no module facts', async () => {
  const p = project({ shallow: true });
  assert.equal(await p.go(), 0);
  const d = p.data.at(-1) as { gaps: string[] };
  assert.ok(d.gaps.includes('shallow clone'), d.gaps.join('|'));
  assert.equal(loadExtras(p.ctx).modules.length, 0);
  assert.ok(p.state().skipped?.some((x) => x.step === 'history'));
  assert.ok(p.state().done.includes('report'));
});

test('the gap report is deterministic, sorted and lists the unknowns', async () => {
  const a = project(), b = project();
  await a.go(); await b.go();
  assert.deepEqual((a.data.at(-1) as { gaps: string[] }).gaps, (b.data.at(-1) as { gaps: string[] }).gaps);
  const gaps = (a.data.at(-1) as { gaps: string[] }).gaps;
  assert.deepEqual(gaps, [...gaps].sort());
  assert.deepEqual(a.out.filter((l) => l.startsWith('- ')), gaps.map((g) => `- ${g}`));
  assert.ok(gaps.some((g) => g.startsWith('unmapped authors')), gaps.join('|'));
  const noOwners = project(); fs.rmSync(path.join(noOwners.root, 'CODEOWNERS')); noOwners.repo.git('add', '-A');
  await noOwners.go();
  assert.ok((noOwners.data.at(-1) as { gaps: string[] }).gaps.includes('no CODEOWNERS'));
});

test('the run writes only inside the plan directory, cache/ and docs.out (plus the docs.out ignore line)', async () => {
  const p = project();
  const before = snapshot(p.root);
  await p.go();
  const after = snapshot(p.root);
  for (const [f, h] of after) {
    if (before.get(f) === h) continue;
    assert.ok(f.startsWith('.plangraph/') || f.startsWith('docs/plangraph/') || f === '.gitignore', `unexpected write: ${f}`);
  }
  for (const f of before.keys()) assert.ok(after.has(f), `removed: ${f}`);
  assert.deepEqual(fs.readdirSync(path.join(p.root, '.plangraph', '.txn')).filter((n) => n !== 'lock'), [], 'no transaction left behind');
});

test('a tracker larger than the fetch caps is capped, reported, and the run completes', async () => {
  const p = project({ runner: bigTracker(1200), config: { fetch: { max_items: 300 } } });
  assert.equal(await p.go(), 0, p.out.join('\n'));
  assert.equal(p.state().capped, true);
  assert.ok((p.data.at(-1) as { gaps: string[] }).gaps.includes('tracker history beyond the fetch caps'));
  assert.ok(p.state().done.includes('report'));
  assert.equal(openStore(p.ctx).readKind('ticket', { defaults: false }).some((t) => String(t.key).startsWith('BIG-')), false, 'tracker history never becomes committed nodes');
});

test('a 20,000-ticket tracker is capped, reported and still completes', { skip: !process.env.CI_SLOW }, async () => {
  const p = project({ runner: bigTracker(20000), config: { fetch: { max_items: 5000 } } });
  assert.equal(await p.go(), 0);
  assert.equal(p.state().capped, true);
  assert.ok((p.data.at(-1) as { gaps: string[] }).gaps.includes('tracker history beyond the fetch caps'));
  assert.ok(p.state().done.includes('report'));
});
