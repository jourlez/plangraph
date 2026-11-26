// The tests 0.4.0 Task 4 left out (docs/audit/0.4.0-audit.md, Known gaps): the blocker-reading commands answer what the frozen 0.3.0 runtime
// answers on generated plans, the depth bound of `neighbors`, a 25-hop `chain`, MCP `ticket` text equal to the CLI text, the cycle error,
// `person` and `sprint` with schedule versions, and the blocker source built once per readySet call.
// NOT covered: timing (test/blockers-one-timing.test.ts), the index-versus-model equivalence (test/blockers-one.test.ts).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { genPlan } from './fixtures/gen.ts';
import { createServer, serve } from '../src/mcp.ts';
import { buildModel } from '../lib/model.ts';
import type { Edge, PlanRecord, ScheduleRow, Ticket } from '../lib/model.ts';
import { readySet } from '../lib/ready.ts';
import { sourceFactory } from '../lib/graph/blockers.ts';

const ROOT = path.join(import.meta.dirname, '..');
const FROZEN = path.join(import.meta.dirname, 'fixtures/release-0.3.0');
const tmps: string[] = [];
after(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });
const jl = (rows: readonly object[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
const ENV = { PATH: process.env.PATH, HOME: os.tmpdir(), LC_ALL: 'C', TZ: 'UTC', NO_COLOR: '1', PLANGRAPH_DIR: '', SOURCE_DATE_EPOCH: '1795305600', ...GIT_ENV };
const cli = (tree: string, cwd: string, args: string[]) => spawnSync(process.execPath, [path.join(tree, 'bin/plangraph'), ...args], { cwd, encoding: 'utf8', env: { ...ENV, CLAUDE_PLUGIN_DATA: path.join(cwd, '.data') }, timeout: 60000 });
type Plan = { tickets: object[]; edges: object[]; schedule: object[]; config: object; findings?: object[] };

/** A git repository with the plan written and built by the runtime in `tree`. */
function repo(tree: string, p: Plan): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'blockers-more-'))); tmps.push(d);
  spawnSync('git', ['init', '-q'], { cwd: d, env: { ...process.env, ...GIT_ENV } });
  assert.equal(cli(tree, d, ['init']).status, 0);
  const b = path.join(d, '.plangraph');
  fs.writeFileSync(path.join(b, 'tickets.jsonl'), jl(p.tickets)); fs.writeFileSync(path.join(b, 'edges.jsonl'), jl(p.edges)); fs.writeFileSync(path.join(b, 'schedule.jsonl'), jl(p.schedule));
  fs.writeFileSync(path.join(b, 'config.json'), JSON.stringify(p.config)); if (p.findings) fs.writeFileSync(path.join(b, 'findings.jsonl'), jl(p.findings));
  const r = cli(tree, d, ['build']); assert.equal(r.status, 0, r.stderr);
  return d;
}
const chainPlan = (n: number, cycle = false): Plan => ({
  tickets: Array.from({ length: n }, (_, i) => ({ key: `C-${i}`, summary: `s${i}`, epic: '', sp: 1, jira_status: 'To Do', verdict: 'READY' })),
  edges: [...Array.from({ length: n - 1 }, (_, i) => ({ consumer: `C-${i + 1}`, producer: `C-${i}`, kind: 'plan_need' })), ...(cycle ? [{ consumer: 'C-0', producer: `C-${n - 1}`, kind: 'plan_need' }] : [])],
  schedule: Array.from({ length: n }, (_, i) => ({ version: 'current', key: `C-${i}`, owner: 'Ana', sprint: 1 })),
  config: { first_sprint: 1, end_sprint: 3, caps: { default: 999 }, min_per_sprint: {}, ignore_link_kinds: [] },
});

