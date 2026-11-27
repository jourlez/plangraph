// renderFind, renderRelieve and renderWhatif on hand-built results: every status and every optional part of the text. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderFind, renderRelieve, renderWhatif } from '../lib/whatif.ts';

const cmd = (s: { sprint: number }): string | null => (s.sprint === 9 ? null : `plangraph whatif K --sprint ${s.sprint}`);
const slot = (sprint: number, over: Record<string, unknown> = {}) => ({ owner: 'Ana', sprint, slip: 1, sameOwner: true, load: 2, cap: 5, warn: false, ...over });
const find = (over: Record<string, unknown> = {}) => ({ status: 'found', key: 'K-1', from: { owner: 'Ana', sprint: 2 }, first: 1, tried: 4, valid: 2, allowed: [], reasons: {}, searchComplete: true, slots: [slot(3), slot(9, { owner: 'Bo', sameOwner: false, warn: true })], ...over }) as never;

test('renderFind: unknown, frozen, none with and without flags, and found with every optional part', () => {
  assert.deepEqual(renderFind(find({ status: 'unknown' }), { cmd }), ['NO: K-1 is not in the plan']);
  assert.match(renderFind(find({ status: 'frozen', frozen: 'S2 started' }), { cmd })[0]!, /keeps its slot \(STARTED: S2 started\)/);
  const none = renderFind(find({ status: 'none', valid: 0, slots: [], reasons: { CAPACITY: 2, LINKS: 2, STARTED: 5 }, searchComplete: false }), { cmd });
  assert.match(none[0]!, /no valid slot among 4 tried \(later sprints, same owner\): STARTED 5, CAPACITY 2, LINKS 2 \(stopped after 4 slots/);
  assert.match(none[1]!, /try: --earlier, --owner-change, or plangraph whatif K-1/);
  const bare = renderFind(find({ status: 'none', valid: 0, slots: [], first: 5, allowed: ['owner-change'] }), { cmd });
  assert.match(bare[0]!, /\(later sprints, any owner\)$/);
  assert.match(bare[1]!, /^try: --earlier, or|^try: plangraph/);
  const all = renderFind(find({ status: 'none', valid: 0, slots: [], allowed: ['earlier', 'owner-change'] }), { cmd });
  assert.match(all[0]!, /later or earlier sprints, any owner/);
  assert.match(all[1]!, /^try: plangraph whatif/);
  const ok = renderFind(find({ valid: 7, searchComplete: false }), { cmd, top: 2, name: (s) => `<${String(s)}>`, key: (s) => `[${String(s)}]` });
  assert.match(ok[0]!, /^FIND \[K-1\] \(<Ana> S2\): 7 valid slots of 4 tried .*best: S3 <Ana> \(no change\), S9 <Bo>.*stopped after 4 slots/);
  assert.match(ok[1]!, /slip 1, load 2\/5 \| plangraph whatif K --sprint 3/);
  assert.match(ok[2]!, /started: confirm with the assignee \| \(no shell-safe command/);
  assert.match(ok[3]!, /5 more valid slots/);
  assert.match(ok[4]!, /dry run/);
  const one = renderFind(find({ valid: 1, slots: [slot(3)] }), { cmd });
  assert.match(one[0]!, /1 valid slot of 4/);
  assert.equal(one.length, 3);
});

const relieve = (over: Record<string, unknown> = {}) => ({ status: 'relieved', person: 'Ana', sprint: 2, load: 9, cap: 5, after: 5, slip: 2, ownerChanges: 1, allowed: [], searchComplete: true, budget: 100, first: 1, reasons: [], order: 'sequential', moves: [{ key: 'K-1', sp: 3, from: { owner: 'Ana', sprint: 2 }, to: { owner: 'Bo', sprint: 3 } }], ...over }) as never;
const mcmd = (m: { sp: number }): string | null => (m.sp === 3 ? 'plangraph whatif K-1 --sprint 3' : null);

test('renderRelieve: none needed, no relief with every reason, and a relief in both orders', () => {
  assert.match(renderRelieve(relieve({ status: 'none_needed', load: 9 }), { cmd: mcmd })[0]!, /only by frozen tickets/);
  assert.match(renderRelieve(relieve({ status: 'none_needed', load: 4 }), { cmd: mcmd })[0]!, /within capacity \(4\/5\)/);
  const no = renderRelieve(relieve({ status: 'no_relief', reasons: [{ code: 'NOT_ENOUGH', freeable: 1, needed: 4 }, { code: 'NO_ROOM', room: 2, needed: 4 }, { code: 'FROZEN', keys: ['A', 'B', 'C', 'D', 'E', 'F', 'G'] }, { code: 'LINKS', keys: ['A'] }] }), { cmd: mcmd, keys: 3 });
  assert.match(no[0]!, /no relief found within the allowed moves \(this cell's tickets, later sprints, same owner\)/);
  assert.equal(no[1], '- the tickets that can move free 1 SP of the 4 needed');
  assert.equal(no[2], '- the targets have room for 2 of 4 SP');
  assert.equal(no[3], '- frozen (started or closed) 7: A B C +4 more');
  assert.equal(no[4], '- every target breaks a link 1: A');
  assert.match(no[5]!, /^try: --earlier, --owner-change, or plangraph whatif KEY/);
  const budget = renderRelieve(relieve({ status: 'no_relief', searchComplete: false, allowed: ['earlier', 'owner-change'], first: 2 }), { cmd: mcmd });
  assert.match(budget[0]!, /within the search budget \(100 steps\); not proven impossible/);
  assert.match(budget[1]!, /^try: plangraph/);
  const firstSprint = renderRelieve(relieve({ status: 'no_relief', first: 2 }), { cmd: mcmd });
  assert.match(firstSprint[1]!, /^try: --owner-change, or/);
  const seq = renderRelieve(relieve({ moves: Array.from({ length: 3 }, (_, i) => ({ key: `K-${i}`, sp: i === 0 ? 3 : 1, from: { owner: 'Ana', sprint: 2 }, to: { owner: 'Bo', sprint: 3 } })) }), { cmd: mcmd, limit: 2 });
  assert.match(seq[0]!, /RELIEF: Ana S2 9\/5 -> 5\/5 with 3 moves \(slip 2, 1 owner change\)/);
  assert.match(seq[1]!, /K-0 3 SP: Ana S2 > Bo S3 \| plangraph whatif K-1 --sprint 3/);
  assert.match(seq[2]!, /\(no shell-safe command/);
  assert.match(seq[3]!, /1 more moves/);
  assert.match(seq[4]!, /in this order with --apply-plan --write/);
  const together = renderRelieve(relieve({ order: 'together', searchComplete: false, ownerChanges: 2 }), { cmd: mcmd });
  assert.match(together[0]!, /with 1 move \(slip 2, 2 owner changes\)/);
  assert.match(together[0]!, /search budget 100 hit/);
  assert.match(together.at(-1)!, /only work together/);
});

const view = (over: Record<string, unknown> = {}) => ({ ok: true, reasons: [], ripple: [{ key: 'K-1', from: { owner: 'Ana', sprint: 2 }, to: { owner: 'Bo', sprint: 3 }, why: 'asked' }], load: { Bo: { 3: { before: 3, after: 6, cap: 5 } }, Ana: { 2: { before: 5, after: 2, cap: 5 } } }, ...over }) as never;

test('renderWhatif: yes with load, freed, warnings, notes and touches; no with each kind of fix', () => {
  const ok = renderWhatif(view({ freed: { sp: 3, owner: 'Ana', sprint: 2 }, reasons: [{ code: 'STARTED', key: 'K-1', detail: 'started', fix: 'f', warn: true }], notes: ['n1', 'n2'], touches: 'touches: X' }));
  assert.match(ok, /^OK: K-1 -> Bo S3\./);
  assert.match(ok, /Frees 3 on Ana S2\./);
  assert.match(ok, /WARN STARTED K-1 \(started\)\./);
  assert.match(ok, /Note: n1; n2\. touches: X$/);
  assert.equal(renderWhatif(view({ ripple: [] })), 'OK: ?. Bo S3 6/5.');
  const reasons = Array.from({ length: 4 }, (_, i) => ({ code: 'CAPACITY', key: `K-${i}`, detail: `d${i}`, fix: `fix${i}` }));
  const no = renderWhatif(view({ ok: false, reasons }), { limit: 2 });
  assert.match(no, /^NO: K-1 -> Bo S3\. CAPACITY K-0 \(d0\) \| CAPACITY K-1 \(d1\) \| \.\.\. 2 more\. Fix: fix0\./);
  const other = renderWhatif(view({ ok: false, reasons: [reasons[0]], suggestion: { sprint: 4, owner: 'Bo', shifts: 1, ownerChanges: 0, flags: ['earlier', 'owner-change'] }, notes: ['n'], touches: 't' }));
  assert.match(other, /Fix: move to S4 \(1 other shifts, 0 owner changes; apply with --earlier --owner-change\)\. Note: n\. t$/);
  assert.match(renderWhatif(view({ ok: false, reasons: [reasons[0]], suggestion: { sprint: 3, owner: 'Bo', shifts: 2, ownerChanges: 1 } })), /Fix: keep S3 \(2 others shift, 1 owner changes\)\./);
  assert.match(renderWhatif(view({ ok: false, reasons: [reasons[0]], suggestion: { none: true } })), /Fix: none found; try --earlier or --owner-change\./);
  assert.equal(renderWhatif(view({ ok: false, ripple: [], reasons: [{ code: 'UNKNOWN_TICKET', key: 'Z', detail: 'd', fix: '' }] })), 'NO: Z. UNKNOWN_TICKET Z (d).');
});
