// `brain whatif KEY --find` (review M5): every (owner, sprint) slot KEY may move to with no violation anywhere, ranked (slip, same owner
// first, least target load, name, sprint), read-only and bounded. Library examples, a property test against brute force on random small
// plans (each listed slot applied to a copy passes verifyPlan with nothing new), the CLI text, --json, usage errors and nothing written.
// The exhaustive small-scope check is test/assure/find.assure.ts.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { buildModel } from '../lib/model.ts';
import { findSlots, renderFind, whatif, applyMoves } from '../lib/whatif.ts';
import type { FindResult, Slot } from '../lib/whatif.ts';
import { verifyPlan } from '../lib/verify.ts';
import { genPlan, rng } from './fixtures/gen.ts';

const T = (key: string, sp: number, o = {}) => ({ key, sp, jira_status: 'To Do', verdict: 'READY', ...o });
// A-1 (2 SP) Ana S2; its consumer C-1 sits in Ben S5; Ana S3 is full (B-1 3/3), Ben S3 has 1/3; P-1 (Done) in Ana S1 feeds A-1.
const TICKETS = [T('A-1', 2), T('B-1', 3), T('C-1', 1), T('D-1', 1), T('P-1', 1, { jira_status: 'Done' })];
const EDGES = [{ consumer: 'C-1', producer: 'A-1', kind: 'x' }, { consumer: 'A-1', producer: 'P-1', kind: 'x' }];
const PLACE: Record<string, [string, number]> = { 'A-1': ['Ana', 2], 'B-1': ['Ana', 3], 'C-1': ['Ben', 5], 'D-1': ['Ben', 3], 'P-1': ['Ana', 1] };
const SCHEDULE = Object.entries(PLACE).map(([key, [owner, sprint]]) => ({ version: 'current', key, owner, sprint }));
const CONFIG = { first_sprint: 1, end_sprint: 5, caps: { default: 3 } };
const model = () => buildModel({ tickets: TICKETS, edges: EDGES, schedule: SCHEDULE, config: CONFIG });
const show = (r: FindResult) => r.slots.map((x) => `${x.owner} S${x.sprint}`);

test('lib: later sprints of the same owner by default; --owner-change and --earlier widen the space; ranked by slip, owner, load', () => {
  const r = findSlots(model(), 'A-1');
  assert.deepEqual([r.status, r.tried, r.valid, show(r)], ['found', 3, 1, ['Ana S4']]); // S3 full, S5 breaks C-1 (Ben S5 needs A-1 by S4)
  assert.deepEqual(r.reasons, { CAPACITY: 1, CONSUMER_EARLY: 1 });
  const oc = findSlots(model(), 'A-1', { allowOwnerChange: true });
  assert.deepEqual(show(oc), ['Ben S2', 'Ben S3', 'Ana S4', 'Ben S4', 'Ben S5']); // by slip; at slip 2 the same owner first
  const all = findSlots(model(), 'A-1', { allowOwnerChange: true, allowEarlier: true });
  // slip 1: the same owner first (Ana S1: P-1 there is Done, so the link holds), then the lighter cell (Ben S1 0 before Ben S3 1)
  assert.deepEqual(show(all), ['Ben S2', 'Ana S1', 'Ben S1', 'Ben S3', 'Ana S4', 'Ben S4', 'Ben S5']);
  for (const x of all.slots) {
    const before = new Set(verifyPlan(model()).map((v) => `${v.code}|${v.key}`));
    assert.deepEqual(verifyPlan(model(), applyMoves(model().sched, [{ key: 'A-1', to: { owner: x.owner, sprint: x.sprint } }])).filter((v) => !before.has(`${v.code}|${v.key}`)), [], `${x.owner} S${x.sprint}`);
  }
});