// ---------- equal to the frozen 0.3.0 runtime on every generated plan ----------
const PLANS: Array<[string, number, number, number]> = [['small', 12, 2, 3], ['wide', 40, 3, 7], ['deep', 25, 2, 11]];
for (const [name, n, people, seed] of PLANS) {
  test(`blockers, ready, ticket, neighbors, chain, person and sprint equal the frozen 0.3.0 output on the ${name} plan`, () => {
    const g = genPlan({ n, people, seed, cap: 99 });
    g.tickets[0].verdict = 'BLOCKED'; g.tickets[1].verdict = 'STALE'; g.tickets[2].jira_status = 'Done';
    const p: Plan = { ...g, findings: [{ key: 'T-4', kind: 'risk', text: 'needs a decision' }, { key: 'T-5', kind: 'question', text: 'who owns it?' }] };
    const old = repo(FROZEN, p), now = repo(ROOT, p);
    const probes: string[][] = [['blockers'], ['blockers', '-v'], ['ready', '--person', 'Ana'], ['ready', '--sprint', '1'], ['sprint', '1'], ['person', 'Ana'], ['person', 'Ben'], ['neighbors', 'T-6', '0'], ['neighbors', 'T-6', '3'], ['neighbors', 'T-6', '50']];
    for (const k of [1, 3, 4, 5, 6, n]) probes.push(['ready', `T-${k}`], ['ticket', `T-${k}`, '-v'], ['chain', `T-${k}`]);
    for (const a of probes) {
      const x = cli(FROZEN, old, a), y = cli(ROOT, now, a);
      assert.deepEqual([y.status, y.stdout, y.stderr], [x.status, x.stdout, x.stderr], a.join(' '));
    }
  });
}

// ---------- neighbors depth ----------
test('neighbors accepts depth 0, 21 and 50 and refuses 51 (and a non-number) with the documented message; there is no clamp', () => {
  const d = repo(ROOT, chainPlan(60));
  for (const depth of ['0', '21', '50']) {
    const r = cli(ROOT, d, ['neighbors', 'C-30', depth]);
    assert.equal(r.status, 0, `${depth}: ${r.stderr}`);
    const [needs, by] = r.stdout.trimEnd().split('\n'), want = Math.min(Number(depth), 30), wantBy = Math.min(Number(depth), 29);
    assert.match(needs as string, new RegExp(`^C-30 needs \\(${want}\\):`), `depth ${depth} needs`);
    assert.match(by as string, new RegExp(`^C-30 is needed by \\(${wantBy}\\):`), `depth ${depth} needed by`);
  }
  for (const depth of ['51', '1000', 'x']) {
    const r = cli(ROOT, d, ['neighbors', 'C-30', depth]);
    assert.notEqual(r.status, 0, depth);
    assert.match(r.stderr, /depth must be a whole number from 0 to 50/, depth);
    assert.equal(r.stdout, '');
  }
});

// ---------- chain ----------
test('a 25-hop chain is complete: 25 hops, 26 tickets, the elided middle counted exactly, the same text as 0.3.0', () => {
  const d = repo(ROOT, chainPlan(26));
  const r = cli(ROOT, d, ['chain', 'C-25']);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trimEnd().split('\n');
  assert.equal(lines[0], 'longest chain behind C-25: 25 hops, 0 handoffs, 1 critical path');
  assert.deepEqual(lines.slice(1).map((l) => l.trim().split(' ')[0]), ['C-0', 'C-1', 'C-2', 'C-3', 'C-4', '...', 'C-21', 'C-22', 'C-23', 'C-24', 'C-25'], 'five from each end');
  assert.equal(lines[6], '  ... 16 more', '26 tickets, 10 shown, 16 counted');
  const old = cli(FROZEN, repo(FROZEN, chainPlan(26)), ['chain', 'C-25']);
  assert.equal(r.stdout, old.stdout);
});

test('a dependency cycle gives the cycle error from chain', () => {
  const d = repo(ROOT, chainPlan(4, true));
  const r = cli(ROOT, d, ['chain', 'C-3']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /dependency cycle: C-\d is needed by C-\d and also needs it/);
  assert.equal(r.stdout, '');
});

