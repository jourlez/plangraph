// Relieve: `brain whatif --relieve PERSON --sprint N` (dry run, read-only) lists the smallest valid set of single-ticket moves of that
// cell's tickets that brings the person's load in sprint N to <= cap without any new violation, chosen by the documented rule (fewest
// tickets moved, then least total sprint slip, then fewest owner changes, then key order), each set verified with verifyPlan, printed
// with the exact `brain whatif` dry-run command of each move in an order where each one passes `brain whatif` alone.
// Asserted here: exact text and --json of relief / nothing to relieve / no relief (with reasons), the flags, the apply order, the budget
// message, determinism, usage errors with their try lines, and that the index and the text files are byte-identical after every run.
// Not covered here: minimality and validity on every small instance against a clean-room brute force (test/assure/relieve.assure.ts),
// hostile names (test/hostile-fuzz.test.ts), moves of tickets outside the cell (not in the move space by design).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { buildModel } from '../lib/model.ts';
import { relieve, renderRelieve } from '../lib/whatif.ts';

const ROOT = path.join(import.meta.dirname, '..'), BRAIN = path.join(ROOT, 'bin/brain');
let BASE = '', REPO = '';
const GIT = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const env = () => ({ PATH: process.env.PATH, HOME: path.join(BASE, 'home'), CLAUDE_PLUGIN_DATA: path.join(BASE, 'data'), LC_ALL: 'C', BRAIN_DIR: '', TMPDIR: BASE, BRAIN_STRICT_OUT: '1', ...GIT });
const run = (...a: string[]) => spawnSync(process.execPath, [BRAIN, ...a], { cwd: REPO, env: env(), encoding: 'utf8', timeout: 60000 });
const jl = (rows: readonly unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const T = (key: string, sp: number, o: Record<string, unknown> = {}) => ({ key, sp, jira_status: 'To Do', verdict: 'READY', ...o });
// Ana S2 is 8/5: K-1 (3) can only go to S4 (S3 would be 6/5), K-2 feeds Ben S3 so it cannot slip, K-3 is In Progress, K-4 (1) fits S3.
// Cleo S1 is 4/2: the In Progress C-1 (3) alone fills it, so the free C-2 (1) must leave, and it cannot: its consumer C-3 sits in Ben S2. Dan S1 is 2/1: D-1 must take its 0-SP consumer D-2 along (D-3 is In Progress).
const TICKETS = [
  T('K-1', 3), T('K-2', 2), T('K-3', 2, { jira_status: 'In Progress' }), T('K-4', 1), T('K-5', 1), T('K-6', 3),
  T('C-1', 3, { jira_status: 'In Progress' }), T('C-2', 1), T('C-3', 1), T('D-1', 1), T('D-2', 0), T('D-3', 1, { jira_status: 'In Progress' }),
];
const PLACE: Record<string, [string, number]> = { 'K-1': ['Ana', 2], 'K-2': ['Ana', 2], 'K-3': ['Ana', 2], 'K-4': ['Ana', 2], 'K-5': ['Ben', 3], 'K-6': ['Ana', 3], 'C-1': ['Cleo', 1], 'C-2': ['Cleo', 1], 'C-3': ['Ben', 2], 'D-1': ['Dan', 1], 'D-2': ['Dan', 1], 'D-3': ['Dan', 1] };
const SCHEDULE = Object.entries(PLACE).map(([key, [owner, sprint]]) => ({ version: 'current', key, owner, sprint }));
const EDGES = [{ consumer: 'K-5', producer: 'K-2', kind: 'code' }, { consumer: 'D-2', producer: 'D-1', kind: 'code' }, { consumer: 'C-3', producer: 'C-2', kind: 'code' }];
const CONFIG = { first_sprint: 1, end_sprint: 4, caps: { default: 10, Ana: 5, Cleo: 2, Dan: 1 }, frozen_statuses: ['Done', 'In Progress'] };
const model = () => buildModel({ tickets: TICKETS, edges: EDGES, schedule: SCHEDULE, config: CONFIG });
const DRY = '(dry run, nothing changed: to apply, the owner runs each command above in this order with --apply-plan --write, then brain export)';

/** sha256 of every file under the brain directory (the index included). */
const digest = () => { const h = crypto.createHash('sha256'), dir = path.join(REPO, '.brain'); for (const f of fs.readdirSync(dir).sort()) h.update(`${f}\0`).update(fs.readFileSync(path.join(dir, f))); return h.digest('hex'); };

before(() => {
  BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-relieve-')));
  for (const d of ['home', 'data', 'repo']) fs.mkdirSync(path.join(BASE, d));
  REPO = path.join(BASE, 'repo');
  execFileSync('git', ['init', '-q'], { cwd: REPO, env: env() });
  assert.equal(run('init').status, 0);
  const B = path.join(REPO, '.brain');
  fs.writeFileSync(path.join(B, 'tickets.jsonl'), jl(TICKETS)); fs.writeFileSync(path.join(B, 'edges.jsonl'), jl(EDGES));
  fs.writeFileSync(path.join(B, 'schedule.jsonl'), jl(SCHEDULE));
  fs.writeFileSync(path.join(B, 'config.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(B, 'config.json'), 'utf8')), ...CONFIG }));
  const b = run('build'); assert.equal(b.status, 0, b.stderr);
});
after(() => { if (BASE) fs.rmSync(BASE, { recursive: true, force: true }); });

test('lib relieve: the cheapest valid set by the rule (one move, the smallest slip), verified, with the reasons of the others', () => {
  const r = relieve(model(), { person: 'Ana', sprint: 2 });
  assert.equal(r.status, 'relief');
  assert.deepEqual([r.load, r.cap, r.after, r.slip, r.ownerChanges, r.searchComplete, r.order], [8, 5, 5, 2, 0, true, 'sequential']);
  assert.deepEqual(r.moves, [{ key: 'K-1', sp: 3, from: { owner: 'Ana', sprint: 2 }, to: { owner: 'Ana', sprint: 4 } }]);
  assert.deepEqual(r.excluded, [{ key: 'K-3', code: 'FROZEN' }]);
});

test('lib relieve: owner changes only with allowOwnerChange (slip 0 beats slip 2), earlier sprints only with allowEarlier', () => {
  const oc = relieve(model(), { person: 'Ana', sprint: 2 }, { allowOwnerChange: true });
  assert.deepEqual(oc.moves, [{ key: 'K-1', sp: 3, from: { owner: 'Ana', sprint: 2 }, to: { owner: 'Ben', sprint: 2 } }]);
  assert.deepEqual([oc.slip, oc.ownerChanges], [0, 1]);
  const early = relieve(model(), { person: 'Ana', sprint: 2 }, { allowEarlier: true });
  assert.deepEqual(early.moves.map((m) => [m.key, m.to.owner, m.to.sprint]), [['K-1', 'Ana', 1]], 'S1 is one sprint away, S4 two');
});

test('lib relieve: a consumer in the same cell moves along (a 0-SP ticket included), in an order where each move passes whatif alone', () => {
  const r = relieve(model(), { person: 'Dan', sprint: 1 });
  assert.equal(r.status, 'relief');
  assert.deepEqual(r.moves.map((m) => [m.key, m.to.owner, m.to.sprint]), [['D-2', 'Dan', 2], ['D-1', 'Dan', 2]], 'the consumer first');
  assert.deepEqual([r.slip, r.order], [2, 'sequential']);
});

test('lib relieve: nothing to relieve, and no relief with its reasons (frozen tickets, nothing movable frees enough)', () => {
  assert.deepEqual(relieve(model(), { person: 'Ben', sprint: 3 }).status, 'none_needed');
  const c = relieve(model(), { person: 'Cleo', sprint: 1 });
  assert.equal(c.status, 'no_relief');
  assert.equal(c.searchComplete, true);
  assert.deepEqual(c.reasons, [{ code: 'FROZEN', keys: ['C-1'] }, { code: 'LINKS', keys: ['C-2'] }, { code: 'NOT_ENOUGH', keys: [], freeable: 0, needed: 1 }]);
});

test('lib relieve: deterministic, and the budget is reported when it is hit (never a silent partial answer)', () => {
  assert.deepEqual(relieve(model(), { person: 'Dan', sprint: 1 }), relieve(model(), { person: 'Dan', sprint: 1 }));
  const r = relieve(model(), { person: 'Dan', sprint: 1 }, { budget: 1 });
  assert.deepEqual([r.status, r.searchComplete, r.budget], ['no_relief', false, 1]);
  assert.equal(renderRelieve(r, { cmd: () => null })[0], 'NO RELIEF: Dan S1 2/1: no relief found within the search budget (1 steps); not proven impossible');
});

test('brain whatif --relieve: the moves with their exact whatif commands, then the dry-run note; exit 0; nothing written', () => {
  const before = digest();
  let r = run('whatif', '--relieve', 'Ana', '--sprint', '2');
  assert.deepEqual([r.status, r.stderr], [0, '']);
  assert.equal(r.stdout, ['RELIEF: Ana S2 8/5 -> 5/5 with 1 move (slip 2, 0 owner changes)', 'K-1 3 SP: Ana S2 > Ana S4 | brain whatif K-1 --sprint 4', DRY, ''].join('\n'));
  r = run('whatif', '--relieve', 'ana', '--sprint', '2', '--owner-change');
  assert.equal(r.stdout, ['RELIEF: Ana S2 8/5 -> 5/5 with 1 move (slip 0, 1 owner change)', 'K-1 3 SP: Ana S2 > Ben S2 | brain whatif K-1 --to Ben --sprint 2', DRY, ''].join('\n'));
  r = run('whatif', '--relieve', 'Dan', '--sprint', '1');
  assert.equal(r.stdout, ['RELIEF: Dan S1 2/1 -> 1/1 with 2 moves (slip 2, 0 owner changes)', 'D-2 0 SP: Dan S1 > Dan S2 | brain whatif D-2 --sprint 2', 'D-1 1 SP: Dan S1 > Dan S2 | brain whatif D-1 --sprint 2', DRY, ''].join('\n'));
  assert.equal(digest(), before, 'relieve never writes');
});

test('every printed command, run in order against the plan as it would be after the earlier ones, says OK', () => {
  const r = relieve(model(), { person: 'Dan', sprint: 1 });
  const dir = fs.mkdtempSync(path.join(BASE, 'apply-'));
  fs.cpSync(REPO, dir, { recursive: true });
  for (const m of r.moves) {
    const dry = spawnSync(process.execPath, [BRAIN, 'whatif', m.key, '--sprint', String(m.to.sprint)], { cwd: dir, env: env(), encoding: 'utf8' });
    assert.equal(dry.status, 0, dry.stdout);
    const w = spawnSync(process.execPath, [BRAIN, 'whatif', m.key, '--sprint', String(m.to.sprint), '--apply-plan', '--write'], { cwd: dir, env: env(), encoding: 'utf8' });
    assert.equal(w.status, 0, w.stdout + w.stderr);
  }
  const ch = spawnSync(process.execPath, [BRAIN, 'sprint', '1'], { cwd: dir, env: env(), encoding: 'utf8' });
  assert.match(ch.stdout, /^Dan: 1 SP \/ cap 1 \(1 tickets\)$/m);
});

test('nothing to relieve (exit 0) and no relief (exit 1) with the reasons and the flags to try', () => {
  let r = run('whatif', '--relieve', 'Ben', '--sprint', '3');
  assert.deepEqual([r.status, r.stdout], [0, 'OK: Ben S3 is within capacity (1/10): nothing to relieve\n']);
  r = run('whatif', '--relieve', 'Cleo', '--sprint', '1');
  assert.equal(r.status, 1);
  assert.equal(r.stdout, [
    'NO RELIEF: Cleo S1 4/2: no relief found within the allowed moves (this cell\'s tickets, later sprints, same owner)',
    '- frozen (started or closed) 1: C-1', '- every target breaks a link 1: C-2', '- the tickets that can move free 0 SP of the 1 needed',
    'try: --owner-change, or brain whatif KEY --sprint M --slip --apply-plan to shift other tickets too', ''].join('\n')); // S1 is first_sprint: no --earlier
});

test('--json: the v2 envelope with every move, its command, the rule results, and next = the commands', () => {
  const e = JSON.parse(run('whatif', '--relieve', 'Dan', '--sprint', '1', '--json').stdout);
  assert.deepEqual([e.v, e.cmd, e.ok, e.exit], [2, 'whatif', true, 0]);
  assert.deepEqual(e.data, {
    relieve: { person: 'Dan', sprint: 1 }, status: 'relief', load: 2, cap: 1, after: 1, slip: 2, ownerChanges: 0, order: 'sequential', searchComplete: true, budget: 1000000, nodes: 11,
    allowed: ['later'], moves: [
      { key: 'D-2', sp: 0, from: { owner: 'Dan', sprint: 1 }, to: { owner: 'Dan', sprint: 2 }, command: 'brain whatif D-2 --sprint 2' },
      { key: 'D-1', sp: 1, from: { owner: 'Dan', sprint: 1 }, to: { owner: 'Dan', sprint: 2 }, command: 'brain whatif D-1 --sprint 2' }],
    reasons: [],
  });
  assert.deepEqual(e.next, ['brain whatif D-2 --sprint 2', 'brain whatif D-1 --sprint 2']);
  const no = JSON.parse(run('whatif', '--relieve', 'Cleo', '--sprint', '1', '--json').stdout);
  assert.deepEqual([no.exit, no.data.status, no.data.reasons], [1, 'no_relief', [{ code: 'FROZEN', keys: ['C-1'] }, { code: 'LINKS', keys: ['C-2'] }, { code: 'NOT_ENOUGH', keys: [], freeable: 0, needed: 1 }]]);
  assert.deepEqual(no.next, ['brain whatif --relieve Cleo --sprint 1 --owner-change']);
});

test('usage errors: KEY with --relieve, no --sprint, a write or apply flag, --to, an unknown person, no KEY at all: exit 2, fixed message', () => {
  const NOT = 'error: --relieve is a dry run: --to, --apply-plan and --write are not supported (it prints the whatif command of each move)';
  const cases: Array<[string[], string, string]> = [
    [['whatif', 'K-1', '--relieve', 'Ana', '--sprint', '2'], 'error: whatif takes a KEY or --relieve NAME, not both', 'try: brain explain whatif'],
    [['whatif', '--relieve', 'Ana'], 'error: --relieve needs --sprint N', 'try: brain explain whatif'],
    [['whatif', '--relieve', 'Ana', '--sprint', '2', '--write'], NOT, 'try: brain explain whatif'],
    [['whatif', '--relieve', 'Ana', '--sprint', '2', '--apply-plan'], NOT, 'try: brain explain whatif'],
    [['whatif', '--relieve', 'Ana', '--sprint', '2', '--to', 'Ben'], NOT, 'try: brain explain whatif'],
    [['whatif', '--relieve', 'Zed\nINJECTED', '--sprint', '2'], 'error: --relieve matches no single person in the plan (exact, case-insensitive or a unique first name)', 'try: brain sprint 2'],
    [['whatif'], 'error: whatif needs a KEY, or --relieve NAME --sprint N', 'try: brain explain whatif'],
  ];
  const before = digest();
  for (const [args, err, tryLine] of cases) {
    const r = run(...args);
    assert.deepEqual([r.status, r.stdout, r.stderr], [2, '', `${err}\n${tryLine}\n`], args.join(' '));
  }
  assert.equal(digest(), before);
});

test('brain whatif KEY is unchanged', () => {
  assert.equal(run('whatif', 'K-4', '--sprint', '3').stdout, 'OK: K-4 -> Ana S3. Ana S3 4/5. Frees 1 on Ana S2.\n');
});

test('lib relieve: the rule compares across subsets: a later subset with less slip, or as much slip and fewer owner changes, wins', () => {
  const at = (pl: Record<string, [string, number]>) => Object.entries(pl).map(([key, [owner, sprint]]) => ({ key, owner, sprint }));
  // E-1 (first by key) can only leave by slipping 2 (its producer G-1 is Gus S3, so E-1 needs S4); E-2 slips 1
  let m = buildModel({ tickets: [T('E-1', 2), T('E-2', 2), T('G-1', 1)], edges: [{ consumer: 'E-1', producer: 'G-1', kind: 'code' }], schedule: at({ 'E-1': ['Eve', 2], 'E-2': ['Eve', 2], 'G-1': ['Gus', 3] }), config: { end_sprint: 4, caps: { default: 2 } } });
  assert.deepEqual(relieve(m, { person: 'Eve', sprint: 2 }).moves.map((x) => [x.key, x.to.owner, x.to.sprint]), [['E-2', 'Eve', 3]]);
  // E-1 (3 SP) does not fit Eve S3 and Ben S2 is full: Ben S3 (slip 1, 1 owner change); E-2 fits Eve S3 (slip 1, no owner change)
  m = buildModel({ tickets: [T('E-1', 3), T('E-2', 2), T('E-3', 1), T('B-1', 3)], schedule: at({ 'E-1': ['Eve', 2], 'E-2': ['Eve', 2], 'E-3': ['Eve', 3], 'B-1': ['Ben', 2] }), config: { end_sprint: 3, caps: { default: 3 } } });
  const r = relieve(m, { person: 'Eve', sprint: 2 }, { allowOwnerChange: true });
  assert.deepEqual([r.moves.map((x) => [x.key, x.to.owner, x.to.sprint]), r.slip, r.ownerChanges], [[['E-2', 'Eve', 3]], 1, 0]);
});

test('lib relieve: prototype-like person names are plain names (caps read as own properties only)', () => {
  const m = buildModel({ tickets: [T('P-1', 2), T('P-2', 2)], schedule: [{ key: 'P-1', owner: '__proto__', sprint: 1 }, { key: 'P-2', owner: '__proto__', sprint: 1 }], config: { end_sprint: 2, caps: JSON.parse('{"default": 9, "__proto__": 3, "constructor": 9}') } });
  const r = relieve(m, { person: '__proto__', sprint: 1 }, { allowOwnerChange: true });
  assert.deepEqual([r.status, r.cap, r.moves.map((x) => [x.key, x.to.owner, x.to.sprint])], ['relief', 3, [['P-1', 'constructor', 1]]]);
});