test('lib: none valid gives the reason groups; a closed ticket never moves; strict turns the In Progress warning into a stop; unknown key', () => {
  const none = findSlots(buildModel({ tickets: TICKETS, edges: EDGES, schedule: SCHEDULE, config: { ...CONFIG, end_sprint: 3 } }), 'A-1');
  assert.deepEqual([none.status, none.tried, none.reasons], ['none', 1, { CAPACITY: 1 }]);
  assert.deepEqual(renderFind(none, { cmd: () => null }), ['FIND A-1 (Ana S2): no valid slot among 1 tried (later sprints, same owner): CAPACITY 1', 'try: --earlier, --owner-change, or brain whatif A-1 --sprint M --slip --apply-plan to shift other tickets too']);
  const done = findSlots(model(), 'P-1', { allowOwnerChange: true, allowEarlier: true });
  assert.deepEqual([done.status, done.valid, done.tried, done.frozen], ['frozen', 0, 1, 'status Done']);
  assert.deepEqual(renderFind(done, { cmd: () => null }), ['FIND P-1 (Ana S1): no slot: P-1 keeps its slot (STARTED: status Done)']);
  const ip = buildModel({ tickets: [T('I-1', 1, { jira_status: 'In Progress' })], schedule: [{ key: 'I-1', owner: 'Ana', sprint: 1 }], config: CONFIG });
  assert.deepEqual([findSlots(ip, 'I-1').valid, findSlots(ip, 'I-1').slots[0].warn, findSlots(ip, 'I-1', { strict: true }).valid], [4, true, 0]);
  assert.deepEqual(renderFind(findSlots(model(), 'NOPE'), { cmd: () => null }), ['NO: NOPE is not in the plan']);
  const capped = findSlots(model(), 'A-1', { allowOwnerChange: true, allowEarlier: true, max: 2 });
  assert.deepEqual([capped.tried, capped.searchComplete], [2, false]);
});

test('property: on random small plans the slots equal a brute force over the same space, each one whatif-OK and verify-clean', () => {
  let checked = 0, found = 0;
  for (let seed = 1; seed <= 120; seed++) {
    const g = genPlan({ n: 4 + (seed % 5), people: 2 + (seed % 2), density: 0.3, seed: seed + 7000, cap: 3 + (seed % 3) });
    const r0 = rng(seed); g.tickets.forEach((t) => { const x = r0(); if (x < 0.15) t.jira_status = 'Done'; else if (x < 0.25) t.jira_status = 'In Progress'; });
    g.config.end_sprint = Math.max(...g.schedule.map((s) => s.sprint)) + 1;
    const m = buildModel(g), keys = [...m.tickets.keys()], people = [...new Set([...m.sched.values()].map((p) => p.owner as string))].sort(); // genPlan places every ticket
    const key = keys[seed % keys.length], cur = m.sched.get(key) as Slot, flags = [{}, { allowEarlier: true }, { allowOwnerChange: true }, { allowEarlier: true, allowOwnerChange: true }][seed % 4]; // genPlan places every ticket
    const want = [], before = verifyPlan(m).map((v) => `${v.code}|${v.key}`);
    for (const o of people) for (let s = 1; s <= g.config.end_sprint; s++) {
      if (o === cur.owner && s === cur.sprint) continue;
      if (o === cur.owner && s < cur.sprint && !flags.allowEarlier) continue;
      if (o !== cur.owner && (!flags.allowOwnerChange || (s < cur.sprint && !flags.allowEarlier))) continue;
      if (!whatif(m, { key, to: o, sprint: s }, { noSuggest: true }).ok) continue;
      const left = [...before];
      const ok = verifyPlan(m, applyMoves(m.sched, [{ key, to: { owner: o, sprint: s } }])).every((v) => { const i = left.indexOf(`${v.code}|${v.key}`); if (i < 0) return false; left.splice(i, 1); return true; });
      if (ok) want.push(`${o} S${s}`);
    }
    const got = findSlots(m, key, flags);
    assert.deepEqual(show(got).slice().sort(), want.slice().sort(), `seed ${seed}`);
    const rank = got.slots.map((x) => [x.slip, x.sameOwner ? 0 : 1, x.load, x.owner, x.sprint]);
    for (let i = 1; i < rank.length; i++) assert.ok(JSON.stringify(rank[i - 1]) <= JSON.stringify(rank[i]) || rank[i - 1][0] < rank[i][0] || (rank[i - 1][0] === rank[i][0] && (rank[i - 1][1] < rank[i][1] || (rank[i - 1][1] === rank[i][1] && rank[i - 1][2] <= rank[i][2]))), `seed ${seed}: order`);
    checked++; if (got.valid) found++;
  }
  assert.ok(checked === 120 && found > 30, `${found} of ${checked} had a slot`);
});

