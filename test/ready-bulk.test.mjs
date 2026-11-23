// Bulk ready: `brain ready --person NAME --sprint N` (either filter alone or both, no KEY) answers "which of these tickets can start now"
// in ONE call, from the SHARED lib/ready.mjs readySet (keys option), never a second implementation. Exact text, caps, -v, --json data,
// exit codes, usage errors and the agreement with `brain ready KEY` on every ticket of the fixture are asserted here.
// Not covered here: the exhaustive small-scope agreement with the clean-room oracle (test/assure/ready.assure.mjs, bulk family), hostile
// names (test/hostile-fuzz.test.mjs), the -v cap of 500 ready keys and the 2000-key cap of the --json lists (no fixture that large).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { buildModel } from '../lib/model.mjs';
import { readySet, readyScope } from '../lib/ready.mjs';

const ROOT = path.join(import.meta.dirname, '..'), BRAIN = path.join(ROOT, 'bin/brain');
let BASE = '', REPO = '';
const GIT = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const env = () => ({ PATH: process.env.PATH, HOME: path.join(BASE, 'home'), CLAUDE_PLUGIN_DATA: path.join(BASE, 'data'), LC_ALL: 'C', BRAIN_DIR: '', TMPDIR: BASE, BRAIN_STRICT_OUT: '1', ...GIT });
const run = (/** @type {string[]} */ ...a) => spawnSync(process.execPath, [BRAIN, ...a], { cwd: REPO, env: env(), encoding: 'utf8', timeout: 60000 });
const jl = (/** @type {any[]} */ rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const T = (/** @type {string} */ key, /** @type {Record<string, unknown>} */ o = {}) => ({ key, sp: 1, jira_status: 'To Do', verdict: 'READY', ...o });
const R30 = Array.from({ length: 30 }, (_, i) => `R-${String(i + 1).padStart(2, '0')}`);
const TICKETS = [
  T('A-1', { jira_status: 'Done' }), T('A-2', { sp: 2 }), T('A-3'), T('A-4', { verdict: 'BLOCKED' }), T('A-5'), T('A-6', { verdict: 'NEEDS_INFO' }), T('A-7'),
  T('B-1'), T('B-2'), ...R30.map((k) => T(k)),
];
const PLACE = { 'A-1': ['Ana Diaz', 1], 'A-2': ['Ana Diaz', 1], 'A-3': ['Ana Diaz', 1], 'A-4': ['Ana Diaz', 1], 'A-5': ['Ana Diaz', 1], 'A-6': ['Ana Diaz', 1], 'A-7': ['Ana Diaz', 2], 'B-1': ['Ben', 1], 'B-2': ['Ben', 2], ...Object.fromEntries(R30.map((k) => [k, ['Ben', 3]])) };
const SCHEDULE = Object.entries(PLACE).map(([key, [owner, sprint]]) => ({ version: 'current', key, owner, sprint }));
const EDGES = [{ consumer: 'A-3', producer: 'A-2', kind: 'code' }, { consumer: 'A-6', producer: 'A-2', kind: 'code' }, { consumer: 'B-2', producer: 'A-1', kind: 'code' }];
const FINDINGS = [{ key: 'A-5', kind: 'gap', text: 'missing acceptance' }];
const FRESH = '(statuses as of the last build: pass --jira snapshot.json for live ones)';

before(() => {
  BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-ready-bulk-')));
  for (const d of ['home', 'data', 'repo']) fs.mkdirSync(path.join(BASE, d));
  REPO = path.join(BASE, 'repo');
  execFileSync('git', ['init', '-q'], { cwd: REPO, env: env() });
  assert.equal(run('init').status, 0);
  const B = path.join(REPO, '.brain');
  fs.writeFileSync(path.join(B, 'tickets.jsonl'), jl(TICKETS)); fs.writeFileSync(path.join(B, 'edges.jsonl'), jl(EDGES));
  fs.writeFileSync(path.join(B, 'schedule.jsonl'), jl(SCHEDULE)); fs.writeFileSync(path.join(B, 'findings.jsonl'), jl(FINDINGS));
  fs.writeFileSync(path.join(REPO, 'snap.json'), JSON.stringify({ 'A-2': { status: 'Done' } }));
  fs.writeFileSync(path.join(REPO, 'reopened.json'), JSON.stringify({ 'A-1': { status: 'To Do' } }));
  const b = run('build'); assert.equal(b.status, 0, b.stderr);
});
after(() => { if (BASE) fs.rmSync(BASE, { recursive: true, force: true }); });

const model = () => buildModel({ tickets: TICKETS, edges: EDGES, schedule: SCHEDULE, findings: FINDINGS, config: {} });

test('readySet keys option: the same classification as the full set, restricted to the keys; verdict lists the non-READY verdicts', () => {
  const m = model(), all = readySet(m), keys = ['A-6', 'A-1', 'A-2', 'A-5', 'NOPE', 'A-2'];
  const part = readySet(m, [], null, { keys });
  const inK = (/** @type {string} */ k) => keys.includes(k);
  assert.deepEqual(part.ready, all.ready.filter(inK));
  assert.deepEqual(part.done, all.done.filter(inK));
  assert.deepEqual(part.waiting, all.waiting.filter(inK));
  assert.deepEqual(part.blocked, all.blocked.filter((b) => inK(b.key)));
  assert.deepEqual(part.verdict, ['A-6']);
  assert.deepEqual(all.verdict, ['A-4', 'A-6'], 'a done ticket is never in verdict');
});

test('readyScope: placed tickets of the owner and/or sprint; every ticket counted once in ready, done or notReady', () => {
  const s = readyScope(model(), { owner: 'Ana Diaz', sprint: 1 });
  assert.deepEqual(s.keys, ['A-1', 'A-2', 'A-3', 'A-4', 'A-5', 'A-6']);
  assert.deepEqual([s.ready, s.done, s.notReady, s.waiting, s.verdict], [['A-2'], ['A-1'], ['A-3', 'A-4', 'A-5', 'A-6'], ['A-3', 'A-6'], ['A-4', 'A-6']]);
  assert.deepEqual(s.blocked, [{ key: 'A-5', kinds: ['gap'] }]);
  assert.deepEqual(readyScope(model(), { sprint: 2 }).keys, ['A-7', 'B-2']);
  assert.deepEqual(readyScope(model(), { owner: 'Ben' }).keys, ['B-1', 'B-2', ...R30]);
  assert.deepEqual(readyScope(model(), { owner: 'Nobody', sprint: 1 }).keys, []);
  assert.throws(() => readyScope(model(), {}), /owner or a sprint/);
});

test('brain ready --person --sprint: counts first, the ready keys, each not-ready reason with example keys, freshness; exit 0', () => {
  const r = run('ready', '--person', 'Ana Diaz', '--sprint', '1');
  assert.equal(r.stderr, '');
  assert.equal(r.stdout, [
    'Ana Diaz S1: ready 1 of 6, done 1, not ready 4 (waiting on producers 2, open items 1, verdict not READY 2)',
    'ready: A-2', 'waiting on producers (2): A-3 A-6', 'open items (1): A-5', 'verdict not READY (2): A-4 A-6', FRESH, ''].join('\n'));
  assert.equal(r.status, 0);
});

test('a unique first name or a case-insensitive name resolves the person; the header names the owner as planned', () => {
  for (const name of ['Ana', 'ana diaz', 'ANA']) assert.match(run('ready', '--person', name, '--sprint', '1').stdout, /^Ana Diaz S1: ready 1 of 6,/, name);
});

test('one filter alone: --sprint lists every owner of the sprint, --person every sprint; the ready list is capped with +N more, -v lifts it', () => {
  let r = run('ready', '--sprint', '3');
  assert.equal(r.stdout, ['S3: ready 30 of 30, done 0, not ready 0', `ready: ${R30.slice(0, 25).join(' ')} +5 more`, FRESH, ''].join('\n'));
  assert.equal(r.status, 0);
  r = run('ready', '--sprint', '3', '-v');
  assert.equal(r.stdout, ['S3: ready 30 of 30, done 0, not ready 0', `ready: ${R30.join(' ')}`, FRESH, ''].join('\n'));
  r = run('ready', '--person', 'ben');
  assert.equal(r.stdout.split('\n')[0], 'Ben: ready 32 of 32, done 0, not ready 0');
  assert.equal(r.stdout.split('\n')[1], `ready: B-1 B-2 ${R30.slice(0, 23).join(' ')} +7 more`);
});

test('example keys per reason are capped at 5 (+N more), -v shows up to 50 and the done keys', () => {
  const r = run('ready', '--sprint', '1', '-v');
  assert.equal(r.stdout, [
    'S1: ready 2 of 7, done 1, not ready 4 (waiting on producers 2, open items 1, verdict not READY 2)',
    'ready: A-2 B-1', 'waiting on producers (2): A-3 A-6', 'open items (1): A-5', 'verdict not READY (2): A-4 A-6', 'done (1): A-1', FRESH, ''].join('\n'));
});

test('nothing ready, or nothing placed in that cell: exit 1 (a negative answer)', () => {
  let r = run('ready', '--person', 'Ana', '--sprint', '9');
  assert.deepEqual([r.status, r.stdout, r.stderr], [1, 'Ana Diaz S9: no placed tickets\n', '']);
  r = run('ready', '--person', 'Ana', '--sprint', '1', '--jira', 'snap.json');
  assert.equal(r.status, 0);
  assert.equal(r.stdout.split('\n')[0], 'Ana Diaz S1: ready 1 of 6, done 2, not ready 3 (open items 1, verdict not READY 2)', 'A-2 Done in the snapshot: A-3 may start, A-6 still has its verdict');
  assert.ok(!r.stdout.includes(FRESH), 'a snapshot was given: no freshness note without -v');
  r = run('ready', '--person', 'Ben', '--sprint', '2', '--jira', 'reopened.json');
  assert.deepEqual([r.status, r.stdout], [1, 'Ben S2: ready 0 of 1, done 0, not ready 1 (waiting on producers 1)\nready: none\nwaiting on producers (1): B-2\n'], 'A-1 reopened: B-2 waits, nothing may start');
  assert.equal(JSON.parse(run('ready', '--person', 'Ben', '--sprint', '2', '--jira', 'reopened.json', '--json').stdout).exit, 1);
});

test('--json: the v2 envelope with the full structured lists and counts; next is a ticket and a ready command', () => {
  const r = run('ready', '--person', 'Ana', '--sprint', '1', '--json'), e = JSON.parse(r.stdout);
  assert.deepEqual([e.v, e.cmd, e.ok, e.exit, r.status], [2, 'ready', true, 0, 0]);
  assert.deepEqual(e.data, {
    person: 'Ana Diaz', sprint: 1, total: 6,
    counts: { ready: 1, done: 1, notReady: 4, waiting: 2, openItems: 1, verdict: 2 },
    ready: ['A-2'], done: ['A-1'], notReady: ['A-3', 'A-4', 'A-5', 'A-6'], waiting: ['A-3', 'A-6'],
    openItems: [{ key: 'A-5', kinds: ['gap'] }], verdict: [{ key: 'A-4', verdict: 'BLOCKED' }, { key: 'A-6', verdict: 'NEEDS_INFO' }], statuses: 'last build',
  });
  assert.deepEqual(e.next, ['brain ticket A-2', 'brain ready A-3']);
  const all = JSON.parse(run('ready', '--sprint', '3', '--json').stdout);
  assert.equal(all.data.ready.length, 30, '--json is not capped like the text');
  assert.equal(all.data.person, null);
});

test('the bulk answer agrees with `brain ready KEY` on every placed ticket of the fixture', () => {
  const bulk = new Set();
  for (const s of [1, 2, 3]) for (const k of JSON.parse(run('ready', '--sprint', String(s), '--json').stdout).data.ready) bulk.add(k);
  for (const { key } of SCHEDULE) assert.equal(run('ready', key).status === 0, bulk.has(key), key);
});

test('usage errors: KEY with a filter, no KEY and no filter, an unknown person, a bad sprint: exit 2 with a fixed message and a try line', () => {
  /** @type {Array<[string[], string, string]>} */
  const cases = [
    [['ready', 'A-2', '--person', 'Ana'], 'error: ready takes a KEY or --person/--sprint, not both', 'try: brain explain ready'],
    [['ready', 'A-2', '--sprint', '1'], 'error: ready takes a KEY or --person/--sprint, not both', 'try: brain explain ready'],
    [['ready'], 'error: ready needs a KEY, or --person NAME and/or --sprint N', 'try: brain explain ready'],
    [['ready', '--person', 'Zed\nINJECTED'], 'error: --person matches no single person in the plan (exact, case-insensitive or a unique first name)', 'try: brain explain ready'],
    [['ready', '--person', 'Zed', '--sprint', '2'], 'error: --person matches no single person in the plan (exact, case-insensitive or a unique first name)', 'try: brain sprint 2'],
    [['ready', '--person', 'Ana', '--sprint', 'x'], 'error: --sprint: expected an integer', 'try: brain explain ready'],
  ];
  for (const [args, err, tryLine] of cases) {
    const r = run(...args);
    assert.deepEqual([r.status, r.stdout, r.stderr], [2, '', `${err}\n${tryLine}\n`], args.join(' '));
  }
});

test('brain ready KEY is unchanged by the bulk options', () => {
  assert.equal(run('ready', 'A-2').stdout, `READY TO START A-2\n${FRESH}\n`);
  assert.equal(run('ready', 'A-3').status, 1);
});