// ---------- person and sprint with schedule versions ----------
test('person and sprint read the current schedule version only: a v2 row neither adds nor moves a ticket', () => {
  const p = chainPlan(6); p.schedule.push({ version: 'v2', key: 'C-0', owner: 'Ben', sprint: 2 }, { version: 'v2', key: 'C-1', owner: 'Ben', sprint: 2 });
  const d = repo(ROOT, p), old = repo(FROZEN, p);
  const ben = cli(ROOT, d, ['person', 'Ben']), s2 = cli(ROOT, d, ['sprint', '2']), ana = cli(ROOT, d, ['person', 'Ana']), s1 = cli(ROOT, d, ['sprint', '1']);
  assert.doesNotMatch(ben.stdout + s2.stdout, /Ben: \d|S2: \d/, 'a v2 placement is not shown');
  assert.match(ana.stdout, /total 6 SP in 1 sprints/); assert.match(s1.stdout, /Ana: 6 SP \/ cap 999 \(6 tickets\)/);
  for (const a of [['person', 'Ben'], ['person', 'Ana'], ['sprint', '1'], ['sprint', '2'], ['ticket', 'C-0']]) {
    const x = cli(FROZEN, old, a), y = cli(ROOT, d, a);
    assert.deepEqual([y.status, y.stdout, y.stderr], [x.status, x.stdout, x.stderr], a.join(' '));
  }
});

// ---------- MCP ticket text equals the CLI text ----------
test('the MCP ticket tool returns the text of `plangraph ticket`, plain and verbose, and for a missing ticket', async () => {
  const g = genPlan({ n: 20, people: 2, seed: 5, cap: 99 });
  const d = repo(ROOT, { ...g, findings: [{ key: 'T-3', kind: 'risk', text: 'needs a decision' }] });
  const server = createServer({ env: { ...ENV, CLAUDE_PLUGIN_DATA: path.join(d, '.data') }, cwd: d });
  const msg = (id: number, method: string, params: unknown) => JSON.stringify({ jsonrpc: '2.0', id, method, params });
  const cases: Array<[Record<string, unknown>, string[]]> = [[{ key: 'T-3' }, ['ticket', 'T-3']], [{ key: 'T-3', verbose: true }, ['ticket', '-v', 'T-3']], [{ key: 'T-99' }, ['ticket', 'T-99']]];
  const out: string[] = [];
  async function* input() { yield Buffer.from([msg(0, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } }), ...cases.map(([a], i) => msg(i + 1, 'tools/call', { name: 'ticket', arguments: a }))].join('\n') + '\n'); }
  await serve(input(), (l) => out.push(l), server);
  const replies = out.map((l) => JSON.parse(l));
  cases.forEach(([, argv], i) => {
    const r = cli(ROOT, d, argv), want = [r.stdout, r.stderr].map((s) => s.replace(/\n$/, '')).filter(Boolean).join('\n');
    const got = replies.find((m) => m.id === i + 1).result.content[0].text;
    assert.equal(got, want, argv.join(' '));
  });
});

// ---------- built once ----------
test('readySet builds the blocker source once per call, however many tickets it answers', () => {
  const g = genPlan({ n: 30, people: 3, seed: 3, cap: 99 });
  const model = buildModel({ tickets: g.tickets as Ticket[], edges: g.edges as unknown as Edge[], schedule: g.schedule as unknown as ScheduleRow[], config: g.config, findings: [{ key: 'T-2', kind: 'risk', text: 'x' }] as PlanRecord[], evidence: [], learnings: [] });
  const real = sourceFactory.build; let built = 0;
  sourceFactory.build = (m, o) => { built++; return real(m, o); };
  try {
    const a = readySet(model); assert.equal(built, 1, 'one source for 30 tickets');
    readySet(model, [], null, { keys: ['T-1', 'T-2'] }); assert.equal(built, 2, 'one more for the next call');
    assert.equal(a.ready.length + a.done.length + a.blocked.length + a.waiting.length + a.verdict.length > 0, true);
  } finally { sourceFactory.build = real; }
});