// ---- CLI ----
const BRAIN = path.join(import.meta.dirname, '..', 'bin', 'brain'), GIT = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
let BASE = '', REPO = '';
const env = () => ({ PATH: process.env.PATH, HOME: path.join(BASE, 'home'), CLAUDE_PLUGIN_DATA: path.join(BASE, 'data'), LC_ALL: 'C', BRAIN_DIR: '', TMPDIR: BASE, ...GIT });
const run = (...a: string[]) => spawnSync(process.execPath, [BRAIN, ...a], { cwd: REPO, env: env(), encoding: 'utf8', timeout: 60000 });
const digest = () => { const h = crypto.createHash('sha256'), dir = path.join(REPO, '.brain'); for (const f of fs.readdirSync(dir).sort()) h.update(`${f}\0`).update(fs.readFileSync(path.join(dir, f))); return h.digest('hex'); };
before(() => {
  BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-find-')));
  for (const d of ['home', 'data', 'repo']) fs.mkdirSync(path.join(BASE, d));
  REPO = path.join(BASE, 'repo');
  execFileSync('git', ['init', '-q'], { cwd: REPO, env: env() });
  assert.equal(run('init').status, 0);
  const B = path.join(REPO, '.brain'), jl = (rows: readonly unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(path.join(B, 'tickets.jsonl'), jl(TICKETS)); fs.writeFileSync(path.join(B, 'edges.jsonl'), jl(EDGES)); fs.writeFileSync(path.join(B, 'schedule.jsonl'), jl(SCHEDULE));
  fs.writeFileSync(path.join(B, 'config.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(B, 'config.json'), 'utf8')), ...CONFIG }));
  assert.equal(run('build').status, 0);
});
after(() => { if (BASE) fs.rmSync(BASE, { recursive: true, force: true }); });

test('brain whatif KEY --find: the ranked slots with their commands, exit 0, nothing written; none found: exit 1 with the reasons', () => {
  const d = digest();
  let r = run('whatif', 'A-1', '--find', '--owner-change', '--earlier');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, [
    'FIND A-1 (Ana S2): 7 valid slots of 9 tried (later or earlier sprints, any owner); best: S2 Ben, S1 Ana (no change), S1 Ben, S3 Ben, S4 Ana (no change)',
    'S2 Ben: slip 0, load 0/3 | brain whatif A-1 --to Ben --sprint 2', 'S1 Ana (no change): slip 1, load 1/3 | brain whatif A-1 --sprint 1',
    'S1 Ben: slip 1, load 0/3 | brain whatif A-1 --to Ben --sprint 1', 'S3 Ben: slip 1, load 1/3 | brain whatif A-1 --to Ben --sprint 3',
    'S4 Ana (no change): slip 2, load 0/3 | brain whatif A-1 --sprint 4', '... 2 more valid slots (--json lists up to 200)',
    '(dry run, nothing changed: each slot was checked with whatif and brain verify on a copy; to apply one, run its command with --apply-plan --write, then brain export)', ''].join('\n'));
  r = run('whatif', 'D-1', '--find');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(digest(), d, 'nothing written');
  r = run('whatif', 'P-1', '--find');
  assert.deepEqual([r.status, r.stdout], [1, 'FIND P-1 (Ana S1): no slot: P-1 keeps its slot (STARTED: status Done)\n']);
});

test('brain whatif KEY --find --json: the v2 envelope with every slot and its command, the counts and next = the best commands', () => {
  const e = JSON.parse(run('whatif', 'A-1', '--find', '--json').stdout);
  assert.deepEqual([e.v, e.cmd, e.ok, e.exit], [2, 'whatif', true, 0]);
  assert.deepEqual(e.data, { key: 'A-1', status: 'found', from: { owner: 'Ana', sprint: 2 }, tried: 3, valid: 1, allowed: ['later'], searchComplete: true,
    slots: [{ owner: 'Ana', sprint: 4, slip: 2, sameOwner: true, load: 0, cap: 3, command: 'brain whatif A-1 --sprint 4' }], reasons: { CAPACITY: 1, CONSUMER_EARLY: 1 } });
  assert.deepEqual(e.next, ['brain whatif A-1 --sprint 4']);
});

test('--find usage errors: with --to, --sprint, --relieve, --apply-plan or --write: exit 2, fixed message', () => {
  const NOT = 'error: --find is a dry run over every slot of KEY: --to, --sprint, --relieve, --apply-plan and --write are not supported (it prints the whatif command of each slot)';
  for (const extra of [['--to', 'Ben'], ['--sprint', '3'], ['--apply-plan'], ['--write']]) {
    const r = run('whatif', 'A-1', '--find', ...extra);
    assert.equal(r.status, 2, extra.join(' ')); assert.equal(r.stderr.split('\n')[0], NOT);
  }
});
