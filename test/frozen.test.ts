// lib/frozen.ts is THE frozen predicate (review I2): verify, whatif (STARTED, proposeMove's pinned set), relieve and the solver read the
// same rule. The solver's Python mirror (bin/plangraph-solve prepare: pr.closed, pr.frozen, pr.live) is compared with it on a grid of every
// status x impl_status x config (closed_statuses, frozen_statuses, frozen_before_sprint) x current sprint x --freeze, sp: keys included.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildModel } from '../lib/model.ts';
import type { Ticket } from '../lib/model.ts';
import { isClosed, frozenTest, linkBinds } from '../lib/frozen.ts';
import { whatif, proposeMove, relieve } from '../lib/whatif.ts';

const SOLVE = path.join(import.meta.dirname, '..', 'bin', 'plangraph-solve');
const HAVE_PY3 = spawnSync('python3', ['--version'], { stdio: 'ignore' }).status === 0;
const PY = `
import importlib.machinery, importlib.util, json, sys, types
loader = importlib.machinery.SourceFileLoader('brain_solve', sys.argv[1]); spec = importlib.util.spec_from_loader('brain_solve', loader)
m = importlib.util.module_from_spec(spec); loader.exec_module(m)
out = []
for case in json.load(sys.stdin):
    A = types.SimpleNamespace(baseline='current', freeze=','.join(case['freeze']), freeze_file=None, end=9, balance=False)
    pr = m.prepare(A, case['tickets'], [tuple(e) for e in case['edges']], {'current': {k: tuple(v) for k, v in case['cur'].items()}}, case['cfg'])
    out.append([sorted(pr.T[i] for i in pr.closed), sorted(pr.T[i] for i in pr.frozen), sorted([pr.T[c], pr.T[p]] for c, p in pr.live)])
print(json.dumps(out))
`;

test('the Python mirror (bin/plangraph-solve prepare) and lib/frozen.ts agree on closed, frozen and the links that bind, on a grid', { skip: HAVE_PY3 ? false : 'skipped: no python3' }, () => {
  const cases: Array<{ cfg: unknown; [k: string]: unknown }> = [], want: Array<[string[], string[], string[][]]> = [];
  for (const closed_statuses of [undefined, ['Closed']]) for (const frozen_statuses of [undefined, [], ['In Progress']]) for (const fb of [undefined, 2]) {
    const cfg = { first_sprint: 1, end_sprint: 9, caps: { default: 99 }, ...(closed_statuses ? { closed_statuses } : {}), ...(frozen_statuses ? { frozen_statuses } : {}), ...(fb !== undefined ? { frozen_before_sprint: fb } : {}) };
    const tickets: Ticket[] = [], cur: Record<string, [string, number]> = {}, freeze: string[] = [];
    let n = 0;
    for (const sp of [false, true]) for (const st of [undefined, 'To Do', 'In Progress', 'Done', 'Closed']) for (const impl of [undefined, 'todo', 'done'] as const) for (const s of [1, 2, 3]) for (const fz of [false, true]) { // literal statuses (ImplStatus)
      const key = `${sp ? 'sp:p/' : 'K-'}${String(++n).padStart(3, '0')}`;
      tickets.push({ key, sp: 1, v2_owner: 'Ana', v2_sprint: s, ...(st ? { jira_status: st } : {}), ...(impl ? { impl_status: impl } : {}) });
      cur[key] = ['Ana', s]; if (fz) freeze.push(key);
    }
    const keys = tickets.map((t) => t.key), edges: Array<[string, string, string]> = [];
    for (let c = 0; c < keys.length; c++) for (let p = 0; p < c; p++) if ((c * 7 + p * 3) % 11 === 0) edges.push([keys[c], keys[p], 'plan_need']);
    const model = buildModel({ tickets, edges: edges.map(([consumer, producer, kind]) => ({ consumer, producer, kind })), schedule: keys.map((key) => ({ key, owner: 'Ana', sprint: cur[key][1] })), config: cfg });
    const frozen = frozenTest(model, { frozen: new Set(freeze) });
    cases.push({ tickets, edges, cur, cfg, freeze });
    want.push([keys.filter((k) => isClosed(model, k)).sort(), keys.filter(frozen).sort(), edges.filter(([c, p]) => linkBinds(model, frozen, c, p)).map(([c, p]) => [c, p]).sort()]);
  }
  const r = spawnSync('python3', ['-I', '-c', PY, SOLVE], { input: JSON.stringify(cases), encoding: 'utf8', timeout: 120000, maxBuffer: 1 << 26 });
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout);
  assert.equal(got.length, want.length);
  for (let i = 0; i < want.length; i++) assert.deepEqual(got[i], want[i], `config ${JSON.stringify(cases[i].cfg)}`);
  assert.ok(want.some((w) => w[0].some((k) => k.startsWith('sp:'))) && want.some((w) => w[1].length > w[0].length), 'the grid exercises sp: tasks and frozen-but-open tickets');
});

// Repro of review I2: first_sprint 2, frozen_before_sprint 3, Z-1 (To Do) in Ben S2 is frozen by its sprint.
const fbModel = () => buildModel({
  tickets: [{ key: 'Z-1', sp: 2, jira_status: 'To Do' }, { key: 'Y-1', sp: 1, jira_status: 'To Do' }],
  schedule: [{ key: 'Z-1', owner: 'Ben', sprint: 2 }, { key: 'Y-1', owner: 'Ben', sprint: 3 }],
  config: { first_sprint: 2, end_sprint: 5, caps: { default: 2 }, frozen_before_sprint: 3 },
});
test('repro I2: a ticket frozen by frozen_before_sprint is a hard STARTED stop in whatif, and proposeMove never plans to move it', () => {
  const w = whatif(fbModel(), { key: 'Z-1', sprint: 4 });
  assert.equal(w.ok, false);
  assert.deepEqual(w.reasons.map((r) => [r.code, r.warn ?? false]), [['STARTED', false]]);
  assert.match(w.reasons[0].detail, /sprint 2 is before frozen_before_sprint 3/);
  // Y-1 into Ben S2 overloads the cell (3/2); the only repair would move Z-1, which is frozen: no plan moves it
  const pm = proposeMove(fbModel(), { key: 'Y-1', sprint: 2 }, {});
  assert.ok(!pm.ok || pm.moves.every((m) => m.key !== 'Z-1'), JSON.stringify(pm.moves));
  assert.equal(pm.ok, false);
  for (const o of [{ allowSlip: true }, { allowEarlier: true, allowOwnerChange: true, allowSlip: true }]) {
    const p = proposeMove(fbModel(), { key: 'Y-1', sprint: 2 }, o);
    assert.ok(p.moves.every((m) => m.key !== 'Z-1'), JSON.stringify(p.moves));
  }
});
test('relieve and proposeMove pin the same tickets as verify: an sp: task with impl_status done, frozen_statuses, frozen_before_sprint', () => {
  const m = buildModel({
    tickets: [{ key: 'sp:p/1', sp: 1, impl_status: 'done' }, { key: 'A-1', sp: 1, jira_status: 'Blocked' }, { key: 'A-2', sp: 1, jira_status: 'To Do' }],
    schedule: [{ key: 'sp:p/1', owner: 'Ana', sprint: 2 }, { key: 'A-1', owner: 'Ana', sprint: 2 }, { key: 'A-2', owner: 'Ana', sprint: 2 }],
    config: { first_sprint: 1, end_sprint: 4, caps: { default: 1 }, frozen_statuses: ['Blocked'] },
  });
  const r = relieve(m, { person: 'Ana', sprint: 2 });
  assert.deepEqual(r.excluded.map((x) => x.key), ['A-1', 'sp:p/1']);
  const w = whatif(m, { key: 'sp:p/1', sprint: 3 }, { noSuggest: true });
  assert.deepEqual(w.reasons.map((x) => [x.code, x.warn ?? false]), [['STARTED', false]]);
});

// Review M2: `plangraph init` writes frozen_statuses ["Done"]. In Progress always warns in whatif (STARTED, warn; a stop only under --strict),
// whatever frozen_statuses says; verify, the solver, proposeMove and relieve freeze only what config lists.
test('In Progress always gives the STARTED warning in whatif, whatever frozen_statuses says; only a listed status is frozen', () => {
  for (const fs of [undefined, [], ['Done'], ['In Progress']]) {
    const m = buildModel({
      tickets: [{ key: 'I-1', sp: 1, jira_status: 'In Progress' }, { key: 'C-1', sp: 1, jira_status: 'To Do' }], edges: [{ consumer: 'C-1', producer: 'I-1', kind: 'x' }],
      schedule: [{ key: 'I-1', owner: 'Ana', sprint: 2 }, { key: 'C-1', owner: 'Ana', sprint: 2 }],
      config: { first_sprint: 1, end_sprint: 4, caps: { default: 9 }, ...(fs ? { frozen_statuses: fs } : {}) },
    });
    const w = whatif(m, { key: 'I-1', sprint: 1 }, { noSuggest: true });
    assert.deepEqual([w.ok, w.started, w.reasons.map((r) => [r.code, r.warn])], [true, true, [['STARTED', true]]], `frozen_statuses ${JSON.stringify(fs)}`);
    assert.equal(whatif(m, { key: 'I-1', sprint: 1 }, { noSuggest: true, strict: true }).ok, false);
    const listed = Array.isArray(fs) && fs.includes('In Progress');
    assert.equal(frozenTest(m)('I-1'), listed);
    // a repair may move I-1 only when it is not listed
    const pm = proposeMove(m, { key: 'C-1', sprint: 1 }, { allowEarlier: true });
    assert.equal(pm.ok, !listed, `frozen_statuses ${JSON.stringify(fs)}: ${JSON.stringify(pm.moves)}`);
  }
});
